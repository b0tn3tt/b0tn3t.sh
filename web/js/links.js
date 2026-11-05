// Clickable links in the terminal: https://, mailto:, tg: and bare e-mail
// addresses. xterm's web-links addon only knows http(s) and rejects
// mailto:/tg: when it checks the URL, so the page uses this provider instead.

const TAIL = /[.,:;!?)\]}'"]+$/;
const LINK = /\b(?:https?:\/\/[^\s"'<>`{}|\\^]+|mailto:[^\s"'<>`]+|tg:\/\/[^\s"'<>`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;

// [{start, end, uri}] for every link in a string; end is exclusive
export function findLinks(text) {
  const out = [];
  for (const m of text.matchAll(LINK)) {
    const raw = m[0].replace(TAIL, "");
    if (!raw) continue;
    let uri = raw;
    if (!/^[a-z]+:/i.test(raw)) uri = `mailto:${raw}`;
    else if (/^https?:\/\/$/i.test(raw)) continue;
    out.push({ start: m.index, end: m.index + raw.length, uri });
  }
  return out;
}

// http(s) in a new tab; other schemes go to the app that owns them
export function openLink(uri, openTab, doc = document) {
  if (/^https?:/i.test(uri)) return openTab(uri);
  const a = doc.createElement("a");
  a.href = uri;
  a.rel = "noopener";
  a.click();
  return true;
}

// xterm ILinkProvider over a whole wrapped line (one-cell characters)
export function linkProvider(term, activate) {
  return {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      let first = y - 1;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      let last = first;
      while (buf.getLine(last + 1)?.isWrapped) last++;
      if (y - 1 < first || y - 1 > last) return callback(undefined);
      const cols = term.cols;
      let text = "";
      for (let i = first; i <= last; i++) text += buf.getLine(i).translateToString(i === last).padEnd(i === last ? 0 : cols);
      const at = (o) => ({ x: (o % cols) + 1, y: first + Math.floor(o / cols) + 1 });
      const links = findLinks(text)
        .map(({ start, end, uri }) => ({
          range: { start: at(start), end: at(end - 1) },
          text: uri,
          decorations: { underline: true, pointerCursor: true },
          activate: (e) => { e?.preventDefault?.(); activate(uri); },
        }))
        .filter((l) => l.range.start.y <= y && l.range.end.y >= y);
      callback(links.length ? links : undefined);
    },
  };
}
