import common from "../shaders/common.glsl?raw";

// ─── Signal pulses ───────────────────────────────────────────────────────────
// Pure function of (strand seed, kind, pulse clock): the filament shader and the
// pulse-head sprite shader evaluate the SAME function, so bright heads ride
// exactly on the comet tails drawn along the lines. No JS per pulse.
const pulseChunk = /* glsl */ `
uniform float uPulseClock;
uniform float uPulseDensity;
uniform float uBurst;
float pulseHead(float seed, float kind, out float on, out float strength) {
  bool dend = kind > 2.5;
  float speed = mix(0.10, 0.36, hash11(seed * 17.3)) * (dend ? 1.7 : 1.0);
  float cyc = uPulseClock * speed + hash11(seed * 3.7) * 7.0;
  float id = floor(cyc);
  float dens = uPulseDensity * (dend ? 2.4 : 1.0) + uBurst * (dend ? 1.0 : 0.3);
  on = step(hash12(vec2(seed * 13.1, id)), dens);
  strength = mix(0.45, 1.35, hash12(vec2(id * 0.73, seed * 7.0))) * (1.0 + uBurst * 0.8);
  return fract(cyc) * 1.35 - 0.12;
}
`;

const depthChunk = /* glsl */ `
uniform float uRadius;
float depthFadeOf(vec4 mv) {
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float depth = clamp((mv.z - c.z) / uRadius, -1.0, 1.0);
  return mix(0.2, 1.0, smoothstep(-0.95, 0.8, depth));
}
`;

// ─── Filaments (outer shell + inner volume share this material) ─────────────
export const filamentVert = /* glsl */ `
${common}
${pulseChunk}
${depthChunk}
attribute vec4 aData; // seed, t, brightness, kind
uniform float uIntensity;
uniform float uHover;
uniform float uAudio;
uniform float uBurstR;
uniform float uBurstAmt;
uniform float uReveal;
uniform float uPulseReveal;
varying float vI;
varying float vHeat;
void main() {
  float seed = aData.x, t = aData.y, b = aData.z, kind = aData.w;
  vec3 p = livingDisplace(position);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depthFade = depthFadeOf(mv);

  // shimmer / flicker (per-strand phase, travels along the strand)
  float sh = 0.72 + 0.28 * sin(uTime * (0.9 + seed * 2.6) + t * 7.0 + seed * 61.0) * sin(uTime * (0.37 + seed) + seed * 17.0);
  sh *= 1.0 + uHover * 0.3 * sin(uTime * 9.0 + seed * 40.0 + t * 20.0);

  // rewiring: strands slowly fade out and others fade in
  float rw = smoothstep(-0.45, 0.35, sin(uDrift * 0.9 * (0.4 + hash11(seed * 91.7)) + seed * 628.3));

  float act, str;
  float h = pulseHead(seed, kind, act, str);
  float dd = h - t;
  float pulse = act * str * (dd >= 0.0 ? exp(-dd * 16.0) : exp(dd * 90.0)) * uPulseReveal;

  float r = length(position) / uRadius;
  float coreProx = 1.0 + 2.2 * pow(1.0 - clamp(r, 0.0, 1.0), 2.0);
  float ring = uBurstAmt * exp(-pow((r - uBurstR) * 6.0, 2.0));
  float ends = smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.9, t);
  float reveal = clamp(uReveal * 1.4 - hash11(seed * 5.3) * 0.4, 0.0, 1.0);

  vI = (b * sh * mix(0.04, 1.0, rw) * coreProx * mix(0.3, 1.0, ends) * (1.0 + uAudio * 0.45) * 0.2
        + pulse * 1.1 + ring * 0.5) * depthFade * uIntensity * reveal;
  vHeat = clamp(0.04 + b * 0.16 + pulse * 0.7 + (coreProx - 1.0) * 0.22 + ring * 0.4, 0.0, 1.0);
}
`;

