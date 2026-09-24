//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// acquireSingleton holds a per-user named mutex so the watchdog's repeated
// starts never create duplicate helpers.
func acquireSingleton(port int) (release func(), already bool, err error) {
	name, _ := windows.UTF16PtrFromString(fmt.Sprintf(`Local\VISION-Helper-%d`, port))
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		if h != 0 {
			windows.CloseHandle(h)
		}
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	return func() { windows.CloseHandle(h) }, false, nil
}
