package candor

import (
	"reflect"
	"time"
)

// Arm is `Arm<R>`: one choice for `tasks.select`: a receive, a send, a timeout, or
// `otherwise`. Its function runs in the selecting task once the arm is picked, and what it
// returns is the select's result.
type Arm[R any] struct {
	kind armKind
	// The Channel, for a receive or a send.
	ch armChan
	// What a send sends, as reflect.Select wants it; and the send under the test scheduler.
	send reflect.Value
	put  func()
	// After how long, for `tasks.after`.
	ms int64
	// The function, given what a receive got and whether it got anything.
	run func(c *Ctx, v any, ok bool) R
}

type armKind int

const (
	armRecv armKind = iota
	armSend
	armAfter
	armOtherwise
)

// armChan is what select needs of a Channel, whatever it carries.
type armChan interface {
	inScope()
	goChan() reflect.Value
	// Under the test scheduler.
	canRecv() bool
	canSend() bool
	take() (any, bool)
	wait(r *receiver)
	leave(r *receiver)
	waitToSend(st *simTask)
	leaveSend(st *simTask)
}

// OnRecv is `ch.onRecv(f)`: ready when the channel has a value, or is closed; f gets the value
// and whether there was one.
func OnRecv[T, R any](c *Ctx, ch *Channel[T], f func(*Ctx, T, bool) R) *Arm[R] {
	return &Arm[R]{kind: armRecv, ch: ch, run: func(c *Ctx, v any, ok bool) R {
		t, _ := v.(T)
		return f(c, t, ok)
	}}
}

// OnSend is `ch.onSend(v, f)`: ready when the channel can take v.
func OnSend[T, R any](c *Ctx, ch *Channel[T], v T, f func(*Ctx) R) *Arm[R] {
	return &Arm[R]{
		kind: armSend,
		ch:   ch,
		send: reflect.ValueOf(&v).Elem(),
		put:  func() { ch.put(v) },
		run:  func(c *Ctx, _ any, _ bool) R { return f(c) },
	}
}

// After is `tasks.after(ms, f)`: ready once ms have passed since the select began.
func After[R any](c *Ctx, ms int64, f func(*Ctx) R) *Arm[R] {
	return &Arm[R]{kind: armAfter, ms: ms, run: func(c *Ctx, _ any, _ bool) R { return f(c) }}
}

// Otherwise is `tasks.otherwise(f)`: picked at once when no other arm is ready.
func Otherwise[R any](c *Ctx, f func(*Ctx) R) *Arm[R] {
	return &Arm[R]{kind: armOtherwise, run: func(c *Ctx, _ any, _ bool) R { return f(c) }}
}

// Select is `tasks.select(arms)`: waits until an arm is ready, picks one of those at random
// (by the seed, under the test scheduler), runs its function and returns what it gave. A
// cancelled task stops here instead.
func Select[R any](c *Ctx, arms []*Arm[R]) R {
	c.point()
	if len(arms) == 0 {
		panic("candor: tasks.select needs at least one arm")
	}
	otherwise := 0
	for _, a := range arms {
		if a.ch != nil {
			a.ch.inScope()
		}
		if a.kind == armOtherwise {
			otherwise++
		}
	}
	if otherwise > 1 {
		panic("candor: tasks.select takes one `otherwise` arm")
	}
	if c.sim != nil {
		return selectSim(c, arms).pick(c)
	}
	return selectGo(c, arms)
}

// pick, under the test scheduler, once the arm is ready: the receive or send, then the function.
func (a *Arm[R]) pick(c *Ctx) R {
	switch a.kind {
	case armRecv:
		v, ok := a.ch.take()
		return a.run(c, v, ok)
	case armSend:
		a.put()
	}
	return a.run(c, nil, false)
}

// selectSim finds the arm to pick. The task waits in every channel its arms use, and for the
// earliest timeout; woken, it looks again. A sender that paired with it says which channel to
// take from; otherwise the ready arms are drawn from.
func selectSim[R any](c *Ctx, arms []*Arm[R]) *Arm[R] {
	s := c.sim
	me := c.st
	start := s.now
	due := int64(-1)
	for _, a := range arms {
		if a.kind == armAfter && (due < 0 || start+a.ms < due) {
			due = start + a.ms
		}
	}
	if due >= 0 {
		t := s.addTimer(due, me, nil)
		defer s.removeTimer(t)
	}
	for {
		c.Check()
		var ready, fallback []*Arm[R]
		for _, a := range arms {
			switch a.kind {
			case armRecv:
				if a.ch.canRecv() {
					ready = append(ready, a)
				}
			case armSend:
				if a.ch.canSend() {
					ready = append(ready, a)
				}
			case armAfter:
				if s.now >= start+a.ms {
					ready = append(ready, a)
				}
			case armOtherwise:
				fallback = append(fallback, a)
			}
		}
		if len(ready) == 0 {
			ready = fallback
		}
		if len(ready) > 0 {
			return ready[s.draw(len(ready))]
		}
		r := &receiver{st: me}
		for _, a := range arms {
			switch a.kind {
			case armRecv:
				a.ch.wait(r)
			case armSend:
				a.ch.waitToSend(me)
			}
		}
		s.block(me, c.tok, "tasks.select")
		for _, a := range arms {
			switch a.kind {
			case armRecv:
				a.ch.leave(r)
			case armSend:
				a.ch.leaveSend(me)
			}
		}
		if r.on != nil && r.on.canRecv() {
			for _, a := range arms {
				if a.kind == armRecv && a.ch == r.on {
					return a
				}
			}
		}
	}
}

// selectGo is Select on goroutines: Go's own select, over any number of arms, through reflect.
func selectGo[R any](c *Ctx, arms []*Arm[R]) R {
	cases := make([]reflect.SelectCase, len(arms)+1)
	var timers []*time.Timer
	for i, a := range arms {
		switch a.kind {
		case armRecv:
			cases[i] = reflect.SelectCase{Dir: reflect.SelectRecv, Chan: a.ch.goChan()}
		case armSend:
			cases[i] = reflect.SelectCase{Dir: reflect.SelectSend, Chan: a.ch.goChan(), Send: a.send}
		case armAfter:
			t := time.NewTimer(time.Duration(a.ms) * time.Millisecond)
			timers = append(timers, t)
			cases[i] = reflect.SelectCase{Dir: reflect.SelectRecv, Chan: reflect.ValueOf(t.C)}
		case armOtherwise:
			cases[i] = reflect.SelectCase{Dir: reflect.SelectDefault}
		}
	}
	cases[len(arms)] = reflect.SelectCase{Dir: reflect.SelectRecv, Chan: reflect.ValueOf(c.tok.done)}
	chosen, got, ok := func() (int, reflect.Value, bool) {
		defer closedPanic("send")
		return reflect.Select(cases)
	}()
	for _, t := range timers {
		t.Stop()
	}
	if chosen == len(arms) {
		c.Check()
		panic("unreachable")
	}
	a := arms[chosen]
	if a.kind == armRecv {
		var v any
		if ok {
			v = got.Interface()
		}
		return a.run(c, v, ok)
	}
	return a.run(c, nil, false)
}
