package candor

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// A panic names Candor lines. The generated Go carries `//line` directives, so Go's own frames
// already point at Candor files; what is left is to show only those, named as Candor names
// them, and to keep them across tasks: a task's stack is gone by the time its scope re-raises
// the crash, so the frames are taken where the panic is first recovered.

// Frame is one Candor function on the stack.
type Frame struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Fn   string `json:"fn"`
}

// crash is a panic on its way up: what it was, and the Candor frames of every task it crossed,
// innermost first.
type crash struct {
	value  any
	traces [][]Frame
}

// Error makes Go's own panic output readable when CANDOR_TRACE=go leaves the crash to Go.
func (c *crash) Error() string { return message(c.value) + trace(c.traces) }

// crashOf wraps what recover gave with this goroutine's Candor frames. A cancellation is not a
// crash and passes through, as does nil. A crash that already has frames gains this goroutine's,
// unless it has them already: re-raised on the goroutine it came from, the stack below is the
// same.
func crashOf(p any) any {
	if p == nil {
		return nil
	}
	if _, ok := p.(cancelled); ok {
		return p
	}
	here := frames()
	c, ok := p.(*crash)
	if !ok {
		return &crash{value: p, traces: [][]Frame{here}}
	}
	if last := c.traces[len(c.traces)-1]; !endsWith(last, here) {
		c.traces = append(c.traces, here)
	}
	return c
}

// asCrash is crashOf for a panic that reached the top: a cancellation there is a bug, but is
// still reported.
func asCrash(p any) *crash {
	if c, ok := crashOf(p).(*crash); ok {
		return c
	}
	return &crash{value: p, traces: [][]Frame{frames()}}
}

// unwrap is the value a crash carries; anything else as is.
func unwrap(p any) any {
	if c, ok := p.(*crash); ok {
		return c.value
	}
	return p
}

func endsWith(xs, tail []Frame) bool {
	if len(tail) > len(xs) {
		return false
	}
	for i, f := range tail {
		if xs[len(xs)-len(tail)+i] != f {
			return false
		}
	}
	return true
}

// frames is the Candor functions on this goroutine's stack, innermost first.
func frames() []Frame {
	pcs := make([]uintptr, 64)
	n := runtime.Callers(2, pcs)
	for n == len(pcs) {
		pcs = make([]uintptr, 2*len(pcs))
		n = runtime.Callers(2, pcs)
	}
	var out []Frame
	fr := runtime.CallersFrames(pcs[:n])
	for {
		f, more := fr.Next()
		if strings.HasSuffix(f.File, ".candor") {
			out = append(out, Frame{File: f.File, Line: f.Line, Fn: candorName(f.Function)})
		}
		if !more {
			return out
		}
	}
}

// candorName turns a generated Go function's name into Candor's: `main.shop__total` is
// `total`, and so is a closure in it, `main.shop__total.func1`; `main.(*fx__kv__real).Get` is
// the operation `get`; `main.Show__for__shop__Point.show` is `show`; `main.test__3` is the
// test running.
func candorName(goName string) string {
	name := strings.TrimPrefix(goName, "main.")
	name = strings.ReplaceAll(name, "[...]", "")
	if rest, ok := strings.CutPrefix(name, "(*"); ok {
		recv, m, _ := strings.Cut(rest, ").")
		return methodName(recv, m)
	}
	first, rest, hasDot := strings.Cut(name, ".")
	if hasDot && (strings.Contains(first, "__for__") || strings.HasSuffix(first, "__real") || strings.HasSuffix(first, "__fake")) {
		return methodName(first, rest)
	}
	if strings.HasPrefix(first, "test__") {
		return "test " + strconv.Quote(currentTest)
	}
	if fx, ok := strings.CutPrefix(first, "fx__"); ok {
		// `fx__kv__newReal`: the effect's state being set up.
		fx, _, _ = strings.Cut(fx, "__")
		return "effect " + fx
	}
	if _, fn, ok := strings.Cut(first, "__"); ok {
		return fn
	}
	return first
}

