package candor

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Gzip is b compressed with gzip, at the default level.
func Gzip(b []byte) []byte {
	var out bytes.Buffer
	w := gzip.NewWriter(&out)
	w.Write(b)
	w.Close()
	return out.Bytes()
}

// Gunzip is b uncompressed, and false if b isn't gzip (or is cut short). Several gzip members
// one after another come out as one.
func Gunzip(b []byte) ([]byte, bool) {
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, false
	}
	out, err := io.ReadAll(r)
	if err != nil {
		return nil, false
	}
	if out == nil {
		out = []byte{}
	}
	return out, true
}

// minGzip is the smallest body `serve` gzips: below it the gzip header and footer cost more
// than they save.
const minGzip = 1024

// Compressible is whether a body of contentType is text that gzip shrinks: text (but not an
// event stream, which goes out an event at a time), JSON, JavaScript, XML, SVG, wasm.
func Compressible(contentType string) bool {
	mt, _, _ := strings.Cut(contentType, ";")
	mt = strings.ToLower(strings.TrimSpace(mt))
	switch mt {
	case "text/event-stream", "":
		return false
	case "application/json", "application/javascript", "application/x-javascript", "application/xml",
		"application/wasm", "image/svg+xml":
		return true
	}
	return strings.HasPrefix(mt, "text/") || strings.HasSuffix(mt, "+json") || strings.HasSuffix(mt, "+xml")
}

// AcceptsGzip is whether Accept-Encoding values take gzip: named (or `*`) without `q=0`.
func AcceptsGzip(values []string) bool {
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			name, params, _ := strings.Cut(part, ";")
			name = strings.ToLower(strings.TrimSpace(name))
			if name != "gzip" && name != "*" {
				continue
			}
			q, ok := strings.CutPrefix(strings.ReplaceAll(strings.ToLower(params), " ", ""), "q=")
			if !ok {
				return true
			}
			if f, err := strconv.ParseFloat(q, 64); err != nil || f > 0 {
				return true
			}
		}
	}
	return false
}

// gzipWriter is how `serve` gzips: it decides at the status, from the headers set by then,
// whether the body goes out gzipped, and says so in Content-Encoding and Vary.
type gzipWriter struct {
	http.ResponseWriter
	r       *http.Request
	decided bool
	on      bool
	gz      *gzip.Writer
}

func (g *gzipWriter) WriteHeader(status int) {
	if !g.decided {
		g.decided = true
		g.on = gzipping(g.Header(), status, g.r.Header.Values("Accept-Encoding"))
		if g.on {
			g.Header().Del("Content-Length")
		}
	}
	g.ResponseWriter.WriteHeader(status)
}

// gzipping is whether a response with headers h and status goes out gzipped to a client that
// sent accept: a compressible type, not ranged, not encoded already, not known to be small. It
// adds Vary and Content-Encoding to h when the type is one gzip applies to.
func gzipping(h http.Header, status int, accept []string) bool {
	if status < 200 || status == 204 || status == 206 || status == 304 {
		return false
	}
	if h.Get("Content-Encoding") != "" || h.Get("Content-Range") != "" || !Compressible(h.Get("Content-Type")) {
		return false
	}
	if !strings.Contains(strings.ToLower(strings.Join(h.Values("Vary"), ",")), "accept-encoding") {
		h.Add("Vary", "Accept-Encoding")
	}
	if n, err := strconv.ParseInt(h.Get("Content-Length"), 10, 64); err == nil && n < minGzip {
		return false
	}
	if !AcceptsGzip(accept) {
		return false
	}
	h.Set("Content-Encoding", "gzip")
	return true
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.decided {
		g.WriteHeader(http.StatusOK)
	}
	if !g.on {
		return g.ResponseWriter.Write(b)
	}
	if g.gz == nil {
		g.gz = gzip.NewWriter(g.ResponseWriter)
	}
	return g.gz.Write(b)
}

// Flush sends what is written so far, gzipped as far as it goes: a streamed body's pieces still
// go out as they are written.
func (g *gzipWriter) Flush() {
	if g.gz != nil {
		g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ReadFrom keeps the server's sendfile path for a file that isn't gzipped.
func (g *gzipWriter) ReadFrom(r io.Reader) (int64, error) {
	if rf, ok := g.ResponseWriter.(io.ReaderFrom); ok && g.decided && !g.on {
		return rf.ReadFrom(r)
	}
	return io.Copy(struct{ io.Writer }{g}, r)
}

func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

// close ends the gzip stream; a gzipped body nothing was written to is an empty gzip stream,
// except for HEAD, which has no body.
func (g *gzipWriter) close() {
	if !g.on {
		return
	}
	if g.gz == nil && g.r.Method != http.MethodHead {
		g.gz = gzip.NewWriter(g.ResponseWriter)
	}
	if g.gz != nil {
		g.gz.Close()
	}
}

// ServedGzip is `http.served` gzipping res as `serve` would for a request with headers (and
// every value of those in all), its body in body or (streamed) the stream id: the headers
// (with Vary for a type gzip applies to) and body, and whether it gzipped. A streamed body is
// read whole first, but only when it would be gzipped, so an event stream isn't.
func ServedGzip(c *Ctx, method string, headers Map[string, string], all Map[string, []string], status int64, resHeaders Map[string, string], body string, streamed bool, id int64) (Map[string, string], string, bool) {
	accept := []string{}
	if vs, ok := all.Get("accept-encoding"); ok {
		accept = vs
	} else if v, ok := headers.Get("accept-encoding"); ok {
		accept = []string{v}
	}
	h := http.Header{}
	for _, e := range resHeaders.Entries() {
		h.Set(e.Key, e.Value)
	}
	if !streamed && h.Get("Content-Length") == "" {
		h.Set("Content-Length", strconv.Itoa(len(body)))
	}
	on := gzipping(h, int(status), accept)
	out := resHeaders
	if vary := strings.Join(h.Values("Vary"), ", "); vary != "" {
		out.SetCopy("vary", vary)
	}
	if !on {
		return out, body, false
	}
	if streamed {
		body = StreamText(c, id)
	}
	out.SetCopy("content-encoding", "gzip")
	out.RemoveCopy("content-length")
	if method == http.MethodHead {
		return out, "", true
	}
	return out, string(Gzip([]byte(body))), true
}

// Ungzip makes res's body read uncompressed when it came gzipped and Go's transport didn't
// undo it (the request asked for gzip itself): the client's bodies are always the content.
func Ungzip(res *http.Response) error {
	if res.Uncompressed || !strings.EqualFold(res.Header.Get("Content-Encoding"), "gzip") {
		return nil
	}
	peek := make([]byte, 1)
	n, err := io.ReadFull(res.Body, peek)
	if n == 0 {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil
		}
		return err
	}
	zr, err := gzip.NewReader(io.MultiReader(bytes.NewReader(peek), res.Body))
	if err != nil {
		return err
	}
	res.Body = struct {
		io.Reader
		io.Closer
	}{zr, res.Body}
	res.Header.Del("Content-Encoding")
	res.Header.Del("Content-Length")
	res.ContentLength = -1
	res.Uncompressed = true
	return nil
}
