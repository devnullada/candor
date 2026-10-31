// Package httpclient is the Go under `http.send`, the client in std/http.candor. Headers cross
// as flat name, value lists: bindings pass ints, strings, bools and lists of strings.
package httpclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	candor "candor.dev/runtime"
)

// maxBody is the largest response body read; past it the request fails rather than hold an
// unbounded body in memory.
const maxBody = 16 << 20

// Reply is a response, read whole, or (from OpenStream) with its body unread.
type Reply struct {
	status  int64
	headers []string
	more    []string
	body    string
	stream  int64
	url     string
}

func (r *Reply) Status() int64     { return r.status }
func (r *Reply) URL() string       { return r.url }
func (r *Reply) Headers() []string { return r.headers }
func (r *Reply) More() []string    { return r.more }
func (r *Reply) Body() string      { return r.body }
func (r *Reply) Stream() int64     { return r.stream }

// defaultRedirects is how many redirects a request follows when it doesn't say; one more is an
// error, as a loop would be.
const defaultRedirects = 10

var clients sync.Map

// plain is the transport for requests that don't ask for gzip (`compressed: false`): Go's
// default otherwise, with its own connections.
var plain = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DisableCompression = true
	return t
}()

type clientKey struct {
	redirects  int64
	compressed bool
}

// clientFor follows up to redirects redirects (-1: up to defaultRedirects, then fails), then
// gives the last response, its location unfollowed; compressed false asks for no gzip. One
// client per limit and switch, so connections are shared.
func clientFor(redirects int64, compressed bool) *http.Client {
	key := clientKey{redirects, compressed}
	if c, ok := clients.Load(key); ok {
		return c.(*http.Client)
	}
	var transport http.RoundTripper
	if !compressed {
		transport = plain
	}
	c := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if redirects < 0 {
			if len(via) > defaultRedirects {
				return fmt.Errorf("stopped after %d redirects", defaultRedirects)
			}
			return nil
		}
		if int64(len(via)) > redirects {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	got, _ := clients.LoadOrStore(key, c)
	return got.(*http.Client)
}

// newRequest is the request Send and OpenStream make: a `host` header becomes the Host sent (Go
// ignores it among the headers), and keepAlive false closes the connection after it.
func newRequest(ctx context.Context, method, target string, headers, more []string, body string, keepAlive bool) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	setHeaders(req.Header, headers, more)
	if h := req.Header.Get("Host"); h != "" {
		req.Host = h
		req.Header.Del("Host")
	}
	req.Close = !keepAlive
	return req, nil
}

// checkTimeout refuses a negative timeoutMs; 0 is no timeout.
func checkTimeout(timeoutMs int64) error {
	if timeoutMs < 0 {
		return fmt.Errorf("timeoutMs is %d: give it a positive number of milliseconds, or 0 for no timeout", timeoutMs)
	}
	return nil
}

// Send makes one request and reads the whole response, or fails: a bad URL, no connection, no
// answer within timeoutMs (0: no limit), too many redirects, or ctx cancelled (the task was).
//
// A gzipped body is read uncompressed (by Go's transport, or by Ungzip when the request asked
// for gzip itself), its content-encoding gone, so a body is always the content.
func Send(ctx context.Context, method, target string, headers []string, more []string, body string, timeoutMs int64, redirects int64, compressed, keepAlive bool) (*Reply, error) {
	if err := checkTimeout(timeoutMs); err != nil {
		return nil, err
	}
	if timeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()
	}
	req, err := newRequest(ctx, method, target, headers, more, body, keepAlive)
	if err != nil {
		return nil, err
	}
	res, err := clientFor(redirects, compressed).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if err := candor.Ungzip(res); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxBody {
		return nil, fmt.Errorf("the response body is over %d bytes", maxBody)
	}
	return &Reply{status: int64(res.StatusCode), headers: firsts(res.Header), more: repeats(res.Header), body: string(b), url: res.Request.URL.String()}, nil
}

// OpenStream makes one request and gives the response with its body unread: the Reply's Stream
// is the body's id in the runtime's stream table, read a piece at a time as it arrives (by
// `http.readResponse`). timeoutMs bounds the wait for the response to start, not the body,
// which may go on for as long as the server sends; cancelling ctx (the task) ends it. 0 waits.
func OpenStream(ctx context.Context, method, target string, headers []string, more []string, body string, timeoutMs int64, redirects int64, compressed, keepAlive bool) (*Reply, error) {
	if err := checkTimeout(timeoutMs); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancelCause(ctx)
	stopped := func() bool { return true }
	if timeoutMs > 0 {
		late := time.AfterFunc(time.Duration(timeoutMs)*time.Millisecond, func() { cancel(context.DeadlineExceeded) })
		stopped = late.Stop
	}
	req, err := newRequest(ctx, method, target, headers, more, body, keepAlive)
	if err != nil {
		cancel(nil)
		return nil, err
	}
	res, err := clientFor(redirects, compressed).Do(req)
	if !stopped() && err != nil {
		err = context.DeadlineExceeded
	}
	if err == nil {
		if err = candor.Ungzip(res); err != nil {
			res.Body.Close()
		}
	}
	if err != nil {
		cancel(nil)
		return nil, err
	}
	// Closed once read to the end, or once `http.readingResponse`'s function returns.
	id := candor.PutPull(candor.ReaderPull(res.Body), func() {
		res.Body.Close()
		cancel(nil)
	})
	return &Reply{status: int64(res.StatusCode), headers: firsts(res.Header), more: repeats(res.Header), stream: id, url: res.Request.URL.String()}, nil
}

// IsTimeout is whether err is Send running out of time.
func IsTimeout(err error) bool {
	var ne net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout())
}

// firsts keeps each header's first value, names lowercased and sorted, as the server does.
func firsts(h http.Header) []string {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, 2*len(keys))
	for _, k := range keys {
		if v := h[k]; len(v) > 0 {
			out = append(out, strings.ToLower(k), v[0])
		}
	}
	return out
}

// repeats is the values after the first of each header given more than once, as flat name,
// value pairs, names lowercased and sorted.
func repeats(h http.Header) []string {
	keys := make([]string, 0, len(h))
	for k, v := range h {
		if len(v) > 1 {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var out []string
	for _, k := range keys {
		for _, v := range h[k][1:] {
			out = append(out, strings.ToLower(k), v)
		}
	}
	return out
}

// setHeaders sets each of the flat name, value pairs headers, then adds each of more.
func setHeaders(h http.Header, headers, more []string) {
	for i := 0; i+1 < len(headers); i += 2 {
		h.Set(headers[i], headers[i+1])
	}
	for i := 0; i+1 < len(more); i += 2 {
		h.Add(more[i], more[i+1])
	}
}

// Resolve is ref, a redirect's location, read against base, the URL that gave it.
func Resolve(base, ref string) string {
	b, err := url.Parse(base)
	if err != nil {
		return ref
	}
	r, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return b.ResolveReference(r).String()
}

// URLParts splits a URL as the server would see it: the path, then each query key and value,
// decoded, first value per key. A URL that doesn't parse is all path.
func URLParts(target string) []string {
	u, err := url.Parse(target)
	if err != nil {
		return []string{target}
	}
	path := u.Path
	if path == "" {
		path = "/"
	}
	q := u.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := []string{path}
	for _, k := range keys {
		out = append(out, k, q[k][0])
	}
	return out
}
