//go:build windows

package execgo

import "os/exec"

// ownGroup does nothing: Windows has no process groups in the Unix sense.
func ownGroup(cmd *exec.Cmd) {}

// signal kills the process: Windows can't send one a signal.
func signal(cmd *exec.Cmd, group bool, n int64) error {
	return cmd.Process.Kill()
}
