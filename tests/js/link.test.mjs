// VmLink against a fake vmd that speaks the frames from src/proto.h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VmLink } from "../../web/js/link.js";
import { MessageParser, message, concat, frame, T, BROWSER_ID, text, splitRequest } from "../../web/js/proto.js";

function setup(onRequest) {
  const fromPage = [];
  let link;
  const guest = new MessageParser((m) => fromPage.push(m));
  link = new VmLink({ send: (b) => guest.push(b), onRequest, onNotice: (t) => notices.push(t), onStart: () => starts++ });
  const notices = [];
  let starts = 0;
  const toPage = (frames) => link.feed(concat(frames));
  return { link, fromPage, toPage, notices, get starts() { return starts; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("hello sends key=value lines and resolves on READY with the same id", async () => {
  const s = setup();
  const p = s.link.hello({ time: 5, tz: "<+05>-5", empty: "", skip: null });
  await tick();
  const m = s.fromPage[0];
  assert.equal(m.type, T.HELLO);
  assert.ok(m.id & BROWSER_ID);
  assert.equal(text(m.header), "time=5\ntz=<+05>-5\n");
  s.toPage(message(T.READY, m.id, "1.0\n"));
  assert.equal(await p, "1.0");
});

test("READY with id 0 means vmd restarted", async () => {
  const s = setup();
  s.toPage(message(T.READY, 0, "1.0\n"));
  await tick();
  assert.equal(s.starts, 1);
  assert.equal(s.link.version, "1.0");
});

test("exec returns exit code and output", async () => {
  const s = setup();
  const p = s.link.exec("echo hi");
  await tick();
  const m = s.fromPage[0];
  assert.equal(text(m.header), "echo hi");
  s.toPage(message(T.RESULT, m.id, "3", "hi\n"));
  assert.deepEqual({ ...(await p), bytes: undefined }, { code: 3, out: "hi\n", bytes: undefined });
});

test("calls time out instead of hanging", async () => {
  const s = setup();
  await assert.rejects(s.link.call(T.PING, "", { timeout: 20 }), /no answer/);
  assert.equal(await s.link.ping(20), false);
});

test("requests are answered with status and body", async () => {
  const s = setup(async (r) => {
    if (r.verb === "paste") return "clip";
    if (r.verb === "copy") { assert.equal(text(r.body), "hello"); return ""; }
    throw new Error("nope");
  });
  s.toPage([...message(T.REQUEST, 7, "paste\0"), ...message(T.REQUEST, 8, "copy\0", "hello"), ...message(T.REQUEST, 9, "bogus\0")]);
  await tick(); await tick();
  const byId = Object.fromEntries(s.fromPage.map((m) => [m.id, m]));
  assert.equal(text(byId[7].header), "0");
  assert.equal(text(byId[7].body), "clip");
  assert.equal(text(byId[8].header), "0");
  assert.equal(text(byId[9].header), "1");
  assert.equal(text(byId[9].body), "nope\n");
});

test("upload sends FILE messages on the request id, then the reply", async () => {
  const s = setup(async (r) => {
    await r.sendFile("a.txt", "AAA");
    await r.sendFile("b.bin", new Blob([new Uint8Array(10000).fill(2)]));
    return "";
  });
  s.toPage(message(T.REQUEST, 11, "up\0"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.fromPage.map((m) => [m.type, m.id, text(m.header), m.body.length]),
    [["O", 11, "a.txt", 3], ["O", 11, "b.bin", 10000], ["Y", 11, "0", 0]]);
});

test("a cancelled request (second END) gets no reply and its signal aborts", async () => {
  let aborted = false, release;
  const s = setup((r) => new Promise((res) => { r.signal.addEventListener("abort", () => { aborted = true; }); release = res; }));
  s.toPage(message(T.REQUEST, 12, "paste\0"));
  await tick();
  s.toPage([frame(T.END, 12)]);
  await tick();
  assert.equal(aborted, true);
  release("late");
  await tick();
  assert.equal(s.fromPage.length, 0);
});

test("notices and drops", async () => {
  const s = setup();
  s.toPage(message(T.NOTICE, BROWSER_ID - 1, "saved /root/x (3 bytes)"));
  await tick();
  assert.deepEqual(s.notices, ["saved /root/x (3 bytes)"]);
  await s.link.dropFile("x", "abc");
  const m = s.fromPage[0];
  assert.equal(m.type, T.FILE);
  assert.ok(m.id & BROWSER_ID);
  assert.deepEqual(splitRequest(m.header), { verb: "x", arg: "" });
});

test("feed never handles a message inside the caller's stack", async () => {
  let handled = false;
  const s = setup(async () => { handled = true; return ""; });
  s.toPage(message(T.REQUEST, 20, "save\0"));
  assert.equal(handled, false, "still inside v86's virtio handler here");
  await tick();
  assert.equal(handled, true);
});

test("replyTo answers a request id directly", () => {
  const s = setup();
  s.link.replyTo(33, true, "machine saved (2.4 MB)\n");
  assert.equal(s.fromPage[0].id, 33);
  assert.equal(text(s.fromPage[0].header), "0");
  assert.equal(text(s.fromPage[0].body), "machine saved (2.4 MB)\n");
});

test("idle() reads the shell state from PONG", async () => {
  const s = setup();
  for (const [h, want] of [["idle=1", true], ["idle=0", false], ["", null]]) {
    const p = s.link.idle(1000);
    await tick();
    const m = s.fromPage.at(-1);
    s.toPage(message(T.PONG, m.id, h));
    assert.equal(await p, want, h);
  }
});
