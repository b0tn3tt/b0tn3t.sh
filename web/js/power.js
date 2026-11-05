// reboot, poweroff and halt for a machine that usually starts from a snapshot.
//
// v86 reboots by resetting the CPU and running the BIOS again, which then
// boots the kernel v86 loaded into memory at start. A machine restored from
// a saved state never had that (and a running kernel overwrites its own
// image anyway), so a reboot would end in "No bootable device". Power puts
// the bzImage back into memory on every reset, like a boot loader would.
// The 9p root lives in the page, not in the machine: files survive a reboot.
//
// Linux has no way to switch v86 off (no ACPI; without a power driver it
// turns poweroff into halt), so both end with the kernel's last words on
// the serial console; Power notices
// them, stops the emulator and lets the page offer to start it again.

const HIGH = 0x100000;       // where the protected-mode kernel goes
const REAL_SEG = 0x8000;     // real-mode setup code segment
const HEAP_END = 0xe000;     // setup heap end, command line right after

// Port of v86's src/kernel.js load_kernel (BSD-2-Clause, (c) the v86
// contributors), without initrd support: boot protocol 2.02+ bzImage only.
// Writes the kernel and command line into guest memory and returns the
// option ROM that jumps to it.
export function loadKernel(mem8, bzimage, cmdline) {
  const b8 = new Uint8Array(bzimage), b16 = new Uint16Array(bzimage), b32 = new Uint32Array(bzimage);
  if (b16[0x1fe >> 1] !== 0xaa55 || (b16[0x202 >> 1] | (b16[0x204 >> 1] << 16)) !== 0x53726448) {
    throw new Error("not a bzImage");
  }
  const protocol = b16[0x206 >> 1];
  if (protocol < 0x202 || !(b8[0x211] & 1)) throw new Error("bzImage boot protocol too old");
  const setupSects = b8[0x1f1] || 4;
  const cmdlineMax = protocol >= 0x206 ? b32[0x238 >> 2] : 255;
  const base = REAL_SEG << 4;

  b8[0x210] = 0xff;                                  // type_of_loader: unassigned
  b8[0x211] = (b8[0x211] & ~0x20 & ~0x40) | 0x80;    // not quiet, no KEEP_SEGMENTS, CAN_USE_HEAP
  b16[0x224 >> 1] = HEAP_END - 0x200;                // heap_end_ptr
  b16[0x1fa >> 1] = 0xffff;                          // vid_mode: normal
  b32[0x218 >> 2] = 0;                               // no ramdisk
  b32[0x21c >> 2] = 0;

  const cl = cmdline + "\0";
  if (cl.length >= cmdlineMax) throw new Error("kernel command line too long");
  const clPtr = base + HEAP_END;
  b32[0x228 >> 2] = clPtr;
  for (let i = 0; i < cl.length; i++) mem8[clPtr + i] = cl.charCodeAt(i);

  const pm = (setupSects + 1) * 512;
  mem8.set(new Uint8Array(bzimage, 0, pm), base);
  mem8.set(new Uint8Array(bzimage, pm), HIGH);
  return { name: "genroms/kernel.bin", data: bootRom() };
}

// 512-byte option ROM: cli; segments = REAL_SEG; sp = HEAP_END; jmp REAL_SEG+0x20:0
function bootRom() {
  const d = new Uint8Array(0x200);
  const code = [0xfa, 0xb8, REAL_SEG & 0xff, REAL_SEG >> 8, 0x8e, 0xc0, 0x8e, 0xd8, 0x8e, 0xe0, 0x8e, 0xe8,
    0x8e, 0xd0, 0xbc, HEAP_END & 0xff, HEAP_END >> 8, 0xea, 0, 0, (REAL_SEG + 0x20) & 0xff, (REAL_SEG + 0x20) >> 8];
  d[0] = 0x55; d[1] = 0xaa; d[2] = 1;
  d.set(code, 3);
  let sum = 0;
  for (const x of d) sum += x;
  d[3 + code.length] = -sum & 0xff;
  return d;
}

// the kernel's last line before it stops the CPU (kernel/reboot.c)
export const OFF_LINE = /reboot: (Power down|System halted)/;

export class Power {
  // kernel: () => ArrayBuffer | Promise<ArrayBuffer> (the bzImage)
  // onReboot(): the machine is starting again; onOff(how): it stopped
  constructor(emulator, { kernel, cmdline, onReboot = () => {}, onOff = () => {} }) {
    this.emulator = emulator;
    this.kernel = kernel;
    this.cmdline = cmdline;
    this.onReboot = onReboot;
    this.onOff = onOff;
    this.image = null;  // cached bzImage
    this.off = false;
    this.reboots = 0;   // resets so far (guest reboots and boot())
    this.line = "";
    const cpu = emulator.v86.cpu;
    const reset = cpu.reboot_internal.bind(cpu);
    this.reset = reset;
    cpu.reboot_internal = () => {
      reset();
      if (this.image) this.load();          // in the same tick: the BIOS never sees an empty machine
      else this.pending = this.fetchAndBoot();
      this.reboots++;
      this.onReboot();
    };
    emulator.add_listener("serial0-output-byte", (byte) => {
      if (byte === 10) {
        const m = this.line.match(OFF_LINE);
        this.line = "";
        if (m && !this.off) this.powerOff(m[1] === "Power down" ? "poweroff" : "halt");
      } else if (this.line.length < 200) this.line += String.fromCharCode(byte);
    });
  }

  load() {
    const cpu = this.emulator.v86.cpu;
    cpu.option_roms = [loadKernel(cpu.mem8, this.image.slice(0), this.cmdline)];
    cpu.jit_clear_cache();
  }

  async fetchAndBoot() {
    const e = this.emulator;
    await e.stop();
    this.image = await this.kernel();
    this.reset();
    this.load();
    await e.run();
  }

  async powerOff(how) {
    this.off = true;
    await this.emulator.stop();
    this.onOff(how);
  }

  // start a stopped (or running) machine from the kernel, files kept
  async boot() {
    const e = this.emulator;
    await e.stop();
    if (!this.image) this.image = await this.kernel();
    this.off = false;
    this.reset();
    this.load();
    this.reboots++;
    this.onReboot();
    await e.run();
  }
}
