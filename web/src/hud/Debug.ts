/**
 * Development overlay. When disabled it is removed from the DOM and update()
 * returns immediately — no timers, no stats sampling, no GPU queries.
 */
export interface DebugInfo {
  fps: number;
  frameMs: number;
  gpuMs: number;
  targetFps: number;
  totalCalls: number;
  sceneCalls: number;
  lines: number;
  points: number;
  triangles: number;
  dpr: number;
  outerStrands: number;
  innerStrands: number;
  particles: number;
  renderer: string;
  quality: string;
  autoStep: number;
  autoReason: string;
  helper: string;
  state: string;
  genMs: number;
}

export class DebugOverlay {
  private readonly el: HTMLElement;
  private enabled = false;
  private acc = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("pre");
    this.el.className = "debug";
    this.parent = parent;
  }
  private readonly parent: HTMLElement;

  get isEnabled() { return this.enabled; }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.parent.appendChild(this.el);
    else this.el.remove();
  }

  /** Returns true when it wants fresh scene stats sampled (every ~2 s). */
  tick(dt: number): boolean {
    if (!this.enabled) return false;
    this.acc += dt;
    return this.acc >= 0.5;
  }

  render(d: DebugInfo) {
    if (!this.enabled) return;
    this.acc = 0;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const f = (n: number, p = 1) => (Number.isFinite(n) ? n.toFixed(p) : "n/a");
    this.el.textContent = [
      `VISION DEBUG`,
      `state        ${d.state}`,
      `fps          ${f(d.fps)} (target ${d.targetFps})`,
      `frame (cpu)  ${f(d.frameMs, 2)} ms`,
      `frame (gpu)  ${Number.isNaN(d.gpuMs) ? "no timer ext" : f(d.gpuMs, 2) + " ms"}`,
      `draw calls   ${d.totalCalls} total · ${d.sceneCalls} orb`,
      `primitives   ${d.lines} lines · ${d.points} points · ${d.triangles} tris`,
      `dpr          ${f(d.dpr, 2)}`,
      `filaments    ${d.outerStrands} outer · ${d.innerStrands} inner`,
      `particles    ${d.particles}`,
      `renderer     ${d.renderer}`,
      `quality      ${d.quality} · auto step ${d.autoStep}`,
      `auto         ${d.autoReason}`,
      `helper       ${d.helper}`,
      `js heap      ${mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(1)} / ${(mem.totalJSHeapSize / 1048576).toFixed(1)} MB` : "n/a"}`,
      `gen          ${f(d.genMs, 0)} ms`,
    ].join("\n");
  }
}
