//go:build !linux && !windows

package main

type nullCollector struct{}

func NewCollector() (Collector, error)           { return nullCollector{}, nil }
func (nullCollector) Collect() (Snapshot, error) { return Snapshot{}, nil }
func (nullCollector) Close()                     {}