export const filamentFrag = /* glsl */ `
uniform vec3 uColDeep;
uniform vec3 uColBase;
uniform vec3 uColLight;
uniform vec3 uColHot;
vec3 palette(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 a = mix(uColDeep, uColBase, smoothstep(0.0, 0.4, x));
  a = mix(a, uColLight, smoothstep(0.35, 0.75, x));
  return mix(a, uColHot, smoothstep(0.7, 1.0, x));
}
varying float vI;
varying float vHeat;
void main() {
  gl_FragColor = vec4(palette(vHeat) * vI, 1.0);
}
`;

// shared fragment palette (for materials that don't include common in frag)
const fragPalette = /* glsl */ `
uniform vec3 uColDeep;
uniform vec3 uColBase;
uniform vec3 uColLight;
uniform vec3 uColHot;
vec3 palette(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 a = mix(uColDeep, uColBase, smoothstep(0.0, 0.4, x));
  a = mix(a, uColLight, smoothstep(0.35, 0.75, x));
  return mix(a, uColHot, smoothstep(0.7, 1.0, x));
}
`;

// ─── Pulse heads: sprites travelling along filament polylines ───────────────
export const headVert = /* glsl */ `
${common}
${pulseChunk}
${depthChunk}
attribute float aStrand;
attribute vec3 aInfo; // seed, kind, tail index (0 = head)
uniform sampler2D uPosTex;
uniform float uSamples;
uniform float uPixelScale;
uniform float uHeadSize;
uniform float uIntensity;
uniform float uPulseReveal;
varying float vA;
varying float vHeat;
vec3 fetchP(float idx) {
  int i = int(idx + 0.5);
  return texelFetch(uPosTex, ivec2(i % 1024, i / 1024), 0).xyz;
}
void main() {
  float act, str;
  float h = pulseHead(aInfo.x, aInfo.y, act, str);
  float tail = aInfo.z;
  float tt = h - tail * 0.02;
  if (act < 0.5 || tt < 0.0 || tt > 1.0 || uPulseReveal < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0; vHeat = 0.0;
    return;
  }
  float fi = tt * (uSamples - 1.0);
  float i0 = floor(fi);
  float base = aStrand * uSamples;
  vec3 p = mix(fetchP(base + i0), fetchP(base + min(i0 + 1.0, uSamples - 1.0)), fi - i0);
  p = livingDisplace(p);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float taper = 1.0 - tail / 5.0;
  float ends = smoothstep(0.0, 0.06, tt) * smoothstep(1.0, 0.94, tt);
  gl_PointSize = uHeadSize * mix(0.35, 1.0, taper) * min(str, 1.4) * uPixelScale / -mv.z;
  vA = str * taper * taper * ends * depthFadeOf(mv) * uIntensity * uPulseReveal;
  vHeat = mix(0.62, 1.0, taper);
}
`;

export const headFrag = /* glsl */ `
${fragPalette}
varying float vA;
varying float vHeat;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 6.0) * (1.0 - smoothstep(0.8, 1.0, d));
  gl_FragColor = vec4(palette(vHeat) * vA * a * 1.6, 1.0);
}
`;

// ─── Sparks: stateless GPU particles escaping the surface ───────────────────
export const sparkVert = /* glsl */ `
${common}
${depthChunk}
attribute vec4 aSeed;
uniform float uSparkClock;
uniform float uSparkRate;
uniform float uPixelScale;
uniform float uSize;
uniform float uIntensity;
uniform float uReveal;
varying float vA;
varying float vHeat;
void main() {
  float cyc = uSparkClock * (0.12 + aSeed.y * 0.22) + aSeed.x * 17.0;
  float id = floor(cyc);
  float age = fract(cyc);
  float alive = step(hash12(vec2(aSeed.x * 31.0, id)), uSparkRate);
  vec3 dir = normalize(hash31(aSeed.x * 97.0 + id * 13.1) * 2.0 - 1.0);
  vec3 start = dir * uRadius * (0.93 + 0.1 * hash11(id + aSeed.z * 9.0));
  vec3 jitter = normalize(hash31(id * 7.0 + aSeed.w * 3.0) * 2.0 - 1.0);
  vec3 vdir = normalize(dir + jitter * 0.5);
  float k = 3.2;
  float dist = (0.25 + aSeed.z * 0.9) * (1.0 - exp(-k * age)) / k * uRadius;
  vec3 p = start + vdir * dist;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float life = pow(1.0 - age, 1.7) * smoothstep(0.0, 0.03, age);
  gl_PointSize = uSize * mix(0.4, 1.0, 1.0 - age) * uPixelScale / -mv.z;
  vA = alive * life * depthFadeOf(mv) * uIntensity * uReveal;
  vHeat = mix(0.55, 0.95, 1.0 - age);
}
`;

