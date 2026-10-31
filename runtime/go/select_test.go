package candor

import (
	"fmt"
	"testing"
	"time"
)

// sleep on whichever clock the context has.
func sleep(c *Ctx, ms int64) {
	if c.sim != nil {
		(&FakeClock{}).Sleep(c, ms)
	} else {
		SystemClock().Sleep(c, ms)
	}
}

func unit(*Ctx) struct{} { return struct{}{} }

func TestSelectTakesWhatIsReady(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		RunScopeUnit(root(), func(c *Ctx, s *Scope) {
			a := NewChannel[int64](c, s, 1)
			b := NewChannel[string](c, s, 1)
			b.Send(c, "b")
			arms := []*Arm[string]{
				OnRecv(c, a, func(_ *Ctx, v int64, ok bool) string { return fmt.Sprint("a ", v, " ", ok) }),
				OnRecv(c, b, func(_ *Ctx, v string, ok bool) string { return fmt.Sprint("b ", v, " ", ok) }),
			}
			if got := Select(c, arms); got != "b b true" {
				t.Fatalf("%s: %q", name, got)
			}
			// A closed channel's arm is ready, with nothing.
			b.Close(c)
			if got := Select(c, arms); got != "b  false" {
				t.Fatalf("%s: after close, %q", name, got)
			}
		})
	}
}

func TestSelectAfterAndOtherwise(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		RunScopeUnit(root(), func(c *Ctx, s *Scope) {
			never := NewChannel[int64](c, s, 0)
			got := func(*Ctx, int64, bool) string { return "got" }
			start := time.Now()
			if r := Select(c, []*Arm[string]{OnRecv(c, never, got), After(c, 30, func(*Ctx) string { return "after" })}); r != "after" {
				t.Fatalf("%s: %q", name, r)
			}
			if c.sim != nil && c.sim.now != 30 {
				t.Fatalf("%s: virtual time %d", name, c.sim.now)
			}
			if c.sim == nil && time.Since(start) < 30*time.Millisecond {
				t.Fatalf("%s: the timeout arm fired after %v", name, time.Since(start))
			}
			otherwise := Otherwise(c, func(*Ctx) string { return "otherwise" })
			if r := Select(c, []*Arm[string]{OnRecv(c, never, got), otherwise}); r != "otherwise" {
				t.Fatalf("%s: %q", name, r)
			}
			// Only when nothing else is ready.
			ready := NewChannel[int64](c, s, 1)
			ready.Send(c, 1)
			if r := Select(c, []*Arm[string]{OnRecv(c, ready, got), otherwise}); r != "got" {
				t.Fatalf("%s: %q", name, r)
			}
		})
	}
}

func TestSelectSendsOnlyToAWaitingReceiver(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		var heard string
		RunScopeUnit(root(), func(c *Ctx, s *Scope) {
			ch := NewChannel[string](c, s, 0)
			offer := func(v string) bool {
				return Select(c, []*Arm[bool]{
					OnSend(c, ch, v, func(*Ctx) bool { return true }),
					Otherwise(c, func(*Ctx) bool { return false }),
				})
			}
			if offer("unheard") {
				t.Fatalf("%s: sent with nobody receiving", name)
			}
			SpawnUnit(c, s, func(c *Ctx) { heard, _ = ch.Recv(c) })
			sleep(c, 20)
			if !offer("heard") {
				t.Fatalf("%s: dropped with a receiver waiting", name)
			}
		})
		if heard != "heard" {
			t.Fatalf("%s: received %q", name, heard)
		}
	}
}

// Two selects, one sending and one receiving on an unbuffered channel, pair up; a select
// receiving from several channels pairs with the one that has a sender.
func TestSelectPairsWithSelect(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		var got []string
		RunScopeUnit(root(), func(c *Ctx, s *Scope) {
			a := NewChannel[string](c, s, 0)
			b := NewChannel[string](c, s, 0)
			SpawnUnit(c, s, func(c *Ctx) { Select(c, []*Arm[struct{}]{OnSend(c, a, "a", unit)}) })
			SpawnUnit(c, s, func(c *Ctx) { Select(c, []*Arm[struct{}]{OnSend(c, a, "a", unit)}) })
			SpawnUnit(c, s, func(c *Ctx) { Select(c, []*Arm[struct{}]{OnSend(c, b, "b", unit)}) })
			label := func(ch *Channel[string]) *Arm[string] {
				return OnRecv(c, ch, func(_ *Ctx, v string, _ bool) string { return v })
			}
			for range 3 {
				got = append(got, Select(c, []*Arm[string]{label(a), label(b)}))
			}
		})
		if fmt.Sprint(got) != "[a a b]" && fmt.Sprint(got) != "[a b a]" && fmt.Sprint(got) != "[b a a]" {
			t.Fatalf("%s: %v", name, got)
		}
	}
}

