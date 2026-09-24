package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Config is the helper's private configuration (config/config.json).
// It is created by `vision-helper --init` during installation and holds the
// randomly generated API token. It is never exposed over HTTP.
type Config struct {
	Port            int      `json:"port"`
	Token           string   `json:"token"`
	AllowedOrigins  []string `json:"allowedOrigins"`
	AppsFile        string   `json:"appsFile"`
	IconsDir        string   `json:"iconsDir"`
	StatsIntervalMs int      `json:"statsIntervalMs"`

	dir string // directory containing config.json (for relative paths)
}

const (
	DefaultPort      = 47821
	tokenBytes       = 32
	maxConfigBytes   = 64 << 10
	maxAppsBytes     = 256 << 10
	maxIconBytes     = 256 << 10
	maxApps          = 12
	maxArgs          = 16
	maxArgLen        = 512
	minStatsInterval = 1000
)

var (
	appIDRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	tokenRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	iconRe   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}\.(png|ico|svg|jpg|jpeg|webp)$`)
	envVarRe = regexp.MustCompile(`%([A-Za-z0-9_()]+)%`)
	// Only these environment variables may be expanded inside apps.json paths.
	allowedEnv = map[string]bool{
		"LOCALAPPDATA": true, "APPDATA": true, "PROGRAMFILES": true, "PROGRAMFILES(X86)": true,
		"PROGRAMW6432": true, "USERPROFILE": true, "SYSTEMROOT": true, "WINDIR": true, "PROGRAMDATA": true, "HOME": true,
	}
)

// NewToken returns 32 cryptographically random bytes as 64 lowercase hex chars.
func NewToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func defaultConfig(dir string) *Config {
	return &Config{
		Port:            DefaultPort,
		AllowedOrigins:  []string{"null", "file://"},
		AppsFile:        filepath.Join("..", "apps.json"),
		IconsDir:        filepath.Join("..", "icons"),
		StatsIntervalMs: 1000,
		dir:             dir,
	}
}

// LoadConfig reads and validates config.json.
func LoadConfig(path string) (*Config, error) {
	data, err := readLimited(path, maxConfigBytes)
	if err != nil {
		return nil, err
	}
	c := defaultConfig(filepath.Dir(path))
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(c); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) Validate() error {
	if c.Port < 1024 || c.Port > 65535 {
		return errors.New("config: port must be 1024-65535")
	}
	if !tokenRe.MatchString(c.Token) {
		return errors.New("config: token must be 64 lowercase hex characters (run --init)")
	}
	if c.StatsIntervalMs < minStatsInterval {
		c.StatsIntervalMs = minStatsInterval
	}
	if len(c.AllowedOrigins) == 0 {
		c.AllowedOrigins = []string{"null", "file://"}
	}
	return nil
}

func (c *Config) resolve(p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(c.dir, p))
}

func (c *Config) AppsPath() string  { return c.resolve(c.AppsFile) }
func (c *Config) IconsPath() string { return c.resolve(c.IconsDir) }

// InitConfig creates config.json with a fresh random token if it is missing
// (or rotates the token when rotate is true). Existing settings are preserved.
func InitConfig(path string, rotate bool) (*Config, bool, error) {
	c := defaultConfig(filepath.Dir(path))
	created := false
	if data, err := readLimited(path, maxConfigBytes); err == nil {
		if err := json.Unmarshal(data, c); err != nil {
			return nil, false, fmt.Errorf("existing config is invalid: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	if rotate || !tokenRe.MatchString(c.Token) {
		t, err := NewToken()
		if err != nil {
			return nil, false, err
		}
		c.Token = t
		created = true
	}
	if err := c.Validate(); err != nil {
		return nil, false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, err
	}
	out, _ := json.MarshalIndent(c, "", "  ")
	if err := writeFileAtomic(path, out, 0o600); err != nil {
		return nil, false, err
	}
	return c, created, nil
}

// ─── apps.json ───────────────────────────────────────────────────────────────

// App is one whitelisted application. Exe/Args/Cwd never leave the helper.
type App struct {
	ID    string
	Label string
	Exe   string
	Args  []string
	Cwd   string
	Icon  string // data: URL or ""
}

// PublicApp is what the wallpaper receives.
type PublicApp struct {
	ID    string  `json:"id"`
	Label string  `json:"label"`
	Icon  *string `json:"icon"`
}

type rawApp struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Icon   *string  `json:"icon"`
	Exe    string   `json:"exe"`
	Args   []string `json:"args"`
	Cwd    string   `json:"cwd"`
	Hotkey *string  `json:"hotkey"`
}

// LoadApps parses and validates apps.json. Invalid entries are skipped and
// reported in warnings; they are never launchable.
func LoadApps(path, iconsDir string) (map[string]App, []string, []string, error) {
	data, err := readLimited(path, maxAppsBytes)
	if err != nil {
		return nil, nil, nil, err
	}
	var file struct {
		Apps []json.RawMessage `json:"apps"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, nil, nil, fmt.Errorf("apps.json: %w", err)
	}
	apps := map[string]App{}
	var order, warnings []string
	for i, raw := range file.Apps {
		if len(order) >= maxApps {
			warnings = append(warnings, fmt.Sprintf("apps[%d]: ignored, maximum %d apps", i, maxApps))
			continue
		}
		var r rawApp
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			warnings = append(warnings, fmt.Sprintf("apps[%d]: %v", i, err))
			continue
		}
		app, err := validateApp(r, iconsDir)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("apps[%d] (%s): %v", i, r.ID, err))
			continue
		}
		if _, dup := apps[app.ID]; dup {
			warnings = append(warnings, fmt.Sprintf("apps[%d]: duplicate id %q", i, app.ID))
			continue
		}
		apps[app.ID] = app
		order = append(order, app.ID)
	}
	return apps, order, warnings, nil
}

