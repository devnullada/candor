package candor

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type result struct {
	ok  bool
	err string
}

func isErr(r result) bool { return !r.ok }

func toScope(r result) (any, bool) { return r, !r.ok }

// noLeaks fails the test if goroutines started during it are still running at the end.
func noLeaks(t *testing.T) {
	t.Helper()
	before := runtime.NumGoroutine()
	t.Cleanup(func() {
		// Exited goroutines can take a moment to be counted out; live ones never are.
		for i := 0; i < 100 && runtime.NumGoroutine() > before; i++ {
			time.Sleep(time.Millisecond)
		}
		if n := runtime.NumGoroutine(); n > before {
			buf := make([]byte, 1<<16)
			t.Fatalf("%d goroutines outlived their scope:\n%s", n-before, buf[:runtime.Stack(buf, true)])
		}
	})
}

func TestScopeRunsInParallel(t *testing.T) {
	noLeaks(t)
	clock := SystemClock()
	start := time.Now()
	got := RunScope(Root(), func(c *Ctx, s *Scope) int64 {
		var tasks []*Task[int64]
		for i := int64(1); i <= 3; i++ {
			tasks = append(tasks, Spawn(c, s, func(c *Ctx) int64 {
				clock.Sleep(c, 100)
				return i
			}, nil))
		}
		var sum int64
		for _, task := range tasks {
			sum += task.Join(c)
		}
		return sum
	}, nil)
	if got != 6 {
		t.Fatalf("sum = %d", got)
	}
	if d := time.Since(start); d > 250*time.Millisecond {
		t.Fatalf("three 100ms tasks took %v: not parallel", d)
	}
}

func TestFailureCancelsTheRest(t *testing.T) {
	noLeaks(t)
	clock := SystemClock()
	var finished []string
	start := time.Now()
	got := RunScope(Root(), func(c *Ctx, s *Scope) result {
		Spawn(c, s, func(c *Ctx) result {
			clock.Sleep(c, 10_000)
			finished = append(finished, "slow")
			return result{ok: true}
		}, toScope)
		Spawn(c, s, func(c *Ctx) result {
			clock.Sleep(c, 10)
			return result{err: "broke"}
		}, toScope)
		// A pure loop stops too: generated loops check on every iteration.
		Spawn(c, s, func(c *Ctx) result {
			for {
				c.Check()
			}
		}, toScope)
		return result{ok: true}
	}, isErr)
	if got.err != "broke" || len(finished) > 0 {
		t.Fatalf("got %+v, finished %v", got, finished)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("cancellation took %v", d)
	}
}

func TestBodyFailureCancelsTasks(t *testing.T) {
	noLeaks(t)
	got := RunScope(Root(), func(c *Ctx, s *Scope) result {
		Spawn(c, s, func(c *Ctx) result {
			SystemClock().Sleep(c, 10_000)
			return result{ok: true}
		}, nil)
		return result{err: "body"}
	}, isErr)
	if got.err != "body" {
		t.Fatalf("got %+v", got)
	}
}

func TestCrashPropagates(t *testing.T) {
	noLeaks(t)
	p := recovered(func() {
		RunScopeUnit(Root(), func(c *Ctx, s *Scope) {
			SpawnUnit(c, s, func(c *Ctx) { panic(errors.New("bug")) })
			SpawnUnit(c, s, func(c *Ctx) { SystemClock().Sleep(c, 10_000) })
		})
	})
	if err, ok := p.(error); !ok || err.Error() != "bug" {
		t.Fatalf("recovered %v", p)
	}
}

func TestNestedScopesAreCancelled(t *testing.T) {
	noLeaks(t)
	got := RunScope(Root(), func(c *Ctx, s *Scope) result {
		Spawn(c, s, func(c *Ctx) result {
			RunScopeUnit(c, func(c *Ctx, inner *Scope) {
				SpawnUnit(c, inner, func(c *Ctx) { SystemClock().Sleep(c, 10_000) })
			})
			return result{ok: true}
		}, toScope)
		Spawn(c, s, func(c *Ctx) result { return result{err: "outer"} }, toScope)
		return result{ok: true}
	}, isErr)
	if got.err != "outer" {
		t.Fatalf("got %+v", got)
	}
}

