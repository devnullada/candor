package candor

import (
	"context"
	"time"
)

// Op is the start of every operation of a user-declared effect: a place where a cancelled task
// stops and, under the test scheduler, where another task may run.
func (c *Ctx) Op() { c.point() }

// Context is the task as a Go context, for Go functions a binding declares with `ctx`: it is
// cancelled when the task is.
func (c *Ctx) Context() context.Context { return goContext{c.tok} }

type goContext struct{ tok *token }

func (goContext) Deadline() (time.Time, bool) { return time.Time{}, false }
func (g goContext) Done() <-chan struct{}     { return g.tok.done }
func (goContext) Value(any) any               { return nil }

func (g goContext) Err() error {
	if g.tok.cancelled.Load() {
		return context.Canceled
	}
	return nil
}
