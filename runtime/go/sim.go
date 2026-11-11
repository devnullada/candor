package candor

import (
	"fmt"
	"math/rand"
	"slices"
	"strings"
)

// Sim is the test scheduler. Tasks are goroutines, but exactly one runs at a time: the others
// wait for it to hand over at an effect call, a join, a sleep or its end. Which ready task goes
// next is decided by a seeded random number generator, so a seed replays an interleaving.
//
// Time is virtual. A sleeping task waits for the clock, and when no task is ready the clock
// jumps to the next timer, so a test of slow work takes no real time.
//
// Every field is touched only by the task holding the turn; handing it over goes through a
// channel, which orders the memory accesses on both sides.
type Sim struct {
	rng    *rand.Rand
	now    int64
	ready  []*simTask
	timers []*timer
	seq    int
	// Live tasks in creation order, for waking cancelled ones deterministically.
	tasks []*simTask
	// Whether any task besides the root was started.
	spawned bool
	// Whether the seed decided anything: a draw among several ready tasks, or select arms.
	chose bool
	// The test's own task, which reports a deadlock.
	root *simTask
	// Turns handed out so far: a uniform run's count sizes a PCT run.
	steps int
	// PCT (probabilistic concurrency testing): run the ready task of highest priority, and at
	// each of the change points (step numbers) drop the one about to run below every other.
	pct     bool
	changes []int
	lowered int
	depth   int
	// Set when every task waits and no timer is left: the report the root task panics with.
	dead string
}

type simTask struct {
	wake    chan struct{}
	blocked bool
	// What a block may be interrupted by: cancellation of this token. Nil: nothing.
	tok *token
	// What it waits for, for a deadlock report: "Channel.recv".
	waits string
	// Under PCT: the higher runs first.
	priority int64
}

type timer struct {
	at  int64
	seq int
	// Made ready when the timer fires, if still blocked.
	st *simTask
	// Called when the timer fires.
	fire func()
}

// NewSim makes a scheduler whose task order is decided by seed, each ready task as likely as
// another at every choice.
func NewSim(seed int64) *Sim { return &Sim{rng: rand.New(rand.NewSource(seed))} }

// NewPCTSim makes a PCT scheduler for a test that takes about k steps (turns), aiming at bugs of
// depth d: those that need d-1 particular preemptions. Tasks get random priorities, and d-1 of
// the k steps, picked by seed, are change points. A run finds a given bug of depth d with odds of at
// least 1/(n k^(d-1)) for n tasks, where a uniform choice at every step can be exponentially
// less likely (Burckhardt et al., "A Randomized Scheduler with Probabilistic Guarantees of
// Finding Bugs", 2010).
func NewPCTSim(seed int64, d int, k int) *Sim {
	s := NewSim(seed)
	s.pct = true
	s.depth = d
	for len(s.changes) < d-1 && len(s.changes) < k {
		c := 1 + s.rng.Intn(k)
		if !slices.Contains(s.changes, c) {
			s.changes = append(s.changes, c)
		}
	}
	return s
}

// pctDepth is the depth a seed's run aims at under PCT, or 0 for a uniform run: half the seeds
// each, so `--seed` replays either kind.
func pctDepth(seed int64) int {
	switch ((seed % 4) + 4) % 4 {
	case 1:
		return 2
	case 3:
		return 3
	}
	return 0
}

// Root is the context of the test itself, running on the caller's goroutine.
func (s *Sim) Root() *Ctx {
	s.root = s.newTask()
	return &Ctx{tok: newToken(nil), sim: s, st: s.root}
}

func (s *Sim) newTask() *simTask {
	s.spawned = s.spawned || len(s.tasks) > 0
	// Under PCT: above the change points' priorities (below d), random among themselves.
	st := &simTask{wake: make(chan struct{}, 1)}
	if s.pct {
		st.priority = 1_000 + s.rng.Int63n(1<<60)
	}
	s.tasks = append(s.tasks, st)
	return st
}

func (s *Sim) makeReady(st *simTask) {
	st.blocked = false
	st.tok = nil
	s.ready = append(s.ready, st)
}

// yield lets another ready task run, possibly me again.
func (s *Sim) yield(me *simTask) {
	s.ready = append(s.ready, me)
	s.switchFrom(me)
}

// block waits until someone makes me ready. With tok, its cancellation does. waits says what
// for, in a deadlock report.
//
// In a deadlock only the root task wakes, and it panics with the report; the others stay
// parked, since nothing can ever wake them.
func (s *Sim) block(me *simTask, tok *token, waits string) {
	me.blocked = true
	me.tok = tok
	me.waits = waits
	s.switchFrom(me)
	if s.dead != "" && me == s.root {
		panic(s.dead)
	}
}

// blockOn waits for k to finish, or for tok to be cancelled.
func (s *Sim) blockOn(me *simTask, tok *token, k *core, waits string) {
	k.waiters = append(k.waiters, me)
	s.block(me, tok, waits)
}

// waitIn blocks me until something wakes the tasks waiting in *list, or tok is cancelled.
func (s *Sim) waitIn(list *[]*simTask, me *simTask, tok *token, waits string) {
	*list = append(*list, me)
	s.block(me, tok, waits)
}

