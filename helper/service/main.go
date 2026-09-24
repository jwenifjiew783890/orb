// VISION Helper — a small localhost service for the VISION Orb wallpaper.
//
// It serves cached system statistics and launches whitelisted applications by
// id. It binds to 127.0.0.1 only and requires a random per-install token.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
)

var Version = "1.0.0"

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func defaultConfigPath() string {
	exe, err := os.Executable()
	if err != nil {
		return filepath.Join("config", "config.json")
	}
	// layout: helper/bin/vision-helper.exe → helper/config/config.json
	return filepath.Join(filepath.Dir(filepath.Dir(exe)), "config", "config.json")
}

func main() {
	var (
		cfgPath     = flag.String("config", defaultConfigPath(), "path to config.json")
		initFlag    = flag.Bool("init", false, "create config.json with a random token if missing, then exit")
		rotate      = flag.Bool("rotate-token", false, "with --init: generate a new token even if one exists")
		printPort   = flag.Bool("print-port", false, "print the configured port and exit")
		checkApps   = flag.Bool("check-apps", false, "validate apps.json, print the result and exit")
		version     = flag.Bool("version", false, "print version and exit")
		probeHotkey = flag.Int("probe-hotkey", 0, "register Ctrl+Space and Ctrl+Alt+Space for N seconds, record presses to config/hotkey-probe.json, then exit")
		writeTokens multiFlag
		clearTokens multiFlag
	)
	flag.Var(&writeTokens, "write-token-js", "write token.js into this VISION wallpaper folder (repeatable)")
	flag.Var(&clearTokens, "clear-token-js", "replace token.js in this wallpaper folder with an empty stub (repeatable)")
	flag.Parse()

	if *version {
		fmt.Println(Version)
		return
	}
	if *probeHotkey > 0 {
		exitOn(runHotkeyProbe(filepath.Dir(*cfgPath), *probeHotkey))
		return
	}
	if *initFlag {
		c, created, err := InitConfig(*cfgPath, *rotate)
		exitOn(err)
		if created {
			fmt.Println("token: generated")
		} else {
			fmt.Println("token: kept existing")
		}
		fmt.Printf("config: %s\nport: %d\n", *cfgPath, c.Port)
		if len(writeTokens) == 0 {
			return
		}
	}
	if len(writeTokens) > 0 || len(clearTokens) > 0 {
		c, err := LoadConfig(*cfgPath)
		exitOn(err)
		failed := false
		for _, d := range writeTokens {
			if err := WriteTokenJS(d, c, false); err != nil {
				fmt.Fprintln(os.Stderr, "skip:", err)
				failed = true
			} else {
				fmt.Println("paired:", d)
			}
		}
		for _, d := range clearTokens {
			if err := WriteTokenJS(d, c, true); err != nil {
				fmt.Fprintln(os.Stderr, "skip:", err)
			} else {
				fmt.Println("cleared:", d)
			}
		}
		if failed {
			os.Exit(3)
		}
		return
	}
	cfg, err := LoadConfig(*cfgPath)
	exitOn(err)
	if *printPort {
		fmt.Println(cfg.Port)
		return
	}
	if *checkApps {
		apps, order, warnings, err := LoadApps(cfg.AppsPath(), cfg.IconsPath())
		exitOn(err)
		for _, w := range warnings {
			fmt.Println("warning:", w)
		}
		for _, id := range order {
			a := apps[id]
			_, statErr := os.Stat(a.Exe)
			state := "ok"
			if statErr != nil {
				state = "exe not found"
			}
			fmt.Printf("%-16s %-24s %s\n", id, a.Label, state)
		}
		return
	}

	// Keep the footprint small: this process idles in the background all day.
	runtime.GOMAXPROCS(2)
	debug.SetGCPercent(40)
	debug.SetMemoryLimit(24 << 20)

	release, already, err := acquireSingleton(cfg.Port)
	if already {
		return // another helper is running — not an error (Task Scheduler repetition)
	}
	exitOn(err)
	defer release()

	logger := newLogger(filepath.Join(filepath.Dir(*cfgPath), "helper.log"))
	logger.Printf("VISION Helper %s starting on 127.0.0.1:%d", Version, cfg.Port)

	collector, err := NewCollector()
	exitOn(err)
	defer collector.Close()

	stop := make(chan struct{})
	stats := NewStatsCache(collector, time.Duration(cfg.StatsIntervalMs)*time.Millisecond, logger)
	reg := NewRegistry(cfg.AppsPath(), cfg.IconsPath(), logger)
	go stats.Run(stop)
	go reg.Watch(stop)

	ln, err := Listen(cfg.Port)
	if err != nil {
		logger.Printf("listen failed: %v", err)
		exitOn(err)
	}
	srv := NewHTTPServer(NewServer(cfg, stats, reg, NewLauncher(), logger))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		close(stop)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Printf("serve: %v", err)
		os.Exit(1) // non-zero so Task Scheduler's restart-on-failure applies
	}
	logger.Printf("stopped")
}

func exitOn(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "vision-helper:", err)
		os.Exit(2)
	}
}

// newLogger writes to helper.log (truncated at start when over 1 MB). Tokens
// and executable paths are never logged.
func newLogger(path string) *log.Logger {
	var w io.Writer = os.Stderr
	if st, err := os.Stat(path); err == nil && st.Size() > 1<<20 {
		_ = os.Remove(path)
	}
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		w = f
	}
	return log.New(w, "", log.LstdFlags)
}
