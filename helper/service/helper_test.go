package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// ─── fixtures ────────────────────────────────────────────────────────────────

type fakeCollector struct{ n int }

func (f *fakeCollector) Collect() (Snapshot, error) {
	f.n++
	g := 8.1
	return Snapshot{CPU: 12.4, RAM: 47.2, GPU: &g, Network: NetStats{Up: 124000, Down: 830000}}, nil
}
func (f *fakeCollector) Close() {}

type recordingLauncher struct {
	mu   sync.Mutex
	cmds []*exec.Cmd
}

func (r *recordingLauncher) start(c *exec.Cmd) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cmds = append(r.cmds, c)
	return nil
}

func fakeExe(t *testing.T, dir, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

type env struct {
	srv      *Server
	cfg      *Config
	rec      *recordingLauncher
	dir      string
	exe      string
	appsPath string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	cfgDir := filepath.Join(dir, "config")
	c, created, err := InitConfig(filepath.Join(cfgDir, "config.json"), false)
	if err != nil || !created {
		t.Fatalf("init: %v %v", created, err)
	}
	exe := fakeExe(t, dir, "notepad")
	apps := map[string]any{"apps": []map[string]any{
		{"id": "notepad", "label": "Notepad", "exe": exe, "args": []string{"--flag"}, "hotkey": nil},
		{"id": "missing", "label": "Missing", "exe": filepath.Join(dir, "nope"+exeSuffix())},
	}}
	b, _ := json.Marshal(apps)
	appsPath := filepath.Join(dir, "apps.json")
	os.WriteFile(appsPath, b, 0o644)
	logger := log.New(io.Discard, "", 0)
	stats := NewStatsCache(&fakeCollector{}, time.Second, logger)
	stats.collect()
	reg := NewRegistry(appsPath, filepath.Join(dir, "icons"), logger)
	rec := &recordingLauncher{}
	l := &Launcher{start: rec.start}
	return &env{srv: NewServer(c, stats, reg, l, logger), cfg: c, rec: rec, dir: dir, exe: exe, appsPath: appsPath}
}

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

func (e *env) do(t *testing.T, method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "http://127.0.0.1:47821"+path, rd)
	req.Host = "127.0.0.1:47821"
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	e.srv.ServeHTTP(w, req)
	return w
}

func code(w *httptest.ResponseRecorder) string {
	var r struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &r)
	return r.Code
}

// ─── token ───────────────────────────────────────────────────────────────────

func TestTokenIsRandom64Hex(t *testing.T) {
	a, _ := NewToken()
	b, _ := NewToken()
	if !tokenRe.MatchString(a) || !tokenRe.MatchString(b) || a == b {
		t.Fatalf("bad tokens %q %q", a, b)
	}
}

func TestInitKeepsTokenUnlessRotated(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	c1, created1, _ := InitConfig(p, false)
	c2, created2, _ := InitConfig(p, false)
	c3, created3, _ := InitConfig(p, true)
	if !created1 || created2 || !created3 {
		t.Fatalf("created flags %v %v %v", created1, created2, created3)
	}
	if c1.Token != c2.Token || c2.Token == c3.Token {
		t.Fatal("token not kept / not rotated")
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(p)
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("config perms %v", st.Mode().Perm())
		}
	}
}

func TestConfigRejectsBadValues(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"short token":   `{"port":47821,"token":"abc"}`,
		"upper token":   `{"port":47821,"token":"` + strings.Repeat("A", 64) + `"}`,
		"low port":      `{"port":80,"token":"` + strings.Repeat("a", 64) + `"}`,
		"unknown field": `{"port":47821,"token":"` + strings.Repeat("a", 64) + `","bind":"0.0.0.0"}`,
		"not json":      `port=1`,
	}
	for name, body := range cases {
		p := filepath.Join(dir, strings.ReplaceAll(name, " ", "_")+".json")
		os.WriteFile(p, []byte(body), 0o600)
		if _, err := LoadConfig(p); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	ok := filepath.Join(dir, "ok.json")
	os.WriteFile(ok, []byte("\xEF\xBB\xBF"+`{"port":47821,"token":"`+strings.Repeat("a", 64)+`"}`), 0o600)
	if _, err := LoadConfig(ok); err != nil {
		t.Errorf("BOM config should load: %v", err)
	}
}

