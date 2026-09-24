//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func configureDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func fallbackDetached(*exec.Cmd) *exec.Cmd { return nil }
