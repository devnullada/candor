package candor

import (
	"os"
	"syscall"
	"testing"
)

// osSignalled swaps signalNotify and signalStop for the test: it gives the channels `Notify`
// was given, and whether `Stop` was called on each.
func osSignalled(t *testing.T) (chan chan<- os.Signal, map[chan<- os.Signal]bool) {
	given := make(chan chan<- os.Signal, 4)
	stopped := map[chan<- os.Signal]bool{}
	savedNotify, savedStop := signalNotify, signalStop
	signalNotify = func(ch chan<- os.Signal, sigs ...os.Signal) { given <- ch }
	signalStop = func(ch chan<- os.Signal) { stopped[ch] = true }
	t.Cleanup(func() { signalNotify, signalStop = savedNotify, savedStop })
	return given, stopped
}

type testSignal struct{ tag uint16 }

func tagOf(s testSignal) uint16    { return s.tag }
func signalOf(t uint16) testSignal { return testSignal{t} }

func TestOSSignalsReachTheChannelUntilTheScopeEnds(t *testing.T) {
	given, stopped := osSignalled(t)
	var in chan<- os.Signal
	got := RunScope(Root(), func(c *Ctx, s *Scope) testSignal {
		ch := Signals(c, OSEnv(), s, []testSignal{{0}, {1}}, tagOf, signalOf)
		in = <-given
		in <- syscall.SIGTERM
		v, ok := ch.Recv(c)
		if !ok {
			t.Fatal("closed")
		}
		return v
	}, nil)
	if got.tag != 1 {
		t.Fatalf("got tag %d, want 1 (Terminate)", got.tag)
	}
	if !stopped[in] {
		t.Fatal("signal.Stop not called when the scope ended")
	}
}

func TestFakeSignalsUnderEachScheduler(t *testing.T) {
	for name, ctx := range contexts() {
		t.Run(name, func(t *testing.T) {
			env := &FakeEnv{}
			c := ctx()
			got := RunScope(c, func(c *Ctx, s *Scope) []uint16 {
				ch := Signals(c, Env(env), s, []testSignal{{2}}, tagOf, signalOf)
				SendSignal(c, env, 0) // not asked for
				SendSignal(c, env, 2)
				SendSignal(c, env, 2)
				a, _ := ch.Recv(c)
				b, _ := ch.Recv(c)
				return []uint16{a.tag, b.tag}
			}, nil)
			if got[0] != 2 || got[1] != 2 {
				t.Fatalf("got %v", got)
			}
			if len(env.listeners) != 0 {
				t.Fatal("still listening after the scope ended")
			}
		})
	}
}

func TestASignalNoOneReadsIsDroppedPastTheBuffer(t *testing.T) {
	env := &FakeEnv{}
	RunScope(Root(), func(c *Ctx, s *Scope) struct{} {
		ch := Signals(c, Env(env), s, []testSignal{{0}}, tagOf, signalOf)
		for i := 0; i < signalBuffer+3; i++ {
			SendSignal(c, env, 0)
		}
		if n := len(ch.ch); n != signalBuffer {
			t.Fatalf("%d waiting, want %d", n, signalBuffer)
		}
		return struct{}{}
	}, nil)
}
