package candor

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// contexts: real goroutines, then the test scheduler at a few seeds.
func contexts() map[string]func() *Ctx {
	cs := map[string]func() *Ctx{"real": Root}
	for seed := int64(1); seed <= 5; seed++ {
		cs[fmt.Sprint("seed ", seed)] = func() *Ctx { return NewSim(seed).Root() }
	}
	return cs
}

// A panic in a hold lets go of the Lock, and of the task's "holding", so the next hold goes ahead.
func TestLockLetGoOnPanic(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		got := 0
		RunScopeUnit(root(), func(c *Ctx, s *Scope) {
			l := NewLock(c, s)
			func() {
				defer func() { recover() }()
				Hold(c, l, func(*Ctx) int { panic("boom") })
			}()
			got = Hold(c, l, func(*Ctx) int { return 2 })
		})
		if got != 2 {
			t.Fatalf("%s: got %d", name, got)
		}
	}
}

func TestMutexAndAtomicLoseNothing(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		var m *Mutex[int64]
		var a *AtomicInt
		RunScopeUnit(root(), func(c *Ctx, s *Scope) {
			m = NewMutex(c, s, int64(0))
			a = NewAtomicInt(c, s, 0)
			for range 100 {
				SpawnUnit(c, s, func(c *Ctx) {
					m.Update(c, func(_ *Ctx, n int64) int64 { return n + 1 })
					a.Add(c, 1)
				})
			}
		})
		// Read after the scope, which waited for every task.
		if tally, count := m.v, a.v.Load(); tally != 100 || count != 100 {
			t.Fatalf("%s: mutex %d, atomic %d", name, tally, count)
		}
	}
}

func TestUpdateWithGivesAResult(t *testing.T) {
	c := Root()
	RunScopeUnit(c, func(c *Ctx, s *Scope) {
		m := NewMutex(c, s, "a")
		old := UpdateWith(c, m, func(_ *Ctx, v string) struct {
			V0 string
			V1 int64
		} {
			return struct {
				V0 string
				V1 int64
			}{v + "b", int64(len(v))}
		})
		if old != 1 || m.Get(c) != "ab" {
			t.Fatalf("got %d, %q", old, m.Get(c))
		}
	})
}

// workers sums 1..20 sent through a channel of the given size by three workers.
func workers(c *Ctx, size int64) int64 {
	var sum *AtomicInt
	RunScopeUnit(c, func(c *Ctx, s *Scope) {
		ch := NewChannel[int64](c, s, size)
		sum = NewAtomicInt(c, s, 0)
		for range 3 {
			SpawnUnit(c, s, func(c *Ctx) {
				for {
					n, ok := ch.Recv(c)
					if !ok {
						return
					}
					sum.Add(c, n)
				}
			})
		}
		for i := int64(1); i <= 20; i++ {
			ch.Send(c, i)
		}
		ch.Close(c)
	})
	return sum.v.Load()
}

func TestChannelWorkers(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		for _, size := range []int64{0, 1, 8} {
			if got := workers(root(), size); got != 210 {
				t.Fatalf("%s, capacity %d: sum %d", name, size, got)
			}
		}
	}
}

func TestUnbufferedSendWaitsForReceiver(t *testing.T) {
	noLeaks(t)
	for seed := int64(0); seed < 10; seed++ {
		io := &RecordingIO{}
		c := NewSim(seed).Root()
		RunScopeUnit(c, func(c *Ctx, s *Scope) {
			ch := NewChannel[string](c, s, 0)
			SpawnUnit(c, s, func(c *Ctx) {
				ch.Send(c, "x")
				io.Print(c, "sent ")
			})
			SpawnUnit(c, s, func(c *Ctx) {
				io.Print(c, "receiving ")
				v, _ := ch.Recv(c)
				io.Print(c, v+" ")
			})
		})
		if out := io.Output(c); !strings.HasPrefix(out, "receiving ") {
			t.Fatalf("seed %d: %q", seed, out)
		}
	}
}

