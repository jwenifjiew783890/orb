/**
 * VISION Desktop Probe — guided test of what Lively actually delivers to a web
 * wallpaper, run on the target Windows PC before the desktop shell is built.
 *
 * Everything is recorded passively (all input/focus/visibility/pause events,
 * plus a frame counter), and each guided step snapshots the counters so its
 * result is the difference. Answers to "did Windows also show …?" questions are
 * given with left-click buttons (or ←/→/1-3 keys if keyboard reaches the page).
 *
 * The final report is written to the helper (POST /diag/probe-report →
 * helper/config/desktop-probe-report.json) when paired, and always shown on
 * screen so it can be photographed if nothing else works.
 */

export {};

type Counters = Record<string, number>;
const c: Counters = {};
const inc = (k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
const keysSeen: string[] = [];
const log: string[] = [];
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
function note(s: string) {
  log.push(`${(now() / 1000).toFixed(1)}s ${s}`);
  if (log.length > 400) log.shift();
  (document.getElementById("log") as HTMLElement).textContent = log.slice(-14).join("\n");
}

// ─── passive recorders ───────────────────────────────────────────────────────
let lastMoveT = 0;
const moveIntervals: number[] = [];
window.addEventListener("pointermove", (e) => {
  inc("move");
  const t = performance.now();
  if (lastMoveT && t - lastMoveT < 200) { moveIntervals.push(t - lastMoveT); if (moveIntervals.length > 300) moveIntervals.shift(); }
  lastMoveT = t;
  if (e.buttons & 1) inc("moveWithLeftDown");
}, { passive: true });
window.addEventListener("pointerdown", (e) => { inc(`down${e.button}`); note(`pointerdown button=${e.button} type=${e.pointerType} at ${e.clientX},${e.clientY}`); });
window.addEventListener("pointerup", (e) => inc(`up${e.button}`));
window.addEventListener("mousedown", (e) => inc(`mousedown${e.button}`));
window.addEventListener("click", () => inc("click"));
window.addEventListener("auxclick", (e) => inc(`auxclick${e.button}`));

window.addEventListener("dblclick", () => { inc("dblclick"); note("dblclick"); });
window.addEventListener("contextmenu", (e) => { inc("contextmenu"); note("contextmenu"); e.preventDefault(); });
window.addEventListener("wheel", () => inc("wheel"), { passive: true });
window.addEventListener("keydown", (e) => {
  // Never let Space/Enter activate a focused button: the keyboard steps type them.
  if (e.key === " " || e.key === "Enter") e.preventDefault();
  inc("keydown");
  if (e.ctrlKey && (e.code === "Space" || e.key === " ")) { inc("ctrlSpace"); note("Ctrl+Space received"); }
  if (keysSeen.length < 60) keysSeen.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.key}`);
  note(`keydown ${e.ctrlKey ? "Ctrl+" : ""}${e.key}`);
  if (e.key === "ArrowRight") next();
  if (/^[1-4]$/.test(e.key)) answerByIndex(Number(e.key) - 1);
});
window.addEventListener("keyup", () => inc("keyup"));
window.addEventListener("focus", () => { inc("windowFocus"); note("window focus"); });
window.addEventListener("blur", () => { inc("windowBlur"); note("window blur"); });
document.addEventListener("visibilitychange", () => { inc(`visibility_${document.visibilityState}`); note(`visibility ${document.visibilityState}`); });
let hasFocusSamplesTrue = 0, hasFocusSamples = 0;
setInterval(() => { hasFocusSamples++; if (document.hasFocus()) hasFocusSamplesTrue++; }, 250);

// Lively hooks
let livelyPaused = false;
const w = window as unknown as Record<string, unknown>;
w.livelyWallpaperPlaybackChanged = (data: string) => {
  try { livelyPaused = !!(JSON.parse(data) as { IsPaused?: boolean }).IsPaused; } catch { return; }
  inc(livelyPaused ? "livelyPause" : "livelyResume");
  note(`Lively IsPaused=${livelyPaused}`);
};
w.livelyPropertyListener = (name: string, val: unknown) => { inc("livelyProperty"); note(`Lively property ${name}=${String(val)}`); };

// frame counter (rAF keeps running unless the host throttles it)
let frames = 0, framesWhilePaused = 0, framesWhileHidden = 0;
const tick = () => {
  frames++;
  if (livelyPaused) framesWhilePaused++;
  if (document.visibilityState === "hidden") framesWhileHidden++;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// ─── guided steps ────────────────────────────────────────────────────────────
interface Step {
  id: string;
  title: string;
  instr: string;
  rings?: "A" | "AB";
  question?: { q: string; options: string[] };
  /** Keys of counters shown live for this step. */
  watch: string[];
  done?: (d: Counters) => boolean;
}

const STEPS: Step[] = [
  { id: "move", title: "Mouse movement", watch: ["move"], done: (d) => (d.move ?? 0) > 60,
    instr: "Move the mouse slowly over EMPTY desktop for a few seconds.\n(Lively → Settings → Wallpaper → Wallpaper Input should be set to Mouse.)" },
  { id: "hoverIcon", title: "Movement over desktop icons", watch: ["move"],
    instr: "Now hover the mouse over one of your DESKTOP ICONS for ~3 seconds, moving it slightly.\nThen click Next (on empty space).",
    question: { q: "Were desktop icons visible during this step?", options: ["Yes", "No, icons already hidden"] } },
  { id: "leftClick", title: "Left click", rings: "A", watch: ["down0", "up0", "click"], done: (d) => (d.click ?? 0) >= 3,
    instr: "Click ring A three times." },
  { id: "dblClick", title: "Double click", rings: "A", watch: ["dblclick", "click"], done: (d) => (d.dblclick ?? 0) >= 2,
    instr: "Double-click ring A twice.",
    question: { q: "Did Windows do anything on the double-click (open something, select icons)?", options: ["No", "Yes"] } },
  { id: "drag", title: "Drag", rings: "AB", watch: ["moveWithLeftDown", "down0", "up0"], done: (d) => (d.moveWithLeftDown ?? 0) > 15,
    instr: "Press on ring A, drag to ring B, release.",
    question: { q: "Did Windows draw a blue selection rectangle while dragging?", options: ["No", "Yes"] } },
  { id: "wheel", title: "Mouse wheel", watch: ["wheel"], done: (d) => (d.wheel ?? 0) >= 3,
    instr: "Scroll the mouse wheel a few notches over empty desktop." },
  { id: "rightClick", title: "Right click (icons visible)", watch: ["down2", "up2", "contextmenu", "auxclick2", "mousedown2"],
    instr: "Right-click EMPTY desktop three times. If a Windows menu appears, press Esc (or left-click empty space) to close it each time.",
    question: { q: "Did the normal Windows desktop menu appear when you right-clicked?", options: ["Yes, every time", "Sometimes", "No, never"] } },
  { id: "middle", title: "Middle click", watch: ["down1", "auxclick1"],
    instr: "Middle-click (press the wheel) on empty desktop twice. Skip if you have no middle button." },
  { id: "keysMouseOnly", title: "Keyboard — input mode: Mouse", watch: ["keydown", "ctrlSpace"],
    instr: "Keep Lively's Wallpaper Input on Mouse.\nClick empty desktop once, then type: vision  and press Ctrl+Space." },
  { id: "keysKeyboard", title: "Keyboard — input mode: Keyboard", watch: ["keydown", "ctrlSpace"],
    instr: "Now set Lively → Settings → Wallpaper → Wallpaper Input to the option that includes KEYBOARD.\nClick empty desktop once, then type: vision  and press Ctrl+Space.",
    question: { q: "Which Wallpaper Input setting did you select?", options: ["Keyboard", "Mouse + Keyboard", "No keyboard option exists"] } },
  { id: "keysOtherWindow", title: "Keyboard while another window is focused", watch: ["keydown", "ctrlSpace", "windowBlur"],
    instr: "Click inside a normal window (e.g. File Explorer or Notepad) so it is focused, then type: abc  and press Ctrl+Space.\nThen click back on empty desktop and click Next." },
  { id: "focus", title: "Focus behaviour", watch: ["windowFocus", "windowBlur"],
    instr: "Alternate 3 times: click a normal window, then click empty desktop.",
    question: { q: "After clicking the desktop, did the previously active window lose its highlight (become inactive)?", options: ["Yes", "No"] } },
  { id: "iconsHiddenClick", title: "Desktop icons HIDDEN — clicks", rings: "A", watch: ["click", "down0", "move"],
    instr: "Hide desktop icons: right-click desktop → View → uncheck \"Show desktop icons\".\nThen click ring A three times and move the mouse where icons used to be." },
  { id: "iconsHiddenRight", title: "Desktop icons HIDDEN — right click", watch: ["down2", "contextmenu", "auxclick2"],
    instr: "With icons still hidden, right-click empty desktop three times (Esc to close any Windows menu).",
    question: { q: "Did the Windows desktop menu appear?", options: ["Yes, every time", "Sometimes", "No, never"] } },
  { id: "iconsHiddenKeys", title: "Desktop icons HIDDEN — keyboard", watch: ["keydown", "ctrlSpace"],
    instr: "With icons still hidden, click empty desktop, type: vision  and press Ctrl+Space.\nAfterwards you may turn desktop icons back on." },
  { id: "maximized", title: "Maximized window", watch: ["livelyPause", "livelyResume", "visibility_hidden", "visibility_visible"],
    instr: "Maximize any normal window for ~10 seconds, then minimize/restore it so the desktop is visible again. Click Next." },
  { id: "fullscreen", title: "Fullscreen app / game", watch: ["livelyPause", "livelyResume", "visibility_hidden", "visibility_visible"],
    instr: "Start a fullscreen game or fullscreen video (F11 in a browser also works) for ~15 seconds, then return to the desktop. Click Next." },
  { id: "property", title: "Lively Customise", watch: ["livelyProperty"],
    instr: "Open Lively → this wallpaper → Customise, toggle the checkbox once, close it. Click Next." },
];

let idx = -1;
let snap: Counters = {};
const answers: Record<string, string> = {};
const results: Record<string, { counters: Counters; seconds: number; answer?: string; autoPassed: boolean; skipped: boolean; moveHz?: number; keys?: string[] }> = {};
let stepStart = 0;
let keysAtStart = 0;
let rafTimer = 0;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const diff = (): Counters => { const d: Counters = {}; for (const k of Object.keys(c)) { const v = (c[k] ?? 0) - (snap[k] ?? 0); if (v) d[k] = v; } return d; };

function placeRings(which?: "A" | "AB") {
  const a = $("ringA"), b = $("ringB");
  a.style.display = which ? "flex" : "none";
  b.style.display = which === "AB" ? "flex" : "none";
  a.style.left = which === "AB" ? "30%" : "50%"; a.style.top = "74%";
  b.style.left = "70%"; b.style.top = "74%";
}
["ringA", "ringB"].forEach((id) => $(id).addEventListener("pointerdown", () => { $(id).classList.add("hit"); setTimeout(() => $(id).classList.remove("hit"), 150); }));

function finishStep(skipped: boolean) {
  if (idx < 0 || idx >= STEPS.length) return;
  const s = STEPS[idx];
  const d = diff();
  const iv = moveIntervals.slice(-100).sort((x, y) => x - y);
  results[s.id] = {
    counters: d, seconds: +((now() - stepStart) / 1000).toFixed(1), answer: answers[s.id],
    autoPassed: s.done ? s.done(d) : false, skipped,
    moveHz: s.id === "move" && iv.length ? +(1000 / iv[Math.floor(iv.length / 2)]).toFixed(1) : undefined,
    keys: s.watch.includes("keydown") ? keysSeen.slice(keysAtStart) : undefined,
  };
}

function next(skipped = false) {
  finishStep(skipped);
  idx++;
  if (idx >= STEPS.length) { done(); return; }
  const s = STEPS[idx];
  snap = { ...c };
  stepStart = now();
  keysAtStart = keysSeen.length;
  $("step").textContent = `STEP ${idx + 1} / ${STEPS.length}`;
  $("title").textContent = s.title;
  $("instr").textContent = s.instr;
  placeRings(s.rings);
  const box = $("answers");
  box.innerHTML = "";
  if (s.question) {
    const q = document.createElement("div");
    q.style.width = "100%";
    q.textContent = s.question.q;
    box.appendChild(q);
    s.question.options.forEach((o) => {
      const btn = document.createElement("button");
      btn.className = "ans";
      btn.textContent = o;
      btn.addEventListener("click", (e) => { e.stopPropagation(); btn.blur(); answers[s.id] = o; [...box.querySelectorAll("button")].forEach((x) => x.classList.toggle("sel", x === btn)); });
      box.appendChild(btn);
    });
  }
  note(`— step ${s.id}`);
}

function answerByIndex(i: number) {
  const btns = [...$("answers").querySelectorAll("button")];
  (btns[i] as HTMLButtonElement | undefined)?.click();
}

function liveLoop() {
  if (idx >= 0 && idx < STEPS.length) {
    const s = STEPS[idx];
    const d = diff();
    const ok = s.done ? (s.done(d) ? "  ✓ detected" : "") : "";
    $("live").textContent = s.watch.map((k) => `${k.padEnd(18)} ${d[k] ?? 0}`).join("\n") + ok
      + (s.watch.includes("keydown") ? `\nkeys: ${keysSeen.slice(keysAtStart).join(" ")}` : "");
  }
  rafTimer = window.setTimeout(liveLoop, 150);
}

async function done() {
  clearTimeout(rafTimer);
  placeRings();
  $("step").textContent = "COMPLETE";
  $("title").textContent = "Report";
  $("answers").innerHTML = "";
  $("live").textContent = "";
  ($("next") as HTMLButtonElement).style.display = "none";
  ($("skip") as HTMLButtonElement).style.display = "none";
  let renderer = "unknown";
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  } catch { /* ignore */ }
  const report = {
    kind: "vision-desktop-probe", version: 1, when: new Date().toISOString(),
    userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}`, dpr: devicePixelRatio, renderer,
    hasFocusRatio: hasFocusSamples ? +(hasFocusSamplesTrue / hasFocusSamples).toFixed(2) : null,
    frames, framesWhileLivelyPaused: framesWhilePaused, framesWhileHidden,
    totals: c, steps: results, log: log.slice(-200),
  };
  const text = JSON.stringify(report, null, 1);
  try { localStorage.setItem("vision.desktopProbe", text); } catch { /* ignore */ }
  const cfg = (window as unknown as { VISION_HELPER?: { port: number; token: string } | null }).VISION_HELPER;
  let status = "Helper not paired: photograph this screen or copy the text below.";
  if (cfg?.token) {
    try {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/diag/probe-report`, {
        method: "POST", headers: { "X-Vision-Token": cfg.token, "Content-Type": "application/json" }, body: JSON.stringify(report),
      });
      status = r.ok ? "Report saved by the helper to helper\\config\\desktop-probe-report.json" : `Helper refused the report (HTTP ${r.status}). Photograph this screen.`;
    } catch { status = "Helper not reachable. Photograph this screen or copy the text below."; }
  }
  $("instr").textContent = status;
  const box = $("report");
  box.style.display = "block";
  box.textContent = summarize(report.steps) + "\n\n" + text;
}

function summarize(steps: typeof results): string {
  const g = (id: string, k: string) => steps[id]?.counters[k] ?? 0;
  const a = (id: string) => steps[id]?.answer ?? "—";
  return [
    `mouse move            ${g("move", "move") > 0 ? "YES" : "NO"} (${steps.move?.moveHz ?? "?"} Hz)   over icons: ${g("hoverIcon", "move") > 0 ? "YES" : "NO"}`,
    `left click            ${g("leftClick", "click")} clicks   dblclick ${g("dblClick", "dblclick")} (Windows reacted: ${a("dblClick")})`,
    `drag                  ${g("drag", "moveWithLeftDown")} moves   (selection rectangle: ${a("drag")})`,
    `wheel                 ${g("wheel", "wheel")}`,
    `right click (icons)   down2 ${g("rightClick", "down2")} contextmenu ${g("rightClick", "contextmenu")}   Windows menu: ${a("rightClick")}`,
    `right click (hidden)  down2 ${g("iconsHiddenRight", "down2")} contextmenu ${g("iconsHiddenRight", "contextmenu")}   Windows menu: ${a("iconsHiddenRight")}`,
    `middle click          ${g("middle", "down1")}`,
    `keys, Mouse mode      ${g("keysMouseOnly", "keydown")} (Ctrl+Space ${g("keysMouseOnly", "ctrlSpace")})`,
    `keys, Keyboard mode   ${g("keysKeyboard", "keydown")} (Ctrl+Space ${g("keysKeyboard", "ctrlSpace")})   setting: ${a("keysKeyboard")}`,
    `keys, other window    ${g("keysOtherWindow", "keydown")} (Ctrl+Space ${g("keysOtherWindow", "ctrlSpace")})`,
    `keys, icons hidden    ${g("iconsHiddenKeys", "keydown")} (Ctrl+Space ${g("iconsHiddenKeys", "ctrlSpace")})`,
    `clicks, icons hidden  ${g("iconsHiddenClick", "click")}`,
    `focus events          focus ${g("focus", "windowFocus")} blur ${g("focus", "windowBlur")}   other window deactivated: ${a("focus")}`,
    `maximized             pause ${g("maximized", "livelyPause")} resume ${g("maximized", "livelyResume")} hidden ${g("maximized", "visibility_hidden")}`,
    `fullscreen            pause ${g("fullscreen", "livelyPause")} resume ${g("fullscreen", "livelyResume")} hidden ${g("fullscreen", "visibility_hidden")}`,
    `Lively property hook  ${g("property", "livelyProperty")}`,
  ].join("\n");
}

$("next").addEventListener("click", (e) => { e.stopPropagation(); (e.currentTarget as HTMLElement).blur(); next(false); });
$("skip").addEventListener("click", (e) => { e.stopPropagation(); (e.currentTarget as HTMLElement).blur(); next(true); });
next();
liveLoop();
(window as unknown as Record<string, unknown>).__probe = { c, results, next, get idx() { return idx; } };
