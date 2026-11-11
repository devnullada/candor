// Package execgo is the Go under std/exec.candor: running a program, its output read a line at a
// time while it runs. A process crosses into Candor as an id in a table here, since bindings
// pass ints, strings and lists of strings.
package execgo

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type proc struct {
	cmd   *exec.Cmd
	lines chan string
	done  chan struct{}
	// Piped: stdout read as bytes, stdin written while it runs, stderr kept whole.
	out     io.ReadCloser
	in      io.WriteCloser
	stderr  *lockedBuffer
	inMu    sync.Mutex
	refused bool
	// A cancel waits for it to end (withStop): Next blocks until the signal and grace have run.
	graceful bool
	waited   sync.Once
	code     int64
}

var (
	mu    sync.Mutex
	procs = map[int64]*proc{}
	next  int64
)

// Start runs program, told it was run as argv0 unless that is "", with args in dir ("" for the current one), env added to this process's
// own as name, value pairs, and stdin from text (stdinKind 1: its bytes as they are) or the
// file at path (2), or a pipe that WriteIn writes to (3). The process is killed if ctx is
// cancelled: the task that started it was. With group 1 it gets a process group of its own and
// a cancel reaches the whole group; with stopSignal 0 to 4 (see sigs) a cancel sends that signal
// first and kills graceMs later. With piped 1 its stdout is read as bytes with ReadOut and its
// stderr kept for Stderr; with 0 both come a line at a time from Next.
func Start(ctx context.Context, program string, argv0 string, args []string, dir string, env []string, stdinKind int64, text string, path string, group int64, stopSignal int64, graceMs int64, piped int64) (int64, error) {
	cmd := exec.CommandContext(ctx, program, args...)
	if argv0 != "" {
		cmd.Args[0] = argv0
	}
	cmd.Dir = dir
	// After a kill, give the pipes 2 s to drain rather than wait on a grandchild holding them.
	cmd.WaitDelay = 2 * time.Second
	if group != 0 {
		ownGroup(cmd)
	}
	if group != 0 || stopSignal >= 0 {
		grace := time.Duration(0)
		if stopSignal >= 0 {
			grace = time.Duration(max(graceMs, 0)) * time.Millisecond
		}
		cmd.Cancel = func() error {
			err := signal(cmd, group != 0, stopSignal)
			if stopSignal >= 0 {
				time.AfterFunc(grace, func() { signal(cmd, group != 0, -1) })
			}
			return err
		}
		// Go kills the process itself (not its group) if it outlasts this.
		cmd.WaitDelay = grace + 2*time.Second
	}
	if len(env) > 0 {
		cmd.Env = os.Environ()
		for i := 0; i+1 < len(env); i += 2 {
			cmd.Env = append(cmd.Env, env[i]+"="+env[i+1])
		}
	}
	switch stdinKind {
	case 1:
		cmd.Stdin = strings.NewReader(text)
	case 2:
		f, err := os.Open(path)
		if err != nil {
			return 0, err
		}
		cmd.Stdin = f
		defer f.Close()
	}
	if piped != 0 {
		return startPiped(ctx, cmd, stdinKind == 3, stopSignal >= 0)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	p := &proc{cmd: cmd, lines: make(chan string, 64), done: make(chan struct{}), graceful: stopSignal >= 0}
	var readers sync.WaitGroup
	readers.Add(2)
	go read(stdout, "o", p.lines, &readers)
	go read(stderr, "e", p.lines, &readers)
	go func() {
		readers.Wait()
		close(p.lines)
	}()
	mu.Lock()
	next++
	id := next
	procs[id] = p
	mu.Unlock()
	return id, nil
}

// startPiped starts cmd with its stdout a pipe for ReadOut, stdin one for WriteIn if pipeIn,
// and stderr kept in memory.
func startPiped(ctx context.Context, cmd *exec.Cmd, pipeIn bool, graceful bool) (int64, error) {
	p := &proc{cmd: cmd, stderr: &lockedBuffer{}, graceful: graceful}
	cmd.Stderr = p.stderr
	var err error
	if pipeIn {
		if p.in, err = cmd.StdinPipe(); err != nil {
			return 0, err
		}
	}
	if p.out, err = cmd.StdoutPipe(); err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	// A cancel stops the program, which closes its stdout; one it started may hold it open, so
	// stop reading once the program has had its grace (WaitDelay) to end.
	delay := cmd.WaitDelay
	context.AfterFunc(ctx, func() { time.AfterFunc(delay, func() { p.out.Close() }) })
	mu.Lock()
	next++
	id := next
	procs[id] = p
	mu.Unlock()
	return id, nil
}

func lookup(id int64) *proc {
	mu.Lock()
	defer mu.Unlock()
	return procs[id]
}

// ReadOut reads up to n bytes of a piped process's stdout (64 KiB below 1, at most 16 MiB):
// "o" then the bytes, "" at its end, or "e" then why it failed.
func ReadOut(ctx context.Context, id int64, n int64) string {
	p := lookup(id)
	if p == nil || p.out == nil {
		return "e" + "the program's output was closed"
	}
	if err := ctx.Err(); err != nil {
		return "e" + "cancelled"
	}
	if n < 1 {
		n = 64 * 1024
	}
	buf := make([]byte, min(n, 16<<20))
	for {
		k, err := p.out.Read(buf)
		if k > 0 {
			return "o" + string(buf[:k])
		}
		if err == io.EOF {
			return ""
		}
		if err != nil {
			if ctx.Err() != nil {
				return "e" + "cancelled"
			}
			if errors.Is(err, os.ErrClosed) {
				return "e" + "the program's output was closed"
			}
			return "e" + err.Error()
		}
	}
}

// CloseOut stops reading a piped process's stdout: a program still printing gets a broken pipe.
func CloseOut(id int64) {
	if p := lookup(id); p != nil && p.out != nil {
		p.out.Close()
	}
}

// WriteIn writes data to a piped process's stdin: "" once written, else why not. A program that
// has closed its stdin or ended refuses it, and Refused says so from then on.
func WriteIn(id int64, data string) string {
	p := lookup(id)
	if p == nil || p.in == nil {
		return "the program's input was closed"
	}
	p.inMu.Lock()
	defer p.inMu.Unlock()
	if _, err := io.WriteString(p.in, data); err != nil {
		p.refused = true
		return "the program stopped reading its input: " + err.Error()
	}
	return ""
}

// CloseIn ends a piped process's stdin: it reads its end.
func CloseIn(id int64) {
	if p := lookup(id); p != nil && p.in != nil {
		p.inMu.Lock()
		defer p.inMu.Unlock()
		p.in.Close()
	}
}

// Refused is whether a write to the process's stdin failed because it stopped reading.
func Refused(id int64) bool {
	if p := lookup(id); p != nil {
		p.inMu.Lock()
		defer p.inMu.Unlock()
		return p.refused
	}
	return false
}

// Stderr is what a piped process printed on stderr, and forgets it: called after Wait, when it
// is whole.
func Stderr(id int64) string {
	mu.Lock()
	p := procs[id]
	delete(procs, id)
	mu.Unlock()
	if p != nil && p.stderr != nil {
		return p.stderr.String()
	}
	return ""
}

// lockedBuffer is a bytes.Buffer that Go's copying goroutine and Stderr may share.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// read sends each line of r, prefixed with which stream it came from, with its line ending
// (none on a last line printed without one).
func read(r io.Reader, prefix string, lines chan<- string, wg *sync.WaitGroup) {
	defer wg.Done()
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 64*1024), 16<<20)
	s.Split(withEndings)
	for s.Scan() {
		lines <- prefix + s.Text()
	}
}

