package candor

import (
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// signalled swaps notifySignals for the test and gives the function that sends the signal.
func signalled(t *testing.T) func() {
	chans := make(chan chan os.Signal, 1)
	saved := notifySignals
	notifySignals = func(ch chan os.Signal) { chans <- ch }
	t.Cleanup(func() { notifySignals = saved })
	return func() { (<-chans) <- os.Interrupt }
}

func freeAddr(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

// waits until c is cancelled, checking as Candor code does.
func untilCancelled(c *Ctx) {
	for {
		c.Check()
		time.Sleep(5 * time.Millisecond)
	}
}

// bigIn and bigGo hold /big until the test lets it answer.
var bigIn, bigGo = make(chan struct{}, 1), make(chan struct{}, 1)

func testHandler(c *Ctx, q HttpRequest) HttpResponse {
	switch q.Path {
	case "/big":
		bigIn <- struct{}{}
		<-bigGo
		return HttpResponse{Status: 200, Body: strings.Repeat("x", 4<<20)}
	case "/slow":
		time.Sleep(300 * time.Millisecond)
		c.Check()
		return HttpResponse{Status: 200, Body: "finished"}
	case "/stuck":
		untilCancelled(c)
	case "/events":
		var h Map[string, string]
		h.Set("content-type", "text/event-stream")
		return HttpResponse{Status: 200, Headers: h, Stream: func(c *Ctx, write func(string)) {
			write("data: hi\n\n")
			untilCancelled(c)
		}}
	case "/page", "/tiny", "/png":
		var h Map[string, string]
		h.Set("content-type", map[string]string{"/page": "text/html; charset=utf-8", "/tiny": "text/plain", "/png": "image/png"}[q.Path])
		body := strings.Repeat("<p>gzip me</p>", 200)
		if q.Path == "/tiny" {
			body = "small"
		}
		return HttpResponse{Status: 200, Headers: h, Body: body}
	case "/csv":
		var h Map[string, string]
		h.Set("content-type", "text/csv")
		return HttpResponse{Status: 200, Headers: h, Stream: func(c *Ctx, write func(string)) {
			for i := 0; i < 3; i++ {
				write("a,b,c\n")
			}
		}}
	case "/repeats":
		var more Map[string, []string]
		more.Set("set-cookie", []string{"b=2"})
		var h Map[string, string]
		h.Set("set-cookie", "a=1")
		tags, _ := q.QueryAll.Get("tag")
		accept, _ := q.HeadersAll.Get("x-tag")
		return HttpResponse{Status: 200, Headers: h, More: more, Body: strings.Join(tags, ",") + " " + strings.Join(accept, ",")}
	}
	return HttpResponse{Status: 404}
}

func serving(t *testing.T, grace int64) (url string, stopped chan string) {
	addr := freeAddr(t)
	stopped = make(chan string, 1)
	go func() { stopped <- Serve(Root(), addr, nil, grace, true, testHandler) }()
	url = "http://" + addr
	for i := 0; ; i++ {
		if res, err := http.Get(url + "/nope"); err == nil {
			res.Body.Close()
			return url, stopped
		}
		if i > 200 {
			t.Fatal("the server never came up")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSignalFinishesRequestsAndCutsStreams(t *testing.T) {
	signal := signalled(t)
	url, stopped := serving(t, 5_000)
	slow := make(chan string, 1)
	go func() {
		res, err := http.Get(url + "/slow")
		if err != nil {
			slow <- err.Error()
			return
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		slow <- string(body)
	}()
	events, err := http.Get(url + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer events.Body.Close()
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	signal()
	select {
	case why := <-stopped:
		if why != "" {
			t.Fatalf("serve gave %q", why)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serve didn't stop: the event stream should be cut at once")
	}
	if got := <-slow; got != "finished" {
		t.Fatalf("the request in flight got %q", got)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("stopping took %v", d)
	}
	if _, err := http.Get(url + "/slow"); err == nil {
		t.Fatal("still listening after the signal")
	}
}

// A handler returns before net/http has written its response; stopping waits for the writing.
func TestSignalSendsTheLastResponseWhole(t *testing.T) {
	signal := signalled(t)
	url, stopped := serving(t, 5_000)
	got := make(chan int, 1)
	go func() {
		res, err := http.Get(url + "/big")
		if err != nil {
			got <- -1
			return
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		got <- len(body)
	}()
	<-bigIn
	signal()
	time.Sleep(20 * time.Millisecond)
	bigGo <- struct{}{}
	if n := <-got; n != 4<<20 {
		t.Fatalf("got %d bytes of %d", n, 4<<20)
	}
	if why := <-stopped; why != "" {
		t.Fatalf("serve gave %q", why)
	}
}

func TestSignalCancelsWhatOutlastsTheGrace(t *testing.T) {
	signal := signalled(t)
	url, stopped := serving(t, 100)
	go func() {
		if res, err := http.Get(url + "/stuck"); err == nil {
			res.Body.Close()
		}
	}()
	time.Sleep(50 * time.Millisecond)
	signal()
	select {
	case why := <-stopped:
		if why != "" {
			t.Fatalf("serve gave %q", why)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serve didn't cancel the request after the grace")
	}
}

func TestRepeatedQueryKeysAndHeaders(t *testing.T) {
	signal := signalled(t)
	url, stopped := serving(t, 1_000)
	req, _ := http.NewRequest("GET", url+"/repeats?tag=a&tag=b&one=1", nil)
	req.Header.Add("X-Tag", "x")
	req.Header.Add("X-Tag", "y")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "a,b x,y" {
		t.Fatalf("body %q", body)
	}
	if got := res.Header.Values("Set-Cookie"); len(got) != 2 || got[0] != "a=1" || got[1] != "b=2" {
		t.Fatalf("set-cookie %q", got)
	}
	signal()
	<-stopped
}

func TestRepeatsKeepsOnlyRepeatedKeys(t *testing.T) {
	m := repeats(map[string][]string{"One": {"1"}, "Two": {"a", "b"}}, true)
	if m.Len() != 1 {
		t.Fatalf("repeats %v", m.Keys())
	}
	if v, _ := m.Get("two"); len(v) != 2 {
		t.Fatalf("two: %v", v)
	}
}

// get fetches path with Accept-Encoding accept (none if ""), Go's own un-gzipping off: the
// response's Content-Encoding and Vary, and its body un-gzipped if it came gzipped.
func get(t *testing.T, url, accept string) (encoding, vary, body string) {
	req, _ := http.NewRequest("GET", url, nil)
	if accept != "" {
		req.Header.Set("Accept-Encoding", accept)
	}
	res, err := (&http.Client{Transport: &http.Transport{DisableCompression: true}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var r io.Reader = res.Body
	encoding = res.Header.Get("Content-Encoding")
	if encoding == "gzip" {
		zr, err := gzip.NewReader(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		r = zr
	}
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return encoding, res.Header.Get("Vary"), string(b)
}

func TestServeGzipsTextForClientsThatTakeIt(t *testing.T) {
	signal := signalled(t)
	url, stopped := serving(t, 1_000)
	page := strings.Repeat("<p>gzip me</p>", 200)
	for _, c := range []struct{ path, accept, encoding, vary, body string }{
		{"/page", "gzip, deflate, br", "gzip", "Accept-Encoding", page},
		{"/page", "", "", "Accept-Encoding", page},
		{"/page", "gzip;q=0, br", "", "Accept-Encoding", page},
		{"/page", "*", "gzip", "Accept-Encoding", page},
		{"/tiny", "gzip", "", "Accept-Encoding", "small"},
		{"/png", "gzip", "", "", page},
		{"/csv", "gzip", "gzip", "Accept-Encoding", "a,b,c\na,b,c\na,b,c\n"},
	} {
		encoding, vary, body := get(t, url+c.path, c.accept)
		if encoding != c.encoding || vary != c.vary || body != c.body {
			t.Errorf("%s with %q: encoding %q vary %q body %.20q", c.path, c.accept, encoding, vary, body)
		}
	}
	signal()
	<-stopped
}

func TestAcceptsGzip(t *testing.T) {
	for v, want := range map[string]bool{"gzip": true, "GZIP;q=0.5": true, "br, gzip ; q=0": false, "identity": false, "*;q=1": true, "": false, "gzip;q=x": true} {
		if AcceptsGzip([]string{v}) != want {
			t.Errorf("%q: want %v", v, want)
		}
	}
}
