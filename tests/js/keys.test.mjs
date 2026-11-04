import { test } from "node:test";
import assert from "node:assert/strict";
import { keySeq, ctrlChar, applyMods, Sticky, latin, modParam, BAR, MORE, LABELS } from "../../web/js/keys.js";

test("arrows: normal, application cursor mode, with modifiers", () => {
  assert.equal(keySeq("UP"), "\x1b[A");
  assert.equal(keySeq("LEFT", {}, true), "\x1bOD");
  assert.equal(keySeq("RIGHT", { ctrl: true }), "\x1b[1;5C");
  assert.equal(keySeq("UP", { alt: true }, true), "\x1b[1;3A");
  assert.equal(keySeq("HOME"), "\x1b[H");
  assert.equal(keySeq("END", {}, true), "\x1bOF");
});

test("editing and function keys", () => {
  assert.equal(keySeq("PGUP"), "\x1b[5~");
  assert.equal(keySeq("PGDN", { ctrl: true }), "\x1b[6;5~");
  assert.equal(keySeq("DEL"), "\x1b[3~");
  assert.equal(keySeq("F1"), "\x1bOP");
  assert.equal(keySeq("F4", { shift: true }), "\x1b[1;2S");
  assert.equal(keySeq("F5"), "\x1b[15~");
  assert.equal(keySeq("F12"), "\x1b[24~");
  assert.equal(keySeq("ESC"), "\x1b");
  assert.equal(keySeq("TAB"), "\t");
  assert.equal(keySeq("TAB", { shift: true }), "\x1b[Z");
  assert.equal(keySeq("x"), null);
  assert.equal(modParam({ shift: true, alt: true, ctrl: true }), 8);
});

test("ctrl characters, including a Russian layout", () => {
  assert.equal(ctrlChar("c"), "\x03");
  assert.equal(ctrlChar("C"), "\x03");
  assert.equal(ctrlChar("с"), "\x03", "Cyrillic с is on the C key");
  assert.equal(ctrlChar("в"), "\x04", "в is on the D key: Ctrl+D");
  assert.equal(ctrlChar("я"), "\x1a");
  assert.equal(ctrlChar("["), "\x1b");
  assert.equal(ctrlChar(" "), "\x00");
  assert.equal(ctrlChar("?"), "\x7f");
  assert.equal(latin("Й"), "q");
});

test("sticky modifiers apply to the first character only", () => {
  assert.equal(applyMods("c", { ctrl: true }), "\x03");
  assert.equal(applyMods("ab", { alt: true }), "\x1bab");
  assert.equal(applyMods("x", { ctrl: true, alt: true }), "\x1b\x18");
  assert.equal(applyMods("\r", { alt: true }), "\x1b\r");
  assert.equal(applyMods("hi", {}), "hi");
});

test("tap = once, quick double tap = lock, third tap = off", () => {
  let now = 0;
  const s = new Sticky(() => now);
  assert.equal(s.tap("ctrl"), 1);
  assert.deepEqual(s.active(), { ctrl: true, alt: false });
  s.used();
  assert.equal(s.state.ctrl, 0, "one-shot clears after a key");
  s.tap("ctrl"); now += 200; assert.equal(s.tap("ctrl"), 2, "double tap locks");
  s.used();
  assert.equal(s.state.ctrl, 2, "lock survives keys");
  now += 1000; assert.equal(s.tap("ctrl"), 0);
  s.tap("alt"); now += 1000; assert.equal(s.tap("alt"), 0, "slow second tap turns off");
});

test("every key on the bars has a label or is a printable character", () => {
  for (const k of [...BAR.flat(), ...MORE.flat()]) {
    assert.ok(LABELS[k] || k.length === 1 || /^F\d+$/.test(k), k);
  }
});

test("emoji split across input events is joined before encoding", async () => {
  const { SurrogateJoiner } = await import("../../web/js/keys.js");
  const j = new SurrogateJoiner();
  const cat = "🐱";
  assert.equal(j.push("a" + cat[0]), "a");
  assert.equal(j.push(cat[1] + "b"), cat + "b");
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(j.push("x"))), "x");
  assert.equal(j.push(cat), cat);
});
