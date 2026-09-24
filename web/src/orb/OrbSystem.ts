/**
 * VISION Orb — the complete orb as ~10 draw calls.
 *
 *   outer filaments (LineSegments)   inner filaments (LineSegments)
 *   pulse heads (Points)             sparks (Points)      dust (Points)
 *   data glyphs (Points)             core (quad)          halo (quad)
 *   core rings (LineSegments)        outer rings (LineSegments)
 *
 * All geometry is built once. Every per-frame change is a handful of uniform
 * writes and three group rotations; nothing is allocated in update().
 *
 * Lineage: the layered-shell / spiral-core / code-text / dust / scan-ring
 * structure comes from Sagar Tamang's MIT "ultron-by-sagar-builds" orbScene.ts.
 * Here the ~2,000 separate Line/Sprite/Mesh objects of that scene are replaced
 * by merged GPU-animated buffers, and the geometric lat/long shell by a
 * procedurally generated neural filament network.
 */
import * as THREE from "three";
import { generateFilaments, type FilamentData } from "./filamentGen";
import { mulberry32, randomDir } from "./rng";
import * as S from "./shaders";
import {
  MAX_DUST, MAX_GLYPHS, MAX_INNER_STRANDS, MAX_OUTER_STRANDS, MAX_PULSE_HEADS, MAX_SPARKS,
  ORB_RADIUS, type QualityProfile, type ThemeColors,
} from "../config";

const SAMPLES_OUTER = 20;
const SAMPLES_INNER = 14;
const TAIL = 5;

export interface OrbDrive {
  /** 0..1 smoothed hover amount. */
  hover: number;
  /** Multiplier on signal pulse density (1 = idle). */
  activity: number;
  /** Multiplier on pulse travel speed. */
  pulseSpeed: number;
  /** Multiplier on auto-rotation. */
  spin: number;
  /** 0..1 audio envelope (0 when disabled). */
  audio: number;
}

export class OrbSystem {
  readonly root = new THREE.Group();
  private readonly outer = new THREE.Group();
  private readonly inner = new THREE.Group();

  readonly uniforms = {
    uTime: { value: 0 },
    uDrift: { value: 0 },
    uWarp: { value: 0.05 },
    uBreath: { value: 1 },
    uColDeep: { value: new THREE.Color() },
    uColBase: { value: new THREE.Color() },
    uColLight: { value: new THREE.Color() },
    uColHot: { value: new THREE.Color() },
    uRadius: { value: ORB_RADIUS },
    uPulseClock: { value: 0 },
    uPulseDensity: { value: 0.22 },
    uBurst: { value: 0 },
    uBurstR: { value: 0 },
    uBurstAmt: { value: 0 },
    uHover: { value: 0 },
    uAudio: { value: 0 },
    uPixelScale: { value: 600 },
    uPulseReveal: { value: 1 },
  };

  private readonly outerData: FilamentData;
  private readonly innerData: FilamentData;
  private readonly outerLines: THREE.LineSegments;
  private readonly innerLines: THREE.LineSegments;
  private readonly heads: THREE.Points;
  private readonly sparks: THREE.Points;
  private readonly dust: THREE.Points;
  private readonly glyphs: THREE.Points;
  private readonly core: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly coreRings: THREE.LineSegments;
  private readonly outerRings: THREE.LineSegments;

  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly posTex: THREE.DataTexture;
  private readonly atlas: THREE.CanvasTexture;

  // per-layer reveal (boot sequence) — owned uniforms
  readonly reveal = {
    rings: { value: 1 },
    outer: { value: 1 },
    inner: { value: 1 },
    core: { value: 1 },
    particles: { value: 1 },
  };

  // intensities that settings/interaction scale
  private readonly outerIntensity = { value: 1 };
  private readonly innerIntensity = { value: 0.55 };
  private readonly coreBreath = { value: 0 };
  private readonly coreBoost = { value: 1 };
  private readonly haloAmt = { value: 1 };
  private readonly sparkClock = { value: 0 };
  private readonly sparkRate = { value: 0.35 };
  private readonly coreRingAngles = { value: new THREE.Vector4() };
  private readonly outerRingAngles = { value: new THREE.Vector4() };
  private readonly outerRingIntensity = { value: 0.5 };

