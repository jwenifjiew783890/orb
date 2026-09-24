package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

var errAppUnavailable = errors.New("app executable not found")

// Launcher starts whitelisted executables directly (CreateProcess on Windows;
// no shell, no command-line parsing by cmd.exe, no browser-supplied arguments).
type Launcher struct {
	// start is replaceable in tests.
	start func(*exec.Cmd) error
}

func NewLauncher() *Launcher { return &Launcher{start: startDetached} }

func (l *Launcher) Launch(app App) error {
	if err := validateExePath(app.Exe); err != nil {
		return err
	}
	st, err := os.Stat(app.Exe)
	if err != nil || !st.Mode().IsRegular() {
		return errAppUnavailable
	}
	cmd := exec.Command(app.Exe, app.Args...)
	cmd.Dir = app.Cwd
	if cmd.Dir == "" {
		cmd.Dir = filepath.Dir(app.Exe)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	return l.start(cmd)
}

func startDetached(cmd *exec.Cmd) error {
	configureDetached(cmd)
	if err := cmd.Start(); err != nil {
		if retry := fallbackDetached(cmd); retry != nil {
			if err2 := retry.Start(); err2 == nil {
				return retry.Process.Release()
			}
		}
		return err
	}
	return cmd.Process.Release()
}