func TestSimFindsDeadlock(t *testing.T) {
	// No noLeaks: in a deadlock the waiting tasks' goroutines stay parked for good.
	for seed := int64(0); seed < 5; seed++ {
		p := recovered(func() {
			c := NewSim(seed).Root()
			RunScopeUnit(c, func(c *Ctx, s *Scope) {
				ch := NewChannel[int64](c, s, 4)
				for range 2 {
					SpawnUnit(c, s, func(c *Ctx) {
						for {
							if _, ok := ch.Recv(c); !ok {
								return
							}
						}
					})
				}
				ch.Send(c, 1)
				// No ch.Close(c): the workers wait for good.
			})
		})
		want := "candor: deadlock: every task is waiting and nothing can wake them (1 on its scope's tasks, 2 on Channel.recv)"
		if s, _ := p.(string); !strings.HasPrefix(s, want+"\n") {
			t.Fatalf("seed %d: recovered %v", seed, p)
		}
	}
}

func TestCancellationWakesBlockedTasks(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		got := RunScope(root(), func(c *Ctx, s *Scope) result {
			ch := NewChannel[int64](c, s, 0)
			Spawn(c, s, func(c *Ctx) result {
				ch.Recv(c)
				return result{ok: true}
			}, toScope)
			Spawn(c, s, func(c *Ctx) result {
				ch.Send(c, 1)
				ch.Send(c, 2)
				return result{ok: true}
			}, toScope)
			Spawn(c, s, func(c *Ctx) result { return result{err: "broke"} }, toScope)
			return result{ok: true}
		}, isErr)
		if got.err != "broke" {
			t.Fatalf("%s: got %+v", name, got)
		}
	}
}

func TestUpdateOnlyComputes(t *testing.T) {
	for name, root := range contexts() {
		p := recovered(func() {
			RunScopeUnit(root(), func(c *Ctx, s *Scope) {
				m := NewMutex(c, s, int64(0))
				a := NewAtomicInt(c, s, 0)
				m.Update(c, func(c *Ctx, n int64) int64 { return n + a.Get(c) })
			})
		})
		if s, _ := p.(string); !strings.Contains(s, "runs while its Mutex is locked") {
			t.Fatalf("%s: recovered %v", name, p)
		}
	}
}

func TestClosedChannels(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		p := recovered(func() {
			RunScopeUnit(root(), func(c *Ctx, s *Scope) {
				ch := NewChannel[int64](c, s, 2)
				ch.Send(c, 1)
				ch.Close(c)
				if v, ok := ch.Recv(c); v != 1 || !ok {
					t.Errorf("%s: what was sent before close: %d %v", name, v, ok)
				}
				if _, ok := ch.Recv(c); ok {
					t.Errorf("%s: closed and empty, yet a value", name)
				}
				ch.Send(c, 2)
			})
		})
		if p != "candor: send on a Channel that is closed" {
			t.Fatalf("%s: recovered %v", name, p)
		}
	}
}

func TestHandlesEndWithTheirScope(t *testing.T) {
	var kept *Channel[int64]
	c := Root()
	RunScopeUnit(c, func(c *Ctx, s *Scope) { kept = NewChannel[int64](c, s, 1) })
	p := recovered(func() { kept.Send(c, 1) })
	if p != "candor: a Channel used after its scope ended" {
		t.Fatalf("recovered %v", p)
	}
}

func TestBoth(t *testing.T) {
	noLeaks(t)
	clock := SystemClock()
	start := time.Now()
	a, b, failed := Both(Root(), func(c *Ctx) int64 {
		clock.Sleep(c, 100)
		return 1
	}, func(c *Ctx) string {
		clock.Sleep(c, 100)
		return "b"
	}, nil, nil)
	if a != 1 || b != "b" || failed != 0 {
		t.Fatalf("got %d %q %d", a, b, failed)
	}
	if d := time.Since(start); d > 180*time.Millisecond {
		t.Fatalf("two 100ms functions took %v: not parallel", d)
	}
	start = time.Now()
	_, r, failed := Both(Root(), func(c *Ctx) int64 {
		clock.Sleep(c, 10_000)
		return 1
	}, func(c *Ctx) result {
		return result{err: "broke"}
	}, nil, isErr)
	if failed != 2 || r.err != "broke" || time.Since(start) > time.Second {
		t.Fatalf("failed %d, %+v, after %v", failed, r, time.Since(start))
	}
}
