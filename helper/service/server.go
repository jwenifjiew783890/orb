package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server is the localhost API.
//
//	GET  /stats            cached system statistics
//	GET  /apps             whitelisted apps: id, label, icon (never paths)
//	POST /launch/{app_id}  launch a whitelisted app by id (optional JSON body {"app_id": id})
//	GET  /health           liveness (used by the installer)
//
// Security layers, in order: loopback-only listener → Host header check (DNS
// rebinding) → Origin allow-list → rate limit → constant-time token check →
// strict routing/validation. Error responses carry a short code and never
// include filesystem details.
type Server struct {
	cfg      *Config
	stats    *StatsCache
	registry *Registry
	launcher *Launcher
	logger   *log.Logger

	general     *bucket
	launchLimit *bucket
	authFail    *bucket
	hostOK      map[string]bool
	originOK    map[string]bool
}

func NewServer(cfg *Config, stats *StatsCache, reg *Registry, l *Launcher, logger *log.Logger) *Server {
	p := strconv.Itoa(cfg.Port)
	s := &Server{
		cfg: cfg, stats: stats, registry: reg, launcher: l, logger: logger,
		general:     newBucket(20, 10),  // 20 burst, 10/s sustained
		launchLimit: newBucket(3, 0.2),  // 3 burst, 1 per 5 s sustained
		authFail:    newBucket(10, 0.2), // repeated bad tokens get throttled
		hostOK:      map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true},
		originOK:    map[string]bool{},
	}
	for _, o := range cfg.AllowedOrigins {
		s.originOK[o] = true
	}
	return s
}