// withEndings is bufio.ScanLines keeping the "\n" (and a "\r" before it).
func withEndings(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return i + 1, data[:i+1], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// Next is the process's next line, "o" or "e" then the text, or "" when both streams have ended
// (or ctx is cancelled).
func Next(ctx context.Context, id int64) string {
	mu.Lock()
	p := procs[id]
	mu.Unlock()
	if p == nil {
		return ""
	}
	select {
	case line, ok := <-p.lines:
		if !ok {
			return ""
		}
		return line
	case <-ctx.Done():
		if p.graceful {
			// The task is ending: let the program stop as withStop said before it does.
			go func() {
				for range p.lines {
				}
			}()
			p.wait()
		}
		return ""
	}
}

// Wait waits for the process to end and forgets it: its exit code, or -1 if it was killed or
// never gave one. A piped one is forgotten by Stderr, which comes after.
func Wait(id int64) int64 {
	mu.Lock()
	p := procs[id]
	if p == nil || p.stderr == nil {
		delete(procs, id)
	}
	mu.Unlock()
	if p == nil {
		return -1
	}
	if p.lines != nil {
		for range p.lines {
		}
	}
	return p.wait()
}

// wait waits for the process to end, once: its exit code, or -1 if it was killed.
func (p *proc) wait() int64 {
	p.waited.Do(func() {
		p.code = -1
		err := p.cmd.Wait()
		var exit *exec.ExitError
		if err == nil {
			p.code = 0
		} else if errors.As(err, &exit) {
			p.code = int64(exit.ExitCode())
		}
	})
	return p.code
}

// IsNotFound is whether err is the program not being found: an *exec.Error is a failed look-up
// of the program, where a missing directory or stdin file is an *fs.PathError.
func IsNotFound(err error) bool {
	var lookup *exec.Error
	return errors.As(err, &lookup)
}
