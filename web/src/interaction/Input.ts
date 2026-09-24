/**
 * Pointer interaction: hover detection, drag (OrbitControls with damping and
 * momentum), clamped zoom, click / double-click discrimination, and the gentle
 * return to the idle framing after ~3 s without input.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CAMERA_HOME, ORB_RADIUS } from "../config";

export interface InputCallbacks {
  onHover(over: boolean): void;
  onDragStart(): void;
  onDragEnd(): void;
  onOrbClick(): void;
  onEmptyClick(): void;
  onDoubleClick(): void;
  onActivity(): void;
}

const CLICK_MOVE_PX = 6;
const CLICK_MS = 400;
const DBL_WINDOW_MS = 260;
const IDLE_RETURN_S = 3;

export class Input {
  readonly controls: OrbitControls;
  private readonly home = new THREE.Spherical().setFromVector3(CAMERA_HOME);
  private readonly cur = new THREE.Spherical();
  private readonly v = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private dragging = false;
  private pointerDown = false;
  private over = false;
  private pendingClick: number | null = null;
  private resetting = false;
  /** Seconds since the last user input. */
  idleFor = 999;
  lastX = -1;
  lastY = -1;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly el: HTMLElement, private readonly cb: InputCallbacks) {
    const c = new OrbitControls(camera, el);
    c.enableDamping = true;
    c.dampingFactor = 0.055; // momentum: the orb keeps turning briefly after release
    c.rotateSpeed = 0.55;
    c.enablePan = false;
    c.zoomSpeed = 0.35;
    c.minDistance = this.home.radius * 0.78;
    c.maxDistance = this.home.radius * 1.3;
    c.minPolarAngle = 0.35;
    c.maxPolarAngle = Math.PI - 0.35;
    c.target.set(0, 0, 0);
    c.update();
    this.controls = c;

    el.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("pointerup", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: true });
    el.addEventListener("pointerleave", this.onLeave);
    c.addEventListener("start", this.onControlStart);
  }

  /** Orb's projected screen radius and centre, in CSS pixels. */
  private orbScreen() {
    const h = this.el.clientHeight || window.innerHeight;
    const w = this.el.clientWidth || window.innerWidth;
    this.center.set(0, 0, 0).project(this.camera);
    const cx = (this.center.x * 0.5 + 0.5) * w;
    const cy = (-this.center.y * 0.5 + 0.5) * h;
    const dist = this.camera.position.length();
    const r = (ORB_RADIUS / (dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2))) * (h / 2);
    return { cx, cy, r };
  }

  isOverOrb(x: number, y: number, scale = 1.0) {
    const s = this.orbScreen();
    return Math.hypot(x - s.cx, y - s.cy) <= s.r * scale;
  }

  private readonly onControlStart = () => {
    this.resetting = false;
  };

  private readonly onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pointerDown = true;
    this.downX = e.clientX; this.downY = e.clientY; this.downT = performance.now();
    this.dragging = false;
    this.touch();
  };

  private readonly onMove = (e: PointerEvent) => {
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (this.pointerDown && !this.dragging && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > CLICK_MOVE_PX) {
      this.dragging = true;
      this.cb.onDragStart();
    }
    const over = this.isOverOrb(e.clientX, e.clientY);
    if (over !== this.over) { this.over = over; this.cb.onHover(over); }
    if (this.pointerDown || over) this.touch();
  };

  private readonly onUp = (e: PointerEvent) => {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    if (this.dragging) {
      this.dragging = false;
      this.cb.onDragEnd();
      this.touch();
      return;
    }
    if (performance.now() - this.downT > CLICK_MS) return;
    const onOrb = this.isOverOrb(e.clientX, e.clientY);
    if (!onOrb) { this.cb.onEmptyClick(); return; }
    // Wait briefly so a double-click doesn't first open then close the ring.
    if (this.pendingClick !== null) {
      clearTimeout(this.pendingClick);
      this.pendingClick = null;
      this.cb.onDoubleClick();
      return;
    }
    this.pendingClick = window.setTimeout(() => { this.pendingClick = null; this.cb.onOrbClick(); }, DBL_WINDOW_MS);
    this.touch();
  };

  private readonly onWheel = () => this.touch();

  private readonly onLeave = () => {
    if (this.over) { this.over = false; this.cb.onHover(false); }
  };

  private touch() {
    this.idleFor = 0;
    this.cb.onActivity();
  }

  /** Smoothly return camera to the home framing (double-click reset). */
  reset() {
    this.resetting = true;
    this.touch();
  }

  get isResetting() { return this.resetting; }
  get isDragging() { return this.dragging; }
  get isOver() { return this.over; }

  /** Returns true while the camera is still moving (keeps 60 fps). */
  update(dt: number): boolean {
    this.idleFor += dt;
    const returning = this.resetting || (this.idleFor > IDLE_RETURN_S && !this.pointerDown);
    let moving = false;
    if (returning) {
      // critically-damped ease toward home on the sphere (never snaps)
      const k = 1 - Math.exp(-dt * (this.resetting ? 3.2 : 0.55));
      this.cur.setFromVector3(this.v.copy(this.camera.position).sub(this.controls.target));
      let dTheta = this.home.theta - this.cur.theta;
      dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
      const dPhi = this.home.phi - this.cur.phi;
      const dR = this.home.radius - this.cur.radius;
      const err = Math.abs(dTheta) + Math.abs(dPhi) + Math.abs(dR) * 0.2;
      if (err > 1e-4) {
        this.cur.theta += dTheta * k;
        this.cur.phi += dPhi * k;
        this.cur.radius += dR * k;
        this.camera.position.setFromSpherical(this.cur).add(this.controls.target);
        moving = err > 0.01;
      } else if (this.resetting) {
        this.resetting = false;
      }
      if (this.resetting && err < 0.01) this.resetting = false;
    }
    moving = this.controls.update(dt) || moving;
    return moving;
  }

  dispose() {
    this.el.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("pointerleave", this.onLeave);
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.dispose();
    if (this.pendingClick !== null) clearTimeout(this.pendingClick);
  }
}
