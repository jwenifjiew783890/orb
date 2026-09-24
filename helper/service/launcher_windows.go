//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const (
	createNewProcessGroup  = 0x00000200
	createBreakawayFromJob = 0x01000000
	createUnicodeEnv       = 0x00000400
)

// configureDetached lets the launched app outlive the helper: its own process
// group, and breakaway from the Task Scheduler job object (so stopping or
// restarting the helper task never kills apps the user opened).
func configureDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | createBreakawayFromJob | createUnicodeEnv,
	}
}

// If the job forbids breakaway, CreateProcess fails with access denied — retry
// without it.
func fallbackDetached(cmd *exec.Cmd) *exec.Cmd {
	c := exec.Command(cmd.Path, cmd.Args[1:]...)
	c.Dir = cmd.Dir
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | createUnicodeEnv}
	return c
}
