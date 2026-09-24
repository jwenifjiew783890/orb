/**
 * Neural filament generator — runs ONCE at start-up (pure CPU, no Three.js).
 *
 * Produces a biological-looking tangle rather than a lat/long wireframe by
 * mixing four strand families, all steered by a clustered density field:
 *
 *   arc      noise-displaced great-circle arcs of random length
 *   walk     spherical random walks steered by swirling "attractor" fields
 *            (tangential curl around cluster axes + pull toward clusters)
 *   tangle   short, high-curvature walks seeded only inside dense clusters
 *   dendrite curving strands that dive from the shell toward the core
 *            (their signal pulses flow inward, feeding the core)
 *
 * Start points are rejection-sampled against a calibrated density field so the
 * surface splits roughly 15% dense / 55% medium / 20% sparse / 10% near-empty.
 *
 * Strands are emitted in random order with a fixed sample count, so any prefix
 * of strands is a statistically faithful subset: quality levels only change the
 * draw range, never the geometry.
 */
import { gaussian, makeValueNoise, mulberry32, randomDir } from "./rng";

export const KIND_ARC = 0;
export const KIND_WALK = 1;
export const KIND_TANGLE = 2;
export const KIND_DENDRITE = 3;

export interface FilamentOptions {
  strands: number;
  samples: number; // vertices per strand
  seed: number;
  radius: number;
  /** Shell radius range as fraction of radius (outer ≈ [0.93,1.06], inner ≈ [0.3,0.72]). */
  shellMin: number;
  shellMax: number;
  /** Arc length range (radians) for arcs/walks. */
  lengthMin: number;
  lengthMax: number;
  /** Family mix: arc, walk, tangle, dendrite (normalised internally). */
  mix: [number, number, number, number];
  /** Brightness multiplier for the layer. */
  brightness: number;
  /** Density band acceptance probabilities: dense, medium, sparse, empty. */
  accept?: [number, number, number, number];
}

export interface FilamentData {
  strands: number;
  samples: number;
  /** xyz per vertex. */
  positions: Float32Array;
  /** seed, t, brightness, kind per vertex. */
  data: Float32Array;
  /** Line-segment index pairs. Strand k occupies [k*(S-1)*2, (k+1)*(S-1)*2). */
  index: Uint32Array;
  /** Per-strand seed/kind/brightness (for pulse heads). */
  strandSeed: Float32Array;
  strandKind: Float32Array;
  /** Position texture (RGBA32F: xyz + t) width TEX_W, for GPU pulse-head lookup. */
  tex: Float32Array;
  texWidth: number;
  texHeight: number;
  /** Fraction of strand start points in each density band (validation). */
  bandFractions: [number, number, number, number];
  /** Fraction of the sphere surface in each band (calibration check). */
  surfaceFractions: [number, number, number, number];
}

export const TEX_W = 1024;

interface Cluster { dir: [number, number, number]; sigma: number; weight: number; swirl: number }