// ─── security matrix (brief §53) ─────────────────────────────────────────────

func TestSecurityMatrix(t *testing.T) {
	e := newEnv(t)
	tok := map[string]string{"X-Vision-Token": e.cfg.Token}
	type tc struct {
		name, method, path, body string
		hdr                      map[string]string
		status                   int
		code                     string
	}
	cases := []tc{
		{"no token", "GET", "/stats", "", nil, 401, "unauthorized"},
		{"wrong token", "GET", "/stats", "", map[string]string{"X-Vision-Token": strings.Repeat("0", 64)}, 401, "unauthorized"},
		{"wrong-length token", "POST", "/launch/notepad", "", map[string]string{"X-Vision-Token": "x"}, 401, "unauthorized"},
		{"token in query ignored", "GET", "/stats?token=" + e.cfg.Token, "", nil, 401, "unauthorized"},
		{"unknown app id", "POST", "/launch/doesnotexist", "", tok, 404, "unknown_app"},
		{"raw exe path (url)", "POST", "/launch/C:%5CWindows%5CSystem32%5Ccalc.exe", "", tok, 400, "invalid_id"},
		{"raw exe path (slashes)", "POST", "/launch/C:/Windows/System32/calc.exe", "", tok, 400, "invalid_id"},
		{"path traversal", "POST", "/launch/../../calc", "", tok, 400, "invalid_id"},
		{"raw exe path (body)", "POST", "/launch", `{"app_id":"C:\\Windows\\System32\\calc.exe"}`, tok, 400, "invalid_id"},
		{"exe field in body", "POST", "/launch/notepad", `{"app_id":"notepad","exe":"C:\\evil.exe"}`, tok, 400, "malformed_request"},
		{"args in body", "POST", "/launch/notepad", `{"app_id":"notepad","args":["/c","calc"]}`, tok, 400, "malformed_request"},
		{"shell command id", "POST", "/launch/cmd%20%2Fc%20calc", "", tok, 400, "invalid_id"},
		{"shell metachar id", "POST", "/launch/notepad&calc", "", tok, 400, "invalid_id"},
		{"shell command body", "POST", "/launch", `{"app_id":"notepad & calc"}`, tok, 400, "invalid_id"},
		{"query args", "POST", "/launch/notepad?args=calc", "", tok, 400, "malformed_request"},
		{"malformed json", "POST", "/launch", `{"app_id":`, tok, 400, "malformed_request"},
		{"json array", "POST", "/launch", `["notepad"]`, tok, 400, "malformed_request"},
		{"json trailing data", "POST", "/launch", `{"app_id":"notepad"}{"app_id":"x"}`, tok, 400, "malformed_request"},
		{"body/path mismatch", "POST", "/launch/notepad", `{"app_id":"missing"}`, tok, 400, "malformed_request"},
		{"oversized body", "POST", "/launch/notepad", strings.Repeat(" ", 2000), tok, 413, "malformed_request"},
		{"GET launch", "GET", "/launch/notepad", "", tok, 405, "method_not_allowed"},
		{"bad host (rebinding)", "GET", "/stats", "", map[string]string{"X-Vision-Token": e.cfg.Token, "Host": "evil.example:47821"}, 421, "bad_host"},
		{"bad origin", "GET", "/stats", "", map[string]string{"X-Vision-Token": e.cfg.Token, "Origin": "https://evil.example"}, 403, "bad_origin"},
		{"unknown route", "GET", "/etc/passwd", "", tok, 404, "not_found"},
		{"missing exe", "POST", "/launch/missing", "", tok, 422, "app_unavailable"},
		{"valid whitelisted id", "POST", "/launch/notepad", "", tok, 200, "launched"},
	}
	for _, c := range cases {
		e.srv.launchLimit = newBucket(100, 100) // isolate from throttling (tested separately)
		e.srv.general = newBucket(100, 100)
		w := e.do(t, c.method, c.path, c.body, c.hdr)
		if w.Code != c.status || code(w) != c.code {
			t.Errorf("%-24s → %d %q, want %d %q", c.name, w.Code, code(w), c.status, c.code)
		}
		if strings.Contains(w.Body.String(), e.dir) || strings.Contains(w.Body.String(), e.cfg.Token) {
			t.Errorf("%s: response leaks path or token: %s", c.name, w.Body.String())
		}
	}
	if len(e.rec.cmds) != 1 {
		t.Fatalf("expected exactly one launch, got %d", len(e.rec.cmds))
	}
	cmd := e.rec.cmds[0]
	if cmd.Path != e.exe || len(cmd.Args) != 2 || cmd.Args[1] != "--flag" {
		t.Fatalf("launched %q %v", cmd.Path, cmd.Args)
	}
}