export const softPointFrag = /* glsl */ `
${fragPalette}
varying float vA;
varying float vHeat;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 5.0) * (1.0 - smoothstep(0.7, 1.0, d));
  gl_FragColor = vec4(palette(vHeat) * vA * a * 1.4, 1.0);
}
`;

// ─── Ambient dust ────────────────────────────────────────────────────────────
export const dustVert = /* glsl */ `
${common}
attribute vec4 aSeed;
uniform float uPixelScale;
uniform float uSize;
uniform float uIntensity;
uniform float uReveal;
varying float vA;
varying float vHeat;
void main() {
  vec3 p = position;
  float s = aSeed.x;
  p += vec3(sin(uTime * 0.07 + s * 40.0), sin(uTime * 0.05 + s * 70.0), cos(uTime * 0.06 + s * 90.0)) * 0.08;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (0.25 + aSeed.y * 0.9) + s * 50.0), 3.0);
  gl_PointSize = uSize * (0.5 + aSeed.z) * uPixelScale / -mv.z;
  float r = length(position);
  vA = tw * 0.16 * aSeed.w * uIntensity * uReveal * smoothstep(1.9, 2.4, r);
  vHeat = 0.2 + aSeed.y * 0.3;
}
`;

// ─── Data glyphs: the Sagar orb's drifting code text, as ONE point cloud ────
export const glyphVert = /* glsl */ `
${common}
${depthChunk}
attribute vec4 aSeed; // seed, cell, rate, brightness
uniform float uPixelScale;
uniform float uSize;
uniform float uIntensity;
uniform float uReveal;
varying float vA;
varying float vCell;
varying float vHeat;
void main() {
  vec3 p = livingDisplace(position);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelScale / -mv.z;
  float flick = step(0.35, fract(sin(floor(uTime * (1.0 + aSeed.z * 5.0)) * 12.9898 + aSeed.x * 78.233) * 43758.5453));
  vCell = mod(aSeed.y + floor(uTime * aSeed.z * 1.5), 64.0);
  vA = aSeed.w * flick * depthFadeOf(mv) * uIntensity * uReveal * 0.55;
  vHeat = 0.3 + aSeed.w * 0.3;
}
`;

export const glyphFrag = /* glsl */ `
${fragPalette}
uniform sampler2D uAtlas;
varying float vA;
varying float vCell;
varying float vHeat;
void main() {
  vec2 cell = vec2(mod(vCell, 8.0), floor(vCell / 8.0));
  vec2 uv = (cell + vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y)) / 8.0;
  float a = texture2D(uAtlas, uv).r;
  gl_FragColor = vec4(palette(vHeat) * a * vA, 1.0);
}
`;

// ─── Camera-facing quad (core + halo) ────────────────────────────────────────
const billboardVert = /* glsl */ `
uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * (c + vec4(position.xy * uSize, 0.0, 0.0));
}
`;
export const coreVert = billboardVert;
export const haloVert = billboardVert;

export const coreFrag = /* glsl */ `
${common}
uniform float uCoreBreath;
uniform float uCoreBoost;
uniform float uReveal;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.y, vUv.x);
  float br = uCoreBreath;
  float hot = exp(-r * r * (170.0 - 60.0 * br));
  float glow = exp(-r * (16.0 - 4.0 * br)) * 0.8 + exp(-r * 5.0) * 0.08;
  float wob = snoise(vec4(cos(a) * 1.5, sin(a) * 1.5, r * 1.5 - uTime * 0.3, uTime * 0.12));
  float spokes = pow(0.5 + 0.5 * sin(a * 36.0 + wob * 2.5), 18.0) * exp(-r * 4.0) * smoothstep(0.04, 0.18, r);
  float fine = pow(0.5 + 0.5 * sin(a * 110.0 + wob * 5.0 + uTime * 0.2), 40.0) * exp(-r * 6.0) * smoothstep(0.05, 0.2, r);
  vec3 col = uColHot * hot * (7.0 + br * 4.0)
           + palette(0.82) * glow * (1.1 + br * 0.9)
           + palette(0.7) * (spokes * 0.7 + fine * 0.45);
  float edge = smoothstep(1.0, 0.6, r);
  gl_FragColor = vec4(col * edge * uReveal * uCoreBoost, 1.0);
}
`;

