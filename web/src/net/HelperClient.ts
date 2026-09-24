/**
 * Client for the local VISION Helper (http://127.0.0.1:<port>).
 *
 * The orb never depends on this: every call has a short timeout, failures only
 * flip the HUD to "STATS OFFLINE", and polling backs off and retries on its own.
 * The browser only ever sends an app *id* — never a path or command.
 */

export interface Stats {
  cpu: number;
  ram: number;
  gpu: number | null;
  network: { up: number; down: number };
  time: string;
}

export interface AppInfo {
  id: string;
  label: string;
  /** data: URL (PNG/ICO/SVG, size-limited by the helper) or null for a monogram. */
  icon: string | null;
}

export type LinkStatus = "connecting" | "online" | "offline" | "unauthorized" | "disabled";

export interface HelperConfig { port: number; token: string }

export const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const POLL_MS = 1500;
const TIMEOUT_MS = 1200;
const MAX_BACKOFF_MS = 15000;

export class HelperClient {
  status: LinkStatus = "connecting";
  lastStats: Stats | null = null;
  private timer: number | null = null;
  private backoff = POLL_MS;
  private running = false;
  private pollStats = true;
  private inflight: AbortController | null = null;
  private statusListeners: ((s: LinkStatus) => void)[] = [];
  private statsListeners: ((s: Stats) => void)[] = [];

  constructor(private cfg: HelperConfig) {}

  configure(cfg: Partial<HelperConfig>) {
    const changed = (cfg.port !== undefined && cfg.port !== this.cfg.port) || (cfg.token !== undefined && cfg.token !== this.cfg.token);
    this.cfg = { ...this.cfg, ...cfg };
    if (changed && this.running) { this.backoff = POLL_MS; this.schedule(0); }
  }

  get hasToken() { return this.cfg.token.length > 0; }

  onStatus(l: (s: LinkStatus) => void) { this.statusListeners.push(l); }
  onStats(l: (s: Stats) => void) { this.statsListeners.push(l); }

  private setStatus(s: LinkStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  /** Enable/disable stats polling (HUD Stats setting). */
  setStatsEnabled(on: boolean) {
    this.pollStats = on;
    if (!on) { this.clear(); this.setStatus("disabled"); }
    else if (this.running) { this.setStatus("connecting"); this.schedule(0); }
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.pollStats) this.schedule(0);
  }

  /** Stop all network activity (wallpaper hidden / paused). */
  stop() {
    this.running = false;
    this.clear();
  }

  private clear() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.inflight?.abort();
    this.inflight = null;
  }

  private schedule(ms: number) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.tick(); }, ms);
  }

  private url(path: string) { return `http://127.0.0.1:${this.cfg.port}${path}`; }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const t = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(this.url(path), {
        ...init,
        signal: ctrl.signal,
        cache: "no-store",
        headers: { "X-Vision-Token": this.cfg.token, ...(init.headers ?? {}) },
      });
    } finally {
      clearTimeout(t);
      if (this.inflight === ctrl) this.inflight = null;
    }
  }

  private async tick() {
    if (!this.running || !this.pollStats) return;
    if (!this.hasToken) { this.setStatus("unauthorized"); this.schedule(MAX_BACKOFF_MS); return; }
    try {
      const r = await this.request("/stats");
      if (r.status === 401 || r.status === 403) { this.setStatus("unauthorized"); this.backoff = MAX_BACKOFF_MS; }
      else if (!r.ok) throw new Error(`HTTP ${r.status}`);
      else {
        const s = sanitizeStats(await r.json());
        if (!s) throw new Error("bad payload");
        this.lastStats = s;
        this.backoff = POLL_MS;
        this.setStatus("online");
        for (const l of this.statsListeners) l(s);
      }
    } catch {
      if (!this.running) return;
      this.setStatus("offline");
      this.backoff = Math.min(MAX_BACKOFF_MS, Math.max(POLL_MS, this.backoff * 1.6));
    }
    if (this.running && this.pollStats) this.schedule(this.backoff);
  }

  async apps(): Promise<AppInfo[] | null> {
    if (!this.hasToken) return null;
    try {
      const r = await this.request("/apps");
      if (!r.ok) return null;
      const j = (await r.json()) as { apps?: unknown };
      if (!Array.isArray(j.apps)) return null;
      return j.apps
        .filter((a): a is AppInfo => !!a && typeof (a as AppInfo).id === "string" && APP_ID_RE.test((a as AppInfo).id))
        .slice(0, 12)
        .map((a) => ({
          id: a.id,
          label: String(a.label ?? a.id).slice(0, 24),
          icon: typeof a.icon === "string" && /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|webp);base64,/.test(a.icon) ? a.icon : null,
        }));
    } catch {
      return null;
    }
  }

  async launch(id: string): Promise<{ ok: boolean; code: string }> {
    if (!APP_ID_RE.test(id)) return { ok: false, code: "invalid_id" };
    try {
      const r = await this.request(`/launch/${encodeURIComponent(id)}`, { method: "POST" });
      let code = r.ok ? "launched" : `http_${r.status}`;
      try { const j = (await r.json()) as { code?: string }; if (j.code) code = String(j.code); } catch { /* empty body */ }
      return { ok: r.ok, code };
    } catch {
      this.setStatus("offline");
      return { ok: false, code: "offline" };
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function sanitizeStats(j: unknown): Stats | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const cpu = num(o.cpu), ram = num(o.ram);
  if (cpu === null || ram === null) return null;
  const net = (o.network ?? {}) as Record<string, unknown>;
  const clamp = (x: number) => Math.max(0, Math.min(100, x));
  const gpu = num(o.gpu);
  return {
    cpu: clamp(cpu),
    ram: clamp(ram),
    gpu: gpu === null ? null : clamp(gpu),
    network: { up: Math.max(0, num(net.up) ?? 0), down: Math.max(0, num(net.down) ?? 0) },
    time: typeof o.time === "string" ? o.time : "",
  };
}
