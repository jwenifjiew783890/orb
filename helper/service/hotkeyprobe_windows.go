//go:build windows

package main

import (
	"fmt"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                    = windows.NewLazySystemDLL("user32.dll")
	procRegisterHotKey        = user32.NewProc("RegisterHotKey")
	procUnregisterHotKey      = user32.NewProc("UnregisterHotKey")
	procGetMessageW           = user32.NewProc("GetMessageW")
	procPostThreadMessageW    = user32.NewProc("PostThreadMessageW")
	procGetForegroundWindow   = user32.NewProc("GetForegroundWindow")
	procGetClassNameW         = user32.NewProc("GetClassNameW")
	procGetKeyboardLayoutList = user32.NewProc("GetKeyboardLayoutList")
)

const (
	modAlt      = 0x0001
	modControl  = 0x0002
	modNoRepeat = 0x4000
	vkSpace     = 0x20
	wmHotkey    = 0x0312
	wmQuit      = 0x0012
)

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	PtX     int32
	PtY     int32
	Private uint32
}

func hotkeyProbe(res *HotkeyProbeResult, d time.Duration, includeCtrlSpace bool) error {
	res.OS = "windows"
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Installed keyboard layouts: Ctrl+Space is the IME toggle for some of them.
	n, _, _ := procGetKeyboardLayoutList.Call(0, 0)
	if n > 0 {
		hkls := make([]uintptr, n)
		procGetKeyboardLayoutList.Call(n, uintptr(unsafe.Pointer(&hkls[0])))
		for _, h := range hkls {
			res.KeyboardLayouts = append(res.KeyboardLayouts, fmt.Sprintf("%08x", h))
		}
	}

	combos := []struct {
		id   int
		name string
		mods uintptr
	}{
		{2, "Ctrl+Alt+Space", modControl | modAlt | modNoRepeat},
	}
	// Ctrl+Space is only tested on explicit opt-in: registering it takes it away
	// from IME switching and editors for the duration of the test.
	if includeCtrlSpace {
		combos = append(combos, struct {
			id   int
			name string
			mods uintptr
		}{1, "Ctrl+Space", modControl | modNoRepeat})
	}
	for _, c := range combos {
		r, _, err := procRegisterHotKey.Call(0, uintptr(c.id), c.mods, vkSpace)
		hc := HotkeyCombo{Name: c.name, Registered: r != 0}
		if r == 0 {
			hc.Error = err.Error()
		}
		res.Combos = append(res.Combos, hc)
	}
	defer func() {
		for _, c := range combos {
			procUnregisterHotKey.Call(0, uintptr(c.id))
		}
	}()

	tid := windows.GetCurrentThreadId()
	timer := time.AfterFunc(d, func() { procPostThreadMessageW.Call(uintptr(tid), wmQuit, 0, 0) })
	defer timer.Stop()
	start := time.Now()
	var m winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			break
		}
		if m.Message != wmHotkey {
			continue
		}
		name := "?"
		for _, c := range combos {
			if uintptr(c.id) == m.WParam {
				name = c.name
			}
		}
		cls := foregroundClass()
		res.Presses = append(res.Presses, HotkeyPress{
			Combo: name, AtSeconds: time.Since(start).Seconds(), ForegroundClass: cls,
			ForegroundIsDesktop: cls == "Progman" || cls == "WorkerW",
		})
	}
	return nil
}

func foregroundClass() string {
	h, _, _ := procGetForegroundWindow.Call()
	if h == 0 {
		return ""
	}
	buf := make([]uint16, 256)
	n, _, _ := procGetClassNameW.Call(h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}
