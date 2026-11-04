// Integration: the built image in v86 under Node, driven through the
// page's own link code. IMAGE=<dir> (default dist/site/image).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { startGuest } from "../../tools/guest.mjs";
import { posixTZ } from "../../web/js/tz.js";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const IMAGE = path.resolve(process.env.IMAGE || path.join(root, "dist/site/image"));
const content = (n) => fs.readFileSync(path.join(root, "content", n + ".txt"), "utf8");
const strip = (s) => s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const KB = 1024, MB = 1024 * 1024;

// what the page would do for each `vm` verb, recorded
const calls = [];
const saveHook = { guest: null, state: null, id: 0 };
const files = { "notes.txt": "hello from the browser\n", "photo.bin": new Uint8Array(300 * KB).map((_, i) => i * 7) };
async function onRequest(r) {
  calls.push({ verb: r.verb, arg: r.arg, body: Buffer.from(r.body) });
  switch (r.verb) {
    case "open": return `opened ${r.arg}\n`;
    case "paste": return "clipboard ✓ text";
    case "copy": case "dl": case "theme": case "font": return "";
    case "up": for (const [n, d] of Object.entries(files)) await r.sendFile(n, d); return "";
    case "get": if (r.arg.endsWith("/missing")) throw new Error("get: 404 Not Found"); return "fetched body\n";
    case "info": return "browser   node\n";
    case "save": {
      // like the page: snapshot the machine while `vm save` waits for us
      const st = await saveHook.guest.save({ inRequest: true });
      saveHook.state = st;
      saveHook.id = r.id;
      return "machine saved\n";
    }
    default: throw new Error(`no ${r.verb}`);
  }
}

test("image size budget", () => {
  const size = (f) => fs.statSync(path.join(IMAGE, f)).size;
  const flat = fs.readdirSync(path.join(IMAGE, "flat")).reduce((n, f) => n + fs.statSync(path.join(IMAGE, "flat", f)).size, 0);
  assert.ok(size("bzImage") < 1.2 * MB, `kernel ${size("bzImage")}`);
  assert.ok(size("state.bin.zst") < 3 * MB, `warm state ${size("state.bin.zst")}`);
  assert.ok(flat < 1 * MB, `rootfs files ${flat}`);
  assert.ok(size("fs.json") < 32 * KB);
  const m = JSON.parse(fs.readFileSync(path.join(IMAGE, "manifest.json")));
  assert.match(m.build, /^[0-9a-f]{12}$/);
  assert.equal(m.files["state.bin.zst"], size("state.bin.zst"));
});

