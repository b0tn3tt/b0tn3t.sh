import { test } from "node:test";
import assert from "node:assert/strict";
import { Quiet } from "../../web/js/quiet.js";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test("waits until there was no traffic for the calm period", async () => {
  const c = clock();
  const q = new Quiet({ now: c.now, sleep: c.sleep });
  q.touch();
  assert.equal(await q.wait(250, 5000), true);
  assert.ok(c.now() >= 250);
});

test("traffic keeps it from settling; times out with false", async () => {
  const c = clock();
  let n = 0;
  const q = new Quiet({ now: c.now, sleep: async (ms) => { c.advance(ms); if (n++ % 2 === 0) q.touch(); } });
  assert.equal(await q.wait(250, 1000), false);
});

test("busy() blocks even when the console is calm", async () => {
  const c = clock();
  let busy = true;
  const q = new Quiet({ now: c.now, sleep: async (ms) => { c.advance(ms); if (c.now() > 600) busy = false; }, busy: () => busy });
  assert.equal(await q.wait(100, 5000), true);
  assert.ok(c.now() > 600);
});
