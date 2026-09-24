package main

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Snapshot is the /stats payload.
type Snapshot struct {
	CPU     float64  `json:"cpu"`
	RAM     float64  `json:"ram"`
	GPU     *float64 `json:"gpu"`
	Network NetStats `json:"network"`
	Time    string   `json:"time"`
}

type NetStats struct {
	Up   float64 `json:"up"`
	Down float64 `json:"down"`
}

// Collector samples the OS. Implementations are rate-based and must be called
// at a steady interval (the cache does that, ≥1 s apart).
type Collector interface {
	Collect() (Snapshot, error)
	Close()
}

// StatsCache collects in the background at most once per interval and serves
// a pre-encoded JSON body, so a browser request never triggers a system query.
// When nobody has asked for stats for a while (wallpaper paused, game running),
// collection stops entirely until the next request.
type StatsCache struct {
	c         Collector
	interval  time.Duration
	idleAfter time.Duration
	logger    *log.Logger

	body    atomic.Pointer[[]byte]
	lastReq atomic.Int64
	wake    chan struct{}
	mu      sync.Mutex
	samples atomic.Int64
}

func NewStatsCache(c Collector, interval time.Duration, logger *log.Logger) *StatsCache {
	if interval < time.Second {
		interval = time.Second
	}
	return &StatsCache{c: c, interval: interval, idleAfter: 20 * time.Second, logger: logger, wake: make(chan struct{}, 1)}
}

// JSON returns the latest encoded snapshot (nil until the first sample).
func (s *StatsCache) JSON() []byte {
	prev := s.lastReq.Swap(time.Now().UnixNano())
	if time.Since(time.Unix(0, prev)) > s.idleAfter {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
	if p := s.body.Load(); p != nil {
		return *p
	}
	return nil
}

func (s *StatsCache) Samples() int64 { return s.samples.Load() }

func (s *StatsCache) collect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap, err := s.c.Collect()
	if err != nil {
		s.logger.Printf("stats: %v", err)
		return
	}
	snap.Time = time.Now().Format(time.RFC3339)
	b, _ := json.Marshal(snap)
	s.body.Store(&b)
	s.samples.Add(1)
}

func (s *StatsCache) Run(stop <-chan struct{}) {
	s.lastReq.Store(time.Now().UnixNano())
	s.collect() // primes rate counters
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if time.Since(time.Unix(0, s.lastReq.Load())) > s.idleAfter {
				continue // idle: nobody is watching
			}
			s.collect()
		case <-s.wake:
			s.collect() // resumes; rates re-prime over one interval
		}
	}
}
