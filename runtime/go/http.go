package candor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// KeepAlive is how often a quiet event stream gets a comment line.
var KeepAlive = 15 * time.Second

// HttpRequest and HttpResponse are `http.Request` and `http.Response` as the runtime sees them;
// the generated `serve` converts between them and the Candor structs.
type HttpRequest struct {
	Method, Path   string
	Query, Headers Map[string, string]
	// Every value of the keys given more than once; nil if none was.
	QueryAll, HeadersAll Map[string, []string]
	Body                 string
	// The client's IP, without the port, and the port (0 if it had none).
	Remote     string
	RemotePort int64
	// On a route that takes large bodies: the body, unread, read as it arrives. Body is "".
	Stream Pull
}

type HttpResponse struct {
	Status  int64
	Headers Map[string, string]
	// From `http.addHeader`: the values sent after the one in Headers, by name.
	More Map[string, []string]
	Body string
	// From `http.streamResponse`: writes the body a piece at a time; Body isn't sent.
	Stream func(c *Ctx, write func(string))
	// From `http.writing`: writes the body to w, and gives its Err as text, failed
	// true. With it, Stream writes the same body.
	Writer func(c *Ctx, w Push) (why string, failed bool)
	// From `http.upgrade`: talks over the WebSocket the request becomes.
	Upgrade func(c *Ctx, s Socket)
	// From `http.serveFile`: the file to send, by ServeContent, which answers ranges; Stream
	// reads the same file.
	File string
}

// maxBody is the largest request body read; a larger one is answered 413 without calling the
// handler.
const maxBody = 1 << 20

// notifySignals sends Ctrl-C and SIGTERM to ch; tests swap it to send their own.
var notifySignals = func(ch chan os.Signal) { signal.Notify(ch, os.Interrupt, syscall.SIGTERM) }

// Serve is `http.serveWith`: it listens on addr and runs handle for every request, each in a
// task of its own, until c is cancelled or the program gets Ctrl-C or SIGTERM. It gives why it
// couldn't listen, or "" once stopped, after every request has ended: no task outlives it. A
// crash in handle is printed and answered 500; the other requests carry on. Requests matching
// one of large (`http.route` patterns) get their body unread, as a stream.
//
// Cancelled, the requests are too. Signalled, it stops listening and the requests in flight
// get grace milliseconds to finish before they are cancelled, but event streams and WebSockets,
// which don't end by themselves, are cancelled at once. A second signal ends the program.
//
// With gz, a response goes out gzipped to a client that takes it, when gzip shrinks its type
// (Compressible) and it isn't known to be under minGzip bytes.
func Serve(c *Ctx, addr string, large []string, grace int64, gz bool, handle func(*Ctx, HttpRequest) HttpResponse) string {
	c.point()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err.Error()
	}
	s := &server{tok: newToken(c.tok), large: large, gzip: gz, handle: handle, endless: map[*token]struct{}{}}
	defer s.tok.detach()
	sig := make(chan os.Signal, 1)
	notifySignals(sig)
	defer signal.Stop(sig)
	// Shutdown doesn't wait for a WebSocket (its connection is no longer the server's), so
	// every request is counted here.
	var live sync.WaitGroup
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			live.Add(1)
			defer live.Done()
			s.serveOne(w, r)
		}),
		ErrorLog: log.New(io.Discard, "", 0),
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	select {
	case err := <-done:
		s.tok.cancel()
		live.Wait()
		return err.Error()
	case <-c.tok.done:
		// The requests' tokens are cancelled with c's, so each stops at its next check.
		srv.Shutdown(context.Background())
		<-done
		live.Wait()
		c.Check()
		return ""
	case <-sig:
		signal.Stop(sig)
		s.stopping()
		ctx, stop := context.WithCancel(context.Background())
		shut := make(chan struct{})
		go func() { srv.Shutdown(ctx); close(shut) }()
		idle := make(chan struct{})
		go func() { live.Wait(); close(idle) }()
		timer := time.NewTimer(time.Duration(grace) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-idle:
		case <-timer.C:
			s.tok.cancel()
			<-idle
		case <-c.tok.done:
			<-idle
		}
		// A handler has returned before net/http writes its response out: Shutdown returns once
		// every connection is idle, so the last responses are sent. A client that connected and
		// sent nothing keeps Shutdown waiting, hence the bound.
		select {
		case <-shut:
		case <-time.After(time.Second):
		}
		stop()
		srv.Close()
		<-done
		c.Check()
		return ""
	}
}

