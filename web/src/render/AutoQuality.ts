/**
 * Adaptive quality. Measures real performance after boot (and periodically
 * while idle) and steps quality DOWN in controlled stages, cheapest visual loss
 * first:
 *
 *   1 particle density ×0.6      4 DPR cap → 1.0
 *   2 filament density ×0.75     5 secondary effects off (chromatic, glyphs)
 *   3 bloom resolution ×0.6
 *
 * Budget: the idle GPU target is ≤10% at 30 fps, i.e. ≤ ~3.3 ms of GPU time per
 * frame. With a GPU timer that is measured directly; without one, the fallback
 * is frame pacing: at a 60 fps target, sustained intervals > 20 ms mean the
 * frame can't keep up.
 */
import type { QualityProfile } from "../config";

export interface QualityAdjust {
  step: number;
  profile: QualityProfile;
  particleScale: number;
  reason: string;
}

export const MAX_STEP = 5;

export function applySteps(base: QualityProfile, step: number): { profile: QualityProfile; particleScale: number } {
  const p = { ...base };
  let particleScale = 1;
  if (step >= 1) particleScale = 0.6;
  if (step >= 2) { p.outerStrands = Math.max(1500, Math.round(p.outerStrands * 0.75)); p.innerStrands = Math.round(p.innerStrands * 0.75); p.pulseHeads = Math.round(p.pulseHeads * 0.75); }
  if (step >= 3) p.bloomScale = p.bloomScale * 0.6;
  if (step >= 4) p.dprCap = Math.min(p.dprCap, 1.0);
  if (step >= 5) { p.chromatic = false; p.glyphs = 0; }
  return { profile: p, particleScale };
}

const IDLE_GPU_BUDGET_MS = 3.3;
const SAMPLE_S = 4;

export class AutoQuality {
  step = 0;
  lastReason = "not measured";
  private sampling = false;
  private sampleT = 0;
  private intervals: number[] = [];
  private cooldown = 0;
  private recheck = 0;

  constructor(private readonly apply: (a: QualityAdjust) => void) {}

  /** Begin a measurement window (call after boot and after quality changes). */
  begin(delayS = 0) {
    this.sampling = true;
    this.sampleT = -delayS;
    this.intervals.length = 0;
  }

  get isSampling() { return this.sampling && this.sampleT >= 0; }

  reset() { this.step = 0; this.lastReason = "reset"; this.cooldown = 0; }

  /**
   * Feed one rendered frame. `interval` is ms since the previous rendered frame,
   * `targetFps` the scheduler's target, `gpuMs` the smoothed GPU time (NaN if
   * unavailable), `base` the user-selected profile.
   */
  frame(dtS: number, interval: number, targetFps: number, gpuMs: number, base: QualityProfile, enabled: boolean) {
    if (!enabled) return;
    if (!this.sampling) {
      this.recheck += dtS;
      if (this.recheck > 30) { this.recheck = 0; this.begin(); }
      return;
    }
    this.sampleT += dtS;
    if (this.sampleT < 0) return;
    if (this.intervals.length < 600) this.intervals.push(interval);
    if (this.sampleT < SAMPLE_S) return;
    this.sampling = false;
    this.recheck = 0;
    if (this.cooldown > 0) { this.cooldown--; return; }

    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const target = 1000 / targetFps;
    let over = false;
    let reason: string;
    if (!Number.isNaN(gpuMs)) {
      // project GPU cost to the 30 fps idle rate
      const gpuPctAtIdle = (gpuMs * 30) / 10;
      over = gpuMs > IDLE_GPU_BUDGET_MS;
      reason = `gpu ${gpuMs.toFixed(2)} ms/frame (≈${gpuPctAtIdle.toFixed(1)}% @30fps)`;
    } else {
      over = median > target * 1.25 + 2;
      reason = `pacing median ${median.toFixed(1)} ms vs ${target.toFixed(1)} ms target`;
    }
    this.lastReason = reason + (over ? " → over budget" : " → ok");
    if (over && this.step < MAX_STEP) {
      this.step++;
      const { profile, particleScale } = applySteps(base, this.step);
      this.apply({ step: this.step, profile, particleScale, reason: this.lastReason });
      this.cooldown = 0;
      this.begin(1); // measure the new level
    }
  }
}
