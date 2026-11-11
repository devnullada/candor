package candor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Test is one `test "name" { ... }` block. Each one builds its own fakes, so tests never share
// state, and runs on its own test scheduler.
type Test struct {
	Name string
	Fn   func(c *Ctx)
}

// Shower is implemented by generated types so failures print them as Candor values.
type Shower interface {
	Show__() string
}

// Show formats a value the way Candor source would write it.
func Show(v any) string {
	switch x := v.(type) {
	case string:
		return strconv.Quote(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return FloatString(x)
	case bool:
		return strconv.FormatBool(x)
	case rune:
		// Only a char is an int32: Candor's int is 64 bits.
		return strconv.QuoteRune(x)
	case Shower:
		return x.Show__()
	}
	// Lists, tuples and functions have no named Go type to hang a method on.
	switch rv := reflect.ValueOf(v); rv.Kind() {
	case reflect.Slice:
		items := make([]string, rv.Len())
		for i := range items {
			items[i] = Show(rv.Index(i).Interface())
		}
		return "[" + strings.Join(items, ", ") + "]"
	case reflect.Struct:
		// A tuple is an anonymous struct; `void` is the empty one.
		if rv.Type().Name() == "" {
			if rv.NumField() == 0 {
				return "void"
			}
			items := make([]string, rv.NumField())
			for i := range items {
				items[i] = Show(rv.Field(i).Interface())
			}
			return "(" + strings.Join(items, ", ") + ")"
		}
	case reflect.Func:
		return "<fn>"
	}
	return fmt.Sprint(v)
}

// Rec records the value of one part of an `assert` and passes it through unchanged.
// Parts that never ran (the right side of a short-circuited `&&`) stay empty.
func Rec[T any](values []string, i int, v T) T {
	values[i] = Show(v)
	return v
}

// assertion is what a failed `assert` panics with, and a broken contract: clause is "assert",
// "requires" or "ensures", and fn the function whose contract it is.
type assertion struct {
	clause string
	fn     string
	line   int
	source string
	cols   []int
	texts  []string
	values []string
}

// Fail reports a failed `assert`. Per recorded part: its rune offset into source, where the
// diagram's bar stands, and its own source text.
func Fail(line int, source string, cols []int, texts []string, values []string) {
	panic(&assertion{clause: "assert", line: line, source: source, cols: cols, texts: texts, values: values})
}

// Broke reports a broken `requires` or `ensures` of fn, recorded as Fail's.
func Broke(clause string, fn string, line int, source string, cols []int, texts []string, values []string) {
	panic(&assertion{clause: clause, fn: fn, line: line, source: source, cols: cols, texts: texts, values: values})
}

func (a *assertion) contract() bool { return a.clause == "requires" || a.clause == "ensures" }

// broken says whose bug a broken contract is: the caller's for a `requires`.
func broken(a *assertion) string {
	if a.clause == "requires" {
		return fmt.Sprintf("`%s` was called with arguments that break its `requires`", a.fn)
	}
	return fmt.Sprintf("`%s` returned a value that breaks its `ensures`", a.fn)
}

// testRun is one `candor test` run, as `--json` prints it.
type testRun struct {
	File     string       `json:"file"`
	Seed     int64        `json:"seed"`
	Passed   int          `json:"passed"`
	Failed   int          `json:"failed"`
	Filtered int          `json:"filtered"`
	Tests    []testResult `json:"tests"`
}

// testResult is one test's: "pass" or "fail", whether its task order or select picks drew on the
// seed, how many orders it ran in and the seed of the last (the failing one's replays it), and
// how it failed.
type testResult struct {
	Name    string   `json:"name"`
	Status  string   `json:"status"`
	Seeded  bool     `json:"seeded"`
	Runs    int      `json:"runs"`
	Seed    int64    `json:"seed"`
	Failure *failure `json:"failure,omitempty"`
}

// failure is how a test failed: an assert with its line, source and recorded parts, a broken
// contract with those and its function, or a panic with its message; the Candor frames each
// time, and the report body as a human reads it.
type failure struct {
	Kind    string // "assert", "requires", "ensures" or "panic"
	Fn      string
	Line    int
	Source  string
	Parts   []part
	Message string
	Traces  [][]Frame
	Text    string
}

// part is one recorded sub-expression of a failed assert.
type part struct {
	Col   int    `json:"col"`
	Text  string `json:"text"`
	Value string `json:"value"`
}

// MarshalJSON writes the fields of the kind only, so a reader gets a discriminated union: an
// assert always has `parts`, a panic never.
func (f *failure) MarshalJSON() ([]byte, error) {
	type rest struct {
		Traces [][]Frame `json:"traces"`
		Text   string    `json:"text"`
	}
	if f.Kind == "requires" || f.Kind == "ensures" {
		return marshal(struct {
			Kind   string `json:"kind"`
			Fn     string `json:"fn"`
			Line   int    `json:"line"`
			Source string `json:"source"`
			Parts  []part `json:"parts"`
			rest
		}{f.Kind, f.Fn, f.Line, f.Source, f.Parts, rest{f.Traces, f.Text}}, "")
	}
	if f.Kind == "assert" {
		return marshal(struct {
			Kind   string `json:"kind"`
			Line   int    `json:"line"`
			Source string `json:"source"`
			Parts  []part `json:"parts"`
			rest
		}{f.Kind, f.Line, f.Source, f.Parts, rest{f.Traces, f.Text}}, "")
	}
	return marshal(struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
		rest
	}{f.Kind, f.Message, rest{f.Traces, f.Text}}, "")
}