// wakeAll readies every task waiting in *list. Each checks again what it waits for.
func (s *Sim) wakeAll(list *[]*simTask) {
	for _, w := range *list {
		if w.blocked {
			s.makeReady(w)
		}
	}
	*list = nil
}

// deadlock describes what every task waits for.
func (s *Sim) deadlock() string {
	var order []string
	counts := map[string]int{}
	for _, st := range s.tasks {
		if !st.blocked {
			continue
		}
		if counts[st.waits] == 0 {
			order = append(order, st.waits)
		}
		counts[st.waits]++
	}
	parts := make([]string, len(order))
	for i, w := range order {
		parts[i] = fmt.Sprintf("%d on %s", counts[w], w)
	}
	msg := "candor: deadlock: every task is waiting and nothing can wake them (" + strings.Join(parts, ", ") + ")"
	if counts["Channel.recv"] > 0 {
		msg += "\n  is a Channel never closed? `ch.close()` ends a `for x in ch` loop"
	}
	if counts["tasks.select"] > 0 {
		msg += "\n  is a Channel never closed? `ch.close()` makes its `onRecv` arm ready; `tasks.after(ms, ...)` gives up waiting"
	}
	if counts["fs.watch"] > 0 {
		msg += "\n  is a watch waiting for a change no task makes? return `.Stop { value }` from its function to end it, or `clock.sleep(1)` before the writes so the watch has begun"
	}
	return msg
}

func (s *Sim) switchFrom(me *simTask) {
	next := s.next()
	if next == me {
		return
	}
	next.wake <- struct{}{}
	<-me.wake
}

// finish ends me, which ran k: its joiners are ready, and the turn goes on. The goroutine exits.
func (s *Sim) finish(me *simTask, k *core) {
	for _, w := range k.waiters {
		if w.blocked {
			s.makeReady(w)
		}
	}
	k.waiters = nil
	s.tasks = slices.DeleteFunc(s.tasks, func(t *simTask) bool { return t == me })
	s.next().wake <- struct{}{}
}

// next picks the task to run. With none ready, the clock moves to the next timer.
func (s *Sim) next() *simTask {
	for len(s.ready) == 0 {
		if len(s.timers) == 0 {
			if s.dead == "" {
				s.dead = s.deadlock()
			}
			s.makeReady(s.root)
			break
		}
		t := s.timers[0]
		s.timers = s.timers[1:]
		s.now = max(s.now, t.at)
		s.fire(t)
	}
	var i int
	s.steps++
	if s.pct {
		i = s.highest()
	} else {
		i = s.draw(len(s.ready))
	}
	st := s.ready[i]
	s.ready = slices.Delete(s.ready, i, i+1)
	return st
}

// highest is the ready task of highest priority, after a change point lowers it.
func (s *Sim) highest() int {
	top := func() int {
		best := 0
		for j, t := range s.ready {
			if t.priority > s.ready[best].priority {
				best = j
			}
		}
		return best
	}
	if len(s.ready) > 1 {
		s.chose = true
	}
	i := top()
	if slices.Contains(s.changes, s.steps) {
		s.lowered++
		// The i-th change point gives d-i: each later one lower still.
		s.ready[i].priority = int64(s.depth - s.lowered)
		i = top()
	}
	return i
}

// draw picks one of n by the seed, and notes that the seed mattered if it had a choice.
func (s *Sim) draw(n int) int {
	if n > 1 {
		s.chose = true
	}
	return s.rng.Intn(n)
}

func (s *Sim) fire(t *timer) {
	if t.st != nil && t.st.blocked {
		s.makeReady(t.st)
	}
	if t.fire != nil {
		t.fire()
	}
}

func (s *Sim) addTimer(at int64, st *simTask, fire func()) *timer {
	s.seq++
	t := &timer{at: at, seq: s.seq, st: st, fire: fire}
	i, _ := slices.BinarySearchFunc(s.timers, t, func(a, b *timer) int {
		if a.at != b.at {
			return int(min(max(a.at-b.at, -1), 1))
		}
		return a.seq - b.seq
	})
	s.timers = slices.Insert(s.timers, i, t)
	return t
}

func (s *Sim) removeTimer(t *timer) {
	s.timers = slices.DeleteFunc(s.timers, func(x *timer) bool { return x == t })
}

// setTime moves the clock, firing every timer it passes.
func (s *Sim) setTime(now int64) {
	s.now = now
	for len(s.timers) > 0 && s.timers[0].at <= now {
		t := s.timers[0]
		s.timers = s.timers[1:]
		s.fire(t)
	}
}

// wakeCancelled readies every task blocked on a token that is now cancelled, so it can unwind.
func (s *Sim) wakeCancelled() {
	for _, st := range s.tasks {
		if st.blocked && st.tok != nil && st.tok.cancelled.Load() {
			s.makeReady(st)
		}
	}
}

// sleep blocks the task until the virtual clock reaches now+ms.
func (s *Sim) sleep(c *Ctx, ms int64) {
	at := s.now + ms
	t := s.addTimer(at, c.st, nil)
	defer s.removeTimer(t)
	for s.now < at {
		c.Check()
		s.block(c.st, c.tok, "clock.sleep")
	}
}
