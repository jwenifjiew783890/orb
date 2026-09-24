/**
 * GPU frame timing via EXT_disjoint_timer_query_webgl2 (when the driver exposes
 * it). Results arrive a few frames late and are read without stalling.
 * Only runs while someone asks for it (auto-quality sampling / debug overlay).
 */
interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private free: WebGLQuery[] = [];
  /** Exponentially smoothed GPU ms per frame (NaN until the first sample). */
  ms = NaN;
  samples = 0;
  enabled = false;

  constructor(gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.gl = gl as WebGL2RenderingContext;
    this.ext = (gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null) ?? null;
  }

  get available() { return this.ext !== null; }

  begin() {
    if (!this.enabled || !this.ext || this.active || this.pending.length > 4) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  private poll() {
    const gl = this.gl;
    const disjoint = this.ext ? gl.getParameter(this.ext.GPU_DISJOINT_EXT) : false;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.free.push(q);
      if (disjoint) continue;
      const ms = ns / 1e6;
      this.ms = Number.isNaN(this.ms) ? ms : this.ms * 0.9 + ms * 0.1;
      this.samples++;
    }
  }

  reset() {
    this.ms = NaN;
    this.samples = 0;
  }

  /** After context loss all query objects are invalid. */
  onContextRestored() {
    this.pending = [];
    this.free = [];
    this.active = null;
    this.reset();
  }
}