// server is one `serve`: its requests' tokens are made from tok.
type server struct {
	tok    *token
	large  []string
	gzip   bool
	handle func(*Ctx, HttpRequest) HttpResponse
	mu     sync.Mutex
	// Once signalled; the event streams and WebSockets open now, cancelled when it is.
	stopped bool
	endless map[*token]struct{}
}

// stopping cancels the event streams and WebSockets, and any that open from now on.
func (s *server) stopping() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopped = true
	for t := range s.endless {
		t.cancel()
	}
}

// endlessly marks tok's request as one that doesn't end by itself; the func forgets it.
func (s *server) endlessly(tok *token) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		tok.cancel()
		return func() {}
	}
	s.endless[tok] = struct{}{}
	return func() {
		s.mu.Lock()
		delete(s.endless, tok)
		s.mu.Unlock()
	}
}

// serveOne runs one request as a task under the server's token, cancelled too if the client
// goes away.
func (s *server) serveOne(w http.ResponseWriter, r *http.Request) {
	large, handle := s.large, s.handle
	tok := newToken(s.tok)
	defer tok.detach()
	defer context.AfterFunc(r.Context(), tok.cancel)()
	query := r.URL.Query()
	// Go moves Host (HTTP/2's :authority) out of the headers into r.Host; it goes back in.
	header := r.Header
	if r.Host != "" {
		header = r.Header.Clone()
		if header == nil {
			header = http.Header{}
		}
		header.Set("Host", r.Host)
	}
	req := HttpRequest{Method: r.Method, Path: r.URL.Path, Query: firsts(query, false), Headers: firsts(header, true), QueryAll: repeats(query, false), HeadersAll: repeats(header, true), Remote: r.RemoteAddr}
	if host, port, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		req.Remote = host
		req.RemotePort, _ = strconv.ParseInt(port, 10, 64)
	}
	if routed(large, r.Method, r.URL.Path) {
		req.Stream = ReaderPull(r.Body)
	} else {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				http.Error(w, fmt.Sprintf("the body is over %d bytes", maxBody), http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, err.Error(), http.StatusBadRequest)
			}
			return
		}
		req.Body = string(body)
	}
	c := &Ctx{tok: tok}
	var res HttpResponse
	p := catch(func() {
		res = handle(c, req)
		if res.Status < 100 || res.Status > 999 {
			panic(fmt.Sprintf("%d is not an HTTP status", res.Status))
		}
	})
	if p != nil {
		if crashed(p, r, "answered 500") {
			http.Error(w, "the server crashed", http.StatusInternalServerError)
		}
		return
	}
	if res.Upgrade != nil {
		defer s.endlessly(tok)()
		upgrade(c, w, r, res.Upgrade)
		return
	}
	if s.gzip {
		g := &gzipWriter{ResponseWriter: w, r: r}
		defer g.close()
		w = g
	}
	for _, e := range res.Headers.Entries() {
		w.Header().Set(e.Key, e.Value)
	}
	for _, e := range res.More.Entries() {
		for _, v := range e.Value {
			w.Header().Add(e.Key, v)
		}
	}
	if res.File != "" && res.Status == 200 {
		if !serveContent(w, r, res.File) {
			w.Header().Del("Content-Type")
			w.WriteHeader(http.StatusNotFound)
		}
		return
	}
	if res.Stream == nil && w.Header().Get("Content-Length") == "" {
		w.Header().Set("Content-Length", strconv.Itoa(len(res.Body)))
	}
	w.WriteHeader(int(res.Status))
	if res.Stream == nil {
		io.WriteString(w, res.Body)
		return
	}
	// Each piece goes out as it is written. The status is sent, so a crash now can only cut the
	// body short.
	flusher, _ := w.(http.Flusher)
	var mu sync.Mutex
	write := func(s string) error {
		mu.Lock()
		defer mu.Unlock()
		_, err := io.WriteString(w, s)
		if flusher != nil {
			flusher.Flush()
		}
		return err
	}
	if res.Writer != nil {
		written(c, r, res.Writer, write)
		return
	}
	// An event stream (`http.events`) gets a comment line when quiet, so proxies keep it open.
	if ct, _ := res.Headers.Get("content-type"); strings.HasPrefix(ct, "text/event-stream") {
		defer s.endlessly(tok)()
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			t := time.NewTicker(KeepAlive)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					write(": keep-alive\n\n")
				case <-stop:
					return
				}
			}
		}()
	}
	p = catch(func() {
		res.Stream(c, func(s string) {
			c.Check()
			if err := write(s); err != nil {
				tok.cancel()
				c.Check()
			}
		})
	})
	if p != nil && crashed(p, r, "its body cut short") {
		panic(http.ErrAbortHandler)
	}
}

