//go:build !windows

package main

import (
	"errors"
	"runtime"
	"time"
)

func hotkeyProbe(res *HotkeyProbeResult, _ time.Duration, _ bool) error {
	res.OS = runtime.GOOS
	return errors.New("global hotkeys are only probed on Windows")
}
