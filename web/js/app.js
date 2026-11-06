// b0tn3t.sh: a Linux machine in the page.
import { now as clockNow, atLeast } from "./clock.js"; // must come before libv86
import { Terminal } from "../vendor/xterm/xterm.mjs";
import { FitAddon } from "../vendor/xterm/addon-fit.mjs";
import { Unicode11Addon } from "../vendor/xterm/addon-unicode11.mjs";
import { SerializeAddon } from "../vendor/xterm/addon-serialize.mjs";
import { V86 } from "../vendor/v86/libv86.mjs";
import { VmLink } from "./link.js";
import { portPump, resizeArgs } from "./pump.js";
import { posixTZ, browserZone } from "./tz.js";
import { BAR, MORE, LABELS, REPEAT, keySeq, applyMods, Sticky, SurrogateJoiner } from "./keys.js";
import { Settings, THEMES, FONTS, SYSTEM_FONT } from "./settings.js";
import { StateStore, MAIN, SNAP, snapKey, gzip, gunzip, mb, LIMIT } from "./store.js";
import { Quiet } from "./quiet.js";
import { netDevice } from "./net.js";
import { Power } from "./power.js";
import { linkProvider, openLink } from "./links.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const touch = matchMedia("(pointer: coarse)").matches;
const enc = new TextEncoder();
const dec = new TextDecoder();
// wall clock: performance.now() is the (shifted) emulator clock, see clock.js
const t0 = Date.now();
const timings = {};
const mark = (k) => { timings[k] = Date.now() - t0; };

const safeStorage = (() => { try { localStorage.setItem("b0tn3t.t", "1"); localStorage.removeItem("b0tn3t.t"); return localStorage; } catch { return { getItem: () => null, setItem() {}, removeItem() {} }; } })();
const settings = new Settings(safeStorage, touch);
const store = new StateStore();

// ------------------------------------------------------------ terminal
const term = new Terminal({
  allowProposedApi: true,
  fontFamily: SYSTEM_FONT,
  fontSize: settings.get("fontSize"),
  lineHeight: 1.15,
  cursorStyle: settings.get("cursor"),
  cursorBlink: settings.get("blink"),
  scrollback: settings.get("scrollback"),
  macOptionIsMeta: true,
  rightClickSelectsWord: true,
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  smoothScrollDuration: touch ? 0 : 80,
});
const fit = new FitAddon();
const serializer = new SerializeAddon();
term.loadAddon(fit);
term.loadAddon(serializer);
const follow = (uri) => openLink(uri, openTab);
term.registerLinkProvider(linkProvider(term, follow));
// OSC 8 hyperlinks from programs: same rules, no confirm() dialog
term.options.linkHandler = { activate: (e, uri) => { e.preventDefault(); follow(uri); }, allowNonHttpProtocols: true };
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
term.open($("#term"));

let webgl = null;
// auto: WebGL on desktops; the DOM renderer on touch screens, where
// WebGL at a devicePixelRatio of 3 drew glyphs at the wrong scale
async function setRenderer(kind) {
  if (webgl) { webgl.dispose(); webgl = null; }
  if (kind === "dom" || (kind === "auto" && touch)) return;
  try {
    const { WebglAddon } = await import("../vendor/xterm/addon-webgl.mjs");
    const a = new WebglAddon();
    a.onContextLoss(() => { a.dispose(); webgl = null; });
    term.loadAddon(a);
    webgl = a;
  } catch (e) {
    console.info("webgl renderer unavailable, using DOM", e && e.message);
  }
}

function setTheme(name) {
  const t = THEMES[name] || THEMES.red;
  term.options.theme = t;
  document.documentElement.dataset.theme = THEMES[name] ? name : "red";
  document.documentElement.style.setProperty("--bg", t.background);
  document.documentElement.style.setProperty("--fg", t.foreground);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", t.background);
}

