/**
 * Secondary HUD: clock/date/greeting (top-left), thin arc gauges (bottom),
 * link status and the boot caption. Plain DOM + CSS transitions, so it costs
 * nothing per frame; text updates at most once per second.
 */
import type { LinkStatus, Stats } from "../net/HelperClient";

const ARC_LEN = 0.75; // 270° gauges
const R = 26;
const CIRC = 2 * Math.PI * R;

function gaugeSvg(): string {
  const dash = `${CIRC * ARC_LEN} ${CIRC}`;
  return `<svg viewBox="0 0 64 64" aria-hidden="true">
    <circle class="track" cx="32" cy="32" r="${R}" stroke-dasharray="${dash}" transform="rotate(135 32 32)"/>
    <circle class="fill" cx="32" cy="32" r="${R}" stroke-dasharray="${dash}" stroke-dashoffset="${CIRC * ARC_LEN}" transform="rotate(135 32 32)"/>
  </svg>`;
}

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Good night";
}

export function formatRate(bytesPerSec: number): string {
  const b = Math.max(0, bytesPerSec);
  if (b < 1000) return `${b.toFixed(0)} B/s`;
  if (b < 1e6) return `${(b / 1e3).toFixed(b < 1e4 ? 1 : 0)} KB/s`;
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB/s`;
  return `${(b / 1e9).toFixed(1)} GB/s`;
}

interface Gauge { root: HTMLElement; fill: SVGCircleElement; value: HTMLElement; sub: HTMLElement }

export class Hud {
  private readonly el: HTMLElement;
  private readonly time: HTMLElement;
  private readonly date: HTMLElement;
  private readonly greet: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly link: HTMLElement;
  private readonly boot: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly gauges: Record<"cpu" | "ram" | "gpu" | "net", Gauge>;
  private clockTimer: number | null = null;
  private name = "";
  private toastTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = parent;
    parent.innerHTML = `
      <section class="hud-clock">
        <div class="hud-time">--:--</div>
        <div class="hud-date"></div>
        <div class="hud-greet"></div>
      </section>
      <section class="hud-stats">
        ${["cpu", "ram", "gpu", "net"].map((k) => `
          <div class="gauge" data-k="${k}">
            ${gaugeSvg()}
            <div class="g-val">--</div>
            <div class="g-label">${k === "net" ? "NETWORK" : k.toUpperCase()}</div>
            <div class="g-sub"></div>
          </div>`).join("")}
        <div class="hud-link">STATS OFFLINE</div>
      </section>
      <div class="hud-boot"></div>
      <div class="hud-toast"></div>
    `;
    const q = <T extends Element>(s: string) => parent.querySelector(s) as T;
    this.time = q(".hud-time");
    this.date = q(".hud-date");
    this.greet = q(".hud-greet");
    this.stats = q(".hud-stats");
    this.link = q(".hud-link");
    this.boot = q(".hud-boot");
    this.toast = q(".hud-toast");
    const g = (k: string): Gauge => {
      const root = q<HTMLElement>(`.gauge[data-k="${k}"]`);
      return { root, fill: root.querySelector(".fill") as SVGCircleElement, value: root.querySelector(".g-val") as HTMLElement, sub: root.querySelector(".g-sub") as HTMLElement };
    };
    this.gauges = { cpu: g("cpu"), ram: g("ram"), gpu: g("gpu"), net: g("net") };
  }

  setName(name: string) {
    this.name = name.trim();
    this.renderClock();
  }

  setAccent(cssColor: string, light: string) {
    this.el.style.setProperty("--accent", cssColor);
    this.el.style.setProperty("--accent-light", light);
  }

  setStatsVisible(on: boolean) {
    this.stats.classList.toggle("hidden", !on);
  }

  startClock() {
    if (this.clockTimer !== null) return;
    const tick = () => {
      this.renderClock();
      const now = new Date();
      this.clockTimer = window.setTimeout(tick, 1000 - now.getMilliseconds() + 5);
    };
    tick();
  }

  stopClock() {
    if (this.clockTimer !== null) { clearTimeout(this.clockTimer); this.clockTimer = null; }
  }

  private renderClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const t = `${hh}:${mm}`;
    if (this.time.textContent !== t) this.time.textContent = t;
    const d = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).replace(",", "").toUpperCase();
    // "THURSDAY 24 SEPTEMBER" → "THURSDAY, 24 SEPTEMBER"
    const date = d.replace(/^(\S+)\s/, "$1, ");
    if (this.date.textContent !== date) this.date.textContent = date;
    const g = greetingFor(now.getHours()) + (this.name ? `, ${this.name}` : "");
    if (this.greet.textContent !== g) this.greet.textContent = g;
  }

  setLink(status: LinkStatus) {
    const label =
      status === "online" ? "" :
      status === "unauthorized" ? "SYSTEM LINK UNPAIRED" :
      status === "disabled" ? "" :
      status === "connecting" ? "LINKING…" : "STATS OFFLINE";
    this.link.textContent = label;
    this.link.classList.toggle("show", label !== "");
    this.stats.classList.toggle("offline", status !== "online");
  }

  private setGauge(g: Gauge, frac: number, text: string, sub = "") {
    const f = Math.max(0, Math.min(1, frac));
    g.fill.style.strokeDashoffset = String(CIRC * ARC_LEN * (1 - f));
    if (g.value.textContent !== text) g.value.textContent = text;
    if (g.sub.textContent !== sub) g.sub.textContent = sub;
  }

  setStats(s: Stats) {
    this.setGauge(this.gauges.cpu, s.cpu / 100, `${Math.round(s.cpu)}%`);
    this.setGauge(this.gauges.ram, s.ram / 100, `${Math.round(s.ram)}%`);
    if (s.gpu === null) this.setGauge(this.gauges.gpu, 0, "—", "n/a");
    else this.setGauge(this.gauges.gpu, s.gpu / 100, `${Math.round(s.gpu)}%`);
    // network arc on a log scale: 1 KB/s … 1 GB/s
    const total = s.network.down + s.network.up;
    const frac = total <= 1000 ? 0 : Math.log10(total / 1000) / 6;
    this.setGauge(this.gauges.net, frac, formatRate(s.network.down), `↑ ${formatRate(s.network.up)}`);
  }

  /** Boot caption: types the text, then fades it (driven by the boot timeline). */
  bootText(chars: number, text: string, opacity: number) {
    const s = text.slice(0, chars);
    if (this.boot.textContent !== s) this.boot.textContent = s;
    this.boot.style.opacity = String(opacity);
  }

  showToast(msg: string, ms = 2600) {
    this.toast.textContent = msg;
    this.toast.classList.add("show");
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove("show"), ms);
  }
}