// methodName: the method up to its first `.` (closures in it follow). An effect's operation is
// exported in Go; a name Go reserves carries a `__` suffix.
func methodName(recv, m string) string {
	m, _, _ = strings.Cut(m, ".")
	m = strings.TrimSuffix(m, "__")
	if strings.HasSuffix(recv, "__real") || strings.HasSuffix(recv, "__fake") {
		return strings.ToLower(m[:1]) + m[1:]
	}
	return m
}

// trace renders every segment, each frame on its own line, and announces each task boundary.
func trace(traces [][]Frame) string {
	var b strings.Builder
	first := true
	for _, seg := range traces {
		if len(seg) == 0 {
			continue
		}
		if !first {
			b.WriteString("\nin a task of the scope at")
		}
		first = false
		for _, f := range seg {
			fmt.Fprintf(&b, "\n  at %s:%d in %s", rel(f.File), f.Line, f.Fn)
		}
	}
	return b.String()
}

// relTraces is the non-empty segments, each file named as the command line would.
func relTraces(traces [][]Frame) [][]Frame {
	out := [][]Frame{}
	for _, seg := range traces {
		if len(seg) == 0 {
			continue
		}
		fs := make([]Frame, len(seg))
		for i, f := range seg {
			fs[i] = Frame{rel(f.File), f.Line, f.Fn}
		}
		out = append(out, fs)
	}
	return out
}

// rel names a file as the command line would, relative to the working directory when it is
// under it.
func rel(file string) string {
	if cwd, err := os.Getwd(); err == nil {
		if r, err := filepath.Rel(cwd, filepath.FromSlash(file)); err == nil && !strings.HasPrefix(r, "..") {
			return filepath.ToSlash(r)
		}
	}
	return file
}

// message is a panic's value as a report says it: Go's runtime errors without their prefix.
func message(p any) string {
	switch x := p.(type) {
	case runtime.Error:
		return strings.TrimPrefix(x.Error(), "runtime error: ")
	case *crash:
		return message(x.value)
	case *assertion:
		if x.contract() {
			return broken(x) + ": " + x.source
		}
		return "assert failed: " + x.source
	case error:
		return x.Error()
	case string:
		return x
	}
	return fmt.Sprint(p)
}

// Where reports go and how the program ends; tests swap them.
var (
	stderr io.Writer = os.Stderr
	exit             = os.Exit
)

// ExitErr ends the program when `main` returns an `Err`: the error on stderr (a string as it is,
// anything else as tests show it), and status 1.
func ExitErr(err any) {
	if s, ok := err.(string); ok {
		fmt.Fprintln(stderr, s)
	} else {
		fmt.Fprintln(stderr, Show(err))
	}
	exit(1)
}

// ExitWith ends the program when `main` returns `Err(Exit { status, message })`: the message on
// stderr (a newline added if it has none, nothing if it is empty), then the status. A status
// outside 0 to 125 (126 and up mean "not run" or a signal to a shell) exits 1 and says so.
func ExitWith(status int, message string) {
	if message != "" {
		if !strings.HasSuffix(message, "\n") {
			message += "\n"
		}
		fmt.Fprint(stderr, message)
	}
	if status < 0 || status > 125 {
		fmt.Fprintf(stderr, "exit status %d is outside 0 to 125; exiting with 1\n", status)
		status = 1
	}
	exit(status)
}

// goTrace says whether CANDOR_TRACE=go asks for Go's own panic output instead of Candor's.
func goTrace() bool { return os.Getenv("CANDOR_TRACE") == "go" }

// Report is deferred by the generated `main`. A panic that reaches it is printed as Candor sees
// it, the message then the Candor frames, and the program exits with status 2, as a Go panic
// would. CANDOR_TRACE=go leaves the panic to Go, for debugging the compiler.
func Report() {
	if goTrace() {
		return
	}
	p := recover()
	if p == nil {
		return
	}
	c := asCrash(p)
	if a, ok := c.value.(*assertion); ok && a.contract() {
		// A broken contract shows its diagram, as a failed `assert` does in a test.
		fmt.Fprintf(stderr, "panic: %s\n\n%s%s\n", broken(a), indent(diagram(a)), trace(c.traces))
	} else {
		fmt.Fprintf(stderr, "panic: %s%s\n", message(c.value), trace(c.traces))
	}
	exit(2)
}
