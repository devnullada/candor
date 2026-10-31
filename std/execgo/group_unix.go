//go:build !windows

package execgo

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// sigs is Candor's Signal by its number in std/exec.candor (signalNumber).
var sigs = []syscall.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGUSR1, syscall.SIGUSR2}

// ownGroup puts the process in a process group of its own, led by it (Setpgid).
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// signal sends sigs[n], or SIGKILL for n -1, to the process, or with group to its whole group.
// One already gone is os.ErrProcessDone, as Go's Cancel wants.
func signal(cmd *exec.Cmd, group bool, n int64) error {
	sig := syscall.SIGKILL
	if n >= 0 && int(n) < len(sigs) {
		sig = sigs[n]
	}
	if !group {
		return cmd.Process.Signal(sig)
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	} else {
		return err
	}
}