func TestLaunchViaBodyOnly(t *testing.T) {
	e := newEnv(t)
	w := e.do(t, "POST", "/launch", `{"app_id":"notepad"}`, map[string]string{"X-Vision-Token": e.cfg.Token})
	if w.Code != 200 || len(e.rec.cmds) != 1 {
		t.Fatalf("got %d %s", w.Code, w.Body.String())
	}
}

func TestStatsAndAppsEndpoints(t *testing.T) {
	e := newEnv(t)
	tok := map[string]string{"X-Vision-Token": e.cfg.Token, "Origin": "null"}
	w := e.do(t, "GET", "/stats", "", tok)
	if w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("stats %d %v", w.Code, w.Header())
	}
	var s Snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil || s.CPU != 12.4 || s.RAM != 47.2 || s.GPU == nil || s.Network.Down != 830000 || s.Time == "" {
		t.Fatalf("stats payload %s", w.Body.String())
	}
	w = e.do(t, "GET", "/apps", "", tok)
	body := w.Body.String()
	if w.Code != 200 || !strings.Contains(body, `"notepad"`) {
		t.Fatalf("apps %d %s", w.Code, body)
	}
	if strings.Contains(body, e.dir) || strings.Contains(body, "exe") || strings.Contains(body, "--flag") {
		t.Fatalf("/apps leaks launch details: %s", body)
	}
}

func TestPreflight(t *testing.T) {
	e := newEnv(t)
	w := e.do(t, "OPTIONS", "/stats", "", map[string]string{"Origin": "null", "Access-Control-Request-Private-Network": "true"})
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Headers") == "" || w.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("preflight %d %v", w.Code, w.Header())
	}
	w = e.do(t, "OPTIONS", "/stats", "", map[string]string{"Origin": "https://evil.example"})
	if w.Code != 403 {
		t.Fatalf("evil preflight %d", w.Code)
	}
}

func TestRateLimits(t *testing.T) {
	e := newEnv(t)
	tok := map[string]string{"X-Vision-Token": e.cfg.Token}
	launched, limited := 0, 0
	for i := 0; i < 10; i++ {
		w := e.do(t, "POST", "/launch/notepad", "", tok)
		switch w.Code {
		case 200:
			launched++
		case 429:
			limited++
		}
	}
	if launched != 3 || limited != 7 {
		t.Fatalf("launch limiter: %d launched, %d limited", launched, limited)
	}
	e2 := newEnv(t)
	got429 := false
	for i := 0; i < 40; i++ {
		if e2.do(t, "GET", "/stats", "", map[string]string{"X-Vision-Token": "bad"}).Code == 429 {
			got429 = true
		}
	}
	if !got429 {
		t.Fatal("repeated bad tokens were never throttled")
	}
}

func TestBucketRefills(t *testing.T) {
	now := time.Unix(0, 0)
	b := newBucket(1, 1)
	b.now = func() time.Time { return now }
	b.last = now
	if !b.take() || b.take() {
		t.Fatal("capacity 1")
	}
	now = now.Add(1100 * time.Millisecond)
	if !b.take() {
		t.Fatal("should refill")
	}
}

