package candor

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// recovered runs f and returns what it panicked with, without the frames catch adds.
func recovered(f func()) any { return unwrap(catch(f)) }

func TestCandorNames(t *testing.T) {
	currentTest = "adds up"
	cases := map[string]string{
		"main.shop__total":                        "total",
		"main.shop__total.func1":                  "total",
		"main.shop__total.func1.2":                "total",
		"main.shop__first[...]":                   "first",
		"main.shop__first[...].func1":             "first",
		"main.(*fx__kv__real).Get":                "get",
		"main.(*fx__kv__fake).GetAll.func1":       "getAll",
		"main.fx__kv__real.Get":                   "get",
		"main.fx__kv__newReal":                    "effect kv",
		"main.shop__Show__for__shop__Point.show":  "show",
		"main.Ord__for__shop__User.compare":       "compare",
		"main.Ord__for__shop__User.compare.func1": "compare",
		"main.test__3":                            `test "adds up"`,
		"main.test__3.func2":                      `test "adds up"`,
	}
	for in, want := range cases {
		if got := candorName(in); got != want {
			t.Errorf("%s: got %q, want %q", in, got, want)
		}
	}
}

func TestMessages(t *testing.T) {
	var zero int64
	p := recovered(func() { _ = 1 / zero })
	if got := message(p); got != "integer divide by zero" {
		t.Errorf("runtime error: %q", got)
	}
	if got := message(errors.New("bug")); got != "bug" {
		t.Errorf("error: %q", got)
	}
	if got := message("candor: send on a Channel that is closed"); got != "candor: send on a Channel that is closed" {
		t.Errorf("string: %q", got)
	}
	if got := message(&assertion{clause: "assert", line: 3, source: "assert x == 1"}); got != "assert failed: assert x == 1" {
		t.Errorf("failure: %q", got)
	}
	if got := message(&assertion{clause: "ensures", fn: "abs", source: "ensures result >= 0"}); got != "`abs` returned a value that breaks its `ensures`: ensures result >= 0" {
		t.Errorf("contract: %q", got)
	}
}

func TestReportShowsABrokenContract(t *testing.T) {
	var out bytes.Buffer
	savedErr, savedExit := stderr, exit
	stderr, exit = &out, func(int) {}
	defer func() { stderr, exit = savedErr, savedExit }()

	func() {
		defer Report()
		Broke("requires", "sqrt", 4, "requires n >= 0", []int{9, 11}, []string{"n", "n >= 0"}, []string{"-1", "false"})
	}()
	want := "panic: `sqrt` was called with arguments that break its `requires`\n\n    requires n >= 0\n             | |\n             | false\n             -1\n"
	if out.String() != want {
		t.Fatalf("got %q", out.String())
	}
}

func TestCrashKeepsItsValueAcrossScopes(t *testing.T) {
	noLeaks(t)
	p := catch(func() {
		RunScopeUnit(Root(), func(c *Ctx, s *Scope) {
			SpawnUnit(c, s, func(c *Ctx) {
				RunScopeUnit(c, func(c *Ctx, inner *Scope) {
					SpawnUnit(c, inner, func(c *Ctx) { panic(errors.New("deep")) })
				})
			})
		})
	})
	c, ok := p.(*crash)
	if !ok || c.value.(error).Error() != "deep" {
		t.Fatalf("recovered %#v", p)
	}
	// No Candor frames in a Go test, so every goroutine's (empty) frames look like the last.
	if len(c.traces) != 1 {
		t.Fatalf("%d segments", len(c.traces))
	}
}

func TestCancellationIsNotACrash(t *testing.T) {
	if p := crashOf(cancelled{}); p != (cancelled{}) {
		t.Fatalf("got %#v", p)
	}
	if p := crashOf(nil); p != nil {
		t.Fatalf("got %#v", p)
	}
}

func TestTraceRendersSegments(t *testing.T) {
	traces := [][]Frame{
		{{File: "/x/shop.candor", Line: 4, Fn: "div"}, {File: "/x/shop.candor", Line: 9, Fn: "main"}},
		{},
		{{File: "/x/shop.candor", Line: 8, Fn: "main"}},
	}
	want := "\n  at /x/shop.candor:4 in div\n  at /x/shop.candor:9 in main\nin a task of the scope at\n  at /x/shop.candor:8 in main"
	if got := trace(traces); got != want {
		t.Fatalf("got %q", got)
	}
	a := []Frame{{File: "f", Line: 1, Fn: "a"}, {File: "f", Line: 2, Fn: "b"}}
	if !endsWith(a, a[1:]) || !endsWith(a, nil) || endsWith(a, []Frame{{File: "f", Line: 1, Fn: "a"}}) || endsWith(a[1:], a) {
		t.Fatal("endsWith")
	}
}

func TestReportPrintsAndExits(t *testing.T) {
	var out bytes.Buffer
	code := -1
	savedErr, savedExit := stderr, exit
	stderr, exit = &out, func(c int) { code = c }
	defer func() { stderr, exit = savedErr, savedExit }()

	func() {
		defer Report()
		var zero int64
		_ = 1 / zero
	}()
	if out.String() != "panic: integer divide by zero\n" || code != 2 {
		t.Fatalf("got %q, exit %d", out.String(), code)
	}

	out.Reset()
	code = -1
	func() {
		defer Report()
	}()
	if out.Len() != 0 || code != -1 {
		t.Fatalf("a quiet main: %q, exit %d", out.String(), code)
	}

	t.Setenv("CANDOR_TRACE", "go")
	p := recovered(func() {
		defer Report()
		panic("left to Go")
	})
	if p != "left to Go" || out.Len() != 0 {
		t.Fatalf("CANDOR_TRACE=go: recovered %v, printed %q", p, out.String())
	}
	if !strings.Contains((&crash{value: errors.New("bug"), traces: [][]Frame{{{File: "f.candor", Line: 1, Fn: "f"}}}}).Error(), "bug\n  at f.candor:1 in f") {
		t.Fatal("crash.Error")
	}
}
