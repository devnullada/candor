package candor

import (
	"sync"
	"sync/atomic"
	"time"
)

// Tasks is the `tasks` effect. It carries nothing: having it is the permission to run things
// concurrently, and the context decides how (goroutines, or the test scheduler).
type Tasks interface{ tasks() }

// RealTasks returns the `tasks` effect for `main`.
func RealTasks() Tasks { return realTasks{} }

type realTasks struct{}

func (realTasks) tasks() {}

// FakeTasks is the `tasks` effect in tests. Tests run tasks on the deterministic scheduler.
type FakeTasks struct{}

func (*FakeTasks) tasks() {}

// group is the tasks of one scope. It cannot end before every one of them has: structured
// concurrency. The first failure or crash cancels the rest.
type group struct {
	parent *Ctx
	// Where the scope's own code runs: the parent's task, with the group's token.
	ctx *Ctx
	mu  sync.Mutex
	// A panic other than cancellation (a bug, or a failed `assert`), re-raised by finish.
	crash any
	// Every task has ended: nothing may be spawned on it, and its Mutexes, Atomics and Channels
	// are gone.
	closed atomic.Bool
	wg     sync.WaitGroup
	// Every task started so far: what the scope waits for under the test scheduler, and what
	// `s.wait()` waits for.
	cores []*core
	// #dfd9edd7: the token of `s.background` tasks, made by the first one, cancelled once the
	// scope's code has returned and every other task has ended.
	bgTok *token
	// Tasks not in the background still running, with real goroutines, and a signal when none is.
	fg     int
	fgIdle *sync.Cond
	// What runs once every task has ended, such as stopping `env.signals` (#cb18c33b).
	ends []func()
}

// atEnd runs f once every task of g has ended.
func (g *group) atEnd(f func()) {
	g.mu.Lock()
	g.ends = append(g.ends, f)
	g.mu.Unlock()
}

func newGroup(c *Ctx) *group {
	g := &group{parent: c}
	g.ctx = &Ctx{tok: newToken(c.tok), sim: c.sim, st: c.st, task: c.task, tx: c.tx, holding: c.holding}
	g.fgIdle = sync.NewCond(&g.mu)
	return g
}

// background is the token of g's background tasks.
func (g *group) background() *token {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.bgTok == nil {
		g.bgTok = newToken(g.ctx.tok)
	}
	return g.bgTok
}

// stopBackground cancels g's background tasks, if it has any.
func (g *group) stopBackground() {
	g.mu.Lock()
	t := g.bgTok
	g.mu.Unlock()
	if t == nil {
		return
	}
	t.cancel()
	if g.parent.sim != nil {
		g.parent.sim.wakeCancelled()
	}
}

func (g *group) cancel() {
	g.ctx.tok.cancel()
	if g.parent.sim != nil {
		g.parent.sim.wakeCancelled()
	}
}

func (g *group) setCrash(p any) {
	g.mu.Lock()
	if g.crash == nil {
		g.crash = p
	}
	g.mu.Unlock()
	g.cancel()
}

// core is one task's state, whatever its result type.
type core struct {
	done chan struct{}
	// Under the test scheduler, set instead of closing done.
	finished bool
	// It stopped without a result: cancelled, or crashed.
	stopped bool
	waiters []*simTask
	// Started by `s.background`: the scope doesn't wait for it to end on its own.
	background bool
}

// start runs f as a new task in g.
func (g *group) start(f func(c *Ctx)) *core {
	return g.startTask(f, false)
}

// startTask runs f as a new task in g, in the background or not.
func (g *group) startTask(f func(c *Ctx), background bool) *core {
	if g.closed.Load() {
		panic("candor: spawn on a scope that has already ended")
	}
	k := &core{done: make(chan struct{}), background: background}
	tok := g.ctx.tok
	if background {
		tok = g.background()
	}
	tc := &Ctx{tok: tok, sim: g.parent.sim, task: k, tx: g.ctx.tx, holding: g.ctx.holding}
	g.mu.Lock()
	g.cores = append(g.cores, k)
	if !background && g.parent.sim == nil {
		g.fg++
	}
	g.mu.Unlock()
	run := func() {
		defer func() {
			if p := recover(); p != nil {
				k.stopped = true
				if _, ok := p.(cancelled); !ok {
					g.setCrash(crashOf(p))
				}
			}
		}()
		f(tc)
	}
	if s := g.parent.sim; s != nil {
		tc.st = s.newTask()
		go func() {
			<-tc.st.wake
			run()
			k.finished = true
			s.finish(tc.st, k)
		}()
		s.makeReady(tc.st)
		return k
	}
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		run()
		close(k.done)
		if !background {
			g.mu.Lock()
			g.fg--
			if g.fg == 0 {
				g.fgIdle.Broadcast()
			}
			g.mu.Unlock()
		}
	}()
	return k
}