// marshal is JSON without HTML escaping, so `a > b` reads as written; indent as MarshalIndent.
func marshal(v any, indent string) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if indent != "" {
		enc.SetIndent("", indent)
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// defaultRuns is how many task orders a test whose order matters runs in, unless `-runs` or
// `-seed` says otherwise: a race that shows one run in three slips past all of them with odds
// of about 1 in 10^18.
const defaultRuns = 100

// options come from the command line: `-seed N`, `-runs N`, `-only text` (repeatable), `-test
// name` (the test named exactly, from `candor test file:line`) and `-json`, each with one or two
// dashes. A seed given runs one order unless runs is given too.
type options struct {
	seed  int64
	runs  int
	only  []string
	exact []string
	json  bool
}

func parseOptions(args []string) options {
	o := options{seed: time.Now().UnixNano() % 1_000_000}
	seeded := false
	for i := 0; i < len(args); i++ {
		switch strings.TrimLeft(args[i], "-") {
		case "seed":
			if i+1 < len(args) {
				if n, err := strconv.ParseInt(args[i+1], 10, 64); err == nil {
					o.seed = n
					seeded = true
				}
				i++
			}
		case "runs":
			if i+1 < len(args) {
				if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
					o.runs = n
				}
				i++
			}
		case "only":
			if i+1 < len(args) {
				o.only = append(o.only, args[i+1])
				i++
			}
		case "test":
			if i+1 < len(args) {
				o.exact = append(o.exact, args[i+1])
				i++
			}
		case "json":
			o.json = true
		}
	}
	if o.runs == 0 {
		o.runs = defaultRuns
		if seeded {
			o.runs = 1
		}
	}
	return o
}