type apiError struct {
	OK   bool   `json:"ok"`
	Code string `json:"code"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, apiError{OK: false, Code: code})
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")

	// 1. DNS-rebinding protection: only our own loopback host names.
	if !s.hostOK[strings.ToLower(r.Host)] {
		fail(w, http.StatusMisdirectedRequest, "bad_host")
		return
	}
	// 2. Origin allow-list (browsers always send Origin on CORS requests).
	origin := r.Header.Get("Origin")
	if origin != "" {
		if !s.originOK[origin] {
			fail(w, http.StatusForbidden, "bad_origin")
			return
		}
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
	}
	// 3. CORS preflight (no token is sent on preflights by design).
	if r.Method == http.MethodOptions {
		h.Set("Access-Control-Allow-Methods", "GET, POST")
		h.Set("Access-Control-Allow-Headers", "X-Vision-Token, Content-Type")
		h.Set("Access-Control-Max-Age", "600")
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			h.Set("Access-Control-Allow-Private-Network", "true")
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// 4. Rate limit.
	if !s.general.take() {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	// 5. Token.
	if !s.authorized(r) {
		if !s.authFail.take() {
			fail(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		fail(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	// 6. Routing.
	switch {
	case r.URL.Path == "/stats":
		if r.Method != http.MethodGet {
			fail(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		body := s.stats.JSON()
		if body == nil {
			fail(w, http.StatusServiceUnavailable, "stats_warming_up")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(body)
	case r.URL.Path == "/apps":
		if r.Method != http.MethodGet {
			fail(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"apps": s.registry.Public()})
	case r.URL.Path == "/diag/probe-report":
		s.handleProbeReport(w, r)
	case r.URL.Path == "/health":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": Version})
	case r.URL.Path == "/launch" || strings.HasPrefix(r.URL.Path, "/launch/"):
		s.handleLaunch(w, r)
	default:
		fail(w, http.StatusNotFound, "not_found")
	}
}

func (s *Server) authorized(r *http.Request) bool {
	got := r.Header.Get("X-Vision-Token")
	if len(got) != len(s.cfg.Token) {
		// still do a comparison to keep timing uniform
		subtle.ConstantTimeCompare([]byte(s.cfg.Token), []byte(s.cfg.Token))
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) == 1
}

func (s *Server) handleLaunch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	// The raw path must be exactly /launch/<id> — no encoded slashes, dots or
	// anything path- or shell-like survives the id regex.
	pathID := ""
	if strings.HasPrefix(r.URL.Path, "/launch/") {
		if r.URL.RawPath != "" {
			fail(w, http.StatusBadRequest, "invalid_id")
			return
		}
		pathID = strings.TrimPrefix(r.URL.Path, "/launch/")
		if !appIDRe.MatchString(pathID) {
			fail(w, http.StatusBadRequest, "invalid_id")
			return
		}
	}
	if r.URL.RawQuery != "" {
		fail(w, http.StatusBadRequest, "malformed_request")
		return
	}
	// Optional body: exactly {"app_id": "<id>"}; anything else is rejected.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1025))
	if err != nil || len(body) > 1024 {
		fail(w, http.StatusRequestEntityTooLarge, "malformed_request")
		return
	}
	id := pathID
	if len(bytes.TrimSpace(body)) > 0 {
		var req struct {
			AppID string `json:"app_id"`
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil || dec.More() {
			fail(w, http.StatusBadRequest, "malformed_request")
			return
		}
		if !appIDRe.MatchString(req.AppID) {
			fail(w, http.StatusBadRequest, "invalid_id")
			return
		}
		if pathID != "" && req.AppID != pathID {
			fail(w, http.StatusBadRequest, "malformed_request")
			return
		}
		id = req.AppID
	}
	if id == "" {
		fail(w, http.StatusBadRequest, "invalid_id")
		return
	}
	app, ok := s.registry.Get(id)
	if !ok {
		fail(w, http.StatusNotFound, "unknown_app")
		return
	}
	if !s.launchLimit.take() {
		fail(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if err := s.launcher.Launch(app); err != nil {
		s.logger.Printf("launch %s failed: %v", id, err)
		if err == errAppUnavailable {
			fail(w, http.StatusUnprocessableEntity, "app_unavailable")
			return
		}
		fail(w, http.StatusInternalServerError, "launch_failed")
		return
	}
	s.logger.Printf("launched %s", id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "code": "launched"})
}

// Listen binds to loopback only. The address is not configurable on purpose.
func Listen(port int) (net.Listener, error) {
	return net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(port))
}

func NewHTTPServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}
}

// ─── token bucket ────────────────────────────────────────────────────────────

type bucket struct {
	mu     sync.Mutex
	cap    float64
	rate   float64
	tokens float64
	last   time.Time
	now    func() time.Time
}

func newBucket(capacity, perSecond float64) *bucket {
	return &bucket{cap: capacity, rate: perSecond, tokens: capacity, last: time.Now(), now: time.Now}
}

func (b *bucket) take() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := b.now()
	b.tokens += n.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.cap {
		b.tokens = b.cap
	}
	b.last = n
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// handleProbeReport stores the desktop-interaction probe's report at a fixed
// path (config/desktop-probe-report.json). Nothing in the body is interpreted
// beyond checking that it is a JSON object from the probe.
func (s *Server) handleProbeReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxProbeReport+1))
	if err != nil || len(body) > maxProbeReport {
		fail(w, http.StatusRequestEntityTooLarge, "malformed_request")
		return
	}
	var head struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(body, &head) != nil || head.Kind != "vision-desktop-probe" {
		fail(w, http.StatusBadRequest, "malformed_request")
		return
	}
	var pretty bytes.Buffer
	if json.Indent(&pretty, body, "", " ") != nil {
		fail(w, http.StatusBadRequest, "malformed_request")
		return
	}
	if err := writeFileAtomic(filepath.Join(s.cfg.dir, "desktop-probe-report.json"), pretty.Bytes(), 0o600); err != nil {
		s.logger.Printf("probe report: %v", err)
		fail(w, http.StatusInternalServerError, "write_failed")
		return
	}
	s.logger.Printf("desktop probe report saved")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "code": "saved"})
}

const maxProbeReport = 256 << 10