// written runs an `http.writing` body: a write fails once the client has gone, and an Err from
// the body cuts the connection, so the client sees a broken body rather than one that looks
// whole. The Err is printed as a crash is, unless the client going caused it.
func written(c *Ctx, r *http.Request, body func(*Ctx, Push) (string, bool), write func(string) error) {
	var why string
	var failed, gone bool
	p := catch(func() {
		why, failed = body(c, func(c *Ctx, b []byte) error {
			if r.Context().Err() != nil {
				gone = true
				return StreamErr("the client has gone")
			}
			if err := write(string(b)); err != nil {
				gone = true
				return StreamErr(err.Error())
			}
			return nil
		})
	})
	if p != nil {
		if crashed(p, r, "its body cut short") {
			panic(http.ErrAbortHandler)
		}
		return
	}
	if !failed {
		return
	}
	if !gone && r.Context().Err() == nil {
		fmt.Fprintf(stderr, "error: %s\nin a request: %s %s, its body cut short\n", why, r.Method, r.URL.Path)
	}
	panic(http.ErrAbortHandler)
}

// serveContent sends the file at p with the headers set already, answering a Range request
// with the part asked for (206, or 416 past the end) and If-Modified-Since with 304. False if
// the file is gone by now.
func serveContent(w http.ResponseWriter, r *http.Request, p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	http.ServeContent(&quietErrors{ResponseWriter: w}, r, p, st.ModTime(), f)
	return true
}

// quietErrors drops the text ServeContent writes with an error status (a 416's "invalid range:
// failed to overlap"), so `serveFile`'s errors all have empty bodies.
type quietErrors struct {
	http.ResponseWriter
	failed bool
}

func (q *quietErrors) WriteHeader(status int) {
	if status >= 400 {
		q.failed = true
		h := q.Header()
		h.Del("Content-Type")
		h.Del("X-Content-Type-Options")
		h.Set("Content-Length", "0")
	}
	q.ResponseWriter.WriteHeader(status)
}

func (q *quietErrors) Write(b []byte) (int, error) {
	if q.failed {
		return len(b), nil
	}
	return q.ResponseWriter.Write(b)
}

// ReadFrom keeps the server's sendfile path for the file itself.
func (q *quietErrors) ReadFrom(r io.Reader) (int64, error) {
	if rf, ok := q.ResponseWriter.(io.ReaderFrom); ok && !q.failed {
		return rf.ReadFrom(r)
	}
	return io.Copy(struct{ io.Writer }{q}, r)
}

func (q *quietErrors) Unwrap() http.ResponseWriter { return q.ResponseWriter }

// upgrade makes the request a WebSocket and runs talk over it in the request's task. The
// connection closes when talk returns, crashes, or is cancelled (the server stopping).
func upgrade(c *Ctx, w http.ResponseWriter, r *http.Request, talk func(*Ctx, Socket)) {
	if AcceptSocket == nil {
		http.Error(w, "this program has no WebSocket support", http.StatusInternalServerError)
		return
	}
	s, err := AcceptSocket(c, w, r)
	if err != nil {
		// Accept has answered the client already (a request that wasn't an upgrade, say).
		return
	}
	defer s.Close(c)
	if p := catch(func() { talk(c, s) }); p != nil {
		crashed(p, r, "its WebSocket closed")
	}
}