const fontLinks = new Map();
async function setFont(name) {
  const family = FONTS[name];
  if (!family) { term.options.fontFamily = SYSTEM_FONT; layout(); return; }
  if (!fontLinks.has(family)) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@400;700&display=swap`;
    fontLinks.set(family, new Promise((ok) => { l.onload = () => ok(true); l.onerror = () => ok(false); }));
    document.head.append(l);
  }
  if (!(await fontLinks.get(family))) throw new Error(`could not load ${family}`);
  await Promise.all([400, 700].map((w) => document.fonts.load(`${w} 16px "${family}"`).catch(() => {})));
  term.options.fontFamily = `"${family}", ${SYSTEM_FONT}`;
  layout();
}

settings.onChange((k, v) => {
  if (k === "theme") setTheme(v);
  if (k === "font") setFont(v).catch((e) => toast(e.message));
  if (k === "fontSize") { term.options.fontSize = v; layout(); }
  if (k === "cursor") term.options.cursorStyle = v;
  if (k === "blink") term.options.cursorBlink = v;
  if (k === "scrollback") term.options.scrollback = v;
  if (k === "renderer") setRenderer(v);
  if (k === "keys") showKeys();
});
setTheme(settings.get("theme"));
if (settings.get("font") !== "system") setFont(settings.get("font")).catch(() => {});
setRenderer(settings.get("renderer"));

const dim = (s) => term.write(`\x1b[90m${s}\x1b[0m`);

// ------------------------------------------------------------ layout
let resizeTimer = 0;
function layout() {
  const vv = window.visualViewport;
  $("#app").style.height = (vv ? vv.height : innerHeight) + "px";
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    try { fit.fit(); } catch { /* not visible yet */ }
    term.scrollToBottom();
  }, 30);
}
addEventListener("resize", layout);
if (window.visualViewport) visualViewport.addEventListener("resize", layout);

// ------------------------------------------------------------ toast + dialog
let toastTimer = 0;
function toast(msg, action = null, ms = 6000) {
  const t = $("#toast");
  t.querySelector(".msg").textContent = msg;
  const b = t.querySelector("button");
  b.hidden = !action;
  if (action) { b.textContent = action.label; b.onclick = () => { hideToast(); action.run(); }; }
  t.classList.add("open");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $("#toast").classList.remove("open"); }

// a small modal: {text, input?, ok, cancel?, onOpen?}; resolves to value or null
function dialog({ text, input = false, ok = "OK", extra = null, signal = null }) {
  const d = $("#dialog");
  d.querySelector(".text").textContent = text;
  const ta = d.querySelector("textarea");
  ta.hidden = !input;
  ta.value = "";
  const okb = d.querySelector(".ok"), cancel = d.querySelector(".cancel"), ex = d.querySelector(".extra");
  okb.textContent = ok;
  ex.hidden = !extra;
  if (extra) ex.textContent = extra.label;
  d.classList.add("open");
  (input ? ta : okb).focus();
  return new Promise((resolve) => {
    const close = (v) => { d.classList.remove("open"); okb.onclick = cancel.onclick = ex.onclick = null; term.focus(); resolve(v); };
    okb.onclick = () => close(input ? ta.value : true);
    cancel.onclick = () => close(null);
    if (extra) ex.onclick = () => { const v = extra.run(); if (v !== undefined) close(v); };
    if (signal) signal.addEventListener("abort", () => close(null), { once: true });
  });
}

// ------------------------------------------------------------ clipboard
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  term.focus();
  if (!ok) toast("Copy blocked by the browser", { label: "Copy", run: () => navigator.clipboard.writeText(text) }, 20000);
  return ok;
}

async function readClipboard(signal) {
  try { return await navigator.clipboard.readText(); } catch { /* ask the user instead */ }
  return dialog({ text: "Paste here (Ctrl+V), then OK", input: true, signal });
}

// ------------------------------------------------------------ tabs
// window.open(..., "noopener") always returns null, so it cannot tell us
// about a blocked pop-up: open normally and cut the opener link by hand.
function openTab(url) {
  const w = window.open(url, "_blank");
  if (w) {
    try { w.opener = null; } catch { /* cross-origin already */ }
    return true;
  }
  toast(`Pop-up blocked: ${url}`, { label: "Open", run: () => window.open(url, "_blank", "noopener") }, 20000);
  return false;
}

// ------------------------------------------------------------ files
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function pickFiles(signal) {
  const input = $("#files");
  input.value = "";
  return new Promise((resolve) => {
    let settled = false, closeDialog = null;
    const done = (files) => {
      if (settled) return;
      settled = true;
      if (closeDialog) closeDialog();
      resolve(files);
    };
    input.onchange = () => done([...input.files]);
    input.oncancel = () => done(null);
    signal.addEventListener("abort", () => done(null), { once: true });
    if (navigator.userActivation?.isActive) { input.click(); return; }
    // no user gesture to open the picker with: ask for one click
    const ctl = new AbortController();
    closeDialog = () => ctl.abort();
    dialog({ text: "Upload files into the machine", ok: "Choose files…", signal: ctl.signal }).then((v) => {
      if (v) input.click(); else done(null);
    });
  });
}

// ------------------------------------------------------------ the machine
let emulator = null, link = null, termPump = null, linkPump = null, power = null, poweredOff = false;
let allowActive = 0; // open vm requests a snapshot may include (the `vm save` itself)
const quiet = new Quiet({ busy: () => (termPump && termPump.queued > 0) || (linkPump && linkPump.queued > 0) || (link && link.active.size > allowActive) });
let manifest = null, memMB = 128, booted = false, dirty = false;
// a reboot clears the screen and shows "booting" with a dot every half
// second until the shell of the next boot speaks on hvc0. (The kernel's own
// boot messages on the serial console would add 3 s: it boots quiet.)
const GOING_DOWN = /The system is going down/;
const bootDots = {
  timer: 0,
  start() {
    this.stop();
    term.write("\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[90mbooting");
    this.timer = setInterval(() => term.write("."), 500);
  },
  stop() { // true if it was running
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = 0;
    term.write("\x1b[0m");
    return true;
  },
};

let pending = []; // keystrokes typed before the machine is up
const ready = {};
ready.promise = new Promise((r) => { ready.resolve = r; });

const joiner = new SurrogateJoiner();
function sendInput(s) {
  if (poweredOff) { offKey(s); return; }
  s = joiner.push(s);
  if (!s) return;
  const bytes = enc.encode(s);
  if (termPump) termPump.write(bytes); else pending.push(bytes);
  dirty = true;
  scheduleAutosave();
}

function sendResize() {
  if (emulator) emulator.bus.send("virtio-console0-resize", resizeArgs(term.cols, term.rows));
}
term.onResize(sendResize);

function helloFields() {
  const zone = browserZone();
  let tz = "<+00>0";
  try { tz = posixTZ(zone); } catch { /* old browser */ }
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    time: Date.now(), tz, zone, seed, build: manifest && manifest.build,
    browser: detectBrowser(), screen: `${screen.width}x${screen.height}`,
    lang: navigator.language, touch: touch ? 1 : 0,
  };
}

function detectBrowser() {
  const ua = navigator.userAgent;
  for (const [re, name] of [[/Firefox\/(\d+)/, "Firefox"], [/Edg\/(\d+)/, "Edge"], [/OPR\/(\d+)/, "Opera"], [/Chrome\/(\d+)/, "Chrome"], [/Version\/(\d+).*Safari/, "Safari"]]) {
    const m = ua.match(re);
    if (m) return `${name}_${m[1]}`;
  }
  return "unknown";
}

async function sayHello(resume = null) {
  try {
    await link.hello({ ...helloFields(), keep: resume ? resume.id : null }, { timeout: 20000 });
    // the save was made while `vm save` waited for its answer: give it now
    if (resume) link.replyTo(resume.id, true, resume.text);
    mark("hello");
    booted = true;
    ready.resolve();
  } catch (e) {
    console.warn("hello failed", e);
  }
}

async function loadManifest() {
  const r = await fetch("image/manifest.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("image/manifest.json: " + r.status);
  return r.json();
}

async function boot() {
  layout();
  term.focus();
  dim("b0tn3t.sh · starting the machine…");
  manifest = await loadManifest();
  const v = `?v=${manifest.build}`;
  memMB = manifest.mem;

  let saved = null;
  if (!params.has("fresh") && !params.has("boot")) {
    saved = await store.get(MAIN).catch(() => null);
    if (saved && saved.build !== manifest.build) {
      await store.del(MAIN).catch(() => {});
      toast("site updated · new machine", null, 5000);
      saved = null;
    }
  }

  const opts = {
    wasm_path: "vendor/v86/v86.wasm" + v,
    bios: { url: "vendor/v86/seabios.bin" + v },
    vga_bios: { url: "vendor/v86/vgabios.bin" + v },
    memory_size: memMB << 20,
    vga_memory_size: manifest.vga << 20,
    filesystem: { baseurl: "image/flat/", basefs: "image/fs.json" + v },
    virtio_console: true,
    net_device: netDevice(),
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  };

  let screenBytes;
  if (saved) {
    atLeast(saved.tick || 0);
    opts.initial_state = { buffer: (await gunzip(saved.blob)).buffer };
    screenBytes = saved.screen;
  } else if (params.has("boot")) {
    Object.assign(opts, { bzimage: { url: "image/bzImage" + v }, cmdline: manifest.cmdline });
  } else {
    atLeast(manifest.tick || 0);
    opts.initial_state = { url: "image/state.bin.zst" + v, size: manifest.files["state.bin.zst"] };
    screenBytes = fetch("image/screen.bin" + v).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)).catch(() => null);
  }

  emulator = new V86(opts);
  window.vm.emulator = emulator;
  emulator.add_listener("download-progress", (e) => {
    if (!e.lengthComputable || !/state|bzImage/.test(e.file_name)) return;
    term.write(`\r\x1b[2K\x1b[90mb0tn3t.sh · loading the machine ${mb(e.loaded)} / ${mb(e.total)}\x1b[0m`);
  });

  termPump = portPump(emulator, 0);
  linkPump = portPump(emulator, 1);
  link = new VmLink({
    send: (b) => linkPump.write(b),
    drain: (n) => linkPump.drained(n),
    onRequest: handleRequest,
    onNotice: (t) => toast(t),
    onStart: () => sayHello(),
  });
  window.vm.link = link;
  emulator.add_listener("virtio-console1-output-bytes", (b) => { quiet.touch(); link.feed(new Uint8Array(b)); });
  emulator.add_listener("virtio-console0-output-bytes", (b) => {
    quiet.touch();
    // first words of a new boot: the banner goes to the top of a clean screen
    if (bootDots.stop()) term.write("\x1b[0m\x1b[H\x1b[2J\x1b[3J");
    term.write(new Uint8Array(b));
  });

  emulator.add_listener("emulator-loaded", async () => {
    mark("loaded");
    power = new Power(emulator, {
      kernel: async () => {
        const r = await fetch("image/bzImage" + v);
        if (!r.ok) throw new Error("image/bzImage: " + r.status);
        return r.arrayBuffer();
      },
      cmdline: manifest.cmdline,
      onLine: (line) => {
        // init announces the shutdown a second before the reset: fetch the kernel now
        if (GOING_DOWN.test(line)) power.prefetch().catch(() => {});
      },
      onReboot: () => { // vmd says READY(0) again, then hello
        booted = false;
        bootDots.start();
      },
      onOff: () => { // poweroff and halt look the same: there is no power driver
        booted = false;
        bootDots.stop();
        poweredOff = true;
        clearTimeout(autosaveTimer);
        setTimeout(showOff, 400); // let the last dots of `poweroff` be seen
      },
    });
    window.vm.power = power;
    term.write("\x1b[2K\r\x1b[H\x1b[2J");
    const s = await screenBytes;
    if (s) term.write(typeof s === "string" ? s : new Uint8Array(s));
    mark("screen");
    sendResize();
    for (const p of pending.splice(0)) termPump.write(p);
    if (opts.bzimage) { booted = true; ready.resolve(); return; } // vmd will say READY(0)
    sayHello(saved && saved.reply);
  });
}

// ------------------------------------------------------------ powered off
// after poweroff/halt the terminal shows a small menu: start again (files
// are kept), wipe everything, or close the page
let offAsk = false;
function showOff() {
  if (!poweredOff) return;
  offAsk = false;
  const d = (t) => `\x1b[90m${t}\x1b[0m`, k = (t) => `\x1b[1m${t}\x1b[0m`;
  const lines = [
    "", "", `  ${k("●")} ${d("b0tn3t.sh is")} ${k("off")}`, "",
    `  ${k("Enter")}  ${d("turn it on (your files are kept)")}`,
    `  ${k("r")}      ${d("reset: wipe everything, start fresh")}`,
    `  ${k("q")}      ${d("close the page")}`, "",
  ];
  term.write("\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[?25l" + lines.join("\r\n"));
}

function offKey(s) {
  if (offAsk) {
    offAsk = false;
    if (/^[yY]/.test(s)) {
      term.write("y\r\n\r\n  " + "\x1b[90mwiping everything…\x1b[0m");
      wipeEverything().then(() => reload("?fresh"));
      poweredOff = false;
    } else showOff();
    return;
  }
  if (s === "\r" || s === "\n" || s === " ") startAgain();
  else if (s === "r" || s === "R") {
    offAsk = true;
    term.write("\r\n  \x1b[1mWipe the machine and all your files?\x1b[0m \x1b[90m[y/N]\x1b[0m \x1b[?25h");
  } else if (s === "q" || s === "Q") closePage();
}

function closePage() {
  window.close(); // allowed for tabs a script opened, or with no history
  setTimeout(() => {
    if (window.closed) return;
    term.write("\r\n  \x1b[90mthe browser keeps this tab open: close it with Ctrl+W (⌘W)\x1b[0m");
  }, 300);
}

function startAgain() {
  if (!poweredOff || !power) return;
  poweredOff = false;
  term.write("\x1b[?25h");
  power.boot().catch((e) => { toast(`could not start the machine: ${e.message}`); poweredOff = true; showOff(); });
}

// ------------------------------------------------------------ saving
let saving = null, autosaveTimer = 0;
// reply: for `vm save`, {id, text(size)}: the answer that request gets,
// stored with the state so a restored machine receives it too.
async function saveMachine(key = MAIN, reply = null) {
  if (!emulator || !booted) throw new Error("the machine is still starting");
  if (saving) await saving;
  saving = (async () => {
    // A snapshot in the middle of console/vmd traffic can restore into a
    // hung foreground program, so wait for a calm moment (never inside a
    // v86 device callback either: quiet.wait always yields first).
    allowActive = reply ? 1 : 0;
    const calm = await quiet.wait(250, reply ? 10000 : 4000);
    allowActive = 0;
    if (!calm) throw new Error("the machine is busy, try again in a moment");
    const screen = serializer.serialize({ scrollback: 300 });
    const tick = clockNow();
    const raw = new Uint8Array(await emulator.save_state());
    const blob = await gzip(raw);
    if (blob.size > LIMIT) throw new Error(`state is ${mb(blob.size)}, over the ${mb(LIMIT)} limit`);
    const value = { blob, size: blob.size, screen, tick, build: manifest.build, mem: memMB, created: Date.now() };
    if (reply) value.reply = { id: reply.id, text: reply.text(blob.size) };
    await store.put(key, value);
    if (key === MAIN) dirty = false;
    return blob.size;
  })();
  try { return await saving; } finally { saving = null; }
}

// Autosave only while the shell waits at its prompt: a snapshot of a
// running job can restore into a terminal that no longer answers.
async function autosave() {
  if (!dirty || !booted || !settings.get("autosave") || saving) return;
  if ((await link.idle()) === false) { scheduleAutosave(); return; }
  await saveMachine().catch((e) => console.warn("autosave", e));
}
function scheduleAutosave() {
  if (!settings.get("autosave")) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 20000);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) autosave(); });

async function wipeEverything() {
  clearTimeout(autosaveTimer);
  booted = false; // no more autosaves
  await store.wipe();
  settings.reset();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("b0tn3t.")) localStorage.removeItem(k); } catch { /* private mode */ }
}

// ------------------------------------------------------------ vm requests
const reload = (q = "") => setTimeout(() => location.replace(location.pathname + q), 300);

async function handleRequest(req) {
  const { verb, arg, body, signal } = req;
  switch (verb) {
    case "open": {
      let u;
      try { u = new URL(arg); } catch { throw new Error(`not a URL: ${arg}`); }
      if (!/^https?:$/.test(u.protocol)) throw new Error("only http and https links");
      return openTab(u.href) ? `opened ${u.href}\n` : "pop-up blocked: use the button in the page\n";
    }
    case "copy":
      await copyText(dec.decode(body));
      return "";
    case "paste": {
      const t = await readClipboard(signal);
      if (t == null) throw new Error("cancelled");
      return t;
    }
    case "up": {
      const files = await pickFiles(signal);
      if (!files || !files.length) throw new Error("cancelled");
      for (const f of files) await req.sendFile(f.name, f);
      return "";
    }
    case "dl":
      saveBlob(new Blob([body]), arg || "download.bin");
      return `downloading ${arg} (${body.length} bytes)\n`;
    case "get": {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      signal.addEventListener("abort", () => ctl.abort());
      try {
        const r = await fetch(arg, { signal: ctl.signal });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        throw new Error(`get ${arg}: ${e.name === "TypeError" ? "network error or blocked by CORS" : e.message}`);
      } finally { clearTimeout(t); }
    }
    case "save": {
      const said = (n) => `${arg ? "snapshot " + arg : "machine"} saved (${mb(n)})\n`;
      return said(await saveMachine(arg ? snapKey(arg) : MAIN, { id: req.id, text: said }));
    }
    case "load": {
      if (arg) {
        const s = await store.get(snapKey(arg));
        if (!s) throw new Error(`no snapshot ${arg}`);
        if (s.build !== manifest.build) throw new Error(`snapshot ${arg} is from an older version of the site`);
        await store.put(MAIN, s);
      } else if (!(await store.get(MAIN))) {
        throw new Error("nothing saved yet (vm save)");
      }
      booted = false;
      reload();
      return `loading ${arg || "the saved machine"}…\n`;
    }
    case "snaps": {
      const [op, name] = arg.split(/\s+/);
      if (op === "rm") {
        if (!(await store.get(snapKey(name)))) throw new Error(`no snapshot ${name}`);
        await store.del(snapKey(name));
        return `removed ${name}\n`;
      }
      const list = (await store.entries()).filter((e) => e.key.startsWith(SNAP));
      if (!list.length) return "no snapshots (vm save <name>)\n";
      return list.map((e) => `${e.key.slice(SNAP.length).padEnd(16)} ${new Date(e.created).toLocaleString()}  ${mb(e.size).padStart(9)}`).join("\n") + "\n";
    }
    case "reboot": // the guest synced before asking; this is the reset button
      // vm prints a dot every half second meanwhile, like `reboot` does
      setTimeout(() => power.boot().catch((e) => toast(`could not restart: ${e.message}`)), 1300);
      return "rebooting";
    case "reset":
      await wipeEverything();
      reload("?fresh");
      return "wiping everything and starting over…\n";
    case "info":
      return info();
    case "theme": {
      if (arg) { settings.set("theme", arg); return ""; }
      const cur = settings.get("theme");
      const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
      return Object.entries(THEMES).map(([k, t]) =>
        `${k === cur ? "*" : " "} ${k.padEnd(10)} \x1b[48;2;${rgb(t.background)}m\x1b[38;2;${rgb(t.foreground)}m user@b0tn3t:~$ \x1b[0m`).join("\n") + "\n";
    }
    case "font": {
      if (/^\d+$/.test(arg)) { settings.set("fontSize", +arg); return ""; }
      if (arg === "+" || arg === "-") { settings.set("fontSize", settings.get("fontSize") + (arg === "+" ? 1 : -1)); return ""; }
      if (arg) { settings.set("font", arg); await setFont(arg); return ""; }
      const cur = settings.get("font");
      return Object.entries(FONTS).map(([k, f]) => `${k === cur ? "*" : " "} ${k.padEnd(16)} \x1b[90m${f || "your system monospace"}\x1b[0m`).join("\n") +
        `\n\nsize ${settings.get("fontSize")}  (vm font 16, vm font +, Ctrl+= / Ctrl+-)\n`;
    }
    default:
      throw new Error(`the page does not know "${verb}"`);
  }
}

async function info() {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const entries = await store.entries().catch(() => []);
  const main = entries.find((e) => e.key === MAIN);
  const used = entries.reduce((n, e) => n + e.size, 0);
  return [
    `browser   ${detectBrowser().replace("_", " ")}${touch ? " (touch)" : ""}`,
    `terminal  ${term.cols}x${term.rows}, ${webgl ? "webgl" : "dom"} renderer, theme ${settings.get("theme")}, font ${settings.get("font")} ${settings.get("fontSize")}px`,
    `timezone  ${browserZone()}`,
    `machine   ${memMB} MB RAM, image ${manifest.build}`,
    `saved     ${main ? new Date(main.created).toLocaleString() + ", " + mb(main.size) : "not yet (vm save, or it saves itself)"}`,
    `storage   ${mb(used)} of ${mb(LIMIT)} used by saves, ${entries.length - (main ? 1 : 0)} snapshots${persisted ? ", persistent" : ""}`,
    est ? `browser quota ${mb(est.usage || 0)} / ${mb(est.quota || 0)}` : "",
  ].filter(Boolean).join("\n") + "\n";
}

// ------------------------------------------------------------ keyboard
const sticky = new Sticky();
term.onData((d) => {
  const mods = sticky.active();
  if (mods.ctrl || mods.alt) { d = applyMods(d, mods); sticky.used(); paintMods(); }
  sendInput(d);
});
term.onBinary((d) => sendInput(d));

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== "keydown") return true;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyC") && term.hasSelection()) {
    copyText(term.getSelection());
    e.preventDefault();
    return false;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyV") return false; // the browser's paste event delivers it
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (k === "=" || k === "+" || k === "-" || k === "0")) {
    e.preventDefault();
    const size = k === "0" ? settings.defaults.fontSize : settings.get("fontSize") + (k === "-" ? -1 : 1);
    try { settings.set("fontSize", Math.max(8, Math.min(40, size))); } catch { /* bounds */ }
    return false;
  }
  return true;
});

term.onSelectionChange(() => {
  if (settings.get("copyOnSelect") && term.hasSelection()) copyText(term.getSelection());
});

// OSC 52: programs in the machine (vim, tmux, printf) can set the clipboard
term.parser.registerOscHandler(52, (data) => {
  const b64 = data.slice(data.indexOf(";") + 1);
  if (b64 && b64 !== "?") {
    try { copyText(dec.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))); } catch { /* bad base64 */ }
  }
  return true;
});

term.onTitleChange((t) => { document.title = t || "b0tn3t.sh"; });
term.onBell(() => {
  if (navigator.vibrate) navigator.vibrate(30);
  const el = $("#term");
  el.classList.remove("bell");
  void el.offsetWidth;
  el.classList.add("bell");
});

// ------------------------------------------------------------ touch key bar
const keyButtons = {};
function paintMods() {
  for (const m of ["ctrl", "alt"]) {
    const b = keyButtons[m.toUpperCase()];
    if (!b) continue;
    b.classList.toggle("on", sticky.state[m] === 1);
    b.classList.toggle("lock", sticky.state[m] === 2);
  }
}

function pressKey(name) {
  if (name === "CTRL" || name === "ALT") { sticky.tap(name.toLowerCase()); paintMods(); return; }
  if (name === "MORE") { $("#more").classList.toggle("open"); keyButtons.MORE.classList.toggle("on"); layout(); return; }
  if (name === "KBD") {
    const ta = term.textarea;
    if (document.activeElement === ta) ta.blur(); else term.focus();
    return;
  }
  if (name === "PASTE") { readClipboard(null).then((t) => t && term.paste(t)); return; }
  const mods = sticky.active();
  const seq = keySeq(name, mods, term.modes.applicationCursorKeysMode);
  const out = seq != null ? seq : applyMods(name, mods);
  sticky.used();
  paintMods();
  sendInput(out);
}

function buildKeys() {
  const mk = (rows, parent) => {
    for (const row of rows) {
      const r = document.createElement("div");
      r.className = "row";
      for (const name of row) {
        const b = document.createElement("button");
        b.type = "button";
        b.tabIndex = -1;
        b.textContent = LABELS[name] || name;
        b.dataset.key = name;
        b.setAttribute("aria-label", name.toLowerCase());
        keyButtons[name] = b;
        let rep = 0;
        const stop = () => { clearTimeout(rep); clearInterval(rep); b.classList.remove("down"); };
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          b.classList.add("down");
          pressKey(name);
          if (REPEAT.has(name)) rep = setTimeout(() => { rep = setInterval(() => pressKey(name), 55); }, 380);
        });
        for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, stop);
        b.addEventListener("contextmenu", (e) => e.preventDefault());
        r.append(b);
      }
      parent.append(r);
    }
  };
  mk(MORE, $("#more"));
  mk(BAR, $("#bar"));
}

function showKeys() {
  const mode = settings.get("keys");
  document.body.classList.toggle("keys", mode === "on" || (mode === "auto" && touch));
  layout();
}

// pinch to zoom the font
let pinch = null;
$("#term").addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), size: term.options.fontSize };
  }
}, { passive: true });
$("#term").addEventListener("touchmove", (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const size = Math.round(pinch.size * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d);
  term.options.fontSize = Math.max(8, Math.min(40, size));
  layout();
}, { passive: false });
$("#term").addEventListener("touchend", () => {
  if (pinch) { settings.set("fontSize", term.options.fontSize); pinch = null; }
});

// ------------------------------------------------------------ drag & drop
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  $("#drop").classList.add("open");
});
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").classList.remove("open"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop").classList.remove("open");
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  await ready.promise;
  for (const f of files) await link.dropFile(f.name, f);
  dirty = true;
  scheduleAutosave();
});

// ------------------------------------------------------------ public API (tests, console)
window.vm = {
  ready: ready.promise,
  timings,
  settings,
  term,
  emulator: null,
  link: null,
  exec: async (cmd) => { await ready.promise; return link.exec(cmd); },
  save: (name) => saveMachine(name ? snapKey(name) : MAIN),
  // the terminal text, with soft-wrapped lines joined back together
  screen: () => {
    const b = term.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      const s = line.translateToString(!line.isWrapped && !(b.getLine(i + 1) || {}).isWrapped);
      if (line.isWrapped && out.length) out[out.length - 1] += s; else out.push(s);
    }
    return out.map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\s+$/, "");
  },
};

buildKeys();
showKeys();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
$("#term").addEventListener("click", () => term.focus());
boot().catch((e) => {
  console.error(e);
  term.write(`\r\n\x1b[31mcould not start the machine: ${e.message}\x1b[0m\r\n`);
});
