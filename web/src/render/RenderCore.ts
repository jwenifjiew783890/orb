import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { finalShader } from "../orb/shaders";
import { CAMERA_HOME } from "../config";

/** UnrealBloomPass already works at half resolution; this scales it further. */
class ScaledBloomPass extends UnrealBloomPass {
  scale = 1;
  override setSize(width: number, height: number) {
    super.setSize(Math.max(64, Math.round(width * this.scale)), Math.max(64, Math.round(height * this.scale)));
  }
}

export const FOV = 42;

export class RenderCore {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly bloom: ScaledBloomPass;
  readonly final: ShaderPass;
  readonly canvas: HTMLCanvasElement;
  readonly gpuName: string;
  readonly isWebGL2: boolean;

  private dprCap = 1.5;
  private width = 1;
  private height = 1;
  private bgColor = new THREE.Color();
  contextLost = false;

  /** Scene-only draw calls/primitives of the last frame (orb system, no post). */
  lastSceneCalls = 0;
  lastSceneLines = 0;
  lastScenePoints = 0;
  lastSceneTriangles = 0;
  lastTotalCalls = 0;

  constructor(parent: HTMLElement, onLost: () => void, onRestored: () => void) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // bloom + additive lines don't benefit enough to pay for MSAA
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    const gl = this.renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
    this.renderer.toneMapping = THREE.NoToneMapping; // tone mapped in the final pass
    this.renderer.info.autoReset = false;
    this.canvas = this.renderer.domElement;
    this.canvas.id = "orb-canvas";
    parent.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.camera.position.copy(CAMERA_HOME);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new ScaledBloomPass(new THREE.Vector2(256, 256), 0.85, 0.35, 0.42);
    this.composer.addPass(this.bloom);
    const fs = { ...finalShader, uniforms: THREE.UniformsUtils.clone(finalShader.uniforms) as Record<string, THREE.IUniform> };
    fs.uniforms.uRes.value = new THREE.Vector2(1, 1);
    this.final = new ShaderPass(fs);
    this.composer.addPass(this.final);

    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // allow restoration
      this.contextLost = true;
      onLost();
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      // three.js re-initialises GL state and lazily re-uploads every geometry,
      // texture and render target on the next render — nothing to rebuild here.
      this.resize();
      onRestored();
    });
  }

  setBackground(hex: string) {
    this.bgColor.set(hex);
    this.renderer.setClearColor(this.bgColor, 1);
  }

  setDprCap(cap: number) {
    this.dprCap = Math.min(1.5, cap);
    this.resize();
  }

  get dpr() { return Math.min(window.devicePixelRatio || 1, this.dprCap); }

  setBloom(strength: number, scale: number) {
    this.bloom.strength = strength;
    if (this.bloom.scale !== scale) {
      this.bloom.scale = scale;
      this.resize();
    }
  }

  setChromatic(on: boolean) {
    this.final.uniforms.uCA.value = on ? 0.012 : 0;
  }

  resize() {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    const dpr = this.dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    // keep the orb a similar screen fraction on portrait / ultrawide screens
    this.camera.fov = this.camera.aspect < 1 ? FOV / Math.max(0.6, this.camera.aspect) : FOV;
    // Lift the orb slightly above centre so the bottom HUD never overlaps it.
    this.camera.setViewOffset(this.width, this.height, 0, Math.round(this.height * 0.035), this.width, this.height);
    this.camera.updateProjectionMatrix();
    (this.final.uniforms.uRes.value as THREE.Vector2).set(this.width * dpr, this.height * dpr);
  }

  get bufferHeight() { return this.height * this.dpr; }

  render(time: number) {
    if (this.contextLost) return;
    this.final.uniforms.uTime.value = time;
    const info = this.renderer.info;
    info.reset();
    // Measure the scene pass on its own so the debug overlay can report the orb's
    // own draw calls separately from post-processing.
    this.composer.render();
    this.lastTotalCalls = info.render.calls;
  }

  /** Scene-only stats, sampled occasionally by the debug overlay. */
  sampleSceneStats() {
    const info = this.renderer.info;
    const target = this.composer.readBuffer;
    info.reset();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.lastSceneCalls = info.render.calls;
    this.lastSceneLines = info.render.lines;
    this.lastScenePoints = info.render.points;
    this.lastSceneTriangles = info.render.triangles;
  }

  dispose() {
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