// crashed prints a crash in a request and says whether there was one: a cancel is not.
func crashed(p any, r *http.Request, outcome string) bool {
	if _, ok := p.(cancelled); ok {
		return false
	}
	c := asCrash(p)
	fmt.Fprintf(stderr, "panic: %s%s\nin a request: %s %s, %s\n", message(c.value), trace(c.traces), r.Method, r.URL.Path, outcome)
	return true
}

// bodyFailed is what a body's stream panics with when it can't be read; ReadBody catches it.
type bodyFailed struct{ why string }

// ReaderPull reads body as it arrives: a request's, or the http client's response. A cancel
// (the client gone, say) stops the task first.
func ReaderPull(body io.Reader) Pull {
	var mu sync.Mutex
	return func(c *Ctx, n int64) ([]byte, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		buf := make([]byte, min(pullN(n), 1<<20))
		for {
			c.Check()
			k, err := body.Read(buf)
			if k > 0 {
				return buf[:k:k], true, nil
			}
			if err == io.EOF {
				return nil, false, nil
			}
			if err != nil {
				c.Check()
				return nil, false, StreamErr(err.Error())
			}
		}
	}
}

// pieces writes what pull gives to each, a piece at a time; a failure is bodyFailed, which
// ReadBody catches.
func pieces(pull Pull) func(*Ctx, func(string)) {
	return func(c *Ctx, each func(string)) {
		for {
			b, more, err := pull(c, 32<<10)
			if err != nil {
				panic(bodyFailed{err.Error()})
			}
			if !more {
				return
			}
			each(string(b))
		}
	}
}

// ReadBody calls each with the pieces of the request body stream id holds, and gives why the
// body couldn't be read, or "". A cancel or a crash in each goes on up.
func ReadBody(c *Ctx, id int64, each func(*Ctx, string)) (why string) {
	defer func() {
		if p := recover(); p != nil {
			if f, ok := p.(bodyFailed); ok {
				why = f.why
				return
			}
			panic(p)
		}
	}()
	s := peekStream(id)
	if s == nil {
		return "the body was read already, after its request ended"
	}
	s(c, func(x string) { each(c, x) })
	return ""
}

// The streamed bodies of requests and responses, by id. A request's leaves when its handler
// returns; a response's when `serve` takes it to send. Requests and responses hold the id, so
// they stay values Candor's `==` compares.
//
// A body to read (a request's, a client response's) is kept as a Pull too, for `http.reading`;
// `http.writing`'s as the Writer it is. Each also has the form the older functions use.
var streams = struct {
	sync.Mutex
	next int64
	m    map[int64]stream
}{m: map[int64]stream{}}

type stream struct {
	write  func(*Ctx, func(string))
	pull   Pull
	writer func(*Ctx, Push) (string, bool)
	// Closes a body that wasn't read to its end; nil if nothing needs it.
	done func()
}

func putStream(s stream) int64 {
	streams.Lock()
	defer streams.Unlock()
	streams.next++
	streams.m[streams.next] = s
	return streams.next
}

// PutStream keeps s and gives its id.
func PutStream(s func(*Ctx, func(string))) int64 { return putStream(stream{write: s}) }

// PutPull keeps a body read by pull, which done (or nil) closes, and gives its id. Read to its
// end as a stream, it is closed then.
func PutPull(pull Pull, done func()) int64 {
	write := pieces(pull)
	if done != nil {
		inner := write
		write = func(c *Ctx, each func(string)) {
			defer done()
			inner(c, each)
		}
	}
	return putStream(stream{write: write, pull: pull, done: done})
}

// PutWriter keeps an `http.writing` body and gives its id. As a stream it writes what body
// writes, an Err ending it there.
func PutWriter(body func(*Ctx, Push) (string, bool)) int64 {
	write := func(c *Ctx, each func(string)) {
		body(c, func(_ *Ctx, b []byte) error {
			each(string(b))
			return nil
		})
	}
	return putStream(stream{write: write, writer: body})
}