// ─── whitelist / path handling ───────────────────────────────────────────────

func TestAppValidation(t *testing.T) {
	dir := t.TempDir()
	abs := fakeExe(t, dir, "good")
	bad := []rawApp{
		{ID: "UPPER", Exe: abs},
		{ID: "has space", Exe: abs},
		{ID: "../x", Exe: abs},
		{ID: "ok", Exe: "relative.exe"},
		{ID: "ok", Exe: `\\server\share\evil.exe`},
		{ID: "ok", Exe: "//server/share/evil.exe"},
		{ID: "ok", Exe: dir + string(filepath.Separator) + ".." + string(filepath.Separator) + "good"},
		{ID: "ok", Exe: abs + "\x00.exe"},
		{ID: "ok", Exe: abs, Args: make([]string, 17)},
		{ID: "ok", Exe: abs, Args: []string{"a\nb"}},
		{ID: "ok", Exe: "%COMSPEC%"},
		{ID: "ok", Exe: abs, Cwd: "relative"},
	}
	if runtime.GOOS == "windows" {
		bad = append(bad, rawApp{ID: "bat", Exe: `C:\x\run.bat`}, rawApp{ID: "lnk", Exe: `C:\x\app.lnk`})
	}
	for _, r := range bad {
		if _, err := validateApp(r, dir); err == nil {
			t.Errorf("accepted invalid app %+v", r)
		}
	}
	if _, err := validateApp(rawApp{ID: "good-1_a", Exe: abs, Args: []string{"--x"}}, dir); err != nil {
		t.Errorf("rejected valid app: %v", err)
	}
}

func TestEnvExpansionWhitelist(t *testing.T) {
	t.Setenv("LOCALAPPDATA", "/tmp/lad")
	if s, err := expandEnv("%LOCALAPPDATA%/x"); err != nil || s != "/tmp/lad/x" {
		t.Fatalf("%q %v", s, err)
	}
	if _, err := expandEnv("%PATH%"); err == nil {
		t.Fatal("PATH must not be expandable")
	}
}

