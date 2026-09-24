//go:build linux

package main

import (
	"bufio"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// procCollector is the Linux implementation (development and CI only; the
// product targets Windows). GPU is reported as null.
type procCollector struct {
	prevIdle, prevTotal uint64
	prevRx, prevTx      uint64
	prevT               time.Time
}

func NewCollector() (Collector, error) { return &procCollector{}, nil }

func (p *procCollector) Close() {}

func (p *procCollector) Collect() (Snapshot, error) {
	var s Snapshot
	idle, total, err := readCPU()
	if err != nil {
		return s, err
	}
	if p.prevTotal > 0 && total > p.prevTotal {
		s.CPU = 100 * (1 - float64(idle-p.prevIdle)/float64(total-p.prevTotal))
	}
	p.prevIdle, p.prevTotal = idle, total
	s.RAM, err = readRAM()
	if err != nil {
		return s, err
	}
	rx, tx := readNet()
	now := time.Now()
	if !p.prevT.IsZero() {
		dt := now.Sub(p.prevT).Seconds()
		if dt > 0 && rx >= p.prevRx && tx >= p.prevTx {
			s.Network.Down = float64(rx-p.prevRx) / dt
			s.Network.Up = float64(tx-p.prevTx) / dt
		}
	}
	p.prevRx, p.prevTx, p.prevT = rx, tx, now
	return s, nil
}

func readCPU() (idle, total uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0, 0, errors.New("empty /proc/stat")
	}
	fields := strings.Fields(sc.Text())
	for i, v := range fields[1:] {
		n, _ := strconv.ParseUint(v, 10, 64)
		total += n
		if i == 3 || i == 4 {
			idle += n
		}
	}
	return idle, total, nil
}

func readRAM() (float64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var total, avail float64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		if len(fs) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(fs[1], 64)
		switch fs[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total == 0 {
		return 0, errors.New("no MemTotal")
	}
	return 100 * (1 - avail/total), nil
}

func readNet() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, ':')
		if i < 0 || strings.TrimSpace(line[:i]) == "lo" {
			continue
		}
		fs := strings.Fields(line[i+1:])
		if len(fs) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fs[0], 10, 64)
		t, _ := strconv.ParseUint(fs[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}