// RunTests runs every test, prints a report and exits: 0 if all passed, 1 otherwise.
//
// Tasks run in an order picked by a seed: `-seed N` on the command line, else a fresh one each
// run. A test whose order or select picks drew on the seed runs again with the next seeds, up to
// `-runs N` orders (100 by default, 1 with `-seed`), stopping at the first failure, which prints
// the seed that replays it. `-only text` runs the tests whose name contains the text; `-json`
// prints a JSON line per test as it ends, then one with the totals.
func RunTests(file string, tests []Test) {
	o := parseOptions(os.Args[1:])
	// Whether the last line printed was blank: a failure's report ends in one.
	blank := false
	each := func(r testResult) {
		if r.Failure == nil {
			if r.Runs > 1 {
				fmt.Printf("PASS %s (%d runs)\n", r.Name, r.Runs)
			} else {
				fmt.Printf("PASS %s\n", r.Name)
			}
			blank = false
			return
		}
		// An assert's heading has its line; a panic's trace has every line.
		where := ""
		if r.Failure.Kind == "assert" {
			where = fmt.Sprintf(" (%s:%d)", file, r.Failure.Line)
		}
		if r.Runs > 1 {
			where += fmt.Sprintf(", run %d of %d", r.Runs, o.runs)
		}
		fmt.Printf("FAIL %s%s\n\n%s\n\n", r.Name, where, indent(r.Failure.Text))
		blank = true
	}
	if o.json {
		each = func(r testResult) { printLine(testLine{Type: "test", testResult: r}) }
	}
	r, ok := runAll(file, tests, o, each)
	if !ok {
		fmt.Fprintf(os.Stderr, "candor: no test matching %s in %s\ntests: %s\n", quoted(append(o.only, o.exact...), " or "), file, quoted(names(tests), ", "))
		os.Exit(1)
	}
	if o.json {
		printLine(summaryLine{Type: "summary", File: r.File, Seed: r.Seed, Passed: r.Passed, Failed: r.Failed, Filtered: r.Filtered})
	} else {
		if !blank {
			fmt.Println()
		}
		summary := fmt.Sprintf("%d passed, %d failed", r.Passed, r.Failed)
		if r.Filtered > 0 {
			summary += fmt.Sprintf(", %d filtered out", r.Filtered)
		}
		fmt.Println(summary)
		for _, t := range r.Tests {
			if t.Failure != nil && t.Seeded {
				fmt.Printf("seed %d: run with --seed %d --only %s for the same task order\n", t.Seed, t.Seed, strconv.Quote(t.Name))
			}
		}
	}
	if r.Failed > 0 {
		os.Exit(1)
	}
	os.Exit(0)
}

// runAll runs the tests the options pick, each on its own scheduler, handing each result to
// each as it comes. A test whose order mattered runs again on the next seeds until it fails or
// has run o.runs times; one whose seed decided nothing would only repeat itself. ok is false
// when `-only` matched nothing.
func runAll(file string, tests []Test, o options, each func(testResult)) (r testRun, ok bool) {
	r = testRun{File: file, Seed: o.seed, Tests: []testResult{}}
	for _, t := range tests {
		if !picked(t.Name, o) {
			r.Filtered++
			continue
		}
		currentTest = t.Name
		res := testResult{Name: t.Name, Status: "pass"}
		for res.Runs < max(o.runs, 1) {
			res.Seed = o.seed + int64(res.Runs)
			res.Runs++
			sim := NewSim(res.Seed)
			res.Failure = run(t, sim)
			res.Seeded = res.Seeded || sim.spawned || sim.chose
			if res.Failure != nil || !sim.chose {
				break
			}
			// Half the seeds go on to a PCT run, sized by the uniform run just made with the
			// same seed, so the seed alone replays it.
			if d := pctDepth(res.Seed); d > 0 {
				pct := NewPCTSim(res.Seed, d, sim.steps)
				if res.Failure = run(t, pct); res.Failure != nil {
					break
				}
			}
		}
		if res.Failure != nil {
			res.Status = "fail"
			r.Failed++
		} else {
			r.Passed++
		}
		r.Tests = append(r.Tests, res)
		if each != nil {
			each(res)
		}
	}
	return r, len(o.only) == 0 || len(r.Tests) > 0
}

// testLine and summaryLine are the lines `-json` prints: one per test as it ends, then the totals.
type testLine struct {
	Type string `json:"type"`
	testResult
}

type summaryLine struct {
	Type     string `json:"type"`
	File     string `json:"file"`
	Seed     int64  `json:"seed"`
	Passed   int    `json:"passed"`
	Failed   int    `json:"failed"`
	Filtered int    `json:"filtered"`
}

func printLine(v any) {
	out, err := marshal(v, "")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(out))
}

