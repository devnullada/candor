//go:build !windows

package candor

import (
	"os"
	"syscall"
)

// osSignals are the signals of `Signal`, by tag.
var osSignals = []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGUSR1, syscall.SIGUSR2}
