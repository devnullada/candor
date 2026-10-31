// Package candor is the runtime for programs compiled by the Candor compiler.
//
// Each effect a Candor function declares with `uses` is an interface here, with a real
// implementation for production and a fake one for tests. Every effect method takes the
// caller's *Ctx first: each call is a place where a cancelled task stops.
package candor

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

// IO is the `io` effect: standard output, and reading standard input.
type IO interface {
	Println(c *Ctx, s string)
	Print(c *Ctx, s string)
	// Eprintln and Eprint write to standard error.
	Eprintln(c *Ctx, s string)
	Eprint(c *Ctx, s string)
	// ReadLine gives the next line without its line ending, and false at the end of input.
	// Candor: `io.readLine() -> string?`.
	ReadLine(c *Ctx) (string, bool)
	// ReadAll gives the rest of the input. Candor: `io.readAll() -> string`.
	ReadAll(c *Ctx) string
}

// StdIO returns the real `io` effect, backed by stdout.
func StdIO() IO { return stdIO{} }

type stdIO struct{}

func (stdIO) Println(c *Ctx, s string) {
	c.point()
	fmt.Fprintln(os.Stdout, s)
}

func (stdIO) Print(c *Ctx, s string) {
	c.point()
	fmt.Fprint(os.Stdout, s)
}

func (stdIO) Eprintln(c *Ctx, s string) {
	c.point()
	fmt.Fprintln(os.Stderr, s)
}

func (stdIO) Eprint(c *Ctx, s string) {
	c.point()
	fmt.Fprint(os.Stderr, s)
}

// One reader for the process, so a readLine after readAll (or the reverse) loses nothing. A read
// that blocks is not cancellable.
var stdin = bufio.NewReader(os.Stdin)

func (stdIO) ReadLine(c *Ctx) (string, bool) {
	c.point()
	return readLine(stdin)
}

func (stdIO) ReadAll(c *Ctx) string {
	c.point()
	b, _ := io.ReadAll(stdin)
	return string(b)
}

func readLine(r *bufio.Reader) (string, bool) {
	line, err := r.ReadString('\n')
	if err != nil && line == "" {
		return "", false
	}
	line = strings.TrimSuffix(line, "\n")
	return strings.TrimSuffix(line, "\r"), true
}

// RecordingIO is the fake `io` effect: it captures output instead of printing it, and reads
// the input a test gives it (none, until `io.setInput`). Tests run one task at a time, so it
// needs no lock.
type RecordingIO struct {
	out, err strings.Builder
	in       *bufio.Reader
}

func (r *RecordingIO) Eprintln(c *Ctx, s string) {
	c.point()
	r.err.WriteString(s + "\n")
}

func (r *RecordingIO) Eprint(c *Ctx, s string) {
	c.point()
	r.err.WriteString(s)
}

// ErrorOutput is everything written to stderr so far. Candor: `io.errorOutput()`, in tests only.
func (r *RecordingIO) ErrorOutput(c *Ctx) string {
	c.point()
	return r.err.String()
}

func (r *RecordingIO) ReadLine(c *Ctx) (string, bool) {
	c.point()
	if r.in == nil {
		return "", false
	}
	return readLine(r.in)
}

func (r *RecordingIO) ReadAll(c *Ctx) string {
	c.point()
	if r.in == nil {
		return ""
	}
	b, _ := io.ReadAll(r.in)
	return string(b)
}

// SetInput replaces what is left to read. Candor: `io.setInput(text)`, in tests only.
func (r *RecordingIO) SetInput(c *Ctx, s string) {
	c.point()
	r.in = bufio.NewReader(strings.NewReader(s))
}

func (r *RecordingIO) Println(c *Ctx, s string) {
	c.point()
	r.out.WriteString(s + "\n")
}

func (r *RecordingIO) Print(c *Ctx, s string) {
	c.point()
	r.out.WriteString(s)
}

// Output is everything printed so far. Candor: `io.output()`, in tests only.
func (r *RecordingIO) Output(c *Ctx) string {
	c.point()
	return r.out.String()
}
