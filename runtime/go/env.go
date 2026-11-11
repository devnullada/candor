package candor

import (
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// Env is the `env` effect: the process's environment variables and command-line arguments,
// read only but for `env.load`.
type Env interface {
	// Get gives the variable's value, and whether it is set. Candor: `env.get(name) -> string?`.
	Get(c *Ctx, name string) (string, bool)
	// Args are the arguments after the program's name.
	Args(c *Ctx) []string
	// Pid is this process's id. Candor: `env.pid()`.
	Pid(c *Ctx) int64
	// Zone is the name of the zone the program runs in. Candor: `env.zone()`, a time.Zone.
	Zone(c *Ctx) string
	// SetDefault sets the variable unless it is set already: `env.load` (see LoadEnv).
	SetDefault(c *Ctx, name, value string)
	// Notify calls send with each signal of tags the process gets, until stop (see Signals).
	Notify(c *Ctx, tags []uint16, send func(tag uint16)) (stop func())
}

// OSEnv returns the real `env` effect.
func OSEnv() Env { return osEnv{} }

type osEnv struct{}

func (osEnv) Get(c *Ctx, name string) (string, bool) {
	c.point()
	return os.LookupEnv(name)
}

func (osEnv) Args(c *Ctx) []string {
	c.point()
	return append([]string{}, os.Args[1:]...)
}

func (osEnv) Pid(c *Ctx) int64 {
	c.point()
	return int64(os.Getpid())
}

func (osEnv) Zone(c *Ctx) string {
	c.point()
	return machineZone()
}

// machineZone is the zone's database name: $TZ's if it names one, else the machine's (the
// link /etc/localtime is, or /etc/timezone), else "Local" for a machine whose zone has no name
// Go can see (Windows), which std/time reads as Go's time.Local; UTC with no zone at all. A
// program calling it imports time, and with it the zone database, so names load anywhere.
func machineZone() string {
	known := func(name string) bool {
		_, err := time.LoadLocation(name)
		return name != "" && name != "Local" && err == nil
	}
	if tz, ok := os.LookupEnv("TZ"); ok {
		if tz = strings.TrimPrefix(tz, ":"); known(tz) {
			return tz
		}
	}
	if link, err := os.Readlink("/etc/localtime"); err == nil {
		if _, name, ok := strings.Cut(link, "zoneinfo/"); ok && known(name) {
			return name
		}
	}
	if b, err := os.ReadFile("/etc/timezone"); err == nil {
		if name := strings.TrimSpace(string(b)); known(name) {
			return name
		}
	}
	// No name: Go's own reading of the machine, unless it is UTC all year (no zone set).
	now := time.Now().In(time.Local)
	_, a := now.Zone()
	_, b := now.AddDate(0, 6, 0).Zone()
	if a == 0 && b == 0 {
		return "UTC"
	}
	return "Local"
}

func (osEnv) SetDefault(c *Ctx, name, value string) {
	c.point()
	if _, ok := os.LookupEnv(name); !ok {
		os.Setenv(name, value)
	}
}

// FakeEnv is the fake `env` effect: no variables, no arguments and no signals, until a test
// sets or sends them.
type FakeEnv struct {
	vars map[string]string
	args []string
	// The pid `env.pid()` gives, 1000 until `env.setPid`; 0 stands for 1000.
	pid int64
	// The zone `env.zone()` gives, UTC until `env.setZone`; "" stands for UTC.
	zone string
	// Who `env.signals` has listening, and to which tags.
	mu        sync.Mutex
	listeners []*listener
}

type listener struct {
	tags []uint16
	send func(uint16)
}

func (e *FakeEnv) Notify(c *Ctx, tags []uint16, send func(uint16)) func() {
	c.point()
	l := &listener{tags: tags, send: send}
	e.mu.Lock()
	e.listeners = append(e.listeners, l)
	e.mu.Unlock()
	return func() {
		e.mu.Lock()
		e.listeners = slices.DeleteFunc(e.listeners, func(x *listener) bool { return x == l })
		e.mu.Unlock()
	}
}

// SendSignal is `env.sendSignal(sig)`, in tests only: each `env.signals` channel taking that
// signal gets it, as if the process were sent it.
func SendSignal(c *Ctx, e Env, tag uint16) {
	c.point()
	fe, ok := e.(*FakeEnv)
	if !ok {
		panic("candor: env.sendSignal is for tests")
	}
	fe.mu.Lock()
	ls := slices.Clone(fe.listeners)
	fe.mu.Unlock()
	for _, l := range ls {
		if slices.Contains(l.tags, tag) {
			l.send(tag)
		}
	}
}

func (e *FakeEnv) Get(c *Ctx, name string) (string, bool) {
	c.point()
	v, ok := e.vars[name]
	return v, ok
}

func (e *FakeEnv) Args(c *Ctx) []string {
	c.point()
	return append([]string{}, e.args...)
}

// Set gives a variable a value. Candor: `env.set(name, value)`, in tests only.
func (e *FakeEnv) Set(c *Ctx, name, value string) {
	c.point()
	if e.vars == nil {
		e.vars = map[string]string{}
	}
	e.vars[name] = value
}

func (e *FakeEnv) Pid(c *Ctx) int64 {
	c.point()
	if e.pid == 0 {
		return 1000
	}
	return e.pid
}

// SetPid sets the pid `env.pid()` gives. Candor: `env.setPid(n)`, in tests only.
func (e *FakeEnv) SetPid(c *Ctx, n int64) {
	c.point()
	e.pid = n
}

func (e *FakeEnv) Zone(c *Ctx) string {
	c.point()
	if e.zone == "" {
		return "UTC"
	}
	return e.zone
}

// SetZone sets the zone `env.zone()` gives. Candor: `env.setZone(z)`, in tests only.
func (e *FakeEnv) SetZone(c *Ctx, name string) {
	c.point()
	e.zone = name
}

func (e *FakeEnv) SetDefault(c *Ctx, name, value string) {
	if _, ok := e.vars[name]; !ok {
		e.Set(c, name, value)
	}
}

// SetArgs replaces the arguments. Candor: `env.setArgs(args)`, in tests only.
func (e *FakeEnv) SetArgs(c *Ctx, args []string) {
	c.point()
	e.args = append([]string{}, args...)
}