// TakeStream gives the stream id holds and forgets it.
func TakeStream(id int64) func(*Ctx, func(string)) {
	streams.Lock()
	defer streams.Unlock()
	s := streams.m[id]
	delete(streams.m, id)
	return s.write
}

// WriterOf is the `http.writing` body id holds, or nil: `serve` takes it before TakeStream.
func WriterOf(id int64) func(*Ctx, Push) (string, bool) {
	streams.Lock()
	defer streams.Unlock()
	return streams.m[id].writer
}

// Reading gives use a reader over the body stream id holds (`http.reading`): read as it
// arrives, or for one written by a function (a test's `http.streamed`, `http.writing`), its
// pieces as written. A client response's body is closed once use returns.
func Reading(c *Ctx, id int64, use func(Pull)) {
	streams.Lock()
	s, ok := streams.m[id]
	streams.Unlock()
	if !ok {
		use(func(*Ctx, int64) ([]byte, bool, error) {
			return nil, false, StreamErr("the body was read already, after its request ended")
		})
		return
	}
	if s.done != nil {
		defer s.done()
	}
	if s.pull != nil {
		use(s.pull)
		return
	}
	var all []string
	s.write(c, func(x string) { all = append(all, x) })
	use(pullPieces(all))
}

// The files `http.serveFile` answers with, by their stream's id: `serve` sends them with
// ServeContent (ranges, If-Modified-Since); anything else reading the body reads the stream.
var files = struct {
	sync.Mutex
	m map[int64]string
}{m: map[int64]string{}}

// PutFile keeps a stream of the file at p, a piece at a time, and gives its id.
func PutFile(p string) int64 {
	id := PutStream(func(c *Ctx, write func(string)) {
		f, err := os.Open(p)
		if err != nil {
			return
		}
		defer f.Close()
		buf := make([]byte, 32<<10)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				write(string(buf[:n]))
			}
			if err != nil {
				return
			}
		}
	})
	files.Lock()
	defer files.Unlock()
	files.m[id] = p
	return id
}

// TakeFile gives the path id streams and forgets it; "" if id is no file.
func TakeFile(id int64) string {
	files.Lock()
	defer files.Unlock()
	p := files.m[id]
	delete(files.m, id)
	return p
}

// The files `http.serveFile` answers with in a test, by their stream's id: the fake client sends
// them as `serve` does, by ServeContent over the bytes in memory.
var memFiles = struct {
	sync.Mutex
	m map[int64]memFile
}{m: map[int64]memFile{}}

type memFile struct {
	data     string
	modified int64
}

// PutMemFile keeps data, a file written at modified (milliseconds), as a stream, and gives its id.
func PutMemFile(data string, modified int64) int64 {
	id := PutStream(Pieces([]string{data}))
	memFiles.Lock()
	defer memFiles.Unlock()
	memFiles.m[id] = memFile{data, modified}
	return id
}

// ServeMemFile is what `serve` sends for res, the file id holds, to a request of method with
// headers, and every value of those in all: ServeContent's 206, 416, 304 and HEAD, with res's
// headers set first. False if id is no file.
func ServeMemFile(id int64, method string, headers Map[string, string], all Map[string, []string], res HttpResponse) (HttpResponse, bool) {
	memFiles.Lock()
	f, ok := memFiles.m[id]
	memFiles.Unlock()
	if !ok {
		return HttpResponse{}, false
	}
	r, err := http.NewRequest(method, "/", nil)
	if err != nil {
		return HttpResponse{}, false
	}
	for _, e := range headers.Entries() {
		r.Header.Set(e.Key, e.Value)
	}
	for _, e := range all.Entries() {
		r.Header.Del(e.Key)
		for _, v := range e.Value {
			r.Header.Add(e.Key, v)
		}
	}
	w := &recorder{header: http.Header{}}
	for _, e := range res.Headers.Entries() {
		w.header.Set(e.Key, e.Value)
	}
	for _, e := range res.More.Entries() {
		for _, v := range e.Value {
			w.header.Add(e.Key, v)
		}
	}
	g := &gzipWriter{ResponseWriter: w, r: r}
	http.ServeContent(&quietErrors{ResponseWriter: g}, r, "", time.UnixMilli(f.modified), strings.NewReader(f.data))
	g.WriteHeader(http.StatusOK)
	g.close()
	body := w.body.String()
	// Several ranges come back as multipart with a random boundary; a test gets the same one
	// every run, as long, so content-length holds.
	ct := w.header.Get("Content-Type")
	if b, ok := strings.CutPrefix(ct, "multipart/byteranges; boundary="); ok {
		fixed := strings.Repeat("0", len(b))
		w.header.Set("Content-Type", strings.ReplaceAll(ct, b, fixed))
		body = strings.ReplaceAll(body, b, fixed)
	}
	return HttpResponse{Status: int64(w.status), Headers: firsts(w.header, true), More: repeats(w.header, true), Body: body}, true
}

