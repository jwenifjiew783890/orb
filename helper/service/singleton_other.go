//go:build !windows

package main

import (
	"errors"
	"net"
	"strconv"
	"syscall"
)

// On non-Windows builds (development/CI) the loopback port itself is the lock:
// if it is already bound, another helper is running.
func acquireSingleton(port int) (release func(), already bool, err error) {
	ln, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			return nil, true, nil
		}
		return nil, false, err
	}
	ln.Close()
	return func() {}, false, nil
}
