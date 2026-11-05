import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKernel, Power, OFF_LINE } from "../../web/js/power.js";
import { NET_DEVICE, netDevice } from "../../web/js/net.js";

// a fake bzImage: boot protocol 2.15 header, 2 setup sectors, a payload
function fakeBzImage({ setup = 2, payload = 4096, protocol = 0x20f } = {}) {
  const size = (setup + 1) * 512 + payload;
  const buf = new ArrayBuffer(size + (4 - (size % 4)) % 4);
  const b8 = new Uint8Array(buf), b16 = new Uint16Array(buf), b32 = new Uint32Array(buf);
  b8[0x1f1] = setup;
  b16[0x1fe >> 1] = 0xaa55;
  b16[0x202 >> 1] = 0x6448; b16[0x204 >> 1] = 0x5372; // "HdrS"
  b16[0x206 >> 1] = protocol;
  b8[0x211] = 0x01 | 0x20 | 0x40;                      // LOADED_HIGH, QUIET, KEEP_SEGMENTS
  b32[0x238 >> 2] = 2047;
  for (let i = (setup + 1) * 512; i < size; i++) b8[i] = i & 0xff;
  return buf;
}

test("loadKernel places setup code, kernel and command line like v86 does", () => {
  const mem8 = new Uint8Array(4 << 20);
  const bz = fakeBzImage();
  const rom = loadKernel(mem8, bz, "console=ttyS0 quiet");
  const b8 = new Uint8Array(bz);
  // protected-mode kernel at 1 MB
  assert.deepEqual(mem8.subarray(0x100000, 0x100000 + 4096), b8.subarray(3 * 512));
  // setup code (with the patched header) at 0x80000
  assert.deepEqual(mem8.subarray(0x80000, 0x80000 + 3 * 512), b8.subarray(0, 3 * 512));
  const hdr = new DataView(mem8.buffer, 0x80000);
  assert.equal(hdr.getUint8(0x210), 0xff, "type_of_loader");
  assert.equal(hdr.getUint8(0x211), 0x01 | 0x80, "loaded high + can use heap, not quiet, no keep segments");
  assert.equal(hdr.getUint16(0x224, true), 0xe000 - 0x200, "heap_end_ptr");
  const clPtr = hdr.getUint32(0x228, true);
  assert.equal(clPtr, 0x80000 + 0xe000);
  assert.equal(new TextDecoder().decode(mem8.subarray(clPtr, clPtr + 19)), "console=ttyS0 quiet");
  assert.equal(mem8[clPtr + 19], 0);
  // the option ROM: signature, one 512-byte block, a valid checksum, a far jump into setup
  assert.equal(rom.name, "genroms/kernel.bin");
  assert.equal(rom.data.length, 512);
  assert.deepEqual([rom.data[0], rom.data[1], rom.data[2]], [0x55, 0xaa, 1]);
  assert.equal(rom.data.reduce((a, b) => a + b, 0) & 0xff, 0);
  const jmp = rom.data.indexOf(0xea);
  assert.deepEqual([...rom.data.subarray(jmp, jmp + 5)], [0xea, 0, 0, 0x20, 0x80]);
});

test("loadKernel refuses what is not a usable bzImage", () => {
  const mem8 = new Uint8Array(4 << 20);
  assert.throws(() => loadKernel(mem8, new ArrayBuffer(4096), ""), /not a bzImage/);
  assert.throws(() => loadKernel(mem8, fakeBzImage({ protocol: 0x201 }), ""), /too old/);
  assert.throws(() => loadKernel(mem8, fakeBzImage(), "x".repeat(3000)), /too long/);
});

function fakeEmulator() {
  const listeners = {};
  const cpu = {
    mem8: new Uint8Array(4 << 20), option_roms: [], resets: 0, cleared: 0,
    reboot_internal() { this.resets++; },
    jit_clear_cache() { this.cleared++; },
  };
  return {
    v86: { cpu }, cpu, running: true, log: [],
    add_listener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    emit(ev, x) { for (const fn of listeners[ev] || []) fn(x); },
    async stop() { this.running = false; this.log.push("stop"); },
    async run() { this.running = true; this.log.push("run"); },
  };
}
const serial = (e, text) => { for (const c of text) e.emit("serial0-output-byte", c.charCodeAt(0)); };

test("a guest reboot puts the kernel back before the BIOS runs", async () => {
  const e = fakeEmulator();
  let fetched = 0, reboots = 0;
  const p = new Power(e, { kernel: async () => { fetched++; return fakeBzImage(); }, cmdline: "a=b", onReboot: () => reboots++ });
  // first reboot: the image is not cached yet, so stop, fetch, reset, load, run
  e.cpu.reboot_internal();
  await p.pending;
  assert.equal(fetched, 1);
  assert.equal(e.cpu.resets, 2, "reset by the guest, then again once the kernel is there");
  assert.deepEqual(e.log, ["stop", "run"]);
  assert.equal(e.cpu.option_roms.length, 1);
  assert.equal(e.cpu.cleared, 1, "JIT cache cleared after rewriting memory");
  // second reboot: synchronous, no fetch, no stop
  e.log.length = 0;
  e.cpu.reboot_internal();
  assert.equal(fetched, 1);
  assert.deepEqual(e.log, []);
  assert.equal(e.cpu.option_roms.length, 1, "one kernel ROM, not one per reboot");
  assert.equal(reboots, 2);
});

test("poweroff and halt are read from the kernel console, then boot() starts again", async () => {
  const e = fakeEmulator();
  const offs = [];
  const p = new Power(e, { kernel: () => fakeBzImage(), cmdline: "", onOff: (how) => offs.push(how) });
  serial(e, "[    1.0] something else\nreboot: Power down\n");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(offs, ["poweroff"]);
  assert.equal(e.running, false);
  serial(e, "reboot: Power down\n");
  assert.deepEqual(offs, ["poweroff"], "reported once");
  await p.boot();
  assert.equal(e.running, true);
  assert.equal(p.off, false);
  serial(e, "reboot: System halted\n");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(offs, ["poweroff", "halt"]);
  assert.match("reboot: Restarting system", /reboot/);
  assert.doesNotMatch("reboot: Restarting system", OFF_LINE);
});

test("the network card is virtio-net on v86's fetch adapter, same for page and harness", () => {
  assert.deepEqual(netDevice(), { type: "virtio", relay_url: "fetch", router_ip: "192.168.86.1", vm_ip: "192.168.86.100" });
  assert.notEqual(netDevice(), netDevice(), "a fresh object each time (v86 may modify it)");
  assert.throws(() => { NET_DEVICE.type = "ne2k"; });
});