// recorder is a ResponseWriter that keeps what was written, for ServeMemFile.
type recorder struct {
	header http.Header
	status int
	body   strings.Builder
}

func (w *recorder) Header() http.Header { return w.header }

func (w *recorder) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *recorder) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.body.Write(b)
}

func peekStream(id int64) func(*Ctx, func(string)) {
	streams.Lock()
	defer streams.Unlock()
	return streams.m[id].write
}

// StreamText is the whole of what stream id writes: `http.bodyOf`, for tests.
func StreamText(c *Ctx, id int64) string {
	s := peekStream(id)
	if s == nil {
		return ""
	}
	var out strings.Builder
	s(c, func(x string) { out.WriteString(x) })
	return out.String()
}

// Pieces is a stream of the given pieces: `http.streamed`, for tests.
func Pieces(pieces []string) func(*Ctx, func(string)) {
	return func(c *Ctx, each func(string)) {
		for _, p := range pieces {
			each(p)
		}
	}
}

// pullPieces reads pieces one at a time.
func pullPieces(pieces []string) Pull {
	var mu sync.Mutex
	i := 0
	return func(c *Ctx, n int64) ([]byte, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		if i >= len(pieces) {
			return nil, false, nil
		}
		i++
		return []byte(pieces[i-1]), true, nil
	}
}

// ErrText is an Err's value as text: a string as it is, anything else as Candor writes it.
func ErrText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return Show(v)
}

// routed is whether method and path match one of patterns, written as for `http.route`: a
// method and a path, or a path alone, where `{name}` matches one non-empty part.
func routed(patterns []string, method, path string) bool {
	for _, p := range patterns {
		want := p
		if m, rest, ok := strings.Cut(p, " "); ok {
			if m != method {
				continue
			}
			want = rest
		}
		ws, gs := strings.Split(want, "/"), strings.Split(path, "/")
		if len(ws) != len(gs) {
			continue
		}
		match := true
		for i, w := range ws {
			param := strings.HasPrefix(w, "{") && strings.HasSuffix(w, "}")
			if (param && gs[i] == "") || (!param && w != gs[i]) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// firsts keeps the first value of each key, in sorted order since Go's maps have none. Header
// names are lowercased: Go's are canonical (`Content-Type`), Candor's `content-type`.
func firsts(vs map[string][]string, lower bool) Map[string, string] {
	keys := make([]string, 0, len(vs))
	for k := range vs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var m Map[string, string]
	for _, k := range keys {
		if v := vs[k]; len(v) > 0 {
			if lower {
				k = strings.ToLower(k)
			}
			m.Set(k, v[0])
		}
	}
	m.Share()
	return m
}

// repeats is every value of the keys given more than once, as firsts has them; nil if none was.
func repeats(vs map[string][]string, lower bool) Map[string, []string] {
	var m Map[string, []string]
	keys := make([]string, 0, len(vs))
	for k, v := range vs {
		if len(v) > 1 {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		name := k
		if lower {
			name = strings.ToLower(k)
		}
		m.Set(name, vs[k])
	}
	m.Share()
	return m
}
