import { test } from "node:test";
import assert from "node:assert/strict";
import { frame, message, concat, FrameParser, MessageParser, splitRequest, T, HDR, CHUNK, MAX_FRAME, BROWSER_ID, text } from "../../web/js/proto.js";

test("frame layout matches src/proto.h (u8 type, u32le id, u32le len)", () => {
  const f = frame("Q", 7, "copy");
  assert.deepEqual([...f.subarray(0, HDR)], [0x51, 7, 0, 0, 0, 4, 0, 0, 0]);
  assert.equal(text(f.subarray(HDR)), "copy");
  const b = frame("P", BROWSER_ID | 5);
  assert.deepEqual([...b], [0x50, 5, 0, 0, 0x80, 0, 0, 0, 0]);
});

test("message chunks the body into CHUNK-sized DATA frames", () => {
  const body = new Uint8Array(CHUNK * 2 + 10).fill(7);
  const frames = message("Y", 3, "0", body);
  assert.equal(frames.length, 5);
  assert.equal(String.fromCharCode(frames[0][0]), "Y");
  assert.equal(frames[1].length, HDR + CHUNK);
  assert.equal(frames[3].length, HDR + 10);
  assert.equal(String.fromCharCode(frames[4][0]), "E");
  assert.ok(HDR + CHUNK <= 4096, "a frame fits one guest buffer");
});

test("parser handles any split of the stream", () => {
  const stream = concat([...message("Q", 9, "paste\0"), ...message("R", 0, "1.0\n"), ...message("Q", 10, "dl\0a.bin", new Uint8Array(9000).fill(1))]);
  for (const step of [1, 2, 9, 10, 4096, stream.length]) {
    const got = [];
    const p = new MessageParser((m) => got.push(m));
    for (let o = 0; o < stream.length; o += step) p.push(stream.subarray(o, o + step));
    assert.equal(got.length, 3, "step " + step);
    assert.deepEqual(splitRequest(got[0].header), { verb: "paste", arg: "" });
    assert.equal(got[1].type, "R");
    assert.equal(got[2].body.length, 9000);
    assert.deepEqual(splitRequest(got[2].header), { verb: "dl", arg: "a.bin" });
  }
});

test("interleaved messages are kept apart", () => {
  const got = [];
  const p = new MessageParser((m) => got.push(m));
  p.push(concat([frame("Q", 1, "a\0"), frame("Q", 2, "b\0"), frame(T.DATA, 2, "two"), frame(T.DATA, 1, "one"), frame(T.END, 2), frame(T.END, 1)]));
  assert.deepEqual(got.map((m) => [m.id, text(m.body)]), [[2, "two"], [1, "one"]]);
});

test("a second END means the guest gave up on that request", () => {
  const cancelled = [];
  const p = new MessageParser(() => {}, (id) => cancelled.push(id));
  p.push(concat(message("Q", 4, "up\0")));
  p.push(frame(T.END, 4));
  assert.deepEqual(cancelled, [4]);
});

test("corrupt length throws instead of buffering forever", () => {
  const p = new FrameParser(() => {});
  const bad = new Uint8Array(HDR);
  new DataView(bad.buffer).setUint32(5, MAX_FRAME + 1, true);
  assert.throws(() => p.push(bad), /corrupt/);
  assert.throws(() => frame("D", 1, new Uint8Array(MAX_FRAME + 1)), RangeError);
});

test("unicode survives", () => {
  const got = [];
  const p = new MessageParser((m) => got.push(m));
  for (const f of message("Y", 1, "0", "буфер 🐱")) p.push(f);
  assert.equal(text(got[0].body), "буфер 🐱");
});
