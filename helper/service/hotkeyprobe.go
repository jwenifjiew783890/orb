package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// HotkeyProbeResult records whether a global shortcut can be registered and
// which window was in front each time it was pressed. It uses RegisterHotKey,
// the standard Windows API for application shortcuts — not an input hook: the
// helper is only told about that one key combination.
type HotkeyProbeResult struct {
	Kind            string        `json:"kind"`
	When            string        `json:"when"`
	OS              string        `json:"os"`
	Seconds         int           `json:"seconds"`
	KeyboardLayouts []string      `json:"keyboardLayouts"`
	Combos          []HotkeyCombo `json:"combos"`
	Presses         []HotkeyPress `json:"presses"`
	Note            string        `json:"note,omitempty"`
}

type HotkeyCombo struct {
	Name       string `json:"name"`
	Registered bool   `json:"registered"`
	Error      string `json:"error,omitempty"`
}

type HotkeyPress struct {
	Combo               string  `json:"combo"`
	AtSeconds           float64 `json:"atSeconds"`
	ForegroundClass     string  `json:"foregroundClass"`
	ForegroundIsDesktop bool    `json:"foregroundIsDesktop"`
}

func runHotkeyProbe(cfgDir string, seconds int, includeCtrlSpace bool) error {
	if seconds < 5 {
		seconds = 5
	}
	if seconds > 600 {
		seconds = 600
	}
	res := HotkeyProbeResult{Kind: "vision-hotkey-probe", When: time.Now().Format(time.RFC3339), Seconds: seconds}
	if err := hotkeyProbe(&res, time.Duration(seconds)*time.Second, includeCtrlSpace); err != nil {
		res.Note = err.Error()
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	path := filepath.Join(cfgDir, "hotkey-probe.json")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(path, out, 0o600); err != nil {
		return err
	}
	fmt.Println(string(out))
	return nil
}
