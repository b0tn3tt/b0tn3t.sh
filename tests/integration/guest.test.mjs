// Integration: the built image in v86 under Node, driven through the
// page's own link code. IMAGE=<dir> (default dist/site/image).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
  // everything in the rootfs, compressed; fetched per file, only when used
  // (tcc's libc.a, htop, ncdu, ip are most of it)
  assert.ok(flat < 4 * MB, `rootfs files ${flat}`);
  assert.ok(size("fs.json") < 64 * KB);
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

  test("network: eth0 has 192.168.86.100, ip is the real iproute2", async () => {
    const br = (await g.link.exec("ip -br a")).out;
    assert.match(br, /^lo\s+UNKNOWN\s+127\.0\.0\.1\/8/m, br);
    assert.match(br, /^eth0\s+UP\s+192\.168\.86\.100\/24/m, br);
    assert.match((await g.link.exec("ip route")).out, /^default via 192\.168\.86\.1 dev eth0/m);
    assert.match((await g.link.exec("ip -V")).out, /iproute2-6\.19/);
    assert.match((await g.link.exec("ip -c -br link")).out, /\x1b\[/, "colors");
    assert.match((await g.link.exec("ip -j addr show eth0")).out, /"local":"192\.168\.86\.100"/);
    const ping = await g.link.exec("ping -c 1 -W 5 192.168.86.1");
    assert.equal(ping.code, 0, ping.out);
    assert.match((await g.link.exec("nslookup example.com")).out, /Address:\s*192\.168\.87\.1/);
  });

  test("http from the machine goes out as fetch(): wget, curl", async () => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.url === "/404") { res.writeHead(404); res.end("nope"); return; }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`${req.method} ${req.url} ${req.headers["x-test"] || "-"} ${body}\n`);
      });
    });
    await new Promise((r) => srv.listen(0, r));
    // v86's fetch adapter maps http://<port>.external/ to localhost:<port>
    const host = `${srv.address().port}.external`;
    try {
      assert.equal((await g.link.exec(`wget -qO- http://${host}/hello`)).out, "GET /hello - \n");
      assert.equal((await g.link.exec(`wget -qO- https://${host}/tls`)).out, "GET /tls - \n", "https goes as http");
      assert.equal((await g.link.exec(`curl -s https://${host}/c -H 'X-Test: 1'`)).out, "GET /c 1 \n");
      assert.equal((await g.link.exec(`curl -sSL -d 'a=1&b=2' ${host}/post`)).out, "POST /post - a=1&b=2\n");
      assert.equal((await g.link.exec(`cd /tmp && curl -sO http://${host}/file.txt && cat file.txt`)).out, "GET /file.txt - \n");
      assert.equal((await g.link.exec(`curl -so /tmp/o.txt http://${host}/o && cat /tmp/o.txt`)).out, "GET /o - \n");
      assert.match((await g.link.exec(`curl -I http://${host}/`)).out, /HTTP\/1\.[01] 200/);
      const e = await g.link.exec(`curl -s http://${host}/404`);
      assert.notEqual(e.code, 0);
      assert.match(e.out, /404 Not Found/);
      assert.doesNotMatch(e.out, /CORS/, "a real HTTP error is not blamed on CORS");
      // a fetch() the browser refuses (here: nothing listens on port 1)
      for (const cmd of ["curl -s http://1.external/x", "wget -q 1.external/x"]) {
        const r = await g.link.exec(cmd);
        assert.notEqual(r.code, 0, cmd);
        assert.match(r.out, /1\.external does not let web pages read it \(no CORS\)[\s\S]*curl ifconfig\.me\/ip/, cmd);
        if (cmd.startsWith("curl")) assert.doesNotMatch(r.out, /502 Fetch Error/, cmd);
      }
    } finally { srv.close(); }
  });

  test("C in the machine: tcc with musl, make, static binaries", async () => {
    const hello = `#include <stdio.h>\n#include <stdlib.h>\n#include <math.h>\nint main(int c, char **v) { printf("hello %d %.3f\\n", c > 1 ? atoi(v[1]) : 0, sqrt(2.0)); return 0; }\n`;
    await g.link.exec(`mkdir -p /tmp/c && printf '%s' '${hello.replace(/'/g, "'\\''")}' > /tmp/c/hello.c`);
    let r = await g.link.exec("cd /tmp/c && cc -o hello hello.c -lm && ./hello 3");
    assert.equal(r.out, "hello 3 1.414\n", r.out);
    r = await g.link.exec("cd /tmp/c && tcc -run hello.c 4");
    assert.equal(r.out, "hello 4 1.414\n", r.out);
    r = await g.link.exec("cd /tmp/c && printf 'all: hi\\nhi: hello.c\\n\\t$(CC) -o $@ hello.c -lm\\n' > Makefile && make && ./hi 5");
    assert.match(r.out, /hello 5 1\.414\n$/, r.out);
    // static: no program interpreter in the ELF header
    r = await g.link.exec("cd /tmp/c && head -c 4096 hello | grep -c ld-musl; true");
    assert.equal(r.out.trim(), "0");
  });

  test("htop and ncdu run, minimal static builds", async () => {
    assert.match((await g.link.exec("htop --version")).out, /htop 3\.5\.3/);
    assert.match((await g.link.exec("ncdu -v")).out, /ncdu 1\.22/);
    for (const [cmd, re] of [["htop", /Tasks/], ["ncdu /etc", /ncdu 1\.22/]]) {
      let from = g.screen.length;
      g.type(cmd + "\n");
      await g.waitFor(re, 30000, from);
      await new Promise((r) => setTimeout(r, 500));
      from = g.screen.length;
      g.type("q");
      await g.until(() => /root@b0tn3t:[^\n]*# $/.test(strip(g.screen.slice(from))), 15000, `prompt after ${cmd}`);
    }
    const sizes = (await g.link.exec("ls -l /usr/bin/htop /usr/bin/ncdu /sbin/ip /usr/bin/tcc | awk '{print $5}'")).out.split("\n").filter(Boolean).map(Number);
    for (const n of sizes) assert.ok(n < 600 * KB, `binary ${n}`);
  });

  test("the usual tools are there", async () => {
    const want = "ip ping nc nslookup netstat wget curl unzip bzip2 bunzip2 xz unxz cpio tar gzip ar cc tcc make htop ncdu reboot poweroff halt vi less top";
    const r = await g.link.exec(`for c in ${want}; do command -v $c >/dev/null || echo missing $c; done`);
    assert.equal(r.out, "");
    const z = await g.link.exec("cd /tmp && echo zipped > z.txt && tar -cf - z.txt | bzip2 | bunzip2 | tar -tf - && echo hi | xz -dc 2>/dev/null; echo ok");
    assert.match(z.out, /z\.txt\nok/);
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

test("reboot boots the kernel again and keeps the files; poweroff stops, boot() starts", async () => {
  const g = await startGuest({ image: IMAGE, state: path.join(IMAGE, "state.bin.zst"), onRequest });
  try {
    await g.link.hello({ time: Date.now() }, { timeout: 20000 });
    await g.link.exec("echo survives > /root/reboot.txt && sync");
    for (const [how, cmd] of [["reboot", "reboot"], ["poweroff", "poweroff"]]) {
      const starts = g.starts, from = g.screen.length;
      const t = Date.now();
      g.type(cmd + "\n");
      if (how === "poweroff") {
        await g.until(() => g.off, 60000, "power off");
        // no power driver: Linux turns poweroff into halt itself
        assert.match(g.off, /^(poweroff|halt)$/);
        assert.match(g.serial, /reboot: (Power down|System halted)/);
        g.off = null;
        await g.power.boot();
      }
      await g.until(() => g.starts > starts, 120000, `vmd READY after ${how}`);
      await g.link.hello({ time: Date.now() }, { timeout: 20000 });
      await g.until(() => /root@b0tn3t:~# $/.test(strip(g.screen.slice(from))), 60000, `prompt after ${how}`);
      console.log(`# ${how} to prompt: ${Date.now() - t} ms`);
      assert.equal((await g.link.exec("cat /root/reboot.txt")).out, "survives\n", `files kept over ${how}`);
      assert.match((await g.link.exec("ip -br a show eth0")).out, /192\.168\.86\.100/);
    }
    assert.ok(g.reboots >= 2);
    assert.doesNotMatch(g.serial, /panic|Oops|BUG:/);
  } finally { await g.stop(); }
});
