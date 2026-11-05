import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findLinks, openLink, linkProvider } from "../../web/js/links.js";

const uris = (s) => findLinks(s).map((l) => l.uri);

test("finds https, mailto, tg and bare e-mail, without trailing punctuation", () => {
  assert.deepEqual(uris("GitHub:    https://github.com/b0tn3tt"), ["https://github.com/b0tn3tt"]);
  assert.deepEqual(uris("see (https://t.me/b0tn3t)."), ["https://t.me/b0tn3t"]);
  assert.deepEqual(uris("mail: mailto:me@example.org, or me@example.org."),
    ["mailto:me@example.org", "mailto:me@example.org"]);
  assert.deepEqual(uris("tg://resolve?domain=b0tn3t"), ["tg://resolve?domain=b0tn3t"]);
  assert.deepEqual(uris("http:// nothing root@b0tn3t: ~"), []);
  const [l] = findLinks("x https://a.b/c, y");
  assert.equal("x https://a.b/c, y".slice(l.start, l.end), "https://a.b/c");
});

test("every contact in content/contacts.txt is a link", () => {
  const text = readFileSync(new URL("../../content/contacts.txt", import.meta.url), "utf8");
  for (const line of text.split("\n").filter((l) => l.includes(":"))) {
    assert.equal(findLinks(line).length, 1, line);
  }
});

test("openLink: http(s) through openTab, other schemes through an <a> click", () => {
  const tabs = [], clicks = [];
  const doc = { createElement: () => ({ click() { clicks.push(this.href); } }) };
  openLink("https://x.y/", (u) => (tabs.push(u), true), doc);
  openLink("mailto:a@b.c", () => assert.fail("no tab for mailto"), doc);
  openLink("tg://resolve?domain=x", () => assert.fail(), doc);
  assert.deepEqual(tabs, ["https://x.y/"]);
  assert.deepEqual(clicks, ["mailto:a@b.c", "tg://resolve?domain=x"]);
});

test("linkProvider maps links on wrapped lines to cells", () => {
  const cols = 10;
  const rows = ["go https:/", "/a.bc/def ", "next"];
  const term = {
    cols,
    buffer: { active: { getLine: (i) => rows[i] == null ? undefined : {
      isWrapped: i === 1,
      translateToString: (trim) => trim ? rows[i].trimEnd() : rows[i].padEnd(cols),
    } } },
  };
  const opened = [];
  const p = linkProvider(term, (u) => opened.push(u));
  for (const y of [1, 2]) {
    p.provideLinks(y, (links) => {
      assert.equal(links.length, 1);
      assert.equal(links[0].text, "https://a.bc/def");
      assert.deepEqual(links[0].range, { start: { x: 4, y: 1 }, end: { x: 9, y: 2 } });
      links[0].activate();
    });
  }
  p.provideLinks(3, (links) => assert.equal(links, undefined));
  assert.deepEqual(opened, ["https://a.bc/def", "https://a.bc/def"]);
});
