// Terminal look and behaviour, persisted per browser in localStorage.

const base = {
  black: "#1b1f27", red: "#ff6b6b", green: "#5af78e", yellow: "#f3f99d",
  blue: "#57c7ff", magenta: "#ff6ac1", cyan: "#9aedfe", white: "#d7dae0",
  brightBlack: "#6b7280", brightRed: "#ff8787", brightGreen: "#7dffa8", brightYellow: "#fbffb5",
  brightBlue: "#82d6ff", brightMagenta: "#ff92d0", brightCyan: "#b8f4ff", brightWhite: "#ffffff",
};

function mono(hex, bg = "#050805") {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const shade = (k) => "#" + rgb.map((c) => Math.round(c * k).toString(16).padStart(2, "0")).join("");
  const t = { background: bg, foreground: shade(0.9), cursor: hex, cursorAccent: bg, selectionBackground: shade(0.35), black: bg, brightBlack: shade(0.5) };
  for (const c of ["red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    t[c] = shade(0.75);
    t["bright" + c[0].toUpperCase() + c.slice(1)] = hex;
  }
  return t;
}

export const THEMES = {
  dark: { ...base, background: "#0d1117", foreground: "#d7dae0", cursor: "#5af78e", cursorAccent: "#0d1117", selectionBackground: "#2f3b4d" },
  light: {
    background: "#fbfbf8", foreground: "#24292f", cursor: "#24292f", cursorAccent: "#fbfbf8", selectionBackground: "#c9d7ea",
    black: "#24292f", red: "#c62828", green: "#2e7d32", yellow: "#8d6e00", blue: "#1f5fbf", magenta: "#8e24aa", cyan: "#00838f", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#e53935", brightGreen: "#43a047", brightYellow: "#a07c00", brightBlue: "#2f74d6", brightMagenta: "#ab47bc", brightCyan: "#0097a7", brightWhite: "#8c959f",
  },
  matrix: mono("#33ff66"),
  amber: mono("#ffb000", "#0a0700"),
  solarized: {
    background: "#002b36", foreground: "#93a1a1", cursor: "#93a1a1", cursorAccent: "#002b36", selectionBackground: "#0b4452",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#93a1a1", brightYellow: "#839496", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
};

export const SYSTEM_FONT = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

// name -> Google Fonts family (loaded on demand); "system" uses local fonts
export const FONTS = {
  system: null,
  "jetbrains-mono": "JetBrains Mono",
  "fira-code": "Fira Code",
  "ibm-plex-mono": "IBM Plex Mono",
  "source-code-pro": "Source Code Pro",
  "ubuntu-mono": "Ubuntu Mono",
  "space-mono": "Space Mono",
  vt323: "VT323",
};

const SCHEMA = {
  theme: { values: Object.keys(THEMES) },
  font: { values: Object.keys(FONTS) },
  fontSize: { min: 8, max: 40 },
  cursor: { values: ["block", "bar", "underline"] },
  blink: { bool: true },
  renderer: { values: ["auto", "webgl", "dom"] },
  scrollback: { min: 100, max: 100000 },
  keys: { values: ["auto", "on", "off"] },
  copyOnSelect: { bool: true },
  autosave: { bool: true },
};

export function defaults(touch = false) {
  return {
    theme: "dark", font: "system", fontSize: touch ? 13 : 15, cursor: "block", blink: true,
    renderer: "auto", scrollback: 10000, keys: "auto", copyOnSelect: false, autosave: true,
  };
}

export function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) throw new Error(`unknown setting ${key}`);
  if (s.values) {
    if (!s.values.includes(value)) throw new Error(`${key}: one of ${s.values.join(", ")}`);
    return value;
  }
  if (s.bool) {
    if (value === true || value === "on" || value === "true") return true;
    if (value === false || value === "off" || value === "false") return false;
    throw new Error(`${key}: on or off`);
  }
  const n = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? +value : NaN;
  if (!Number.isInteger(n) || n < s.min || n > s.max) throw new Error(`${key}: a number from ${s.min} to ${s.max}`);
  return n;
}

export class Settings {
  constructor(storage, touch = false, key = "b0tn3t.settings") {
    this.storage = storage;
    this.key = key;
    this.defaults = defaults(touch);
    this.values = { ...this.defaults };
    this.listeners = [];
    let saved = {};
    try { saved = JSON.parse(storage.getItem(key) || "{}"); } catch { saved = {}; }
    for (const [k, v] of Object.entries(saved)) {
      try { this.values[k] = validate(k, v); } catch { /* drop stale or bad values */ }
    }
  }

  get(k) { return this.values[k]; }

  set(k, v) {
    const val = validate(k, v);
    this.values[k] = val;
    this.persist();
    for (const l of this.listeners) l(k, val);
    return val;
  }

  reset() {
    this.values = { ...this.defaults };
    try { this.storage.removeItem(this.key); } catch { /* private mode */ }
    for (const [k, v] of Object.entries(this.values)) for (const l of this.listeners) l(k, v);
  }

  persist() {
    const changed = Object.fromEntries(Object.entries(this.values).filter(([k, v]) => v !== this.defaults[k]));
    try { this.storage.setItem(this.key, JSON.stringify(changed)); } catch { /* private mode */ }
  }

  onChange(fn) { this.listeners.push(fn); }
}
