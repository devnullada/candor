package candor

import "time"

// Clock is the `clock` effect: the current time, in milliseconds since the Unix epoch.
type Clock interface {
	Now(c *Ctx) int64
	Sleep(c *Ctx, ms int64)
	// Nanos is a monotonic count of nanoseconds, for measuring how long something took.
	Nanos(c *Ctx) int64
}

// started is what systemClock's Nanos counts from; time.Since reads the monotonic clock.
var started = time.Now()

// SystemClock returns the real `clock` effect.
func SystemClock() Clock { return systemClock{} }

type systemClock struct{}

func (systemClock) Now(c *Ctx) int64 {
	c.point()
	return time.Now().UnixMilli()
}

func (systemClock) Nanos(c *Ctx) int64 {
	c.point()
	return int64(time.Since(started))
}

// Sleep waits, unless the task is cancelled first.
func (systemClock) Sleep(c *Ctx, ms int64) {
	c.point()
	t := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer t.Stop()
	select {
	case <-t.C:
	case <-c.tok.done:
		panic(cancelled{})
	}
}

// FakeClock is the fake `clock` effect: the test scheduler's virtual time. It starts at 0 and
// moves when told to, or when every task is asleep.
type FakeClock struct{}

func (*FakeClock) Now(c *Ctx) int64 {
	c.point()
	return c.sim.now
}

// Nanos is the virtual time in nanoseconds: it moves only when the milliseconds do.
func (*FakeClock) Nanos(c *Ctx) int64 {
	c.point()
	return c.sim.now * 1_000_000
}

func (*FakeClock) Sleep(c *Ctx, ms int64) {
	c.point()
	c.sim.sleep(c, ms)
}

// Set moves the clock to ms, waking every task asleep until then.
func (*FakeClock) Set(c *Ctx, ms int64) {
	c.point()
	c.sim.setTime(ms)
}

func (*FakeClock) Advance(c *Ctx, ms int64) {
	c.point()
	c.sim.setTime(c.sim.now + ms)
}
