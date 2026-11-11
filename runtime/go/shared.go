package candor

import (
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
)

// What tasks share: a Mutex, an Atomic or a Channel, made by a scope with `s.mutex(v)`,
// `s.atomic(v)` or `s.channel(n)`. They belong to it, like its tasks: once the scope has ended,
// using one panics.

// alive panics if g, the scope that made a `what`, has ended.
func alive(g *group, what string) {
	if g.closed.Load() {
		panic("candor: a " + what + " used after its scope ended")
	}
}

// Mutex is `Mutex<T>`: a value tasks change one at a time.
//
// The function given to update runs under the lock, so it may only compute: no effects (the
// checker sees to that) and no Mutex, Atomic, Channel or Task (Ctx.point panics). So a lock is
// never held while waiting for another one, and Mutexes cannot deadlock. Under the test
// scheduler nothing yields while a lock is held, so the lock is never contended there.
type Mutex[T any] struct {
	g  *group
	mu sync.Mutex
	v  T
}

// NewMutex is `s.mutex(v)`.
func NewMutex[T any](c *Ctx, s *Scope, v T) *Mutex[T] {
	c.point()
	return &Mutex[T]{g: s.g, v: v}
}

// Get is `m.get()`: the value now.
func (m *Mutex[T]) Get(c *Ctx) T {
	c.point()
	alive(m.g, "Mutex")
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.v
}

// Update is `m.update(f)`: stores f of the value, and returns it.
func (m *Mutex[T]) Update(c *Ctx, f func(*Ctx, T) T) T {
	return UpdateWith(c, m, func(c *Ctx, v T) struct {
		V0 T
		V1 T
	} {
		n := f(c, v)
		return struct {
			V0 T
			V1 T
		}{n, n}
	})
}

// UpdateWith is `m.updateWith(f)`: f gives the new value and a result, which it returns. If f
// stops (a crash, or cancellation), the value is unchanged.
func UpdateWith[T, R any](c *Ctx, m *Mutex[T], f func(*Ctx, T) struct {
	V0 T
	V1 R
}) R {
	c.point()
	alive(m.g, "Mutex")
	m.mu.Lock()
	defer m.mu.Unlock()
	c.locked++
	defer func() { c.locked-- }()
	r := f(c, m.v)
	m.v = r.V0
	return r.V1
}

// Lock is `Lock`: what its hold functions do, one task at a time. Unlike a Mutex's, they may use
// effects: a file's read-change-write. It holds no value.
//
// A task holds one Lock at a time (a hold inside a hold panics, in tasks spawned there too), so
// two Locks can't be taken in opposite orders and deadlock. On goroutines it is a one-slot Go
// channel, so a wait can be cancelled; under the test scheduler, a flag and the tasks waiting.
type Lock struct {
	g    *group
	slot chan struct{}
	// Under the test scheduler.
	sim     *Sim
	held    bool
	waiters []*simTask
}

// NewLock is `s.lock()`.
func NewLock(c *Ctx, s *Scope) *Lock {
	c.point()
	if c.sim != nil {
		return &Lock{g: s.g, sim: c.sim}
	}
	return &Lock{g: s.g, slot: make(chan struct{}, 1)}
}

// Hold is `lock.hold(f)`: f's result, once f has run with no other task holding the lock. It is
// let go however f ends: returning, panicking or cancelled.
func Hold[R any](c *Ctx, l *Lock, f func(*Ctx) R) R {
	c.point()
	alive(l.g, "Lock")
	if c.holding {
		panic("candor: Lock.hold inside a hold: a task holds one Lock at a time, since two taken in opposite orders deadlock. Guard what is changed together with one Lock")
	}
	if s := l.sim; s != nil {
		for l.held {
			c.Check()
			s.waitIn(&l.waiters, c.st, c.tok, "Lock.hold")
		}
		c.Check()
		l.held = true
		defer func() {
			l.held = false
			s.wakeAll(&l.waiters)
		}()
	} else {
		select {
		case l.slot <- struct{}{}:
		case <-c.tok.done:
			c.Check()
		}
		defer func() { <-l.slot }()
	}
	c.holding = true
	defer func() { c.holding = false }()
	return f(c)
}

// AtomicInt is `Atomic<int>`.
type AtomicInt struct {
	g *group
	v atomic.Int64
}

// NewAtomicInt is `s.atomic(n)`.
func NewAtomicInt(c *Ctx, s *Scope, n int64) *AtomicInt {
	c.point()
	a := &AtomicInt{g: s.g}
	a.v.Store(n)
	return a
}

func (a *AtomicInt) Get(c *Ctx) int64 {
	c.point()
	alive(a.g, "Atomic")
	return a.v.Load()
}

