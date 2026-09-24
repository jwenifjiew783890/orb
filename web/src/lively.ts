/**
 * Lively Wallpaper bridge.
 *
 * Lively calls global functions on the page:
 *   livelyPropertyListener(name, value)        — once per property on load, then on change
 *   livelyAudioListener(float[128])            — when LivelyInfo "Arguments" has --audio
 *   livelyWallpaperPlaybackChanged(jsonString) — {"IsPaused":bool}, needs --pause-event
 *
 * The globals are installed immediately (before the app finishes booting) and
 * buffer anything that arrives early, so no property is ever lost.
 */
import type { QualityName, Settings, ThemeName } from "./config";

type PropHandler = (patch: Partial<Settings>) => void;
type AudioHandler = (bins: ArrayLike<number>) => void;
type PauseHandler = (paused: boolean) => void;

const THEME_BY_INDEX: ThemeName[] = ["gold", "arc", "crimson", "custom"];
const QUALITY_BY_INDEX: QualityName[] = ["low", "medium", "high"];

/** Map one Lively property to a settings patch. Unknown names are ignored. */
export function mapLivelyProperty(name: string, val: unknown): Partial<Settings> | null {
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
  const bool = (v: unknown) => v === true || v === "true" || v === 1;
  switch (name) {
    case "theme": return { theme: THEME_BY_INDEX[Math.max(0, Math.min(3, num(val) | 0))] };
    case "customColor": return typeof val === "string" && /^#[0-9a-f]{6}$/i.test(val) ? { customColor: val } : null;
    case "rotationSpeed": return { rotationSpeed: Math.max(0, Math.min(2, num(val) / 100)) };
    case "bloomStrength": return { bloomStrength: Math.max(0, Math.min(2, num(val) / 100)) };
    case "particleDensity": return { particleDensity: Math.max(0.25, Math.min(1.5, num(val) / 100)) };
    case "audioReactive": return { audioReactive: bool(val) };
    case "hudStats": return { hudStats: bool(val) };
    case "quality": return { quality: QUALITY_BY_INDEX[Math.max(0, Math.min(2, num(val) | 0))] };
    case "autoQuality": return { autoQuality: bool(val) };
    case "debugOverlay": return { debugOverlay: bool(val) };
    case "userName": return { userName: String(val ?? "").slice(0, 40) };
    case "helperPort": {
      const p = num(val) | 0;
      return p >= 1024 && p <= 65535 ? { helperPort: p } : null;
    }
    case "helperToken": return { helperToken: String(val ?? "").trim().slice(0, 128) };
    default: return null;
  }
}

class LivelyBridge {
  private propHandler: PropHandler | null = null;
  private audioHandler: AudioHandler | null = null;
  private pauseHandler: PauseHandler | null = null;
  private pendingProps: Partial<Settings> = {};
  private pendingPause: boolean | null = null;
  /** True once Lively has called any hook (useful for the debug overlay). */
  seenLively = false;

  install() {
    const w = window as unknown as Record<string, unknown>;
    w.livelyPropertyListener = (name: string, val: unknown) => {
      this.seenLively = true;
      const patch = mapLivelyProperty(name, val);
      if (!patch) return;
      if (this.propHandler) this.propHandler(patch);
      else Object.assign(this.pendingProps, patch);
    };
    w.livelyAudioListener = (bins: ArrayLike<number>) => {
      this.seenLively = true;
      this.audioHandler?.(bins);
    };
    w.livelyWallpaperPlaybackChanged = (data: string) => {
      this.seenLively = true;
      let paused = false;
      try { paused = !!(JSON.parse(data) as { IsPaused?: boolean }).IsPaused; } catch { return; }
      if (this.pauseHandler) this.pauseHandler(paused);
      else this.pendingPause = paused;
    };
  }

  onProperties(h: PropHandler) {
    this.propHandler = h;
    if (Object.keys(this.pendingProps).length) { h(this.pendingProps); this.pendingProps = {}; }
  }
  onAudio(h: AudioHandler) { this.audioHandler = h; }
  onPause(h: PauseHandler) {
    this.pauseHandler = h;
    if (this.pendingPause !== null) { h(this.pendingPause); this.pendingPause = null; }
  }
}

export const lively = new LivelyBridge();