func validateApp(r rawApp, iconsDir string) (App, error) {
	if !appIDRe.MatchString(r.ID) {
		return App{}, errors.New("id must match ^[a-z0-9][a-z0-9_-]{0,31}$")
	}
	label := strings.TrimSpace(r.Label)
	if label == "" {
		label = r.ID
	}
	if len([]rune(label)) > 24 {
		label = string([]rune(label)[:24])
	}
	exe, err := expandEnv(r.Exe)
	if err != nil {
		return App{}, err
	}
	if err := validateExePath(exe); err != nil {
		return App{}, err
	}
	if len(r.Args) > maxArgs {
		return App{}, fmt.Errorf("at most %d args", maxArgs)
	}
	args := make([]string, 0, len(r.Args))
	for _, a := range r.Args {
		if len(a) > maxArgLen || strings.ContainsAny(a, "\x00\r\n") {
			return App{}, errors.New("invalid argument")
		}
		ea, err := expandEnv(a)
		if err != nil {
			return App{}, err
		}
		args = append(args, ea)
	}
	cwd := ""
	if r.Cwd != "" {
		c, err := expandEnv(r.Cwd)
		if err != nil {
			return App{}, err
		}
		if !filepath.IsAbs(c) || strings.HasPrefix(c, `\\`) {
			return App{}, errors.New("cwd must be an absolute local path")
		}
		cwd = filepath.Clean(c)
	}
	icon := ""
	if r.Icon != nil && *r.Icon != "" {
		icon = loadIcon(iconsDir, *r.Icon)
	}
	return App{ID: r.ID, Label: label, Exe: exe, Args: args, Cwd: cwd, Icon: icon}, nil
}

// validateExePath enforces: absolute, local (no UNC), already clean (no ".."),
// and on Windows a .exe target — .bat/.cmd/.lnk would involve a shell.
func validateExePath(p string) error {
	if p == "" {
		return errors.New("exe is required")
	}
	if strings.ContainsAny(p, "\x00\r\n\"*?<>|") {
		return errors.New("exe contains invalid characters")
	}
	if strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, "//") {
		return errors.New("exe must be a local path (UNC not allowed)")
	}
	if !filepath.IsAbs(p) {
		return errors.New("exe must be an absolute path")
	}
	for _, part := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." || part == "." {
			return errors.New("exe must not contain . or .. segments")
		}
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(p), ".exe") {
		return errors.New("exe must point to a .exe file")
	}
	return nil
}

func expandEnv(s string) (string, error) {
	var bad error
	out := envVarRe.ReplaceAllStringFunc(s, func(m string) string {
		name := strings.ToUpper(m[1 : len(m)-1])
		if !allowedEnv[name] {
			bad = fmt.Errorf("environment variable %%%s%% is not allowed", name)
			return m
		}
		return os.Getenv(name)
	})
	return out, bad
}

func loadIcon(iconsDir, name string) string {
	if !iconRe.MatchString(name) {
		return ""
	}
	p := filepath.Join(iconsDir, name)
	if filepath.Dir(p) != filepath.Clean(iconsDir) {
		return ""
	}
	data, err := readLimited(p, maxIconBytes)
	if err != nil {
		return ""
	}
	mime := map[string]string{
		".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml",
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
	}[strings.ToLower(filepath.Ext(name))]
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

// ─── token.js for the wallpaper ──────────────────────────────────────────────

// pairableTitles are the only wallpapers the helper will write token.js into.
var pairableTitles = map[string]bool{"VISION Orb": true, "VISION Desktop Probe": true}

// WriteTokenJS writes <dir>/token.js so the wallpaper can authenticate. It only
// writes into a folder that is recognisably a VISION Orb wallpaper.
func WriteTokenJS(dir string, c *Config, clear bool) error {
	info, err := readLimited(filepath.Join(dir, "LivelyInfo.json"), 64<<10)
	if err != nil {
		return fmt.Errorf("%s is not a wallpaper folder (no LivelyInfo.json)", dir)
	}
	var li struct{ Title string }
	if json.Unmarshal(stripBOM(info), &li) != nil || !pairableTitles[li.Title] {
		return fmt.Errorf("%s is not the VISION Orb wallpaper", dir)
	}
	body := "window.VISION_HELPER = null;\n"
	if !clear {
		j, _ := json.Marshal(map[string]any{"port": c.Port, "token": c.Token})
		body = "window.VISION_HELPER = " + string(j) + ";\n"
	}
	return writeFileAtomic(filepath.Join(dir, "token.js"), []byte(body), 0o600)
}

// ─── fs helpers ──────────────────────────────────────────────────────────────

func readLimited(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	if st.Size() > max {
		return nil, fmt.Errorf("file too large (%d bytes, max %d)", st.Size(), max)
	}
	buf := make([]byte, st.Size())
	_, err = io.ReadFull(f, buf)
	return stripBOM(buf), err
}

func stripBOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	return b
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