// picked is whether the options run the test named name: every test, those whose name contains
// one of `-only`'s texts, or those named exactly by `-test`.
func picked(name string, o options) bool {
	if len(o.only) == 0 && len(o.exact) == 0 {
		return true
	}
	for _, x := range o.exact {
		if name == x {
			return true
		}
	}
	for _, s := range o.only {
		if strings.Contains(name, s) {
			return true
		}
	}
	return false
}

func names(tests []Test) []string {
	out := make([]string, len(tests))
	for i, t := range tests {
		out[i] = t.Name
	}
	return out
}

func quoted(xs []string, sep string) string {
	qs := make([]string, len(xs))
	for i, x := range xs {
		qs[i] = strconv.Quote(x)
	}
	return strings.Join(qs, sep)
}

// currentTest is the test running, which its frames are named after.
var currentTest string

// run runs one test and describes its failure, if any.
func run(t Test, sim *Sim) (f *failure) {
	defer func() {
		if goTrace() {
			return
		}
		if p := recover(); p != nil {
			f = describe(asCrash(p))
		}
	}()
	t.Fn(sim.Root())
	return nil
}

// describe says how a test failed: a failed `assert` as its diagram, with the Candor frames
// when it ran in a helper (an assert in the test itself needs none in the text: the heading has
// its line); a panic as its message and frames.
func describe(c *crash) *failure {
	traces := relTraces(c.traces)
	if a, ok := c.value.(*assertion); ok && a.contract() {
		// A contract is always in a function, so its frames are always shown.
		text := broken(a) + "\n\n" + diagram(a) + trace(c.traces)
		return &failure{Kind: a.clause, Fn: a.fn, Line: a.line, Source: a.source, Parts: parts(a), Traces: traces, Text: text}
	}
	if a, ok := c.value.(*assertion); ok {
		where := ""
		if len(c.traces) > 1 || len(c.traces[0]) > 1 {
			where = trace(c.traces)
		}
		return &failure{Kind: "assert", Line: a.line, Source: a.source, Parts: parts(a), Traces: traces, Text: diagram(a) + where}
	}
	msg := message(c.value)
	return &failure{Kind: "panic", Message: msg, Traces: traces, Text: "panic: " + msg + trace(c.traces)}
}

// parts is each recorded part of a failed assert, left to right. One that never ran (the right
// side of a short-circuited `&&`) is left out, as in the diagram, and so is a second part at
// the same column.
func parts(a *assertion) []part {
	out := []part{}
	seen := map[int]bool{}
	for i, c := range a.cols {
		if a.values[i] != "" && !seen[c] {
			seen[c] = true
			out = append(out, part{c, a.texts[i], a.values[i]})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Col < out[j].Col })
	return out
}

// diagram draws each recorded value under the part of the source it came from:
//
//	assert total(o) == 42
//	       |        |
//	       41       false
func diagram(a *assertion) string {
	type mark struct {
		col   int
		value string
	}
	var marks []mark
	seen := map[int]bool{}
	for i, c := range a.cols {
		if a.values[i] != "" && !seen[c] {
			seen[c] = true
			marks = append(marks, mark{c, a.values[i]})
		}
	}
	lines := []string{a.source}
	if len(marks) == 0 {
		return a.source
	}
	// Rightmost first: each value is written to the right of every bar still standing.
	sort.Slice(marks, func(i, j int) bool { return marks[i].col > marks[j].col })
	bars := func(n int) []rune {
		row := []rune(strings.Repeat(" ", marks[0].col+1))
		for _, m := range marks[n:] {
			row[m.col] = '|'
		}
		return row
	}
	lines = append(lines, strings.TrimRight(string(bars(0)), " "))
	for i, m := range marks {
		row := append(bars(i + 1)[:m.col], []rune(m.value)...)
		lines = append(lines, strings.TrimRight(string(row), " "))
	}
	return strings.Join(lines, "\n")
}

// indent indents each line but the blank ones.
func indent(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = "    " + l
		}
	}
	return strings.Join(lines, "\n")
}