func TestTimeoutRaceAll(t *testing.T) {
	noLeaks(t)
	c := Root()
	clock := SystemClock()
	if _, ok := Timeout(c, 20, func(c *Ctx) int64 { clock.Sleep(c, 10_000); return 1 }); ok {
		t.Fatal("timeout should have run out")
	}
	if v, ok := Timeout(c, 5_000, func(c *Ctx) int64 { return 7 }); !ok || v != 7 {
		t.Fatalf("timeout = %d, %v", v, ok)
	}
	win := Race(c, []func(*Ctx) result{
		func(c *Ctx) result { return result{err: "fast failure"} },
		func(c *Ctx) result { clock.Sleep(c, 20); return result{ok: true, err: "slow"} },
		func(c *Ctx) result { clock.Sleep(c, 10_000); return result{ok: true} },
	}, isErr)
	if win.err != "slow" {
		t.Fatalf("race = %+v", win)
	}
	out, failed := All(c, []int64{1, 2, 3}, func(c *Ctx, x int64) result {
		if x == 2 {
			return result{err: "two"}
		}
		clock.Sleep(c, 10_000)
		return result{ok: true}
	}, isErr)
	if failed != 1 || out[1].err != "two" {
		t.Fatalf("all = %v, %d", out, failed)
	}
}

// order runs four tasks that each print twice, on the test scheduler.
func order(seed int64) string {
	io := &RecordingIO{}
	c := NewSim(seed).Root()
	RunScopeUnit(c, func(c *Ctx, s *Scope) {
		for _, name := range []string{"a", "b", "c", "d"} {
			SpawnUnit(c, s, func(c *Ctx) {
				io.Print(c, name)
				io.Print(c, name)
			})
		}
	})
	return io.Output(c)
}

func TestSimIsDeterministic(t *testing.T) {
	noLeaks(t)
	seen := map[string]bool{}
	for seed := int64(0); seed < 20; seed++ {
		first := order(seed)
		if again := order(seed); again != first {
			t.Fatalf("seed %d: %q then %q", seed, first, again)
		}
		if len(first) != 8 {
			t.Fatalf("seed %d: %q", seed, first)
		}
		seen[first] = true
	}
	if len(seen) < 5 {
		t.Fatalf("20 seeds gave only %d orders: %v", len(seen), seen)
	}
}

func TestSimVirtualTime(t *testing.T) {
	noLeaks(t)
	clock := &FakeClock{}
	io := &RecordingIO{}
	c := NewSim(1).Root()
	got := RunScope(c, func(c *Ctx, s *Scope) result {
		Spawn(c, s, func(c *Ctx) result {
			clock.Sleep(c, 100)
			io.Println(c, "slow finished")
			return result{ok: true}
		}, toScope)
		Spawn(c, s, func(c *Ctx) result {
			clock.Sleep(c, 30)
			return result{err: fmt.Sprint("failed at ", clock.Now(c))}
		}, toScope)
		return result{ok: true}
	}, isErr)
	if got.err != "failed at 30" || io.Output(c) != "" || clock.Now(c) != 30 {
		t.Fatalf("got %+v, output %q, now %d", got, io.Output(c), clock.Now(c))
	}
	// Parallel sleeps overlap in virtual time too.
	AllUnit(c, []int64{100, 100, 100}, func(c *Ctx, ms int64) { clock.Sleep(c, ms) })
	if clock.Now(c) != 130 {
		t.Fatalf("now %d", clock.Now(c))
	}
	if _, ok := Timeout(c, 50, func(c *Ctx) int64 { clock.Sleep(c, 1_000); return 1 }); ok || clock.Now(c) != 180 {
		t.Fatalf("timeout: ok %v, now %d", ok, clock.Now(c))
	}
}

