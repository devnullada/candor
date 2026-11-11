package candor

import (
	"sync"
	"sync/atomic"
)

// Ctx is the hidden first parameter of every generated function, `ctx__`: which task the code
// runs in, and whether that task has been cancelled. Candor code never sees it.
type Ctx struct {
	tok *token
	// Under the test scheduler: the scheduler, and the task this code runs as. Nil otherwise.
	sim *Sim
	st  *simTask
	// The task this code runs in, through nested scopes, so `s.wait()` can refuse to wait for
	// itself. Nil in `main` and in a test's own code.
	task *core
	// Inside the function given to Mutex.update: how many locks this task holds.
	locked int
	// Inside the function given to Lock.hold, or in a task spawned there: another hold panics.
	holding bool
	// Inside `sql.transaction`: the transaction its queries run in, shared with the tasks it
	// spawns.
	tx *sqlTx
}

// Root is the context `main` runs in: real goroutines, never cancelled.
func Root() *Ctx { return &Ctx{tok: newToken(nil)} }

// cancelled is what a cancelled task panics with to unwind. The group that started the task
// recovers it; Candor code cannot.
type cancelled struct{}

// Deferred runs the body of a Candor `defer`, when its function returns or unwinds. The body
// may run because the task was cancelled, so it gets a token of its own: its effect operations
// and loops run to the end instead of stopping at once.
func Deferred(c *Ctx, body func(*Ctx)) {
	shielded := *c
	shielded.tok = newToken(nil)
	body(&shielded)
}

// Check stops the task if it has been cancelled. Generated loops call it on every iteration.
func (c *Ctx) Check() {
	if c.tok.cancelled.Load() {
		panic(cancelled{})
	}
}

// point is every effect operation: a place to stop if cancelled and, under the test
// scheduler, to let another task run.
func (c *Ctx) point() {
	if c.locked > 0 {
		panic("candor: the function given to `update` runs while its Mutex is locked, so it can only compute: it can't use a Mutex, Atomic, Channel or Task. State checked together belongs in one Mutex, with the check inside its updateWith")
	}
	c.Check()
	if c.sim != nil {
		c.sim.yield(c.st)
		c.Check()
	}
}

// token is a cancellation flag. Cancelling one cancels every token made from it.
type token struct {
	cancelled atomic.Bool
	// Closed on cancel, for waits that must wake up.
	done     chan struct{}
	mu       sync.Mutex
	parent   *token
	children map[*token]struct{}
}

func newToken(parent *token) *token {
	t := &token{done: make(chan struct{}), parent: parent}
	if parent == nil {
		return t
	}
	parent.mu.Lock()
	if parent.cancelled.Load() {
		parent.mu.Unlock()
		t.cancel()
		return t
	}
	if parent.children == nil {
		parent.children = map[*token]struct{}{}
	}
	parent.children[t] = struct{}{}
	parent.mu.Unlock()
	return t
}

func (t *token) cancel() {
	t.mu.Lock()
	if t.cancelled.Load() {
		t.mu.Unlock()
		return
	}
	t.cancelled.Store(true)
	close(t.done)
	kids := t.children
	t.children = nil
	t.mu.Unlock()
	for k := range kids {
		k.cancel()
	}
}

// detach forgets t in its parent, once the scope it belongs to has ended.
func (t *token) detach() {
	if p := t.parent; p != nil {
		p.mu.Lock()
		delete(p.children, t)
		p.mu.Unlock()
	}
}
