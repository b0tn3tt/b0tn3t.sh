import { test } from "node:test";
import assert from "node:assert/strict";
import { splashFrame, CAT, TIPS } from "../../web/js/splash.js";

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const steps = [
  { label: "image manifest", state: "done", note: "build abc" },
  { label: "downloading the machine", state: "run", note: "3.0 MB / 6.0 MB" },
  { label: "restoring memory", state: "wait", note: "" },
];

test("a big screen shows the cat, the steps, the bar and a tip, centered", () => {
  const f = splashFrame({ cols: 100, rows: 40, steps, progress: 0.5, tick: 0 });
  const t = plain(f);
  assert.ok(t.includes(CAT[6].trim()), "cat");
  assert.match(t, /✓ image manifest {2}build abc/);
  assert.match(t, /⠋ downloading the machine {2}█+ +50% {2}3\.0 MB \/ 6\.0 MB/);
  assert.match(t, /· restoring memory/);
  assert.ok(t.includes(`tip: ${TIPS[0]}`));
  for (const l of t.split("\r\n")) assert.ok([...l].length <= 100, l);
  assert.ok(t.split("\r\n")[0] === "" && /^ +\S/.test(t.split("\r\n").find((l) => l)), "centered");
});

test("the cat fills in from the bottom with the download", () => {
  const lit = (fill) => (splashFrame({ cols: 100, rows: 40, steps, progress: fill, tick: 0 }).match(/\x1b\[97m/g) || []).length;
  assert.equal(lit(0), 0);
  assert.ok(lit(0.5) > 0 && lit(0.5) < lit(1));
});

test("a phone screen drops the cat and keeps lines short", () => {
  const t = plain(splashFrame({ cols: 36, rows: 20, steps, progress: 0.2, tick: 31 }));
  assert.ok(!t.includes(CAT[6].trim()));
  assert.ok(t.includes(`tip: ${TIPS[1]}`));
});