func (a *AtomicInt) Set(c *Ctx, n int64) {
	c.point()
	alive(a.g, "Atomic")
	a.v.Store(n)
}

// Add is `a.add(n)`: the value after adding.
func (a *AtomicInt) Add(c *Ctx, n int64) int64 {
	c.point()
	alive(a.g, "Atomic")
	return a.v.Add(n)
}

// CompareAndSet is `a.compareAndSet(old, new)`: whether the value was old, and is now new.
func (a *AtomicInt) CompareAndSet(c *Ctx, old, new int64) bool {
	c.point()
	alive(a.g, "Atomic")
	return a.v.CompareAndSwap(old, new)
}

// AtomicBool is `Atomic<bool>`.
type AtomicBool struct {
	g *group
	v atomic.Bool
}

// NewAtomicBool is `s.atomic(b)`.
func NewAtomicBool(c *Ctx, s *Scope, b bool) *AtomicBool {
	c.point()
	a := &AtomicBool{g: s.g}
	a.v.Store(b)
	return a
}

func (a *AtomicBool) Get(c *Ctx) bool {
	c.point()
	alive(a.g, "Atomic")
	return a.v.Load()
}

func (a *AtomicBool) Set(c *Ctx, b bool) {
	c.point()
	alive(a.g, "Atomic")
	a.v.Store(b)
}

func (a *AtomicBool) CompareAndSet(c *Ctx, old, new bool) bool {
	c.point()
	alive(a.g, "Atomic")
	return a.v.CompareAndSwap(old, new)
}

// Channel is `Channel<T>`: values passed from task to task in order. With capacity 0, a send
// waits for a receiver; with n, for room among n.
//
// On goroutines it is a Go channel. The test scheduler has its own, since a goroutine blocked
// on a Go channel would hold the turn: a queue of what was sent, where a sender waits until its
// item is taken or fits in the capacity, and the tasks waiting to receive. A sender that finds
// one claims it, so no two senders count on the same receiver: a `tasks.select` waits in every
// channel it receives from at once.
type Channel[T any] struct {
	g  *group
	ch chan T
	// Under the test scheduler.
	sim    *Sim
	size   int
	queue  []*item[T]
	closed bool
	// Senders waiting for their item to be taken, or to fit.
	senders []*simTask
	// Tasks in a `tasks.select` with a send on this channel, waiting for it to be possible.
	selectors []*simTask
	// Tasks waiting to receive, in order.
	receivers []*receiver
}

type item[T any] struct {
	v     T
	taken bool
}

// receiver is a task blocked until a channel has something for it. A `tasks.select` puts the
// same receiver in every channel it receives from; the sender that pairs with it sets `on`, so
// that select takes from that channel and no other sender counts on it.
type receiver struct {
	st *simTask
	on armChan
}

// NewChannel is `s.channel(n)`.
func NewChannel[T any](c *Ctx, s *Scope, n int64) *Channel[T] {
	c.point()
	if n < 0 {
		panic("candor: a Channel's capacity can't be negative")
	}
	if c.sim != nil {
		return &Channel[T]{g: s.g, sim: c.sim, size: int(n)}
	}
	return &Channel[T]{g: s.g, ch: make(chan T, n)}
}

// closedPanic turns Go's panics on a closed channel into Candor's.
func closedPanic(what string) {
	if p := recover(); p != nil {
		if e, ok := p.(error); ok && strings.Contains(e.Error(), "closed channel") {
			panic("candor: " + what + " on a Channel that is closed")
		}
		panic(p)
	}
}

// Send is `ch.send(v)`. Cancellation stops the wait, and the value is not sent.
func (ch *Channel[T]) Send(c *Ctx, v T) {
	c.point()
	alive(ch.g, "Channel")
	if s := ch.sim; s != nil {
		if ch.closed {
			panic("candor: send on a Channel that is closed")
		}
		it := &item[T]{v: v}
		ch.queue = append(ch.queue, it)
		ch.offer()
		for !it.taken && slices.Index(ch.queue, it) >= ch.size {
			if ch.closed || c.tok.cancelled.Load() {
				ch.queue = slices.DeleteFunc(ch.queue, func(x *item[T]) bool { return x == it })
				if ch.closed {
					panic("candor: send on a Channel that is closed")
				}
				c.Check()
			}
			s.waitIn(&ch.senders, c.st, c.tok, "Channel.send")
		}
		return
	}
	defer closedPanic("send")
	select {
	case ch.ch <- v:
	case <-c.tok.done:
		c.Check()
	}
}