  // motion state (no allocation in update)
  private spinAngle = 0;
  private innerAngle = 0;
  private readonly axis = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private burstT = 99;
  private densityScale = 1;
  private profile!: QualityProfile;

  stats = { outerStrands: 0, innerStrands: 0, particles: 0, genMs: 0 };

  constructor() {
    const t0 = performance.now();
    this.outerData = generateFilaments({
      strands: MAX_OUTER_STRANDS, samples: SAMPLES_OUTER, seed: 1337, radius: ORB_RADIUS,
      shellMin: 0.92, shellMax: 1.05, lengthMin: 0.18, lengthMax: 1.5,
      mix: [0.26, 0.42, 0.17, 0.15], brightness: 1,
    });
    this.innerData = generateFilaments({
      strands: MAX_INNER_STRANDS, samples: SAMPLES_INNER, seed: 4242, radius: ORB_RADIUS,
      shellMin: 0.28, shellMax: 0.74, lengthMin: 0.2, lengthMax: 1.1,
      mix: [0.3, 0.45, 0.15, 0.1], brightness: 0.9,
    });
    this.stats.genMs = performance.now() - t0;

    this.root.add(this.outer, this.inner);

    // ── filaments
    this.outerLines = this.makeFilaments(this.outerData, this.outerIntensity, this.reveal.outer);
    this.innerLines = this.makeFilaments(this.innerData, this.innerIntensity, this.reveal.inner);
    this.outer.add(this.outerLines);
    this.inner.add(this.innerLines);

    // ── pulse heads (sampled from the outer filament texture)
    this.posTex = new THREE.DataTexture(this.outerData.tex, this.outerData.texWidth, this.outerData.texHeight, THREE.RGBAFormat, THREE.FloatType);
    this.posTex.needsUpdate = true;
    this.heads = this.makeHeads();
    this.outer.add(this.heads);

    // ── glyphs ride the outer shell
    this.atlas = makeGlyphAtlas();
    this.glyphs = this.makeGlyphs();
    this.outer.add(this.glyphs);

    // ── sparks / dust (world-anchored in root)
    this.sparks = this.makeSparks();
    this.dust = this.makeDust();
    this.root.add(this.sparks, this.dust);

    // ── core, halo, rings (not spun with the shell)
    this.halo = this.makeQuad(S.haloVert, S.haloFrag, ORB_RADIUS * 3.6, { uHaloAmt: this.haloAmt, uReveal: this.reveal.outer });
    this.halo.renderOrder = -1;
    this.core = this.makeQuad(S.coreVert, S.coreFrag, ORB_RADIUS * 1.1, { uCoreBreath: this.coreBreath, uCoreBoost: this.coreBoost, uReveal: this.reveal.core });
    this.core.renderOrder = 2;
    this.coreRings = this.makeRings(
      [ { r: 0.19, segs: 128, gaps: 3, ticks: 0, b: 0.9 }, { r: 0.25, segs: 160, gaps: 6, ticks: 36, b: 0.55 }, { r: 0.31, segs: 160, gaps: 2, ticks: 0, b: 0.35 } ],
      new THREE.Vector4(0.35, 1.2, -0.7, 0), this.coreRingAngles, { value: 1 }, this.reveal.core,
    );
    this.outerRings = this.makeRings(
      [ { r: 1.2, segs: 360, gaps: 5, ticks: 72, b: 0.5 }, { r: 1.34, segs: 360, gaps: 9, ticks: 0, b: 0.25 }, { r: 1.13, segs: 240, gaps: 2, ticks: 0, b: 0.18 } ],
      new THREE.Vector4(1.3, 1.42, 1.18, 0), this.outerRingAngles, this.outerRingIntensity, this.reveal.rings,
    );
    this.root.add(this.halo, this.coreRings, this.core);
    this.root.add(this.outerRings);
  }

  // ─── builders ──────────────────────────────────────────────────────────────

  private material(vert: string, frag: string, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { ...this.uniforms, ...extra },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.mats.push(m);
    return m;
  }

