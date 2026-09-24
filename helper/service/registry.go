package main

import (
	"log"
	"os"
	"sync"
	"time"
)

// Registry holds the validated app whitelist and reloads apps.json when it
// changes on disk (checked by mtime, cheaply, every few seconds).
type Registry struct {
	path, iconsDir string
	logger         *log.Logger

	mu      sync.RWMutex
	apps    map[string]App
	order   []string
	modTime time.Time
	size    int64
}

func NewRegistry(path, iconsDir string, logger *log.Logger) *Registry {
	r := &Registry{path: path, iconsDir: iconsDir, logger: logger, apps: map[string]App{}}
	r.Reload()
	return r
}

// Reload re-reads apps.json if its mtime/size changed. Returns true if reloaded.
func (r *Registry) Reload() bool {
	st, err := os.Stat(r.path)
	if err != nil {
		r.mu.Lock()
		changed := len(r.apps) > 0 || !r.modTime.IsZero()
		r.apps, r.order, r.modTime, r.size = map[string]App{}, nil, time.Time{}, 0
		r.mu.Unlock()
		if changed {
			r.logger.Printf("apps.json unavailable: %v", err)
		}
		return changed
	}
	r.mu.RLock()
	same := st.ModTime().Equal(r.modTime) && st.Size() == r.size
	r.mu.RUnlock()
	if same {
		return false
	}
	apps, order, warnings, err := LoadApps(r.path, r.iconsDir)
	for _, w := range warnings {
		r.logger.Printf("apps.json: %s", w)
	}
	if err != nil {
		r.logger.Printf("apps.json rejected: %v", err)
		apps, order = map[string]App{}, nil
	}
	r.mu.Lock()
	r.apps, r.order, r.modTime, r.size = apps, order, st.ModTime(), st.Size()
	r.mu.Unlock()
	r.logger.Printf("apps.json loaded: %d app(s)", len(order))
	return true
}

func (r *Registry) Watch(stop <-chan struct{}) {
	t := time.NewTicker(4 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			r.Reload()
		}
	}
}

func (r *Registry) Get(id string) (App, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.apps[id]
	return a, ok
}

func (r *Registry) Public() []PublicApp {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PublicApp, 0, len(r.order))
	for _, id := range r.order {
		a := r.apps[id]
		p := PublicApp{ID: a.ID, Label: a.Label}
		if a.Icon != "" {
			icon := a.Icon
			p.Icon = &icon
		}
		out = append(out, p)
	}
	return out
}
