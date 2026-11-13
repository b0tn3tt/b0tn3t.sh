import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// RFC 9116: Contact and Expires are required; Expires should be at most a
// year ahead. The reminder to bump it is .github/workflows/security-txt.yml,
// not this test: a deploy is never blocked by the date.
test("/.well-known/security.txt is valid", () => {
  const text = readFileSync(new URL("../../web/well-known/security.txt", import.meta.url), "utf8");
  const fields = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z-]+): (\S.*)$/);
    assert.ok(m, `bad line: ${line}`);
    (fields[m[1]] ??= []).push(m[2]);
  }
  assert.ok(fields.Contact?.every((c) => /^(https:|mailto:|tel:)/.test(c)), "Contact");
  assert.equal(fields.Expires?.length, 1, "one Expires");
  const exp = Date.parse(fields.Expires[0]);
  const day = 864e5;
  assert.ok(!Number.isNaN(exp), "Expires is a date");
  assert.ok(exp < Date.now() + 366 * day, "Expires is more than a year ahead");
  assert.deepEqual(fields.Canonical, ["https://b0tn3t.sh/.well-known/security.txt"]);
});