// wait blocks until every task in g has ended. Cancellation does not interrupt it: a task
// never outlives its scope. Background tasks are cancelled once the others have ended.
func (g *group) wait() {
	defer func() {
		for i := len(g.ends) - 1; i >= 0; i-- {
			g.ends[i]()
		}
	}()
	g.waitForeground()
	g.stopBackground()
	if s := g.parent.sim; s != nil {
		// Once the root task has a deadlock to report, every wait of its ends in that report
		// (see Sim.block). When the scope's own code was reported first, that crash is the one to
		// raise: it carries the frames of where the tasks got stuck.
		defer func() {
			if p := recover(); p != nil {
				if g.crash != nil {
					panic(g.crash)
				}
				panic(p)
			}
		}()
		for i := 0; i < len(g.cores); i++ {
			for !g.cores[i].finished {
				s.blockOn(g.parent.st, nil, g.cores[i], "its scope's tasks")
			}
		}
	} else {
		g.wg.Wait()
	}
	g.closed.Store(true)
	if g.bgTok != nil {
		g.bgTok.detach()
	}
	g.ctx.tok.detach()
}

// waitForeground blocks until every task in g not in the background has ended, those they
// start included.
func (g *group) waitForeground() {
	if s := g.parent.sim; s != nil {
		defer func() {
			if p := recover(); p != nil {
				if g.crash != nil {
					panic(g.crash)
				}
				panic(p)
			}
		}()
		for i := 0; i < len(g.cores); i++ {
			for k := g.cores[i]; !k.background && !k.finished; {
				s.blockOn(g.parent.st, nil, k, "its scope's tasks")
			}
		}
		return
	}
	g.mu.Lock()
	for g.fg > 0 {
		g.fgIdle.Wait()
	}
	g.mu.Unlock()
}

// finish, after wait: re-raise a crash, or keep unwinding if the scope itself was cancelled.
func (g *group) finish() {
	if g.crash != nil {
		panic(g.crash)
	}
	g.parent.Check()
}

// timer calls fire after ms, unless stopped first. Stop waits for it to be gone.
func (g *group) timer(ms int64, fire func()) (stop func()) {
	if s := g.parent.sim; s != nil {
		t := s.addTimer(s.now+ms, nil, fire)
		return func() { s.removeTimer(t) }
	}
	quit := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTimer(time.Duration(ms) * time.Millisecond)
		defer t.Stop()
		select {
		case <-t.C:
			fire()
		case <-quit:
		}
	}()
	return func() {
		close(quit)
		wg.Wait()
	}
}

// Scope is `s` in `tasks.scope((s) => ...)`.
type Scope struct {
	g       *group
	failed  bool
	failure any
}

// fail records the scope's result as a failure, if it is the first, and cancels the rest.
func (s *Scope) fail(r any) {
	s.g.mu.Lock()
	first := !s.failed
	if first {
		s.failed = true
		s.failure = r
	}
	s.g.mu.Unlock()
	if first {
		s.g.cancel()
	}
}

// RunScope is `tasks.scope(body)`. failed says whether a result of the body is a failure; nil
// if it cannot be. The result is the body's, or the first failure of any task in it.
func RunScope[R any](c *Ctx, body func(*Ctx, *Scope) R, failed func(R) bool) R {
	c.point()
	s := &Scope{g: newGroup(c)}
	var r R
	if p := catch(func() { r = body(s.g.ctx, s) }); p != nil {
		if _, ok := p.(cancelled); ok {
			s.g.cancel()
		} else {
			s.g.setCrash(p)
		}
	} else if failed != nil && failed(r) {
		s.fail(r)
	}
	s.g.wait()
	s.g.finish()
	if s.failed {
		return s.failure.(R)
	}
	return r
}

// catch runs f and returns what it panicked with, carrying its Candor frames (see crashOf), or
// nil.
func catch(f func()) (p any) {
	defer func() { p = crashOf(recover()) }()
	f()
	return nil
}

// Task is the handle `s.spawn` returns.
type Task[T any] struct {
	k     *core
	value T
}

// Spawn is `s.spawn(f)`. fail turns a failed result into the scope's failure; nil if the
// task cannot fail.
func Spawn[T any](c *Ctx, s *Scope, f func(*Ctx) T, fail func(T) (any, bool)) *Task[T] {
	c.point()
	t := &Task[T]{}
	t.k = s.g.start(func(tc *Ctx) {
		v := f(tc)
		t.value = v
		if fail != nil {
			if r, bad := fail(v); bad {
				s.fail(r)
			}
		}
	})
	return t
}

