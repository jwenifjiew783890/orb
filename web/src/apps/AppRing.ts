/**
 * Radial holographic app ring.
 *
 *   open:   orb pulse → ring expands → nodes emerge from the core → settle into a
 *           slow 3D orbit (tilted plane; nodes scale/fade with depth)
 *   launch: node brightens → energy beam travels to the core → orb launch pulse →
 *           POST /launch/{app_id} → node collapses → ring closes
 *
 * Nodes are DOM elements (crisp icons + labels) positioned each frame from their
 * projected 3D orbit positions; the ring line and energy beam are 2 GPU draws.
 * Only app ids ever leave the page.
 */
import * as THREE from "three";
import { ORB_RADIUS } from "../config";
import type { OrbSystem } from "../orb/OrbSystem";
import * as S from "../orb/shaders";
import type { AppInfo, HelperClient } from "../net/HelperClient";

const RING_R = ORB_RADIUS * 1.62;
const TILT_X = 0.38;
const TILT_Z = -0.12;
const BEAM_N = 56;
const CACHE_KEY = "vision.apps.v1";

type Phase = "closed" | "opening" | "open" | "launching" | "closing";

interface Node { app: AppInfo; el: HTMLElement; angle0: number; emerge: number; collapse: number }

export interface AppRingCallbacks {
  onClosed(): void;
  onLaunchStart(): void;
  onToast(msg: string): void;
}

const ringVert = /* glsl */ `
uniform float uScale;
uniform float uOpacity;
uniform float uRingR;
attribute float aB;
varying float vA;
varying float vHeat;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * uScale, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float depth = clamp((mv.z - c.z) / (uRingR * uScale + 1e-3), -1.0, 1.0);
  vA = aB * uOpacity * mix(0.18, 1.0, smoothstep(-0.9, 0.35, depth)); // back half sits behind the orb
  vHeat = 0.55;
}
`;

const beamVert = /* glsl */ `
uniform vec3 uFrom;
uniform float uBeamT;
uniform float uPixelScale;
attribute float aT;
varying float vA;
varying float vHeat;
void main() {
  float o = aT * 0.45;
  float s = clamp(uBeamT - o, 0.0, 1.0);
  float e = s * s * (3.0 - 2.0 * s);
  vec3 dir = -uFrom;
  vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + 1e-4);
  vec3 p = uFrom + dir * e + side * sin(e * 9.0 + aT * 20.0) * 0.06 * (1.0 - e);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float live = step(0.0, uBeamT - o) * step(s, 0.999);
  gl_PointSize = mix(0.09, 0.03, aT) * uPixelScale / -mv.z;
  vA = live * (1.0 - aT) * 1.4;
  vHeat = mix(1.0, 0.6, aT);
}
`;

function monogram(label: string) {
  const m = (label.trim()[0] ?? "?").toUpperCase();
  const span = document.createElement("span");
  span.className = "mono";
  span.textContent = m;
  return span;
}

export class AppRing {
  readonly group = new THREE.Group();
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly ringLine: THREE.LineSegments;
  private readonly beam: THREE.Points;
  private readonly layer: HTMLElement;
  private nodes: Node[] = [];
  private phase: Phase = "closed";
  private t = 0;
  private spin = 0;
  private selected: Node | null = null;
  private launched = false;
  private apps: AppInfo[] = [];
  private appsFetchedAt = 0;
  private readonly v = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();