export const haloFrag = /* glsl */ `
${fragPalette}
uniform float uHaloAmt;
uniform float uSize;
uniform float uRadius;
uniform float uReveal;
varying vec2 vUv;
void main() {
  float r = length(vUv) * uSize * 0.5 / uRadius; // in orb radii
  float inner = exp(-r * r * 3.0) * 0.004;
  float rim = exp(-pow((r - 1.0) * 5.0, 2.0)) * 0.011;
  float outer = exp(-max(r - 1.0, 0.0) * 3.5) * step(1.0, r) * 0.006;
  float h = (inner + rim + outer) * smoothstep(1.0, 0.75, length(vUv));
  gl_FragColor = vec4(palette(0.5) * h * uHaloAmt * uReveal, 1.0);
}
`;

// ─── Line rings (core rings / outer rings / app ring) ────────────────────────
// Each vertex carries its ring id; rotation per ring is built in the shader
// from a uniform angle vector, so all rings are one draw call.
export const ringVert = /* glsl */ `
attribute vec2 aRing; // ring id, brightness
uniform vec4 uAngles;   // spin angle per ring
uniform vec4 uTilts;    // fixed tilt per ring
uniform float uIntensity;
uniform float uReveal;
varying float vI;
varying float vHeat;
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
void main() {
  int id = int(aRing.x + 0.5);
  float ang = id == 0 ? uAngles.x : id == 1 ? uAngles.y : id == 2 ? uAngles.z : uAngles.w;
  float tilt = id == 0 ? uTilts.x : id == 1 ? uTilts.y : id == 2 ? uTilts.z : uTilts.w;
  vec3 p = rotZ(tilt * 0.35) * rotX(tilt) * rotY(ang) * position;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float reveal = clamp(uReveal * 1.5 - aRing.x * 0.15, 0.0, 1.0);
  vI = aRing.y * uIntensity * reveal;
  vHeat = 0.25 + aRing.y * 0.3;
}
`;

export const ringFrag = /* glsl */ `
${fragPalette}
varying float vI;
varying float vHeat;
void main() {
  gl_FragColor = vec4(palette(vHeat) * vI, 1.0);
}
`;

// ─── Final composite: tone map + grade + subtle chromatic aberration ────────
export const finalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: null },
    uCA: { value: 0.0 },
    uTime: { value: 0 },
    uExposure: { value: 1.0 },
    uGrain: { value: 0.006 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uCA;
    uniform float uTime;
    uniform float uExposure;
    uniform float uGrain;
    varying vec2 vUv;
    // Hue-preserving extended Reinhard on the max channel: gold stays gold,
    // only genuinely hot regions roll off toward white.
    vec3 tonemap(vec3 c) {
      float m = max(max(c.r, c.g), c.b);
      if (m <= 1e-5) return vec3(0.0);
      const float W = 5.0;
      float r = m * (1.0 + m / (W * W)) / (1.0 + m);
      vec3 t = c * (r / m);
      float hot = smoothstep(1.5, 9.0, m);
      return mix(t, vec3(r), hot * 0.55);
    }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main() {
      vec2 d = vUv - 0.5;
      vec3 col;
      if (uCA > 0.0) {
        float o = uCA * dot(d, d);
        col = vec3(texture2D(tDiffuse, vUv - d * o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + d * o).b);
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }
      col = tonemap(col * uExposure);
      float v = smoothstep(1.15, 0.2, length(d * vec2(uRes.x / uRes.y, 1.0)));
      col *= mix(0.45, 1.0, v);
      col = toSRGB(col);
      float n = fract(sin(dot(vUv * uRes + uTime * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