// Background is `s.background(f)` (#dfd9edd7): a task the scope cancels once its function has
// returned and its other tasks have ended. A failure still becomes the scope's, as for Spawn.
func Background[T any](c *Ctx, s *Scope, f func(*Ctx) T, fail func(T) (any, bool)) {
	c.point()
	s.g.startTask(func(tc *Ctx) {
		v := f(tc)
		if fail != nil {
			if r, bad := fail(v); bad {
				s.fail(r)
			}
		}
	}, true)
}

// Join is `t.join()`: waits for the task's result.
func (t *Task[T]) Join(c *Ctx) T {
	c.point()
	if s := c.sim; s != nil {
		for !t.k.finished {
			c.Check()
			s.blockOn(c.st, c.tok, t.k, "Task.join")
		}
	} else {
		select {
		case <-t.k.done:
		case <-c.tok.done:
		}
	}
	c.Check()
	if t.k.stopped {
		panic("candor: joined a task that was cancelled")
	}
	return t.value
}

// Wait is `s.wait()`: blocks until every task spawned on the scope so far has ended, or the
// caller is cancelled; background tasks aside, which end with the scope. The scope stays open:
// more may be spawned after it. A task waiting on its own scope would wait for itself, so that
// is refused.
func (s *Scope) Wait(c *Ctx) {
	c.point()
	s.g.mu.Lock()
	var cores []*core
	for _, k := range s.g.cores {
		if !k.background {
			cores = append(cores, k)
		}
	}
	s.g.mu.Unlock()
	for _, k := range cores {
		if k == c.task {
			panic("candor: s.wait() inside one of the scope's tasks would wait for itself; for work of its own, a task opens a nested tasks.scope")
		}
	}
	for _, k := range cores {
		if sim := c.sim; sim != nil {
			for !k.finished {
				c.Check()
				sim.blockOn(c.st, c.tok, k, "Scope.wait")
			}
		} else {
			select {
			case <-k.done:
			case <-c.tok.done:
			}
		}
		c.Check()
	}
}

// All is `tasks.all(xs, f)` for an f that can fail: every result, and the index of the first
// failure, or -1. The first failure cancels the rest.
func All[A, B any](c *Ctx, xs []A, f func(*Ctx, A) B, failed func(B) bool) ([]B, int) {
	c.point()
	g := newGroup(c)
	out := make([]B, len(xs))
	first := -1
	for i, x := range xs {
		g.start(func(tc *Ctx) {
			v := f(tc, x)
			out[i] = v
			if failed != nil && failed(v) {
				g.mu.Lock()
				isFirst := first < 0
				if isFirst {
					first = i
				}
				g.mu.Unlock()
				if isFirst {
					g.cancel()
				}
			}
		})
	}
	g.wait()
	g.finish()
	return out, first
}

// AllValues is `tasks.all(xs, f)` for an f that cannot fail.
func AllValues[A, B any](c *Ctx, xs []A, f func(*Ctx, A) B) []B {
	out, _ := All(c, xs, f, nil)
	return out
}

// Race is `tasks.race(fs)`: the first result that is not a failure; the others are cancelled.
// If every one fails, the last failure.
func Race[T any](c *Ctx, fs []func(*Ctx) T, failed func(T) bool) T {
	if len(fs) == 0 {
		panic("candor: tasks.race needs at least one function")
	}
	c.point()
	g := newGroup(c)
	var win, lastFailure T
	won := false
	for _, f := range fs {
		g.start(func(tc *Ctx) {
			v := f(tc)
			g.mu.Lock()
			if won {
				g.mu.Unlock()
				return
			}
			if failed != nil && failed(v) {
				lastFailure = v
				g.mu.Unlock()
				return
			}
			won = true
			win = v
			g.mu.Unlock()
			g.cancel()
		})
	}
	g.wait()
	g.finish()
	if won {
		return win
	}
	return lastFailure
}

// Timeout is `tasks.timeout(ms, f)`: f's result, and false if time ran out first, in which
// case f was cancelled.
func Timeout[T any](c *Ctx, ms int64, f func(*Ctx) T) (T, bool) {
	c.point()
	g := newGroup(c)
	var v T
	var ok atomic.Bool
	stop := g.timer(ms, g.cancel)
	g.start(func(tc *Ctx) {
		v = f(tc)
		ok.Store(true)
	})
	g.wait()
	stop()
	g.finish()
	return v, ok.Load()
}

// TimeoutDone is `tasks.timeout(ms, f)` for an f that returns nothing: whether it finished in time.
func TimeoutDone(c *Ctx, ms int64, f func(*Ctx) struct{}) bool {
	_, ok := Timeout(c, ms, f)
	return ok
}
