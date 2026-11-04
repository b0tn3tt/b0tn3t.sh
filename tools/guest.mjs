// Run the b0tn3t LFS guest under Node: used by the build-time warm-up
// (tools/warm.mjs) and by the integration tests. The browser link is the
// page's own web/js/link.js + pump.js.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { now as clockNow, atLeast } from "../web/js/clock.js"; // before libv86
import { VmLink } from "../web/js/link.js";
import { portPump, resizeArgs } from "../web/js/pump.js";
import { Quiet } from "../web/js/quiet.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));

// one source of truth for the kernel command line, shared with the page
export const CMDLINE = fs.readFileSync(path.join(here, "../kernel/cmdline"), "utf8").trim();

export const MEM = 128;
export const VGA = 2;

export async function startGuest({
  v86 = path.join(here, "../vendor"),
  image,                // dir with bzImage, fs.json, flat/ (and state.bin[.zst])
  state = null,         // path to a saved state, or null to boot the kernel
  mem = MEM,
  cmdline = CMDLINE,
  onRequest = null,
  serial = false,       // echo the kernel console (ttyS0) to stderr
  tick = null,          // clock tick the state was saved at (default: <state>.tick or manifest)
  kernel = null,        // another bzImage (the in-kernel vmd variant)
} = {}) {
  if (state) {
    if (tick == null && fs.existsSync(state + ".tick")) tick = +fs.readFileSync(state + ".tick", "utf8");
    if (tick == null && fs.existsSync(path.join(image, "manifest.json"))) tick = readJSON(path.join(image, "manifest.json")).tick;
    atLeast(tick || 0);
  }
  const { V86 } = await import(path.join(v86, "libv86.mjs"));
  const opts = {
    wasm_path: path.join(v86, "v86.wasm"),
    bios: { url: path.join(v86, "seabios.bin") },
    vga_bios: { url: path.join(v86, "vgabios.bin") },
    memory_size: mem << 20,
    vga_memory_size: VGA << 20,
    filesystem: { baseurl: path.join(image, "flat") + "/", basefs: path.join(image, "fs.json") },
    virtio_console: true,
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  };
  if (state) opts.initial_state = { url: state };
  else Object.assign(opts, { bzimage: { url: kernel || path.join(image, "bzImage") }, cmdline });

  const emulator = new V86(opts);
  const g = new Guest(emulator, { onRequest, serial });
  await new Promise((resolve) => emulator.add_listener("emulator-loaded", resolve));
  return g;
}

export class Guest {
  constructor(emulator, { onRequest, serial }) {
    this.emulator = emulator;
    this.screen = "";        // everything the terminal (hvc0) printed
    this.raw = [];
    this.serial = "";
    this.notices = [];
    this.starts = 0;
    const dec = new TextDecoder();
    this.quiet = new Quiet({ busy: () => this.term.queued > 0 || this.port.queued > 0 || this.link.active.size > this.allowActive });
    this.allowActive = 0;
    emulator.add_listener("virtio-console0-output-bytes", (b) => {
      this.quiet.touch();
      this.raw.push(new Uint8Array(b));
      this.screen += dec.decode(b, { stream: true });
      this.wake();
    });
    emulator.add_listener("serial0-output-byte", (b) => {
      this.serial += String.fromCharCode(b);
      if (serial) process.stderr.write(String.fromCharCode(b));
    });
    this.term = portPump(emulator, 0);
    const port = portPump(emulator, 1);
    this.port = port;
    this.link = new VmLink({
      send: (bytes) => port.write(bytes),
      drain: (n) => port.drained(n),
      onRequest,
      onNotice: (t) => { this.notices.push(t); this.wake(); },
      onStart: () => { this.starts++; this.wake(); },
    });
    emulator.add_listener("virtio-console1-output-bytes", (b) => { this.quiet.touch(); this.link.feed(new Uint8Array(b)); this.wake(); });
    this.waiters = new Set();
  }

  wake() { for (const w of this.waiters) w(); }

  // resolve when pred() is truthy, checked after every guest output
  until(pred, timeout = 60000, what = "condition") {
    return new Promise((resolve, reject) => {
      const check = () => {
        let v;
        try { v = pred(); } catch (e) { return done(reject, e); }
        if (v) done(resolve, v);
      };
      const done = (fn, v) => { clearTimeout(t); clearInterval(iv); this.waiters.delete(check); fn(v); };
      const t = setTimeout(() => done(reject, new Error(`timeout waiting for ${what}\n--- screen ---\n${this.screen.slice(-1500)}\n--- serial ---\n${this.serial.slice(-1500)}`)), timeout);
      const iv = setInterval(check, 200);
      this.waiters.add(check);
      check();
    });
  }

  // wait for `re` to appear in the terminal output after `from`
  waitFor(re, timeout, from = 0) {
    return this.until(() => re.test(this.screen.slice(from)), timeout, String(re));
  }

  type(s) { this.term.write(new TextEncoder().encode(s)); }

  resize(cols, rows) { this.emulator.bus.send("virtio-console0-resize", resizeArgs(cols, rows)); }

  // type a command and return what it printed before the next prompt
  async run(cmd, { prompt = /[#$] $/, timeout = 30000 } = {}) {
    const from = this.screen.length;
    this.type(cmd + "\n");
    await this.until(() => prompt.test(this.screen.slice(from + cmd.length)), timeout, `prompt after ${cmd}`);
    return this.screen.slice(from);
  }

  // like the page: snapshot only at a calm moment. `inRequest`: called
  // from a vm request handler (that one request may stay open).
  async save({ inRequest = false, calm = 250, timeout = 10000 } = {}) {
    this.allowActive = inRequest ? 1 : 0;
    if (!(await this.quiet.wait(calm, timeout))) throw new Error("the machine never went quiet");
    const tick = clockNow();
    const state = new Uint8Array(await this.emulator.save_state());
    state.tick = tick;
    return state;
  }

  async stop() {
    await this.emulator.destroy();
  }
}

export function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
