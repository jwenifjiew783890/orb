import * as THREE from "three";

// ─── Themes ──────────────────────────────────────────────────────────────────
// One shared colour configuration drives every layer (filaments, core, bloom
// tint, pulses, rings, HUD accent). Themes never change the render path.

export type ThemeName = "gold" | "arc" | "crimson" | "custom";

export interface ThemeColors {
  deep: string;
  base: string;
  light: string;
  hot: string;
  /** Near-black background tint. */
  bg: string;
}

export const THEMES: Record<Exclude<ThemeName, "custom">, ThemeColors> = {
  gold: { deep: "#FF8F00", base: "#FFB300", light: "#FFE082", hot: "#FFF8E1", bg: "#020100" },
  arc: { deep: "#0B5CFF", base: "#26A6FF", light: "#9EE6FF", hot: "#F1FCFF", bg: "#000105" },
  crimson: { deep: "#B0001E", base: "#FF2542", light: "#FF9A8C", hot: "#FFF1EE", bg: "#030001" },
};

/** Derive a full four-stop ramp from a single user-picked colour. */
export function customTheme(hex: string): ThemeColors {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  const mk = (s: number, l: number) => "#" + new THREE.Color().setHSL(hsl.h, s, l, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace);
  return {
    deep: mk(Math.min(1, hsl.s * 1.05), 0.42),
    base: mk(hsl.s, 0.55),
    light: mk(hsl.s * 0.9, 0.78),
    hot: mk(hsl.s * 0.8, 0.96),
    bg: mk(hsl.s * 0.6, 0.012),
  };
}

// ─── Quality profiles ────────────────────────────────────────────────────────
// All profiles share the same geometry (generated once at the HIGH size); lower
// profiles only shrink draw ranges, bloom resolution and DPR, so switching is
// instant and the artistic identity is preserved.

export type QualityName = "low" | "medium" | "high";

export interface QualityProfile {
  outerStrands: number;
  innerStrands: number;
  pulseHeads: number;
  sparks: number;
  dust: number;
  glyphs: number;
  bloomScale: number; // relative to the (already half-res) UnrealBloom chain
  bloomMips: number;
  dprCap: number;
  chromatic: boolean;
}

export const MAX_OUTER_STRANDS = 4000;
export const MAX_INNER_STRANDS = 1400;
export const MAX_PULSE_HEADS = 700;
export const MAX_SPARKS = 420;
export const MAX_DUST = 1800;
export const MAX_GLYPHS = 700;

export const QUALITY: Record<QualityName, QualityProfile> = {
  low: { outerStrands: 1500, innerStrands: 500, pulseHeads: 220, sparks: 120, dust: 500, glyphs: 0, bloomScale: 0.6, bloomMips: 4, dprCap: 1.0, chromatic: false },
  medium: { outerStrands: 2600, innerStrands: 900, pulseHeads: 420, sparks: 260, dust: 1000, glyphs: 360, bloomScale: 1.0, bloomMips: 5, dprCap: 1.25, chromatic: true },
  high: { outerStrands: 4000, innerStrands: 1400, pulseHeads: 700, sparks: 420, dust: 1800, glyphs: 700, bloomScale: 1.0, bloomMips: 5, dprCap: 1.5, chromatic: true },
};

// ─── User settings (mirrors LivelyProperties.json) ───────────────────────────

export interface Settings {
  theme: ThemeName;
  customColor: string;
  rotationSpeed: number; // 0..2 multiplier
  bloomStrength: number; // 0..2 multiplier
  particleDensity: number; // 0.25..1.5 multiplier on sparks/dust/glyphs
  audioReactive: boolean;
  hudStats: boolean;
  quality: QualityName;
  autoQuality: boolean;
  debugOverlay: boolean;
  userName: string;
  helperPort: number;
  helperToken: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "gold",
  customColor: "#7CFFB2",
  rotationSpeed: 1,
  bloomStrength: 1,
  particleDensity: 1,
  audioReactive: false,
  hudStats: true,
  quality: "medium",
  autoQuality: true,
  debugOverlay: false,
  userName: "",
  helperPort: 47821,
  helperToken: "",
};

export const ORB_RADIUS = 2.0;
export const CAMERA_HOME = new THREE.Vector3(0, 0.4, 9.8);
