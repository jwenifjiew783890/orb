//go:build windows

package main

import (
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// pdhCollector reads Windows Performance Data Helper counters — the same
// sources Task Manager uses — in ONE query per collection:
//
//	CPU     \Processor Information(_Total)\% Processor Utility  (fallback: \Processor(_Total)\% Processor Time)
//	GPU     \GPU Engine(*engtype_3D)\Utilization Percentage       summed per physical engine, max across engines
//	Network \Network Interface(*)\Bytes Received/sec, Bytes Sent/sec summed across interfaces
//	RAM     GlobalMemoryStatusEx (dwMemoryLoad)
//
// DLLs are loaded from System32 only (NewLazySystemDLL), preventing DLL planting.
var (
	pdh                      = windows.NewLazySystemDLL("pdh.dll")
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procPdhOpenQuery         = pdh.NewProc("PdhOpenQueryW")
	procPdhAddEnglishCounter = pdh.NewProc("PdhAddEnglishCounterW")
	procPdhCollectQueryData  = pdh.NewProc("PdhCollectQueryData")
	procPdhGetFormattedValue = pdh.NewProc("PdhGetFormattedCounterValue")
	procPdhGetFormattedArray = pdh.NewProc("PdhGetFormattedCounterArrayW")
	procPdhCloseQuery        = pdh.NewProc("PdhCloseQuery")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
)

const (
	pdhFmtDouble      = 0x00000200
	pdhFmtNoCap100    = 0x00008000
	pdhMoreData       = 0x800007D2
	pdhCstatusValid   = 0x00000000
	pdhCstatusNewData = 0x00000001
)

type pdhFmtCounterValue struct {
	CStatus uint32
	_       uint32
	Double  float64
}

type pdhFmtCounterValueItem struct {
	Name  *uint16
	Value pdhFmtCounterValue
}

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

type pdhCollector struct {
	query        uintptr
	cpu, gpu     uintptr
	netRx, netTx uintptr
	buf          []byte
}

func NewCollector() (Collector, error) {
	c := &pdhCollector{buf: make([]byte, 64<<10)}
	if r, _, _ := procPdhOpenQuery.Call(0, 0, uintptr(unsafe.Pointer(&c.query))); r != 0 {
		return nil, errors.New("PdhOpenQuery failed")
	}
	add := func(path string) uintptr {
		var h uintptr
		p, _ := windows.UTF16PtrFromString(path)
		if r, _, _ := procPdhAddEnglishCounter.Call(c.query, uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&h))); r != 0 {
			return 0
		}
		return h
	}
	c.cpu = add(`\Processor Information(_Total)\% Processor Utility`)
	if c.cpu == 0 {
		c.cpu = add(`\Processor(_Total)\% Processor Time`)
	}
	c.gpu = add(`\GPU Engine(*engtype_3D)\Utilization Percentage`)
	c.netRx = add(`\Network Interface(*)\Bytes Received/sec`)
	c.netTx = add(`\Network Interface(*)\Bytes Sent/sec`)
	procPdhCollectQueryData.Call(c.query) // prime rate counters
	return c, nil
}

func (c *pdhCollector) Close() {
	if c.query != 0 {
		procPdhCloseQuery.Call(c.query)
		c.query = 0
	}
}

func (c *pdhCollector) single(h uintptr) (float64, bool) {
	if h == 0 {
		return 0, false
	}
	var v pdhFmtCounterValue
	r, _, _ := procPdhGetFormattedValue.Call(h, pdhFmtDouble|pdhFmtNoCap100, 0, uintptr(unsafe.Pointer(&v)))
	if r != 0 || (v.CStatus != pdhCstatusValid && v.CStatus != pdhCstatusNewData) {
		return 0, false
	}
	return v.Double, true
}

// array calls fn for every instance of a wildcard counter.
func (c *pdhCollector) array(h uintptr, fn func(name string, v float64)) bool {
	if h == 0 {
		return false
	}
	for attempt := 0; attempt < 2; attempt++ {
		size := uint32(len(c.buf))
		var count uint32
		r, _, _ := procPdhGetFormattedArray.Call(h, pdhFmtDouble|pdhFmtNoCap100, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&c.buf[0])))
		if uint32(r) == pdhMoreData {
			c.buf = make([]byte, size+4096)
			continue
		}
		if r != 0 {
			return false
		}
		items := unsafe.Slice((*pdhFmtCounterValueItem)(unsafe.Pointer(&c.buf[0])), count)
		for _, it := range items {
			if it.Value.CStatus != pdhCstatusValid && it.Value.CStatus != pdhCstatusNewData {
				continue
			}
			fn(windows.UTF16PtrToString(it.Name), it.Value.Double)
		}
		return true
	}
	return false
}

func (c *pdhCollector) Collect() (Snapshot, error) {
	var s Snapshot
	if r, _, _ := procPdhCollectQueryData.Call(c.query); r != 0 {
		return s, errors.New("PdhCollectQueryData failed")
	}
	if v, ok := c.single(c.cpu); ok {
		s.CPU = clamp100(v)
	}
	// GPU: instance names look like pid_1234_luid_0x0_0x0000D1E2_phys_0_eng_0_engtype_3D.
	// Sum per engine (luid+phys+eng) across processes, then take the busiest engine.
	engines := map[string]float64{}
	if c.array(c.gpu, func(name string, v float64) {
		key := name
		if i := strings.Index(name, "_luid_"); i >= 0 {
			key = name[i:]
		}
		engines[key] += v
	}) {
		max := 0.0
		for _, v := range engines {
			if v > max {
				max = v
			}
		}
		g := clamp100(max)
		s.GPU = &g
	}
	c.array(c.netRx, func(_ string, v float64) { s.Network.Down += v })
	c.array(c.netTx, func(_ string, v float64) { s.Network.Up += v })
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	if r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r != 0 {
		if m.TotalPhys > 0 {
			s.RAM = 100 * float64(m.TotalPhys-m.AvailPhys) / float64(m.TotalPhys)
		}
	}
	return s, nil
}

func clamp100(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
