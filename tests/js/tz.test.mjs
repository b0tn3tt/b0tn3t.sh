import { test } from "node:test";
import assert from "node:assert/strict";
import { posixTZ, offsetAt, abbr, posixOffset, transitions } from "../../web/js/tz.js";

test("fixed-offset zones", () => {
  assert.equal(posixTZ("Asia/Almaty", 2026), "<+05>-5");
  assert.equal(posixTZ("Asia/Kolkata", 2026), "<+0530>-5:30");
  assert.equal(posixTZ("UTC", 2026), "<+00>0");
  assert.equal(posixTZ("America/Sao_Paulo", 2026), "<-03>3");
  assert.equal(posixTZ("Asia/Kathmandu", 2026), "<+0545>-5:45");
});

test("northern DST zones", () => {
  assert.equal(posixTZ("Europe/Berlin", 2026), "<+01>-1<+02>,M3.5.0,M10.5.0/3");
  assert.equal(posixTZ("Europe/London", 2026), "<+00>0<+01>,M3.5.0/1,M10.5.0");
  assert.equal(posixTZ("America/New_York", 2026), "<-05>5<-04>,M3.2.0,M11.1.0");
});

test("southern hemisphere DST starts late in the year", () => {
  assert.equal(posixTZ("Australia/Sydney", 2026), "<+10>-10<+11>,M10.1.0,M4.1.0/3");
});

test("non-hour DST shift spells out the DST offset", () => {
  // Lord Howe: +10:30 standard, +11 summer (30 minutes)
  assert.equal(posixTZ("Australia/Lord_Howe", 2026), "<+1030>-10:30<+11>-11,M10.1.0,M4.1.0");
});

test("helpers", () => {
  assert.equal(abbr(-210), "<-0330>");
  assert.equal(posixOffset(-210), "3:30");
  assert.equal(posixOffset(0), "0");
  assert.equal(offsetAt("Asia/Tokyo", Date.UTC(2026, 0, 1)), 540);
  assert.equal(transitions("Asia/Tokyo", 2026).length, 0);
  const t = transitions("Europe/Berlin", 2026);
  assert.equal(t.length, 2);
  assert.equal(new Date(t[0].at).toISOString(), "2026-03-29T01:00:00.000Z");
});
