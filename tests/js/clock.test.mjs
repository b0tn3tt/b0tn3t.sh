import { test } from "node:test";
import assert from "node:assert/strict";
import { now, atLeast } from "../../web/js/clock.js";

test("performance.now is the continuous clock once the module is loaded", () => {
  assert.equal(performance.now.b0tn3tClock, true);
  const a = performance.now(), b = now();
  assert.ok(Math.abs(a - b) < 50);
});

test("atLeast moves time forward to a saved tick, never back", () => {
  const before = now();
  atLeast(before + 60000);
  assert.ok(now() >= before + 60000, "jumped to the saved tick");
  const after = now();
  atLeast(1000);
  assert.ok(now() >= after, "an older tick does not rewind");
});

test("libv86 picks up the patched clock", async () => {
  // libv86 binds performance.now when evaluated: import it after clock.js
  const { V86 } = await import("../../vendor/libv86.mjs");
  assert.equal(typeof V86, "function");
  const t = now();
  atLeast(t + 5000);
  assert.ok(performance.now() >= t + 5000);
});
