// The experimental in-kernel vmd: same image, kernel with the driver
// built in (KVMD=<bzImage-kvmd>, default dist/bzImage-kvmd). Same frames,
// same `vm` command (it opens /dev/vmd), same page code on our side.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { startGuest } from "../../tools/guest.mjs";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const IMAGE = path.resolve(process.env.IMAGE || path.join(root, "dist/site/image"));
const KVMD = path.resolve(process.env.KVMD || path.join(root, "dist/bzImage-kvmd"));
const strip = (s) => s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

const calls = [];
async function onRequest(r) {
  calls.push([r.verb, r.arg, Buffer.from(r.body).toString()]);
  if (r.verb === "paste") return "from the browser";
  if (r.verb === "up") { await r.sendFile("k.txt", "kernel upload\n"); return ""; }
  if (r.verb === "load") throw new Error("no snapshot x");
  return r.verb === "open" ? `opened ${r.arg}\n` : "";
}

describe("vmd in the kernel", { skip: !fs.existsSync(KVMD) && "build dist/bzImage-kvmd first" }, () => {
  let g;
  before(async () => {
    g = await startGuest({ image: IMAGE, kernel: KVMD, onRequest });
    await g.waitFor(/root@b0tn3t[^\n]*# $/, 120000);
    await g.until(() => g.starts > 0, 30000, "READY(0) from the kernel");
  });
  after(async () => { if (g) await g.stop(); });

  test("the driver owns hvc1 and announces itself", async () => {
    assert.equal(g.link.version, "1.0-kernel");
    const v = await g.link.hello({ time: Date.now(), tz: "<+05>-5", zone: "Asia/Almaty", browser: "node_kvmd" });
    assert.equal(v, "1.0-kernel");
    const r = await g.link.exec("dmesg | grep vmd; ls -l /dev/vmd; date +%z; cat /run/vmd/env; pidof vmd >/dev/null && echo userspace-vmd-parked");
    assert.match(r.out, /vmd: attached to hvc1, \/dev\/vmd ready/);
    assert.match(r.out, /\+0500/, "clock and timezone set from the kernel");
    assert.match(r.out, /zone=Asia\/Almaty/);
    assert.match(r.out, /userspace-vmd-parked/, "the userspace vmd stepped aside");
    assert.equal(r.code, 0);
    assert.ok(Math.abs(+(await g.link.exec("date +%s")).out - Date.now() / 1000) < 30);
  });

  test("ping and exec exit codes", async () => {
    assert.equal(await g.link.ping(), true);
    const r = await g.link.exec("echo out; echo err >&2; exit 5");
    assert.equal(r.code, 5);
    assert.equal(r.out, "out\nerr\n");
  });

  test("vm through /dev/vmd: blog, copy, paste, up, errors", async () => {
    calls.length = 0;
    assert.match(strip(await g.run("blog")), /opened https:\/\/blog\.b0tn3t\.sh/);
    await g.run("echo -n hi | vm copy");
    assert.match(strip(await g.run("vm paste")), /from the browser/);
    assert.match(strip(await g.run("mkdir -p /tmp/k && vm up /tmp/k && cat /tmp/k/k.txt")), /kernel upload/);
    assert.match(strip(await g.run("vm load x; echo rc=$?")), /no snapshot x[\s\S]*rc=1/);
    assert.deepEqual(calls.map((c) => c[0]), ["open", "copy", "paste", "up", "load"]);
    assert.equal(calls[1][2], "hi");
  });

  test("a dropped file lands in /root", async () => {
    const n = g.notices.length;
    await g.link.dropFile("from-kernel.txt", "dropped\n");
    await g.until(() => g.notices.length > n, 10000, "notice");
    assert.match(g.notices.at(-1), /saved \/root\/from-kernel\.txt \(8 bytes\)/);
    assert.equal((await g.link.exec("cat /root/from-kernel.txt")).out, "dropped\n");
  });
});