test("cold boot from the kernel reaches a shell and vmd", async () => {
  const t = Date.now();
  const g = await startGuest({ image: IMAGE, onRequest });
  try {
    await g.waitFor(/root@b0tn3t[^\n]*# $/, 120000);
    await g.until(() => g.starts > 0, 30000, "vmd READY(0)");
    const boot = Date.now() - t;
    assert.ok(boot < 60000, `boot took ${boot} ms`);
    const screen = strip(g.screen);
    assert.ok(screen.includes(content("motd").trim().split("\n")[0]), "motd shown");
    assert.doesNotMatch(screen, /starting pid|BusyBox v|can't|not found|error/i, "no noise on the terminal");
    assert.doesNotMatch(g.serial, /panic|Oops|BUG:|segfault/i);
    console.log(`# cold boot to prompt: ${boot} ms`);
  } finally { await g.stop(); }
});

describe("warm machine (the state the page loads)", () => {
  let g;
  const zone = "Europe/Berlin";

  before(async () => {
    const t = Date.now();
    g = await startGuest({ image: IMAGE, state: path.join(IMAGE, "state.bin.zst"), onRequest });
    await g.link.hello({ time: Date.now(), tz: posixTZ(zone), zone, browser: "node_test", screen: "1920x1080",
      seed: "ab".repeat(32) }, { timeout: 20000 });
    console.log(`# warm restore to vmd hello: ${Date.now() - t} ms`);
    g.resize(120, 40);
    await new Promise((r) => setTimeout(r, 300));
  });
  after(async () => { await g.stop(); });

  test("screen.bin is the motd and a prompt", () => {
    const s = strip(fs.readFileSync(path.join(IMAGE, "screen.bin"), "utf8"));
    assert.ok(s.startsWith(content("motd").split("\n")[0]));
    assert.match(s, /root@b0tn3t:~# $/);
  });

  test("whois and contacts print the repo text exactly, from shell functions", async () => {
    for (const name of ["whois", "contacts", "help"]) {
      const out = strip(await g.run(name));
      assert.equal(out.slice(name.length + 1).replace(/root@b0tn3t:~# $/, ""), content(name), name);
      const r = await g.link.exec(`/usr/bin/${name}`);
      assert.equal(r.out, content(name));
    }
    assert.match(strip(await g.run("type whois")), /whois is a function/);
  });

  test("fetch and its aliases", async () => {
    const out = strip(await g.run("fetch"));
    assert.match(out, /OS\s+b0tn3t LFS 1\.0 i686/);
    assert.match(out, /Kernel\s+6\.6\./);
    assert.match(out, /Terminal\s+xterm\.js 120x40/);
    assert.match(out, /Browser\s+node test/);
    assert.match(out, /Timezone\s+Europe\/Berlin/);
    for (const alias of ["neofetch", "fastfetch", "screenfetch", "pfetch"]) {
      const r = await g.link.exec(`${alias} --plain`);
      assert.match(r.out, /b0tn3t LFS/, alias);
    }
    const size = await g.link.exec("ls -l /usr/bin/fetch | awk '{print $5}'");
    assert.ok(+size.out < 32 * KB, "fetch stays tiny: " + size.out);
  });

  test("python is MicroPython", async () => {
    assert.match(strip(await g.run("python -c 'print(sum(i*i for i in range(10)))'")), /\n285\n/);
    for (const p of ["python3", "micropython"]) assert.equal((await g.link.exec(`${p} -c 'import sys; print(sys.implementation.name)'`)).out, "micropython\n");
    assert.match(strip(await g.run("py -c 'import json; print(json.dumps([1]))'")), /\[1\]/);
  });

  test("terminal size follows the page (v86 swap compensated)", async () => {
    assert.match(strip(await g.run("stty size")), /\n40 120\n/);
    g.resize(90, 30);
    await new Promise((r) => setTimeout(r, 200));
    assert.match(strip(await g.run("stty size")), /\n30 90\n/);
    g.resize(120, 40);
  });

  test("clock and timezone come from the browser", async () => {
    const r = await g.link.exec("date +%s; date +%z; cat /run/vmd/env");
    const [secs, z] = r.out.split("\n");
    assert.ok(Math.abs(+secs - Date.now() / 1000) < 30, "clock set");
    const berlin = new Date().toLocaleString("en", { timeZone: zone, timeZoneName: "shortOffset" }).includes("GMT+2") ? "+0200" : "+0100";
    assert.equal(z, berlin);
    assert.match(r.out, /zone=Europe\/Berlin/);
  });

  test("exec reports exit codes and stderr", async () => {
    const r = await g.link.exec("echo out; echo err >&2; exit 7");
    assert.equal(r.code, 7);
    assert.equal(r.out, "out\nerr\n");
  });

  test("blog opens blog.b0tn3t.sh", async () => {
    calls.length = 0;
    const out = strip(await g.run("blog"));
    assert.deepEqual(calls.map((c) => [c.verb, c.arg]), [["open", "https://blog.b0tn3t.sh"]]);
    assert.match(out, /opened https:\/\/blog\.b0tn3t\.sh/);
    calls.length = 0;
    await g.run("vm open https://example.com/");
    assert.deepEqual(calls.map((c) => c.arg), ["https://example.com/"]);
  });

  test("copy, paste, dl, get, up through the browser", async () => {
    calls.length = 0;
    await g.run("echo -n 'to the clipboard' | vm copy");
    assert.equal(calls[0].body.toString(), "to the clipboard");
    assert.match(strip(await g.run("vm paste")), /clipboard ✓ text/);

    await g.run("head -c 50000 /bin/busybox > /tmp/blob && vm dl /tmp/blob");
    const dl = calls.find((c) => c.verb === "dl");
    assert.equal(dl.arg, "blob");
    assert.equal(dl.body.length, 50000);
    await g.run("mkdir -p /tmp/d/sub && echo x > /tmp/d/sub/f && vm dl /tmp/d");
    const tgz = calls.filter((c) => c.verb === "dl").pop();
    assert.equal(tgz.arg, "d.tar.gz");
    assert.equal(tgz.body[0], 0x1f);

    assert.match(strip(await g.run("vm get https://example.com/x -o /tmp/got && cat /tmp/got")), /fetched body/);
    const miss = strip(await g.run("vm get https://example.com/missing; echo rc=$?"));
    assert.match(miss, /404 Not Found[\s\S]*rc=1/);

    const up = strip(await g.run("mkdir -p /root/in && vm up /root/in && ls -l /root/in"));
    assert.match(up, /notes\.txt \(23 bytes\)/);
    const sum = await g.link.exec("cat /root/in/notes.txt; wc -c < /root/in/photo.bin");
    assert.equal(sum.out, `${files["notes.txt"]}${300 * KB}\n`);
  });

  test("vm errors exit non-zero with a message", async () => {
    const r = await g.link.exec("vm bogus; echo rc=$?; vm open; echo rc=$?; vm reset </dev/null; echo rc=$?");
    assert.match(r.out, /unknown command[\s\S]*rc=1[\s\S]*usage: vm open[\s\S]*rc=1[\s\S]*-y[\s\S]*rc=1/);
  });

  test("a file dropped on the page lands in the shell's directory", async () => {
    await g.run("mkdir -p /root/work && cd /root/work");
    const before = g.notices.length;
    await g.link.dropFile("dropped report.txt", "dropped!\n");
    await g.until(() => g.notices.length > before, 10000, "notice");
    assert.match(g.notices.at(-1), /saved \/root\/work\/dropped report\.txt \(9 bytes\)/);
    assert.equal((await g.link.exec("cat '/root/work/dropped report.txt'")).out, "dropped!\n");
    await g.run("cd");
  });

  test("unicode and a big paste survive the console", async () => {
    assert.match(strip(await g.run("echo 'привет 🐱 ✓'")), /\nпривет 🐱 ✓\n/);
    const line = "0123456789".repeat(9) + "\n";
    const big = line.repeat(300); // 27 KB, several 4 KiB guest buffers
    g.type("cat > /tmp/paste\n");
    await new Promise((r) => setTimeout(r, 200));
    g.type(big + "\x04");
    let n = "";
    for (let i = 0; i < 60 && n !== String(big.length); i++) {
      n = (await g.link.exec("wc -c < /tmp/paste")).out.trim();
      if (n !== String(big.length)) await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(n, String(big.length));
  });

  test("a snapshot taken during `vm save` restores to a live machine", async () => {
    saveHook.guest = g;
    await g.run("echo before > /root/during.txt");
    assert.match(strip(await g.run("vm save")), /machine saved/);
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "state-")), "s.bin");
    fs.writeFileSync(tmp, saveHook.state);
    fs.writeFileSync(tmp + ".tick", String(saveHook.state.tick));
    const g2 = await startGuest({ image: IMAGE, state: tmp, onRequest });
    try {
      await g2.link.hello({ time: Date.now(), keep: saveHook.id }, { timeout: 20000 });
      g2.link.replyTo(saveHook.id, true, "machine saved (resumed)\n");
      await g2.waitFor(/machine saved \(resumed\)\r?\n[^\n]*# $/, 15000);
      assert.equal((await g2.link.exec("cat /root/during.txt")).out, "before\n");
      assert.match(strip(await g2.run("echo alive")), /\nalive\n/);
    } finally { await g2.stop(); }
  });

  test("files written to the 9p root are part of the saved state", async () => {
    await g.link.exec("echo persistent > /root/keep.txt && sync");
    const state = await g.save();
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "state-")), "s.bin");
    fs.writeFileSync(tmp, state);
    fs.writeFileSync(tmp + ".tick", String(state.tick));
    const g3 = await startGuest({ image: IMAGE, state: tmp, onRequest });
    try {
      await g3.link.hello({ time: Date.now() }, { timeout: 20000 });
      assert.equal((await g3.link.exec("cat /root/keep.txt")).out, "persistent\n");
    } finally { await g3.stop(); }
  });
});
