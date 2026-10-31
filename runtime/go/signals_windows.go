//go:build windows

package candor

import (
	"os"
	"syscall"
)

// osSignals are the signals of `Signal`, by tag. Windows has Ctrl-C (Ctrl-Break too) as an
// interrupt, and Go gives a console's close, logoff or shutdown as SIGTERM; nothing sends the
// others, so asking for them is allowed and they never come.
var osSignals = []os.Signal{os.Interrupt, syscall.SIGTERM, nil, nil, nil}