  constructor(
    private readonly orb: OrbSystem,
    private readonly camera: THREE.PerspectiveCamera,
    parent: HTMLElement,
    private readonly helper: HelperClient,
    private readonly cb: AppRingCallbacks,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "app-layer";
    parent.appendChild(this.layer);

    this.group.rotation.set(TILT_X, 0, TILT_Z);
    this.rot.makeRotationFromEuler(this.group.rotation);

    // ring line: two concentric circles + tick marks
    const pos: number[] = [];
    const b: number[] = [];
    const seg = 180;
    for (const [rf, br] of [[1, 0.9], [1.04, 0.3]] as const) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        pos.push(Math.cos(a0) * RING_R * rf, 0, Math.sin(a0) * RING_R * rf, Math.cos(a1) * RING_R * rf, 0, Math.sin(a1) * RING_R * rf);
        b.push(br, br);
      }
    }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pos.push(Math.cos(a) * RING_R * 0.97, 0, Math.sin(a) * RING_R * 0.97, Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R);
      b.push(0.5, 0.5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aB", new THREE.Float32BufferAttribute(b, 1));
    const common = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false };
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: ringVert, fragmentShader: S.ringFrag.replace("varying float vI;", "varying float vA;").replace("palette(vHeat) * vI", "palette(vHeat) * vA"),
      uniforms: { ...orb.uniforms, uScale: { value: 0 }, uOpacity: { value: 0 }, uRingR: { value: RING_R } }, ...common,
    });
    this.ringLine = new THREE.LineSegments(g, this.ringMat);
    this.ringLine.frustumCulled = false;
    this.group.add(this.ringLine);

    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BEAM_N * 3), 3));
    bg.setAttribute("aT", new THREE.BufferAttribute(Float32Array.from({ length: BEAM_N }, (_, i) => i / (BEAM_N - 1)), 1));
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: beamVert, fragmentShader: S.softPointFrag,
      uniforms: { ...orb.uniforms, uFrom: { value: new THREE.Vector3() }, uBeamT: { value: 0 } }, ...common,
    });
    this.beam = new THREE.Points(bg, this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;

    this.group.visible = false;
    try { const c = localStorage.getItem(CACHE_KEY); if (c) this.apps = JSON.parse(c) as AppInfo[]; } catch { /* storage unavailable */ }
  }

  /** Beam lives in world space (not the tilted ring group). */
  get beamObject() { return this.beam; }

  get isOpen() { return this.phase !== "closed"; }
  get isAnimating() { return this.phase !== "closed"; }
  get currentPhase() { return this.phase; }

  open() {
    if (this.phase === "open" || this.phase === "opening") return;
    this.phase = "opening";
    this.t = 0;
    this.launched = false;
    this.selected = null;
    this.group.visible = true;
    this.orb.burst(0.35);
    this.buildNodes(this.apps);
    if (performance.now() - this.appsFetchedAt > 30000 || this.apps.length === 0) void this.refreshApps();
  }

  close() {
    if (this.phase === "closed" || this.phase === "closing") return;
    this.phase = "closing";
    this.t = 0;
  }

  private async refreshApps() {
    const apps = await this.helper.apps();
    if (apps === null) {
      if (this.apps.length === 0 && this.isOpen) this.buildNodes([]);
      return;
    }
    this.appsFetchedAt = performance.now();
    const changed = JSON.stringify(apps) !== JSON.stringify(this.apps);
    this.apps = apps;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(apps.map((a) => ({ ...a, icon: a.icon && a.icon.length < 40000 ? a.icon : null })))); } catch { /* quota */ }
    if (changed && (this.phase === "opening" || this.phase === "open")) this.buildNodes(apps);
  }

  private buildNodes(apps: AppInfo[]) {
    this.layer.replaceChildren();
    const list: AppInfo[] = apps.length ? apps : [{ id: "", label: this.helper.status === "online" ? "NO APPS" : "LINK OFFLINE", icon: null }];
    this.nodes = list.map((app, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "app-node" + (app.id ? "" : " disabled");
      el.setAttribute("aria-label", app.label);
      const icon = document.createElement("div");
      icon.className = "app-icon";
      if (app.icon) {
        const img = document.createElement("img");
        img.src = app.icon;
        img.alt = "";
        img.draggable = false;
        icon.appendChild(img);
      } else icon.appendChild(monogram(app.label));
      const label = document.createElement("div");
      label.className = "app-label";
      label.textContent = app.label;
      el.append(icon, label);
      const node: Node = { app, el, angle0: (i / list.length) * Math.PI * 2 + Math.PI / 2 /* first node at the front */, emerge: 0, collapse: 0 };
      el.addEventListener("click", (e) => { e.stopPropagation(); this.select(node); });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.layer.appendChild(el);
      return node;
    });
  }

  private select(node: Node) {
    if (this.phase !== "open" && this.phase !== "opening") return;
    if (!node.app.id) {
      this.cb.onToast(this.helper.status === "online" ? "ADD APPS IN helper/apps.json" : "SYSTEM LINK OFFLINE");
      return;
    }
    this.selected = node;
    this.phase = "launching";
    this.t = 0;
    node.el.classList.add("selected");
    this.nodeWorld(node, this.beamMat.uniforms.uFrom.value as THREE.Vector3);
    this.beam.visible = true;
    this.cb.onLaunchStart();
  }

  private nodeWorld(n: Node, out: THREE.Vector3) {
    const a = n.angle0 + this.spin;
    const rf = 0.25 + 0.75 * n.emerge;
    out.set(Math.cos(a) * RING_R * rf, 0, Math.sin(a) * RING_R * rf).applyMatrix4(this.rot);
    return out;
  }

  update(dt: number) {
    if (this.phase === "closed") return;
    this.t += dt;
    const t = this.t;
    const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    const easeBack = (x: number) => { x = Math.min(1, Math.max(0, x)); const c = 1.5; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

    let ringF = 1;
    if (this.phase === "opening") {
      ringF = easeOut(t / 0.4);
      this.nodes.forEach((n, i) => { n.emerge = easeBack((t - 0.18 - i * 0.05) / 0.45); });
      if (t > 0.7 + this.nodes.length * 0.05) this.phase = "open";
      this.spin += dt * (0.07 + 1.1 * Math.exp(-t * 3));
    } else if (this.phase === "open") {
      this.spin += dt * 0.07;
      for (const n of this.nodes) n.emerge = 1;
    } else if (this.phase === "launching") {
      this.spin += dt * 0.015;
      (this.beamMat.uniforms.uBeamT as THREE.IUniform).value = t / 0.42;
      if (!this.launched && t >= 0.4) {
        this.launched = true;
        this.orb.burst(1.0);
        const id = this.selected!.app.id;
        void this.helper.launch(id).then((r) => {
          if (!r.ok) this.cb.onToast(r.code === "offline" ? "SYSTEM LINK OFFLINE" : `LAUNCH FAILED · ${r.code.toUpperCase()}`);
        });
      }
      if (this.selected) this.selected.collapse = easeOut((t - 0.45) / 0.35);
      if (t > 0.85) {
        this.beam.visible = false;
        this.phase = "closing";
        this.t = 0;
      }
    } else if (this.phase === "closing") {
      ringF = 1 - easeOut(t / 0.35);
      this.nodes.forEach((n) => { n.emerge = Math.min(n.emerge, ringF); });
      this.spin += dt * 0.05;
      if (t >= 0.35) {
        this.phase = "closed";
        this.group.visible = false;
        this.beam.visible = false;
        this.layer.replaceChildren();
        this.nodes = [];
        this.cb.onClosed();
        return;
      }
    }
    this.ringMat.uniforms.uScale.value = 0.3 + 0.7 * ringF;
    this.ringMat.uniforms.uOpacity.value = ringF * 0.55;
    this.layoutNodes();
  }

  private layoutNodes() {
    const w = window.innerWidth, h = window.innerHeight;
    this.c.set(0, 0, 0).applyMatrix4(this.camera.matrixWorldInverse);
    for (const n of this.nodes) {
      this.nodeWorld(n, this.v);
      // depth relative to the orb centre in view space: +1 near, -1 far
      const view = this.v.applyMatrix4(this.camera.matrixWorldInverse);
      const depth = Math.max(-1, Math.min(1, (view.z - this.c.z) / RING_R));
      view.applyMatrix4(this.camera.projectionMatrix);
      const x = (view.x * 0.5 + 0.5) * w;
      const y = (-view.y * 0.5 + 0.5) * h;
      const vis = n.emerge * (1 - n.collapse);
      const scale = (0.78 + 0.3 * (depth * 0.5 + 0.5)) * (0.4 + 0.6 * vis) * (1 - n.collapse * 0.8);
      const alpha = vis * (0.45 + 0.55 * (depth * 0.5 + 0.5));
      n.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      n.el.style.opacity = alpha.toFixed(3);
      n.el.style.zIndex = String(Math.round(100 + depth * 50));
      n.el.style.pointerEvents = vis > 0.6 && depth > -0.85 ? "auto" : "none";
    }
  }

  dispose() {
    this.ringLine.geometry.dispose();
    this.beam.geometry.dispose();
    this.ringMat.dispose();
    this.beamMat.dispose();
    this.layer.remove();
  }
}