  private makeFilaments(d: FilamentData, intensity: THREE.IUniform, reveal: THREE.IUniform) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute("aData", new THREE.BufferAttribute(d.data, 4));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ORB_RADIUS * 1.3);
    const m = this.material(S.filamentVert, S.filamentFrag, { uIntensity: intensity, uReveal: reveal });
    const l = new THREE.LineSegments(g, m);
    l.frustumCulled = false;
    return l;
  }

  private makeHeads() {
    const n = MAX_PULSE_HEADS * TAIL;
    const strand = new Float32Array(n);
    const info = new Float32Array(n * 3);
    for (let h = 0; h < MAX_PULSE_HEADS; h++) {
      for (let k = 0; k < TAIL; k++) {
        const i = h * TAIL + k;
        strand[i] = h; // heads map onto the first strands, so they stay inside the drawn subset
        info[i * 3] = this.outerData.strandSeed[h];
        info[i * 3 + 1] = this.outerData.strandKind[h];
        info[i * 3 + 2] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aStrand", new THREE.BufferAttribute(strand, 1));
    g.setAttribute("aInfo", new THREE.BufferAttribute(info, 3));
    const m = this.material(S.headVert, S.headFrag, {
      uPosTex: { value: this.posTex },
      uSamples: { value: SAMPLES_OUTER },
      uHeadSize: { value: 0.032 },
      uIntensity: this.outerIntensity,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  private makeSparks() {
    const rand = mulberry32(99);
    const seeds = new Float32Array(MAX_SPARKS * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    const m = this.material(S.sparkVert, S.softPointFrag, {
      uSparkClock: this.sparkClock, uSparkRate: this.sparkRate, uSize: { value: 0.03 },
      uIntensity: this.outerIntensity, uReveal: this.reveal.particles,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  private makeDust() {
    const rand = mulberry32(7);
    const pos = new Float32Array(MAX_DUST * 3);
    const seeds = new Float32Array(MAX_DUST * 4);
    const d = [0, 0, 0];
    for (let i = 0; i < MAX_DUST; i++) {
      randomDir(rand, d);
      const r = ORB_RADIUS * (1.05 + Math.pow(rand(), 0.55) * 2.6);
      pos[i * 3] = d[0] * r; pos[i * 3 + 1] = d[1] * r; pos[i * 3 + 2] = d[2] * r;
      seeds[i * 4] = rand(); seeds[i * 4 + 1] = rand(); seeds[i * 4 + 2] = rand(); seeds[i * 4 + 3] = 0.3 + rand() * 0.7;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    const m = this.material(S.dustVert, S.softPointFrag, { uSize: { value: 0.022 }, uIntensity: { value: 1 }, uReveal: this.reveal.particles });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  private makeGlyphs() {
    const rand = mulberry32(31);
    const pos = new Float32Array(MAX_GLYPHS * 3);
    const seeds = new Float32Array(MAX_GLYPHS * 4);
    const d = [0, 0, 0];
    for (let i = 0; i < MAX_GLYPHS; i++) {
      randomDir(rand, d);
      const r = ORB_RADIUS * (1.02 + rand() * 0.1);
      pos[i * 3] = d[0] * r; pos[i * 3 + 1] = d[1] * r; pos[i * 3 + 2] = d[2] * r;
      seeds[i * 4] = rand(); seeds[i * 4 + 1] = Math.floor(rand() * 64); seeds[i * 4 + 2] = 0.1 + rand() * 0.8; seeds[i * 4 + 3] = 0.2 + Math.pow(rand(), 2) * 0.8;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    const m = this.material(S.glyphVert, S.glyphFrag, { uAtlas: { value: this.atlas }, uSize: { value: 0.075 }, uIntensity: { value: 1 }, uReveal: this.reveal.outer });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  private makeQuad(vert: string, frag: string, size: number, extra: Record<string, THREE.IUniform>) {
    const m = this.material(vert, frag, { uSize: { value: size }, ...extra });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    mesh.frustumCulled = false;
    return mesh;
  }

  private makeRings(
    rings: { r: number; segs: number; gaps: number; ticks: number; b: number }[],
    tilts: THREE.Vector4, angles: THREE.IUniform, intensity: THREE.IUniform, reveal: THREE.IUniform,
  ) {
    const pos: number[] = [];
    const attr: number[] = [];
    const rand = mulberry32(5);
    rings.forEach((ring, id) => {
      const R = ring.r * ORB_RADIUS;
      // broken arcs: skip `gaps` random spans
      const gapStarts = Array.from({ length: ring.gaps }, () => Math.floor(rand() * ring.segs));
      const gapLen = Math.floor(ring.segs * 0.04);
      for (let i = 0; i < ring.segs; i++) {
        if (gapStarts.some((g) => i >= g && i < g + gapLen)) continue;
        const a0 = (i / ring.segs) * Math.PI * 2, a1 = ((i + 1) / ring.segs) * Math.PI * 2;
        pos.push(Math.cos(a0) * R, 0, Math.sin(a0) * R, Math.cos(a1) * R, 0, Math.sin(a1) * R);
        attr.push(id, ring.b, id, ring.b);
      }
      for (let k = 0; k < ring.ticks; k++) {
        const a = (k / ring.ticks) * Math.PI * 2;
        const len = (k % 6 === 0 ? 0.05 : 0.022) * ORB_RADIUS;
        pos.push(Math.cos(a) * R, 0, Math.sin(a) * R, Math.cos(a) * (R + len), 0, Math.sin(a) * (R + len));
        attr.push(id, ring.b * 1.2, id, ring.b * 1.2);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aRing", new THREE.Float32BufferAttribute(attr, 2));
    const m = this.material(S.ringVert, S.ringFrag, { uAngles: angles, uTilts: { value: tilts }, uIntensity: intensity, uReveal: reveal });
    const l = new THREE.LineSegments(g, m);
    l.frustumCulled = false;
    return l;
  }

  // ─── public controls ───────────────────────────────────────────────────────

  setTheme(c: ThemeColors) {
    this.uniforms.uColDeep.value.set(c.deep);
    this.uniforms.uColBase.value.set(c.base);
    this.uniforms.uColLight.value.set(c.light);
    this.uniforms.uColHot.value.set(c.hot);
  }

  /** Quality + particle density: draw-range changes only, no rebuild. */
  setQuality(p: QualityProfile, particleDensity: number) {
    this.profile = p;
    this.densityScale = particleDensity;
    const oS = Math.min(p.outerStrands, MAX_OUTER_STRANDS);
    const iS = Math.min(p.innerStrands, MAX_INNER_STRANDS);
    this.outerLines.geometry.setDrawRange(0, oS * (SAMPLES_OUTER - 1) * 2);
    this.innerLines.geometry.setDrawRange(0, iS * (SAMPLES_INNER - 1) * 2);
    const heads = Math.min(p.pulseHeads, oS, MAX_PULSE_HEADS);
    this.heads.geometry.setDrawRange(0, heads * TAIL);
    const sp = Math.min(MAX_SPARKS, Math.round(p.sparks * particleDensity));
    const du = Math.min(MAX_DUST, Math.round(p.dust * particleDensity));
    const gl = Math.min(MAX_GLYPHS, Math.round(p.glyphs * particleDensity));
    this.sparks.geometry.setDrawRange(0, sp);
    this.dust.geometry.setDrawRange(0, du);
    this.glyphs.geometry.setDrawRange(0, gl);
    this.glyphs.visible = gl > 0;
    this.stats.outerStrands = oS;
    this.stats.innerStrands = iS;
    this.stats.particles = heads * TAIL + sp + du + gl;
  }

  get quality() { return this.profile; }
  get particleDensity() { return this.densityScale; }

  setPixelScale(drawingBufferHeight: number, fovDeg: number) {
    this.uniforms.uPixelScale.value = drawingBufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  /** Trigger the launch/energy burst (inward dendrite surge + outward shockwave). */
  burst(strength = 1) {
    this.burstT = 0;
    this.burstStrength = strength;
  }
  private burstStrength = 1;

  /**
   * Per-frame update. `dt` seconds (clamped by caller), `t` seconds since start,
   * `rot` = user rotation-speed multiplier.
   */
  update(dt: number, t: number, drive: OrbDrive, rot: number) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uDrift.value += dt * (0.045 + drive.hover * 0.02 + drive.audio * 0.03);
    u.uWarp.value = 0.05 + drive.hover * 0.012 + drive.audio * 0.02;

    // breathing: ~3.2 s cycle, core-synchronous
    const breath = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 3.2);
    const b = Math.pow(breath, 1.6);
    u.uBreath.value = 1 + b * 0.012 + drive.audio * 0.02;
    this.coreBreath.value = Math.min(1, b * 0.85 + drive.hover * 0.15 + drive.audio * 0.5);
    this.coreBoost.value = 1 + drive.hover * 0.2 + drive.audio * 0.25;
    this.haloAmt.value = 1 + drive.hover * 0.35 + b * 0.15;

    // pulses: integrate the clock so speed changes never jump
    u.uPulseClock.value += dt * drive.pulseSpeed * (1 + drive.audio * 0.8);
    u.uPulseDensity.value = Math.min(0.9, 0.2 * drive.activity + drive.audio * 0.15);
    u.uHover.value = drive.hover;
    u.uAudio.value = drive.audio;

    // burst envelope
    this.burstT += dt;
    const bt = this.burstT;
    const env = bt < 1.6 ? Math.exp(-bt * 2.2) * this.burstStrength : 0;
    u.uBurst.value = env;
    u.uBurstAmt.value = bt < 1.4 ? Math.exp(-bt * 1.8) * this.burstStrength : 0;
    u.uBurstR.value = bt * 1.1; // radius (in orb radii) expanding outward
    this.outerIntensity.value = 1 + drive.hover * 0.18 + env * 0.5;
    this.innerIntensity.value = 0.55 + drive.hover * 0.12 + env * 0.6;

    // sparks
    this.sparkClock.value += dt * (1 + drive.hover * 0.6 + env * 3);
    this.sparkRate.value = Math.min(1, 0.3 + drive.hover * 0.15 + env * 0.6 + drive.audio * 0.2);

    // rotation: slightly tilted axis that drifts; inner layer at a different rate
    const spin = 0.07 * rot * drive.spin;
    this.spinAngle += dt * spin;
    this.innerAngle -= dt * spin * 1.55;
    this.axis.set(Math.sin(t * 0.021) * 0.22 + 0.12, 1, Math.cos(t * 0.017) * 0.18).normalize();
    this.q.setFromAxisAngle(this.axis, this.spinAngle);
    this.outer.quaternion.copy(this.q);
    this.axis.set(Math.cos(t * 0.013) * 0.3, 1, Math.sin(t * 0.019) * 0.25 - 0.1).normalize();
    this.q.setFromAxisAngle(this.axis, this.innerAngle);
    this.inner.quaternion.copy(this.q);

    // rings
    const ringSpeed = 1 + drive.hover * 1.5 + env * 3;
    const ca = this.coreRingAngles.value;
    ca.x += dt * 0.9 * ringSpeed; ca.y -= dt * 0.55 * ringSpeed; ca.z += dt * 0.35 * ringSpeed;
    const oa = this.outerRingAngles.value;
    oa.x += dt * 0.05 * ringSpeed * rot; oa.y -= dt * 0.03 * ringSpeed * rot; oa.z += dt * 0.08 * ringSpeed * rot;
    this.outerRingIntensity.value = 0.5 + drive.hover * 0.35 + env * 0.5;
  }

  /** Draw-call count of the orb system itself (for the debug overlay). */
  get drawObjects(): number {
    let n = 0;
    this.root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) n++; });
    return n;
  }

  dispose() {
    this.root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) g.dispose();
    });
    for (const m of this.mats) m.dispose();
    this.posTex.dispose();
    this.atlas.dispose();
  }
}

function makeGlyphAtlas(): THREE.CanvasTexture {
  // 8×8 atlas of short hex/code tokens (Sagar's code-text idea, one texture).
  const tokens = ["3F", "A1", "0x", "FF", "7E", "::", "01", "10", "C4", "9B", ">>", "E0", "5D", "2A", "B8", "6C",
    "{}", "D7", "11", "4E", "AF", "08", "<>", "3C", "92", "7B", "EE", "1D", "//", "C0", "F4", "8A"];
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = "#fff";
  ctx.font = "600 26px Consolas, 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 64; i++) {
    const x = (i % 8) * 64 + 32, y = Math.floor(i / 8) * 64 + 32;
    ctx.fillText(tokens[i % tokens.length], x, y);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
