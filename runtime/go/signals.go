package candor

import (
	"os"
	"os/signal"
)

// signalBuffer is how many signals a channel from `env.signals` keeps unread; more are
// dropped, as Go's signal.Notify drops them.
const signalBuffer = 8

// Signals is `env.signals(s, which)`: a Channel that gets each of those signals the
// process is sent, until the scope ends. The runtime knows a `Signal` by its tag (Interrupt 0,
// Terminate 1, Hangup 2, User1 3, User2 4); tag and of read and make the program's own type.
func Signals[T any](c *Ctx, e Env, s *Scope, which []T, tag func(T) uint16, of func(uint16) T) *Channel[T] {
	ch := NewChannel[T](c, s, signalBuffer)
	tags := make([]uint16, len(which))
	for i, v := range which {
		tags[i] = tag(v)
	}
	s.g.atEnd(e.Notify(c, tags, func(t uint16) { ch.offerNow(of(t)) }))
	return ch
}

// offerNow sends v if it can without waiting, and drops it if not: a signal waits for no one.
// A channel the program closed drops it too.
func (ch *Channel[T]) offerNow(v T) {
	if ch.sim != nil {
		if !ch.closed && ch.canSend() {
			ch.put(v)
		}
		return
	}
	defer func() { recover() }()
	select {
	case ch.ch <- v:
	default:
	}
}

// signalNotify and signalStop are os/signal's; tests swap them to send their own.
var (
	signalNotify = signal.Notify
	signalStop   = signal.Stop
)

func (osEnv) Notify(c *Ctx, tags []uint16, send func(uint16)) func() {
	c.point()
	byOS := map[os.Signal]uint16{}
	for _, t := range tags {
		if s := osSignals[t]; s != nil {
			byOS[s] = t
		}
	}
	if len(byOS) == 0 {
		return func() {}
	}
	in := make(chan os.Signal, signalBuffer)
	sigs := make([]os.Signal, 0, len(byOS))
	for s := range byOS {
		sigs = append(sigs, s)
	}
	signalNotify(in, sigs...)
	quit, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case s := <-in:
				send(byOS[s])
			case <-quit:
				return
			}
		}
	}()
	return func() {
		signalStop(in)
		close(quit)
		<-done
	}
}