func TestLoadAppsSkipsInvalidAndLimits(t *testing.T) {
	dir := t.TempDir()
	exe := fakeExe(t, dir, "a")
	var list []map[string]any
	list = append(list, map[string]any{"id": "bad id", "exe": exe})
	list = append(list, map[string]any{"id": "typo", "exe": exe, "exee": "x"})
	list = append(list, map[string]any{"id": "dup", "exe": exe}, map[string]any{"id": "dup", "exe": exe})
	for i := 0; i < 15; i++ {
		list = append(list, map[string]any{"id": "app" + string(rune('a'+i)), "exe": exe})
	}
	b, _ := json.Marshal(map[string]any{"apps": list})
	p := filepath.Join(dir, "apps.json")
	os.WriteFile(p, b, 0o644)
	apps, order, warnings, err := LoadApps(p, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(apps) != maxApps || len(order) != maxApps {
		t.Fatalf("got %d apps", len(apps))
	}
	if len(warnings) < 4 {
		t.Fatalf("warnings: %v", warnings)
	}
	os.WriteFile(p, []byte("{not json"), 0o644)
	if _, _, _, err := LoadApps(p, dir); err == nil {
		t.Fatal("malformed apps.json accepted")
	}
}

func TestRegistryHotReload(t *testing.T) {
	e := newEnv(t)
	if _, ok := e.srv.registry.Get("notepad"); !ok {
		t.Fatal("notepad missing")
	}
	time.Sleep(20 * time.Millisecond)
	os.WriteFile(e.appsPath, []byte(`{"apps":[{"id":"other","exe":"`+jsonEscape(e.exe)+`"}]}`), 0o644)
	future := time.Now().Add(2 * time.Second)
	os.Chtimes(e.appsPath, future, future)
	if !e.srv.registry.Reload() {
		t.Fatal("no reload")
	}
	if _, ok := e.srv.registry.Get("notepad"); ok {
		t.Fatal("removed app still launchable")
	}
	if _, ok := e.srv.registry.Get("other"); !ok {
		t.Fatal("new app missing")
	}
}

func jsonEscape(s string) string { b, _ := json.Marshal(s); return string(b[1 : len(b)-1]) }

func TestIconLoadingIsConfined(t *testing.T) {
	dir := t.TempDir()
	icons := filepath.Join(dir, "icons")
	os.Mkdir(icons, 0o755)
	os.WriteFile(filepath.Join(icons, "a.png"), []byte("\x89PNG"), 0o644)
	os.WriteFile(filepath.Join(dir, "secret.png"), []byte("x"), 0o644)
	if s := loadIcon(icons, "a.png"); !strings.HasPrefix(s, "data:image/png;base64,") {
		t.Fatalf("icon %q", s)
	}
	for _, n := range []string{"../secret.png", "..\\secret.png", "/etc/passwd", "a.exe", "a.png/../../secret.png"} {
		if loadIcon(icons, n) != "" {
			t.Errorf("icon %q escaped the icons folder", n)
		}
	}
}

// ─── token.js pairing ────────────────────────────────────────────────────────

func TestWriteTokenJSOnlyIntoVisionWallpaper(t *testing.T) {
	c := &Config{Port: 47821, Token: strings.Repeat("a", 64)}
	good := t.TempDir()
	os.WriteFile(filepath.Join(good, "LivelyInfo.json"), []byte("\xEF\xBB\xBF"+`{"Title":"VISION Orb"}`), 0o644)
	if err := WriteTokenJS(good, c, false); err != nil {
		t.Fatal(err)
	}
	js, _ := os.ReadFile(filepath.Join(good, "token.js"))
	if !strings.Contains(string(js), c.Token) || !strings.HasPrefix(string(js), "window.VISION_HELPER = {") {
		t.Fatalf("token.js: %s", js)
	}
	WriteTokenJS(good, c, true)
	js, _ = os.ReadFile(filepath.Join(good, "token.js"))
	if strings.Contains(string(js), c.Token) {
		t.Fatal("clear left the token behind")
	}
	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "LivelyInfo.json"), []byte(`{"Title":"Something Else"}`), 0o644)
	if WriteTokenJS(other, c, false) == nil || WriteTokenJS(t.TempDir(), c, false) == nil {
		t.Fatal("wrote token into a non-VISION folder")
	}
}

// ─── stats cache ─────────────────────────────────────────────────────────────

func TestStatsCacheNeverCollectsPerRequest(t *testing.T) {
	f := &fakeCollector{}
	s := NewStatsCache(f, time.Second, log.New(io.Discard, "", 0))
	s.collect()
	for i := 0; i < 1000; i++ {
		if s.JSON() == nil {
			t.Fatal("no body")
		}
	}
	if f.n != 1 {
		t.Fatalf("collector called %d times for 1000 requests", f.n)
	}
}

func TestStatsCacheIdlesWithoutRequests(t *testing.T) {
	f := &fakeCollector{}
	s := NewStatsCache(f, time.Second, log.New(io.Discard, "", 0))
	s.interval = 10 * time.Millisecond
	s.idleAfter = 30 * time.Millisecond
	stop := make(chan struct{})
	go s.Run(stop)
	time.Sleep(200 * time.Millisecond)
	idleCount := s.Samples()
	time.Sleep(200 * time.Millisecond)
	if s.Samples() != idleCount {
		t.Fatalf("collected while idle: %d → %d", idleCount, s.Samples())
	}
	s.JSON() // a request wakes it
	time.Sleep(100 * time.Millisecond)
	close(stop)
	if s.Samples() <= idleCount {
		t.Fatal("did not resume after request")
	}
}

func TestRealCollector(t *testing.T) {
	c, err := NewCollector()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Collect()
	time.Sleep(300 * time.Millisecond)
	s, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if s.CPU < 0 || s.CPU > 100 || s.RAM <= 0 || s.RAM > 100 {
		t.Fatalf("implausible stats %+v", s)
	}
}

// ─── launcher ────────────────────────────────────────────────────────────────