func TestSimCrashInTask(t *testing.T) {
	noLeaks(t)
	p := recovered(func() {
		c := NewSim(3).Root()
		RunScopeUnit(c, func(c *Ctx, s *Scope) {
			SpawnUnit(c, s, func(c *Ctx) { (&FakeClock{}).Sleep(c, 1_000) })
			SpawnUnit(c, s, func(c *Ctx) { panic("assert failed") })
		})
	})
	if p != "assert failed" {
		t.Fatalf("recovered %v", p)
	}
}

func TestSpawnAfterScopeEnds(t *testing.T) {
	var kept *Scope
	RunScopeUnit(Root(), func(c *Ctx, s *Scope) { kept = s })
	p := recovered(func() { SpawnUnit(Root(), kept, func(c *Ctx) {}) })
	if s, _ := p.(string); !strings.Contains(s, "already ended") {
		t.Fatalf("recovered %v", p)
	}
}

func TestWaitSeesWhatTasksBuilt(t *testing.T) {
	noLeaks(t)
	clock := SystemClock()
	got := RunScope(Root(), func(c *Ctx, s *Scope) int64 {
		built := make([]int64, 3)
		for i := range built {
			SpawnUnit(c, s, func(c *Ctx) {
				clock.Sleep(c, 20)
				built[i] = int64(i) + 1
			})
		}
		s.Wait(c)
		sum := built[0] + built[1] + built[2]
		// The scope stays open: more work, and another wait.
		var extra int64
		SpawnUnit(c, s, func(c *Ctx) { extra = 10 })
		s.Wait(c)
		return sum + extra
	}, nil)
	if got != 16 {
		t.Fatalf("got %d", got)
	}
}

func TestWaitUnwindsWhenATaskFails(t *testing.T) {
	noLeaks(t)
	clock := SystemClock()
	reached := false
	start := time.Now()
	got := RunScope(Root(), func(c *Ctx, s *Scope) result {
		Spawn(c, s, func(c *Ctx) result {
			clock.Sleep(c, 10_000)
			return result{ok: true}
		}, toScope)
		Spawn(c, s, func(c *Ctx) result {
			clock.Sleep(c, 10)
			return result{err: "broke"}
		}, toScope)
		s.Wait(c)
		reached = true
		return result{ok: true}
	}, isErr)
	if got.err != "broke" || reached {
		t.Fatalf("got %+v, reached %v", got, reached)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("unwinding took %v", d)
	}
}

func TestWaitInsideATaskPanics(t *testing.T) {
	noLeaks(t)
	direct := recovered(func() {
		RunScopeUnit(Root(), func(c *Ctx, s *Scope) {
			SpawnUnit(c, s, func(c *Ctx) { s.Wait(c) })
		})
	})
	if p, _ := direct.(string); !strings.Contains(p, "would wait for itself") {
		t.Fatalf("recovered %v", direct)
	}
	// Through a nested scope's own code too: it still runs in the task.
	nested := recovered(func() {
		RunScopeUnit(Root(), func(c *Ctx, outer *Scope) {
			SpawnUnit(c, outer, func(c *Ctx) {
				RunScopeUnit(c, func(c *Ctx, inner *Scope) { outer.Wait(c) })
			})
		})
	})
	if p, _ := nested.(string); !strings.Contains(p, "would wait for itself") {
		t.Fatalf("recovered %v", nested)
	}
	// A nested scope of its own is the way: waiting on that is fine.
	RunScopeUnit(Root(), func(c *Ctx, outer *Scope) {
		SpawnUnit(c, outer, func(c *Ctx) {
			RunScopeUnit(c, func(c *Ctx, inner *Scope) {
				SpawnUnit(c, inner, func(c *Ctx) {})
				inner.Wait(c)
			})
		})
	})
}

