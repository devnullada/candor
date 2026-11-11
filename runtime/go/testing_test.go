package candor

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

var threeTests = []Test{
	{Name: "adds", Fn: func(c *Ctx) {}},
	{Name: "adds twice", Fn: func(c *Ctx) {
		Fail(3, "assert add(1, 1) == 3", []int{7, 17}, []string{"add(1, 1)", "add(1, 1) == 3"}, []string{"2", "false"})
	}},
	{Name: "divides", Fn: func(c *Ctx) {
		zero := 0
		_ = 1 / zero
	}},
}

func TestRunAllReportsEachKindOfFailure(t *testing.T) {
	var seen []string
	r, ok := runAll("m.candor", threeTests, options{seed: 1}, func(res testResult) { seen = append(seen, res.Name+":"+res.Status) })
	if !ok || r.Passed != 1 || r.Failed != 2 || r.Filtered != 0 || r.Seed != 1 || r.File != "m.candor" {
		t.Fatalf("got %+v", r)
	}
	if !reflect.DeepEqual(seen, []string{"adds:pass", "adds twice:fail", "divides:fail"}) {
		t.Fatalf("each saw %v", seen)
	}
	a := r.Tests[1].Failure
	want := []part{{7, "add(1, 1)", "2"}, {17, "add(1, 1) == 3", "false"}}
	if a.Kind != "assert" || a.Line != 3 || a.Source != "assert add(1, 1) == 3" || !reflect.DeepEqual(a.Parts, want) {
		t.Fatalf("assert failure: %+v", a)
	}
	if a.Text != "assert add(1, 1) == 3\n       |         |\n       |         false\n       2" {
		t.Fatalf("assert text:\n%s", a.Text)
	}
	p := r.Tests[2].Failure
	if p.Kind != "panic" || p.Message != "integer divide by zero" || !strings.HasPrefix(p.Text, "panic: integer divide by zero") {
		t.Fatalf("panic failure: %+v", p)
	}
}

func TestOnlyPicksBySubstring(t *testing.T) {
	r, ok := runAll("m.candor", threeTests, options{seed: 1, only: []string{"adds"}}, nil)
	if !ok || len(r.Tests) != 2 || r.Filtered != 1 || r.Tests[1].Name != "adds twice" {
		t.Fatalf("got %+v", r)
	}
	r, ok = runAll("m.candor", threeTests, options{seed: 1, only: []string{"twice", "div"}}, nil)
	if !ok || len(r.Tests) != 2 || r.Filtered != 1 {
		t.Fatalf("two filters: %+v", r)
	}
	if _, ok := runAll("m.candor", threeTests, options{only: []string{"nope"}}, nil); ok {
		t.Fatal("a filter matching nothing should not be ok")
	}
}

func TestPartsSkipWhatNeverRanAndRepeatedColumns(t *testing.T) {
	a := &assertion{cols: []int{13, 7, 7}, texts: []string{"n == 1", "n", "-n"}, values: []string{"", "0", "0"}}
	if got := parts(a); !reflect.DeepEqual(got, []part{{7, "n", "0"}}) {
		t.Fatalf("got %+v", got)
	}
	if got := parts(&assertion{}); got == nil || len(got) != 0 {
		t.Fatalf("no parts should be an empty list, got %#v", got)
	}
}

func TestParseOptions(t *testing.T) {
	o := parseOptions([]string{"-seed", "5", "--only", "a", "-only", "b c", "--json"})
	if o.seed != 5 || !reflect.DeepEqual(o.only, []string{"a", "b c"}) || !o.json {
		t.Fatalf("got %+v", o)
	}
	if o := parseOptions(nil); o.seed < 0 || o.only != nil || o.json || o.runs != defaultRuns {
		t.Fatalf("defaults: %+v", o)
	}
	if o.runs != 1 {
		t.Fatalf("a seed runs one order: %+v", o)
	}
	if o := parseOptions([]string{"-seed", "5", "--runs", "20"}); o.runs != 20 {
		t.Fatalf("runs: %+v", o)
	}
}

// fourth fails when four tasks print in the one order of 24 that reverses them.
var fourth = Test{Name: "not reversed", Fn: func(c *Ctx) {
	io := &RecordingIO{}
	RunScopeUnit(c, func(c *Ctx, s *Scope) {
		for _, name := range []string{"a", "b", "c", "d"} {
			SpawnUnit(c, s, func(c *Ctx) { io.Print(c, name) })
		}
	})
	if io.Output(c) == "dcba" {
		Fail(1, "assert out != reversed", nil, nil, nil)
	}
}}

func TestARaceRunsUntilItFailsAndItsSeedReplaysIt(t *testing.T) {
	r, _ := runAll("m.candor", []Test{fourth}, options{seed: 1, runs: 200}, nil)
	res := r.Tests[0]
	if res.Status != "fail" || res.Runs < 2 || res.Seed != 1+int64(res.Runs)-1 || !res.Seeded {
		t.Fatalf("got %+v", res)
	}
	again, _ := runAll("m.candor", []Test{fourth}, options{seed: res.Seed, runs: 1}, nil)
	if again.Tests[0].Status != "fail" || again.Tests[0].Runs != 1 {
		t.Fatalf("replay: %+v", again.Tests[0])
	}
	if r, _ := runAll("m.candor", threeTests, options{seed: 1, runs: 100}, nil); r.Tests[0].Runs != 1 {
		t.Fatalf("a test the seed decides nothing in runs once: %+v", r.Tests[0])
	}
}

func TestResultsJSONIsADiscriminatedUnion(t *testing.T) {
	r := testRun{File: "m.candor", Seed: 7, Failed: 2, Tests: []testResult{
		{Name: "a", Status: "fail", Failure: &failure{Kind: "assert", Line: 3, Source: "assert x", Parts: []part{},
			Traces: [][]Frame{{{File: "m.candor", Line: 3, Fn: `test "a"`}}}, Text: "assert x"}},
		{Name: "b", Status: "fail", Seeded: true, Failure: &failure{Kind: "panic", Message: "boom", Traces: [][]Frame{}, Text: "panic: boom"}},
		{Name: "c", Status: "pass"},
	}}
	out, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"file":"m.candor","seed":7,"passed":0,"failed":2,"filtered":0,"tests":[` +
		`{"name":"a","status":"fail","seeded":false,"runs":0,"seed":0,"failure":{"kind":"assert","line":3,"source":"assert x","parts":[],` +
		`"traces":[[{"file":"m.candor","line":3,"fn":"test \"a\""}]],"text":"assert x"}},` +
		`{"name":"b","status":"fail","seeded":true,"runs":0,"seed":0,"failure":{"kind":"panic","message":"boom","traces":[],"text":"panic: boom"}},` +
		`{"name":"c","status":"pass","seeded":false,"runs":0,"seed":0}]}`
	if string(out) != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
}

func TestRelTracesDropsEmptySegments(t *testing.T) {
	got := relTraces([][]Frame{{}, {{File: "f.candor", Line: 1, Fn: "f"}}, {}})
	if !reflect.DeepEqual(got, [][]Frame{{{File: "f.candor", Line: 1, Fn: "f"}}}) {
		t.Fatalf("got %+v", got)
	}
	if got := relTraces(nil); got == nil || len(got) != 0 {
		t.Fatalf("no segments should be an empty list, got %#v", got)
	}
}