func TestLauncherNeverUsesShell(t *testing.T) {
	dir := t.TempDir()
	exe := fakeExe(t, dir, "tool")
	rec := &recordingLauncher{}
	l := &Launcher{start: rec.start}
	if err := l.Launch(App{ID: "t", Exe: exe, Args: []string{"a b", "&", "|calc"}}); err != nil {
		t.Fatal(err)
	}
	c := rec.cmds[0]
	if c.Path != exe {
		t.Fatalf("path %q", c.Path)
	}
	// metacharacters are passed as literal argv entries, never interpreted
	if strings.Join(c.Args[1:], "|") != "a b|&||calc" {
		t.Fatalf("args %q", c.Args)
	}
	base := strings.ToLower(filepath.Base(c.Path))
	if base == "cmd.exe" || base == "sh" || base == "powershell.exe" {
		t.Fatal("shell used")
	}
	if err := l.Launch(App{ID: "m", Exe: filepath.Join(dir, "missing"+exeSuffix())}); err != errAppUnavailable {
		t.Fatalf("missing exe: %v", err)
	}
}

func TestHTTPServerBindsLoopbackOnly(t *testing.T) {
	ln, err := Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if !strings.HasPrefix(ln.Addr().String(), "127.0.0.1:") {
		t.Fatalf("bound to %s", ln.Addr())
	}
	srv := NewHTTPServer(http.NotFoundHandler())
	if srv.ReadHeaderTimeout == 0 || srv.MaxHeaderBytes == 0 {
		t.Fatal("timeouts/limits not set")
	}
}

// ─── desktop probe support ───────────────────────────────────────────────────

func TestProbeReportEndpoint(t *testing.T) {
	e := newEnv(t)
	tok := map[string]string{"X-Vision-Token": e.cfg.Token, "Origin": "null"}
	if w := e.do(t, "POST", "/diag/probe-report", `{"kind":"vision-desktop-probe","steps":{}}`, nil); w.Code != 401 {
		t.Fatalf("no token → %d", w.Code)
	}
	for body, want := range map[string]int{
		`{"kind":"something-else"}`:                          400,
		`not json`:                                            400,
		`{"kind":"vision-desktop-probe","x":"` + strings.Repeat("a", 300<<10) + `"}`: 413,
	} {
		e.srv.general = newBucket(100, 100)
		if w := e.do(t, "POST", "/diag/probe-report", body, tok); w.Code != want {
			t.Errorf("body %.30q → %d, want %d", body, w.Code, want)
		}
	}
	w := e.do(t, "POST", "/diag/probe-report", `{"kind":"vision-desktop-probe","steps":{"move":{"counters":{"move":80}}}}`, tok)
	if w.Code != 200 {
		t.Fatalf("valid report → %d %s", w.Code, w.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(e.cfg.dir, "desktop-probe-report.json"))
	if err != nil || !strings.Contains(string(data), `"move": 80`) {
		t.Fatalf("report not written: %v %s", err, data)
	}
	if w := e.do(t, "GET", "/diag/probe-report", "", tok); w.Code != 405 {
		t.Fatalf("GET → %d", w.Code)
	}
}

func TestPairingAllowsProbeFolderOnly(t *testing.T) {
	c := &Config{Port: 47821, Token: strings.Repeat("b", 64)}
	probe := t.TempDir()
	os.WriteFile(filepath.Join(probe, "LivelyInfo.json"), []byte(`{"Title":"VISION Desktop Probe"}`), 0o644)
	if err := WriteTokenJS(probe, c, false); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "LivelyInfo.json"), []byte(`{"Title":"VISION Desktop Probe (copy)"}`), 0o644)
	if WriteTokenJS(other, c, false) == nil {
		t.Fatal("paired an unknown title")
	}
}

func TestHotkeyProbeWritesResult(t *testing.T) {
	dir := t.TempDir()
	if err := runHotkeyProbe(dir, 5); err != nil && runtime.GOOS == "windows" {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "hotkey-probe.json"))
	if err != nil || !strings.Contains(string(data), `"kind": "vision-hotkey-probe"`) {
		t.Fatalf("%v %s", err, data)
	}
}