func TestSimWait(t *testing.T) {
	noLeaks(t)
	clock := &FakeClock{}
	c := NewSim(2).Root()
	built := RunScope(c, func(c *Ctx, s *Scope) int64 {
		var sum int64
		for _, ms := range []int64{100, 200, 300} {
			SpawnUnit(c, s, func(c *Ctx) {
				clock.Sleep(c, ms)
				sum += ms
			})
		}
		s.Wait(c)
		return sum
	}, nil)
	if built != 600 || clock.Now(c) != 300 {
		t.Fatalf("built %d, now %d", built, clock.Now(c))
	}
	p := recovered(func() {
		RunScopeUnit(c, func(c *Ctx, s *Scope) {
			SpawnUnit(c, s, func(c *Ctx) { s.Wait(c) })
		})
	})
	if s, _ := p.(string); !strings.Contains(s, "would wait for itself") {
		t.Fatalf("recovered %v", p)
	}
}

// Shorthands for functions that return nothing, as Go writes them.

// RunScopeUnit is `tasks.scope(body)` for a body that returns nothing.
func RunScopeUnit(c *Ctx, body func(*Ctx, *Scope)) {
	RunScope(c, func(c *Ctx, s *Scope) struct{} {
		body(c, s)
		return struct{}{}
	}, nil)
}

// SpawnUnit is `s.spawn(f)` for an f that returns nothing.
func SpawnUnit(c *Ctx, s *Scope, f func(*Ctx)) *Task[struct{}] {
	return Spawn(c, s, func(c *Ctx) struct{} {
		f(c)
		return struct{}{}
	}, nil)
}

// AllUnit is `tasks.all(xs, f)` for an f that returns nothing.
func AllUnit[A any](c *Ctx, xs []A, f func(*Ctx, A)) {
	All(c, xs, func(c *Ctx, x A) struct{} {
		f(c, x)
		return struct{}{}
	}, nil)
}

// RaceUnit is `tasks.race(fs)` for functions that return nothing.
func RaceUnit(c *Ctx, fs []func(*Ctx)) {
	wrapped := make([]func(*Ctx) struct{}, len(fs))
	for i, f := range fs {
		wrapped[i] = func(c *Ctx) struct{} {
			f(c)
			return struct{}{}
		}
	}
	Race(c, wrapped, nil)
}

// A background task runs until the scope's code and its other tasks are done, then
// is cancelled; the scope still waits for it to end.
func TestBackgroundEndsWithTheScope(t *testing.T) {
	for name, ctx := range contexts() {
		t.Run(name, func(t *testing.T) {
			if name == "real" {
				noLeaks(t)
			}
			var log []string
			var mu sync.Mutex
			note := func(s string) {
				mu.Lock()
				log = append(log, s)
				mu.Unlock()
			}
			RunScopeUnit(ctx(), func(c *Ctx, s *Scope) {
				never := NewChannel[int64](c, s, 0)
				Background(c, s, func(c *Ctx) struct{} {
					defer Deferred(c, func(*Ctx) { note("watcher stopped") })
					never.Recv(c)
					note("watcher got one")
					return struct{}{}
				}, nil)
				Spawn(c, s, func(c *Ctx) struct{} {
					SystemClock().Sleep(c, 5)
					note("work done")
					return struct{}{}
				}, nil)
				s.Wait(c)
				note("waited")
			})
			if got := strings.Join(log, ", "); got != "work done, waited, watcher stopped" {
				t.Fatalf("log: %s", got)
			}
		})
	}
}

func TestBackgroundFailureCancelsTheScope(t *testing.T) {
	for name, ctx := range contexts() {
		t.Run(name, func(t *testing.T) {
			got := RunScope(ctx(), func(c *Ctx, s *Scope) result {
				Background(c, s, func(c *Ctx) result { return result{err: "watch failed"} }, toScope)
				Spawn(c, s, func(c *Ctx) result {
					SystemClock().Sleep(c, 10_000)
					return result{ok: true}
				}, toScope)
				return result{ok: true}
			}, isErr)
			if got.err != "watch failed" {
				t.Fatalf("got %+v", got)
			}
		})
	}
}