func TestSelectTieIsSeeded(t *testing.T) {
	winners := map[string]bool{}
	for seed := int64(0); seed < 20; seed++ {
		var runs []string
		for range 2 {
			RunScopeUnit(NewSim(seed).Root(), func(c *Ctx, s *Scope) {
				a := NewChannel[string](c, s, 1)
				b := NewChannel[string](c, s, 1)
				a.Send(c, "a")
				b.Send(c, "b")
				id := func(_ *Ctx, v string, _ bool) string { return v }
				runs = append(runs, Select(c, []*Arm[string]{OnRecv(c, a, id), OnRecv(c, b, id)}))
			})
		}
		if runs[0] != runs[1] {
			t.Fatalf("seed %d: %s, then %s", seed, runs[0], runs[1])
		}
		winners[runs[0]] = true
	}
	if len(winners) != 2 {
		t.Fatalf("20 seeds, and the winners were %v", winners)
	}
}

func TestSelectWakesOnCancellation(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		got := RunScope(root(), func(c *Ctx, s *Scope) result {
			a := NewChannel[int64](c, s, 0)
			b := NewChannel[int64](c, s, 0)
			Spawn(c, s, func(c *Ctx) result {
				Select(c, []*Arm[struct{}]{OnRecv(c, a, func(*Ctx, int64, bool) struct{} { return struct{}{} })})
				return result{ok: true}
			}, toScope)
			Spawn(c, s, func(c *Ctx) result {
				Select(c, []*Arm[struct{}]{OnSend(c, b, 1, unit), After(c, 100_000, unit)})
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

func TestSelectOnAClosedChannel(t *testing.T) {
	noLeaks(t)
	for name, root := range contexts() {
		p := recovered(func() {
			RunScopeUnit(root(), func(c *Ctx, s *Scope) {
				ch := NewChannel[int64](c, s, 0)
				ch.Close(c)
				Select(c, []*Arm[struct{}]{OnSend(c, ch, 1, unit)})
			})
		})
		if p != "candor: send on a Channel that is closed" {
			t.Fatalf("%s: recovered %v", name, p)
		}
	}
}

func TestSelectFindsDeadlock(t *testing.T) {
	// No noLeaks: in a deadlock the waiting tasks' goroutines stay parked for good.
	p := recovered(func() {
		RunScopeUnit(NewSim(3).Root(), func(c *Ctx, s *Scope) {
			ch := NewChannel[int64](c, s, 0)
			SpawnUnit(c, s, func(c *Ctx) {
				Select(c, []*Arm[struct{}]{OnRecv(c, ch, func(*Ctx, int64, bool) struct{} { return struct{}{} })})
			})
		})
	})
	want := "candor: deadlock: every task is waiting and nothing can wake them (1 on its scope's tasks, 1 on tasks.select)\n" +
		"  is a Channel never closed? `ch.close()` makes its `onRecv` arm ready; `tasks.after(ms, ...)` gives up waiting"
	if p != want {
		t.Fatalf("recovered %v", p)
	}
}

func TestSelectArms(t *testing.T) {
	one := func(*Ctx) int64 { return 1 }
	p := recovered(func() { Select(Root(), []*Arm[int64]{Otherwise(Root(), one), Otherwise(Root(), one)}) })
	if p != "candor: tasks.select takes one `otherwise` arm" {
		t.Fatalf("recovered %v", p)
	}
	p = recovered(func() { Select(Root(), []*Arm[int64]{}) })
	if p != "candor: tasks.select needs at least one arm" {
		t.Fatalf("recovered %v", p)
	}
	var kept *Arm[int64]
	c := Root()
	RunScopeUnit(c, func(c *Ctx, s *Scope) {
		kept = OnRecv(c, NewChannel[int64](c, s, 1), func(*Ctx, int64, bool) int64 { return 1 })
	})
	p = recovered(func() { Select(c, []*Arm[int64]{kept}) })
	if p != "candor: a Channel used after its scope ended" {
		t.Fatalf("recovered %v", p)
	}
}
