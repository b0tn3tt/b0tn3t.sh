import { test } from "node:test";
import assert from "node:assert/strict";
import { Pump, PAGE, rxQueueIndex } from "../../web/js/pump.js";

function fakeGuest(buffers) {
  const got = [];
  let free = buffers;
  const retries = [];
  const pump = new Pump({
    canSend: () => free > 0,
    deliver: (c) => { free--; got.push(c.slice()); },
    schedule: (fn) => retries.push(fn),
  });
  return {
    pump, got, retries,
    refill(n) { free += n; const r = retries.splice(0); r.forEach((f) => f()); },
  };
}

test("rx queue index per port matches v86 (port 0 -> 0, port n -> 2n+2)", () => {
  assert.equal(rxQueueIndex(0), 0);
  assert.equal(rxQueueIndex(1), 4);
  assert.equal(rxQueueIndex(3), 8);
});

test("never sends more than one page per guest buffer", () => {
  const g = fakeGuest(100);
  g.pump.write(new Uint8Array(PAGE * 2 + 5).fill(1));
  assert.deepEqual(g.got.map((c) => c.length), [PAGE, PAGE, 5]);
});

test("waits when the guest has no buffer, and loses nothing", () => {
  const g = fakeGuest(1);
  const data = Uint8Array.from({ length: PAGE * 3 }, (_, i) => i & 255);
  g.pump.write(data);
  assert.equal(g.got.length, 1);
  assert.equal(g.retries.length, 1, "one retry scheduled, not a busy loop");
  g.refill(1);
  g.refill(5);
  const all = new Uint8Array(g.got.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of g.got) { all.set(c, o); o += c.length; }
  assert.deepEqual(all, data);
});

test("order is preserved across writes", () => {
  const g = fakeGuest(0);
  g.pump.write(new Uint8Array([1, 2]));
  g.pump.write(new Uint8Array([3]));
  g.refill(10);
  assert.deepEqual(g.got.map((c) => [...c]), [[1, 2], [3]]);
});

test("drained() gives backpressure", async () => {
  const g = fakeGuest(0);
  g.pump.write(new Uint8Array(PAGE * 4));
  let done = false;
  const p = g.pump.drained(PAGE).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  g.refill(3);
  await p;
  assert.equal(done, true);
  assert.equal(g.pump.queued, PAGE);
});
