import { test } from "node:test";
import assert from "node:assert/strict";
import { Settings, validate, THEMES, FONTS, defaults } from "../../web/js/settings.js";
import { checkQuota, snapKey, gzip, gunzip, LIMIT, mb } from "../../web/js/store.js";

class MemStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

test("defaults differ for touch screens", () => {
  assert.equal(defaults(false).fontSize, 15);
  assert.equal(defaults(true).fontSize, 13);
});

test("settings persist only what differs from defaults", () => {
  const st = new MemStorage();
  const s = new Settings(st);
  const seen = [];
  s.onChange((k, v) => seen.push([k, v]));
  s.set("theme", "amber");
  s.set("fontSize", "18");
  assert.deepEqual(JSON.parse(st.getItem("b0tn3t.settings")), { theme: "amber", fontSize: 18 });
  assert.deepEqual(seen, [["theme", "amber"], ["fontSize", 18]]);
  const again = new Settings(st);
  assert.equal(again.get("theme"), "amber");
  assert.equal(again.get("fontSize"), 18);
  again.reset();
  assert.equal(st.getItem("b0tn3t.settings"), null);
  assert.equal(again.get("theme"), "dark");
});

test("bad or stale stored values are dropped, not fatal", () => {
  const st = new MemStorage({ "b0tn3t.settings": JSON.stringify({ theme: "gone", fontSize: 999, cursor: "bar", nope: 1 }) });
  const s = new Settings(st);
  assert.equal(s.get("theme"), "dark");
  assert.equal(s.get("fontSize"), 15);
  assert.equal(s.get("cursor"), "bar");
  const broken = new Settings(new MemStorage({ "b0tn3t.settings": "{not json" }));
  assert.equal(broken.get("theme"), "dark");
});

test("validation", () => {
  assert.throws(() => validate("theme", "nope"), /one of/);
  assert.throws(() => validate("fontSize", 7), /8 to 40/);
  assert.throws(() => validate("fontSize", "12px"), /number/);
  assert.throws(() => validate("bogus", 1), /unknown/);
  assert.equal(validate("blink", "off"), false);
  assert.equal(validate("autosave", "on"), true);
  for (const t of Object.values(THEMES)) for (const k of ["background", "foreground", "red", "brightWhite"]) assert.match(t[k], /^#[0-9a-f]{6}$/i);
  assert.ok("system" in FONTS);
});

test("snapshot names", () => {
  assert.equal(snapKey("before-update.1"), "snap:before-update.1");
  for (const bad of ["", "a b", "../x", "x".repeat(33), "ж"]) assert.throws(() => snapKey(bad), /snapshot names/);
});

test("the 512 MB limit counts everything but the value being replaced", () => {
  const M = 1048576;
  assert.equal(LIMIT, 512 * M);
  const stored = [{ key: "save", size: 100 * M }, { key: "snap:a", size: 300 * M }];
  checkQuota(stored, "save", 200 * M);            // replaces the 100
  assert.throws(() => checkQuota(stored, "snap:b", 200 * M), /no room/);
  assert.throws(() => checkQuota([], "save", LIMIT + 1), /more than/);
  checkQuota([], "save", LIMIT);
  assert.equal(mb(1.5 * M), "1.5 MB");
});

test("gzip round trip of a machine-sized buffer", async () => {
  const data = new Uint8Array(3 << 20);
  for (let i = 0; i < data.length; i += 4096) data[i] = i & 255;
  const blob = await gzip(data);
  assert.ok(blob.size < data.length / 10, "zero pages compress");
  assert.deepEqual(await gunzip(blob), data);
});
