// Build-time warm-up: boot the guest once, pull everything a visitor is
// likely to run into the guest page cache, leave a clean screen with the
// motd and a prompt, and save that machine. The page restores this state,
// so the first `whois` or `contacts` never touches the network.
//
//   node tools/warm.mjs <image-dir> <out-dir>
// writes <out-dir>/state.bin and <out-dir>/screen.bin

import fs from "node:fs";
import path from "node:path";
import { startGuest, MEM } from "./guest.mjs";

const [image, out] = process.argv.slice(2);
const epoch = +(process.env.SOURCE_DATE_EPOCH || 0);
const t0 = Date.now();
const log = (m) => console.error(`warm: ${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

const WARM = [
  // the text commands, as functions and as files
  "whois; contacts; help; /usr/bin/whois; /usr/bin/contacts; /usr/bin/help",
  "fetch; neofetch --plain",
  "python -c 'import sys, os, json, re, math, time, random; print(sum(range(10)))'",
  "vm --help; vm info",
  // what tab completion and `ls` read
  "ls -la --color=always / /bin /sbin /usr/bin /etc /root",
  "cat /etc/motd /etc/profile /etc/shrc /etc/os-release /etc/passwd /etc/group",
  "less --help; vi --help; grep --help; awk 'BEGIN{}'; sed -n 1p /etc/motd; date; free; ps; top -bn1",
].join(" >/dev/null 2>&1; ") + " >/dev/null 2>&1; sync";

const g = await startGuest({ image, onRequest: async () => "" });
await g.waitFor(/# $/, 120000);
log("shell is up");
await g.until(() => g.link.version, 30000, "vmd");
await g.link.hello({ time: epoch * 1000, tz: "<+00>0", zone: "UTC", browser: "build" });
g.resize(80, 24);
log("vmd ready");

const r = await g.link.exec(WARM);
if (r.code !== 0) throw new Error("warm-up failed: " + r.out);
log("page cache warm");

// a clean screen: clear, motd, fresh prompt
const CLEAR = "\x1b[H\x1b[2J\x1b[3J";
await g.link.exec(`rm -f /root/.ash_history; printf '${CLEAR.replace(/\x1b/g, "\\033")}' > /dev/hvc0; cat /etc/motd > /dev/hvc0`);
const mark = g.screen.lastIndexOf(CLEAR);
g.type("\n");
await g.until(() => mark >= 0 && /# $/.test(g.screen.slice(mark + CLEAR.length)), 20000, "fresh prompt");
await new Promise((r) => setTimeout(r, 3000)); // let the guest settle into idle

const raw = Buffer.concat(g.raw.map((b) => Buffer.from(b)));
const at = raw.lastIndexOf(Buffer.from(CLEAR));
const screen = raw.subarray(at);
const state = await g.save();
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "state.bin"), state);
fs.writeFileSync(path.join(out, "screen.bin"), screen);
fs.writeFileSync(path.join(out, "mem"), String(MEM));
fs.writeFileSync(path.join(out, "tick"), String(Math.ceil(state.tick)));
log(`saved state ${(state.length / 1048576).toFixed(1)} MiB, screen ${screen.length} bytes`);
await g.stop();
process.exit(0);