// Recv is `ch.recv()`: the next value, or false once the channel is closed and empty.
func (ch *Channel[T]) Recv(c *Ctx) (T, bool) {
	c.point()
	alive(ch.g, "Channel")
	if s := ch.sim; s != nil {
		for len(ch.queue) == 0 {
			if ch.closed {
				var zero T
				return zero, false
			}
			c.Check()
			r := &receiver{st: c.st}
			ch.wait(r)
			s.block(c.st, c.tok, "Channel.recv")
			ch.leave(r)
		}
		c.Check()
		return ch.next()
	}
	select {
	case v, ok := <-ch.ch:
		return v, ok
	case <-c.tok.done:
		c.Check()
		panic("unreachable")
	}
}

// Close is `ch.close()`: receivers get what is left, then none. A second close panics.
func (ch *Channel[T]) Close(c *Ctx) {
	c.point()
	alive(ch.g, "Channel")
	if s := ch.sim; s != nil {
		if ch.closed {
			panic("candor: close on a Channel that is closed")
		}
		ch.closed = true
		s.wakeAll(&ch.senders)
		s.wakeAll(&ch.selectors)
		for _, r := range ch.receivers {
			if r.st.blocked {
				s.makeReady(r.st)
			}
		}
		return
	}
	defer closedPanic("close")
	close(ch.ch)
}

// The test scheduler's channel, below the operations above and `tasks.select`.

// offer, after queueing an item: the first receiver no sender has claimed is woken, and will
// take from this channel.
func (ch *Channel[T]) offer() {
	for _, r := range ch.receivers {
		if r.on == nil {
			r.on = ch
			if r.st.blocked {
				ch.sim.makeReady(r.st)
			}
			return
		}
	}
}

// next, once canRecv: the first item, waking the sender waiting on it and anyone waiting for
// room; or nothing, on a closed channel that is empty.
func (ch *Channel[T]) next() (T, bool) {
	if len(ch.queue) == 0 {
		var zero T
		return zero, false
	}
	it := ch.queue[0]
	ch.queue = ch.queue[1:]
	it.taken = true
	ch.sim.wakeAll(&ch.senders)
	ch.sim.wakeAll(&ch.selectors)
	return it.v, true
}

// put is a send chosen by `tasks.select`, once canSend: queued, and offered to a receiver.
func (ch *Channel[T]) put(v T) {
	if ch.closed {
		panic("candor: send on a Channel that is closed")
	}
	ch.queue = append(ch.queue, &item[T]{v: v})
	ch.offer()
}

// wait registers r to receive. A select waiting to send here can now go ahead.
func (ch *Channel[T]) wait(r *receiver) {
	ch.receivers = append(ch.receivers, r)
	ch.sim.wakeAll(&ch.selectors)
}

func (ch *Channel[T]) leave(r *receiver) {
	ch.receivers = slices.DeleteFunc(ch.receivers, func(x *receiver) bool { return x == r })
}

// What `tasks.select` needs of a Channel, whatever it carries (see select.go).

func (ch *Channel[T]) inScope() { alive(ch.g, "Channel") }

func (ch *Channel[T]) goChan() reflect.Value { return reflect.ValueOf(ch.ch) }

func (ch *Channel[T]) canRecv() bool { return len(ch.queue) > 0 || ch.closed }

// canSend: there is room, or a receiver no sender has claimed. A closed channel takes the send
// too, which then panics, as in Go.
func (ch *Channel[T]) canSend() bool {
	return ch.closed || len(ch.queue) < ch.size || slices.ContainsFunc(ch.receivers, func(r *receiver) bool { return r.on == nil })
}

func (ch *Channel[T]) take() (any, bool) {
	v, ok := ch.next()
	if !ok {
		return nil, false
	}
	return v, true
}

func (ch *Channel[T]) waitToSend(st *simTask) { ch.selectors = append(ch.selectors, st) }

func (ch *Channel[T]) leaveSend(st *simTask) {
	ch.selectors = slices.DeleteFunc(ch.selectors, func(x *simTask) bool { return x == st })
}

// Both is `tasks.both(fa, fb)`: both results at once, and which failed first (1 or 2), or 0.
// A failure cancels the other.
func Both[A, B any](c *Ctx, fa func(*Ctx) A, fb func(*Ctx) B, failedA func(A) bool, failedB func(B) bool) (A, B, int) {
	c.point()
	g := newGroup(c)
	var a A
	var b B
	first := 0
	fail := func(n int) {
		g.mu.Lock()
		isFirst := first == 0
		if isFirst {
			first = n
		}
		g.mu.Unlock()
		if isFirst {
			g.cancel()
		}
	}
	g.start(func(tc *Ctx) {
		a = fa(tc)
		if failedA != nil && failedA(a) {
			fail(1)
		}
	})
	g.start(func(tc *Ctx) {
		b = fb(tc)
		if failedB != nil && failedB(b) {
			fail(2)
		}
	})
	g.wait()
	g.finish()
	return a, b, first
}