export function generateFilaments(o: FilamentOptions): FilamentData {
  const rand = mulberry32(o.seed);
  const noise = makeValueNoise(o.seed ^ 0x9e3779b9);
  const S = o.samples;
  const N = o.strands;

  // ─── Density field: dense clusters, voids and low-frequency noise ──────────
  const clusters: Cluster[] = [];
  const voids: Cluster[] = [];
  const tmp = [0, 0, 0];
  for (let i = 0; i < 13; i++) {
    randomDir(rand, tmp);
    clusters.push({ dir: [tmp[0], tmp[1], tmp[2]], sigma: 0.22 + rand() * 0.3, weight: 0.7 + rand() * 0.8, swirl: (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 1.2) });
  }
  for (let i = 0; i < 6; i++) {
    randomDir(rand, tmp);
    voids.push({ dir: [tmp[0], tmp[1], tmp[2]], sigma: 0.25 + rand() * 0.3, weight: 1.2 + rand() * 0.6, swirl: 0 });
  }

  const field = (x: number, y: number, z: number): number => {
    let f = 0.55 * noise(x * 2.2 + 7, y * 2.2, z * 2.2) + 0.25 * noise(x * 5.1, y * 5.1 + 3, z * 5.1);
    for (const c of clusters) {
      const d = 1 - (x * c.dir[0] + y * c.dir[1] + z * c.dir[2]);
      f += c.weight * Math.exp(-(d * 2) / (c.sigma * c.sigma));
    }
    for (const v of voids) {
      const d = 1 - (x * v.dir[0] + y * v.dir[1] + z * v.dir[2]);
      f -= v.weight * Math.exp(-(d * 2) / (v.sigma * v.sigma));
    }
    return f;
  };

  // Calibrate quantile thresholds on a uniform surface sample.
  const cal: number[] = [];
  for (let i = 0; i < 6000; i++) { randomDir(rand, tmp); cal.push(field(tmp[0], tmp[1], tmp[2])); }
  cal.sort((a, b) => a - b);
  const q = (p: number) => cal[Math.floor(p * (cal.length - 1))];
  const tDense = q(0.85), tMedium = q(0.30), tSparse = q(0.10);
  const band = (f: number) => (f >= tDense ? 0 : f >= tMedium ? 1 : f >= tSparse ? 2 : 3);
  const surfaceFractions: [number, number, number, number] = [0, 0, 0, 0];
  for (const f of cal) surfaceFractions[band(f)] += 1 / cal.length;

  const accept = o.accept ?? [1.0, 0.34, 0.1, 0.012];

  // Swirl/attraction steering field (tangential).
  const steer = (p: number[], out: number[]) => {
    out[0] = out[1] = out[2] = 0;
    for (const c of clusters) {
      const dot = p[0] * c.dir[0] + p[1] * c.dir[1] + p[2] * c.dir[2];
      const w = c.weight * Math.exp(-((1 - dot) * 2) / (c.sigma * c.sigma * 2.2));
      // swirl: c × p
      out[0] += w * c.swirl * (c.dir[1] * p[2] - c.dir[2] * p[1]);
      out[1] += w * c.swirl * (c.dir[2] * p[0] - c.dir[0] * p[2]);
      out[2] += w * c.swirl * (c.dir[0] * p[1] - c.dir[1] * p[0]);
      // attraction toward cluster centre
      out[0] += w * 0.8 * (c.dir[0] - p[0] * dot);
      out[1] += w * 0.8 * (c.dir[1] - p[1] * dot);
      out[2] += w * 0.8 * (c.dir[2] - p[2] * dot);
    }
  };

  const mixSum = o.mix[0] + o.mix[1] + o.mix[2] + o.mix[3];
  const cumMix = [o.mix[0] / mixSum, (o.mix[0] + o.mix[1]) / mixSum, (o.mix[0] + o.mix[1] + o.mix[2]) / mixSum];

  const positions = new Float32Array(N * S * 3);
  const data = new Float32Array(N * S * 4);
  const index = new Uint32Array(N * (S - 1) * 2);
  const strandSeed = new Float32Array(N);
  const strandKind = new Float32Array(N);
  const texHeight = Math.ceil((N * S) / TEX_W);
  const tex = new Float32Array(TEX_W * texHeight * 4);
  const bandCounts: [number, number, number, number] = [0, 0, 0, 0];

  const p = [0, 0, 0], d = [0, 0, 0], s = [0, 0, 0];
  const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; };
  const tangentize = (v: number[], n: number[]) => { const k = v[0] * n[0] + v[1] * n[1] + v[2] * n[2]; v[0] -= n[0] * k; v[1] -= n[1] * k; v[2] -= n[2] * k; };

  const pickStart = (denseOnly: boolean): number => {
    for (let tries = 0; tries < 400; tries++) {
      randomDir(rand, p);
      const b = band(field(p[0], p[1], p[2]));
      if (denseOnly && b !== 0) continue;
      if (rand() < accept[b]) return b;
    }
    return 1;
  };

  for (let k = 0; k < N; k++) {
    const r0 = rand();
    const kind = r0 < cumMix[0] ? KIND_ARC : r0 < cumMix[1] ? KIND_WALK : r0 < cumMix[2] ? KIND_TANGLE : KIND_DENDRITE;
    const b = pickStart(kind === KIND_TANGLE);
    bandCounts[b]++;

    const seed = rand();
    strandSeed[k] = seed;
    strandKind[k] = kind;

    // Brightness: log-normal with a few hero strands; dense regions brighter.
    let bright = Math.exp(gaussian(rand) * 0.55) * 0.42 * o.brightness;
    if (rand() < 0.05) bright *= 3.0;
    bright *= [1.9, 0.85, 0.55, 0.35][b];
    bright = Math.min(bright, 3.2);

    const shell = o.shellMin + (o.shellMax - o.shellMin) * Math.pow(rand(), 0.7);
    let len = o.lengthMin + (o.lengthMax - o.lengthMin) * Math.pow(rand(), 1.6);
    if (kind === KIND_TANGLE) len *= 0.45;

    // initial tangent direction
    randomDir(rand, d); tangentize(d, p); norm(d);
    const step = len / (S - 1);
    const turn = kind === KIND_ARC ? 0.02 : kind === KIND_WALK ? 0.22 : kind === KIND_TANGLE ? 0.9 : 0.12;
    const steerGain = kind === KIND_ARC ? 0.05 : kind === KIND_TANGLE ? 0.25 : 0.55;
    const dendriteDepth = 0.18 + rand() * 0.35;
    const wobbleF = 3 + rand() * 4, wobbleA = 0.012 + rand() * 0.02;

    for (let i = 0; i < S; i++) {
      const t = i / (S - 1);
      // radius profile
      let r = shell;
      if (kind === KIND_DENDRITE) {
        const e = t * t * (3 - 2 * t);
        r = shell * (1 - e * (1 - dendriteDepth));
      } else {
        r += noise(p[0] * wobbleF + seed * 50, p[1] * wobbleF, p[2] * wobbleF) * wobbleA * 2;
      }
      const vi = (k * S + i);
      positions[vi * 3] = p[0] * r * o.radius;
      positions[vi * 3 + 1] = p[1] * r * o.radius;
      positions[vi * 3 + 2] = p[2] * r * o.radius;
      data[vi * 4] = seed;
      data[vi * 4 + 1] = t;
      data[vi * 4 + 2] = bright;
      data[vi * 4 + 3] = kind;
      tex[vi * 4] = positions[vi * 3];
      tex[vi * 4 + 1] = positions[vi * 3 + 1];
      tex[vi * 4 + 2] = positions[vi * 3 + 2];
      tex[vi * 4 + 3] = t;

      // advance along the sphere
      steer(p, s); tangentize(s, p);
      d[0] += s[0] * steerGain * step * 4 + (rand() - 0.5) * turn;
      d[1] += s[1] * steerGain * step * 4 + (rand() - 0.5) * turn;
      d[2] += s[2] * steerGain * step * 4 + (rand() - 0.5) * turn;
      tangentize(d, p); norm(d);
      const stepHere = kind === KIND_DENDRITE ? step * 0.45 : step;
      p[0] += d[0] * stepHere; p[1] += d[1] * stepHere; p[2] += d[2] * stepHere;
      norm(p);
    }
    for (let i = 0; i < S - 1; i++) {
      const ii = (k * (S - 1) + i) * 2;
      index[ii] = k * S + i;
      index[ii + 1] = k * S + i + 1;
    }
  }

  const total = bandCounts.reduce((a, b) => a + b, 0) || 1;
  return {
    strands: N, samples: S, positions, data, index, strandSeed, strandKind,
    tex, texWidth: TEX_W, texHeight,
    bandFractions: bandCounts.map((c) => c / total) as [number, number, number, number],
    surfaceFractions,
  };
}
