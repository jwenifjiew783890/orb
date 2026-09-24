/**
 * Explicit interaction states. Exactly one state owns the orb's "drive"
 * (activity, hover glow, spin, frame-rate class) at a time, which prevents
 * competing animations.
 */
export type OrbState = "IDLE" | "HOVER" | "DRAG" | "APP_RING" | "LAUNCHING" | "RESET" | "PAUSED";

export interface StateDrive {
  hover: number;
  activity: number;
  pulseSpeed: number;
  spin: number;
  /** Frame-rate class: interactive states run at 60 fps, idle at 30. */
  interactive: boolean;
}

export const DRIVE: Record<OrbState, StateDrive> = {
  IDLE: { hover: 0, activity: 1, pulseSpeed: 1, spin: 1, interactive: false },
  HOVER: { hover: 1, activity: 1.8, pulseSpeed: 1.35, spin: 1.2, interactive: true },
  DRAG: { hover: 0.7, activity: 2.2, pulseSpeed: 1.5, spin: 0.25, interactive: true },
  APP_RING: { hover: 0.8, activity: 2.4, pulseSpeed: 1.4, spin: 0.6, interactive: true },
  LAUNCHING: { hover: 1, activity: 3.2, pulseSpeed: 2.2, spin: 0.6, interactive: true },
  RESET: { hover: 0.3, activity: 1.4, pulseSpeed: 1.2, spin: 0.8, interactive: true },
  PAUSED: { hover: 0, activity: 1, pulseSpeed: 1, spin: 1, interactive: false },
};

type Listener = (next: OrbState, prev: OrbState) => void;

const ALLOWED: Record<OrbState, OrbState[]> = {
  IDLE: ["HOVER", "DRAG", "APP_RING", "RESET", "PAUSED"],
  HOVER: ["IDLE", "DRAG", "APP_RING", "RESET", "PAUSED"],
  DRAG: ["IDLE", "HOVER", "APP_RING", "RESET", "PAUSED"],
  APP_RING: ["IDLE", "HOVER", "LAUNCHING", "RESET", "DRAG", "PAUSED"],
  LAUNCHING: ["IDLE", "HOVER", "PAUSED"],
  RESET: ["IDLE", "HOVER", "DRAG", "APP_RING", "PAUSED"],
  PAUSED: ["IDLE"],
};

export class StateMachine {
  private _state: OrbState = "IDLE";
  private listeners: Listener[] = [];
  private resumeTo: OrbState = "IDLE";

  get state() { return this._state; }

  /** Attempt a transition; returns false (and does nothing) if not allowed. */
  go(next: OrbState): boolean {
    const prev = this._state;
    if (next === prev) return true;
    if (!ALLOWED[prev].includes(next)) return false;
    this._state = next;
    for (const l of this.listeners) l(next, prev);
    return true;
  }

  pause() {
    if (this._state === "PAUSED") return;
    // an in-flight launch has already been sent; resume to idle rather than replay it
    this.resumeTo = this._state === "LAUNCHING" || this._state === "RESET" ? "IDLE" : this._state === "APP_RING" ? "APP_RING" : "IDLE";
    this.go("PAUSED");
  }

  resume() {
    if (this._state !== "PAUSED") return;
    this._state = "IDLE";
    for (const l of this.listeners) l("IDLE", "PAUSED");
    if (this.resumeTo !== "IDLE") this.go(this.resumeTo);
  }

  onChange(l: Listener) { this.listeners.push(l); }
}
