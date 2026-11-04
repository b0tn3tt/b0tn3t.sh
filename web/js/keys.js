// Terminal key sequences and the on-screen key bar for touch devices.

// Two rows that are always visible on touch screens, one optional row.
export const BAR = [
  ["ESC", "/", "-", "|", "~", "HOME", "UP", "END", "PGUP"],
  ["TAB", "CTRL", "ALT", "MORE", "KBD", "LEFT", "DOWN", "RIGHT", "PGDN"],
];
export const MORE = [
  ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"],
  ["[", "]", "{", "}", "<", ">", "$", "&", "PASTE", "DEL"],
];

export const LABELS = {
  ESC: "esc", TAB: "⇥", CTRL: "ctrl", ALT: "alt", MORE: "⋯", KBD: "⌨",
  UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→", HOME: "home", END: "end",
  PGUP: "pg↑", PGDN: "pg↓", PASTE: "paste", DEL: "del",
};

// keys that auto-repeat while held
export const REPEAT = new Set(["UP", "DOWN", "LEFT", "RIGHT", "PGUP", "PGDN", "DEL"]);

const CSI = "\x1b[";
const ARROWS = { UP: "A", DOWN: "B", RIGHT: "C", LEFT: "D", HOME: "H", END: "F" };
const TILDE = { PGUP: 5, PGDN: 6, DEL: 3, INS: 2 };
const FKEYS = ["P", "Q", "R", "S", 15, 17, 18, 19, 20, 21, 23, 24];

// xterm modifier parameter: 1 + shift + 2*alt + 4*ctrl
export function modParam({ shift = false, alt = false, ctrl = false } = {}) {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

// Escape sequence for a named key. appCursor: DECCKM is on (vi, less).
export function keySeq(name, mods = {}, appCursor = false) {
  const m = modParam(mods);
  if (name in ARROWS) {
    if (m > 1) return `${CSI}1;${m}${ARROWS[name]}`;
    return (appCursor ? "\x1bO" : CSI) + ARROWS[name];
  }
  if (name in TILDE) return m > 1 ? `${CSI}${TILDE[name]};${m}~` : `${CSI}${TILDE[name]}~`;
  const f = /^F([1-9]|1[0-2])$/.exec(name);
  if (f) {
    const code = FKEYS[+f[1] - 1];
    if (typeof code === "string") return m > 1 ? `${CSI}1;${m}${code}` : `\x1bO${code}`;
    return m > 1 ? `${CSI}${code};${m}~` : `${CSI}${code}~`;
  }
  if (name === "ESC") return "\x1b";
  if (name === "TAB") return mods.shift ? `${CSI}Z` : "\t";
  if (name === "ENTER") return "\r";
  if (name === "BKSP") return "\x7f";
  return null;
}

// Russian ЙЦУКЕН keys map to the Latin key in the same place, so Ctrl+С
// on a Russian layout is still Ctrl+C.
const RU = "йцукенгшщзхъфывапролджэячсмитьбю";
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";

export function latin(ch) {
  const i = RU.indexOf(ch.toLowerCase());
  return i < 0 ? ch : EN[i];
}

// Control character for Ctrl+<ch>, xterm style.
export function ctrlChar(ch) {
  const c = latin(ch);
  if (c === " " || c === "2" || c === "@") return "\x00";
  if (c === "?" || c === "8") return "\x7f";
  const special = { "3": "\x1b", "4": "\x1c", "5": "\x1d", "6": "\x1e", "7": "\x1f", "/": "\x1f" };
  if (c in special) return special[c];
  const code = c.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  return c;
}

// Apply sticky on-screen modifiers to typed text (first character only,
// like a real modifier key held for one keystroke).
export function applyMods(text, { ctrl = false, alt = false } = {}) {
  if (!text || (!ctrl && !alt)) return text;
  const chars = Array.from(text);
  let first = chars.shift();
  if (first === "\r" || first === "\x7f" || first.startsWith("\x1b")) return (alt ? "\x1b" : "") + text;
  if (ctrl) first = ctrlChar(first);
  if (alt) first = "\x1b" + first;
  return first + chars.join("");
}

// Sticky modifier state machine: tap = next key only, double tap = lock.
export class Sticky {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.state = { ctrl: 0, alt: 0 }; // 0 off, 1 once, 2 locked
    this.last = { ctrl: 0, alt: 0 };
  }

  tap(name) {
    const t = this.now(), s = this.state[name];
    this.state[name] = s === 0 ? 1 : s === 1 && t - this.last[name] < 400 ? 2 : 0;
    this.last[name] = t;
    return this.state[name];
  }

  active() { return { ctrl: this.state.ctrl > 0, alt: this.state.alt > 0 }; }

  // after a key was sent: one-shot modifiers turn off
  used() {
    for (const k of ["ctrl", "alt"]) if (this.state[k] === 1) this.state[k] = 0;
  }
}

// Input can arrive split inside a UTF-16 surrogate pair (one event per
// code unit: emoji typed through some drivers/IMEs). Hold a dangling high
// surrogate until its partner arrives so the guest gets valid UTF-8.
export class SurrogateJoiner {
  constructor() { this.hold = ""; }

  push(s) {
    s = this.hold + s;
    this.hold = "";
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.hold = s.slice(-1);
      s = s.slice(0, -1);
    }
    return s;
  }
}
