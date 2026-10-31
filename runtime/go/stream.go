package candor

import (
	"bufio"
	"io"
	"strings"
	"sync"
)

// Readers and writers (#6ea8241a) are Candor functions: a reader `fn(int) -> Result<Bytes?,
// string>` gives up to n bytes, none at the end; a writer `fn(Bytes) -> Result<void, string>`
// takes a piece. The emitter converts them to and from Pull and Push.

// Pull is a reader seen from Go: up to n bytes, more false at the end, or why it failed.
type Pull func(c *Ctx, n int64) (b []byte, more bool, err error)

// Push is a writer seen from Go: nil once it took b.
type Push func(c *Ctx, b []byte) error

// StreamErr is a reader's or a writer's error text, which is what Candor sees.
type StreamErr string

func (e StreamErr) Error() string { return string(e) }

// pullSize is what a read asks for when its caller asks for less than a byte.
const pullSize = 64 * 1024

// pullN is how much a read of n takes: below 1 a buffer's worth, and at most 16 MiB at once.
func pullN(n int64) int {
	if n < 1 {
		return pullSize
	}
	return int(min(n, 16<<20))
}

// PullBytes reads b, a piece at a time.
func PullBytes(b []byte) Pull {
	var mu sync.Mutex
	pos := 0
	return func(c *Ctx, n int64) ([]byte, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		if pos >= len(b) {
			return nil, false, nil
		}
		k := min(pullN(n), len(b)-pos)
		piece := b[pos : pos+k : pos+k]
		pos += k
		return piece, true, nil
	}
}

// Collect gives use a writer that keeps what it is given, and returns that.
func Collect(use func(w Push)) []byte {
	var mu sync.Mutex
	out := []byte{}
	use(func(c *Ctx, b []byte) error {
		mu.Lock()
		out = append(out, b...)
		mu.Unlock()
		return nil
	})
	mu.Lock()
	defer mu.Unlock()
	return out[:len(out):len(out)]
}

// ReadAll reads r to its end.
func ReadAll(c *Ctx, r Pull) ([]byte, error) {
	out := []byte{}
	for {
		b, more, err := r(c, pullSize)
		if err != nil {
			return nil, err
		}
		if !more {
			return out[:len(out):len(out)], nil
		}
		out = append(out, b...)
	}
}

// Copy writes everything r gives to w, and says how many bytes that was.
func Copy(c *Ctx, r Pull, w Push) (int64, error) {
	var n int64
	for {
		b, more, err := r(c, pullSize)
		if err != nil {
			return n, err
		}
		if !more {
			return n, nil
		}
		if len(b) == 0 {
			continue
		}
		if err := w(c, b); err != nil {
			return n, err
		}
		n += int64(len(b))
	}
}

// ReadLines calls each with every line r gives, without its line ending (`\n` or `\r\n`), as
// FS.ReadLines does.
func ReadLines(c *Ctx, r Pull, each func(*Ctx, string)) error {
	src := &pullReader{c: c, pull: r}
	sc := bufio.NewScanner(src)
	sc.Buffer(make([]byte, 64*1024), 1<<30)
	for sc.Scan() {
		each(c, strings.TrimSuffix(sc.Text(), "\r"))
	}
	if src.err != nil {
		return src.err
	}
	if err := sc.Err(); err != nil {
		return StreamErr(err.Error())
	}
	return nil
}

// PullReader is r as an io.Reader, for std's Go packages (xmlgo). A reader's own error comes
// back from Read as a StreamErr.
func PullReader(c *Ctx, r Pull) io.Reader {
	return &pullReader{c: c, pull: r}
}

// pullReader is a Pull as an io.Reader. A Candor reader may give more than was asked for, so
// what didn't fit waits for the next Read.
type pullReader struct {
	c    *Ctx
	pull Pull
	rest []byte
	err  error
}

func (p *pullReader) Read(buf []byte) (int, error) {
	for len(p.rest) == 0 {
		b, more, err := p.pull(p.c, int64(len(buf)))
		if err != nil {
			p.err = err
			return 0, err
		}
		if !more {
			return 0, io.EOF
		}
		p.rest = b
	}
	n := copy(buf, p.rest)
	p.rest = p.rest[n:]
	return n, nil
}
