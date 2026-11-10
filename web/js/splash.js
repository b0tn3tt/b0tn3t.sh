// The loading screen: the braille cat (as in fetch) draws itself in as the
// machine downloads, with a progress bar, the steps so far and a tip.
// splashFrame() is pure (a whole screen as a string) so it can be tested.

export const CAT = [
  "               ⣼⣿⡄",
  "      ⣴⠚⡄⢫⠉⢩⠃ ⣰⣿⣿⡇           ⢀⣤⡄",
  "   ⠠⡞⠳⡜⠦⠚⠘⠒⠋ ⢰⣿⣿⣿⡇          ⣰⣿⣿⡇",
  "    ⠈⠚⠁     ⢠⣿⣿⣿⣿⣧        ⢠⣾⣿⣿⣿⠁",
  "            ⣼⣿⣿⣿⣿⣿       ⣰⣿⣿⣿⣿⣿",
  "           ⢰⣿⣿⣿⣿⣿⣿     ⢀⣾⣿⣿⣿⣿⣿⡇",
  "          ⢀⣿⣿⣿⣿⣿⣿⣿⣤⣄⣀⡀⣠⣿⣿⣿⣿⣿⣿⣿⠇",
  "        ⢀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿    ⢸⠉⠉⢰⠂",
  "        ⣾⣿⣿⠟⠛⠙⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏    ⡇ ⡰⠃",
  "       ⢰⣿⣿⠃  ⢰⡆⢻⣿⣿⣿⣿⣿⡿⠛⠛⠻⣿⣿⣿⣿    ⢰⠁⡰⠁",
  "    ⣶⣦⣤⠘⣿⣿⣆  ⢿⠇⣼⣿⣿⣿⣿⠛⢸⡇  ⠙⣿⣿⣿⣇   ⠈⠒⠁",
  "    ⢀⣀⣁ ⠻⣿⣿⣷⣦⣤⣶⣿⣿⣿⣿⣇⡀⣾⠃  ⢠⣿⣿⣿⡇ ⡔⠒⠲⡄",
  "   ⠘⠛⠋⠉  ⠈⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⣤⣴⣾⣿⣿⠟  ⠱⠤⣀⠇",
  "            ⠈⠛⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠁⢀⣤⣀",
  "                 ⠈⠉⠉⠉⠉⠉⠉  ⣀⡀ ⠉⠙⠓",
  " ⡗⡤⡲                      ⠈⢻⠆",
  "⣴⣫⢸⢷⣤",
  " ⠈⠞",
];

// the cat is the largest 4-connected group of cells; the rest are red doodles
function catMask(lines) {
  const H = lines.length, W = Math.max(...lines.map((l) => [...l].length));
  const g = lines.map((l) => [...l].concat(Array(W).fill(" ")).slice(0, W));
  const comp = g.map((r) => r.map(() => -1));
  const sizes = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (g[y][x] === " " || comp[y][x] >= 0) continue;
    const k = sizes.length, st = [[y, x]];
    comp[y][x] = k;
    let n = 0;
    while (st.length) {
      const [cy, cx] = st.pop();
      n++;
      for (const [dy, dx] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const ny = cy + dy, nx = cx + dx;
        if (ny >= 0 && ny < H && nx >= 0 && nx < W && g[ny][nx] !== " " && comp[ny][nx] < 0) {
          comp[ny][nx] = k;
          st.push([ny, nx]);
        }
      }
    }
    sizes.push(n);
  }
  const big = sizes.indexOf(Math.max(...sizes));
  return { g, W, isCat: (y, x) => comp[y][x] === big };
}
const ART = catMask(CAT);

export const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const TIPS = [
  "type help to see what is here",
  "fetch shows the system, contacts where to find me",
  "your files stay between visits (vm save, vm load)",
  "drop a file onto the page to upload it",
  "cc hello.c && ./a.out: there is a C compiler inside",
  "python starts MicroPython",
  "this is a real i686 Linux, emulated in WebAssembly",
];

const RED = "\x1b[38;2;255;59;59m", WHITE = "\x1b[97m", GRAY = "\x1b[90m", DARK = "\x1b[38;2;60;20;20m", BOLD = "\x1b[1m", R = "\x1b[0m";
const width = (s) => [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;

// fill: how much of the cat is drawn (0..1), the download so far by default
// steps: [{label, state: "done"|"run"|"wait", note}]
// progress: 0..1 or null (unknown); tick: frame counter (spinner, tips)
export function splashFrame({ cols, rows, steps, progress = null, fill = progress, tick = 0 }) {
  const out = [];
  const roomForCat = cols >= ART.W + 4 && rows >= CAT.length + steps.length + 8;
  if (roomForCat) {
    // the cat fills in from the bottom up as the download goes
    const p = fill == null ? 0 : fill;
    const shown = Math.round(p * CAT.length);
    for (let y = 0; y < CAT.length; y++) {
      const lit = y >= CAT.length - shown;
      let line = "", cur = "";
      for (let x = 0; x < ART.W; x++) {
        const ch = ART.g[y][x];
        const c = ch === " " ? "" : !lit ? DARK : ART.isCat(y, x) ? WHITE : RED;
        if (c && c !== cur) { line += c; cur = c; }
        line += ch;
      }
      out.push(line.trimEnd() + R);
    }
    out.push("");
  }
  out.push(`${BOLD}${RED}b0tn3t.sh${R}${GRAY} · b0tn3tOS LFS 1.0 · i686 in your browser${R}`);
  out.push("");
  const barW = Math.max(10, Math.min(30, cols - 30));
  for (const s of steps) {
    const mark = s.state === "done" ? `${RED}✓${R}` : s.state === "run" ? `${RED}${SPIN[tick % SPIN.length]}${R}` : `${GRAY}·${R}`;
    const label = s.state === "wait" ? `${GRAY}${s.label}${R}` : s.label;
    let line = `${mark} ${label}`;
    if (s.state === "run" && progress != null) {
      const full = Math.round(progress * barW);
      line += `  ${RED}${"█".repeat(full)}${DARK}${"█".repeat(barW - full)}${R} ${String(Math.round(progress * 100)).padStart(3)}%`;
    }
    if (s.note) line += `  ${GRAY}${s.note}${R}`;
    out.push(line);
  }
  out.push("");
  out.push(`${GRAY}tip: ${TIPS[Math.floor(tick / 30) % TIPS.length]}${R}`);

  // center the block
  const w = Math.max(...out.map(width));
  const left = " ".repeat(Math.max(0, Math.floor((cols - w) / 2)));
  const top = Math.max(0, Math.floor((rows - out.length) / 2));
  return "\x1b[?25l\x1b[H\x1b[2J" + "\r\n".repeat(top) + out.map((l) => (l ? left + l : l)).join("\r\n");
}

// the live screen: set() a step, progress() the download, done() to hand over
export class Splash {
  constructor(term) {
    this.term = term;
    this.steps = [];
    this.p = null;
    this.fill = 0;
    this.tick = 0;
    this.timer = 0;
  }
  start(labels) {
    this.steps = labels.map((label) => ({ label, state: "wait", note: "" }));
    this.timer = setInterval(() => { this.tick++; this.draw(); }, 100);
    this.draw();
  }
  step(i, note = "") { // finish the steps before i, run i
    this.steps.forEach((s, j) => { s.state = j < i ? "done" : j === i ? "run" : "wait"; });
    if (note) this.steps[i].note = note;
    this.p = null;
    this.draw();
  }
  note(i, note) { this.steps[i].note = note; this.draw(); }
  progress(p) { this.p = Math.max(0, Math.min(1, p)); this.fill = Math.max(this.fill, this.p); }
  filled() { this.fill = 1; }
  get running() { return !!this.timer; }
  draw() {
    if (!this.timer) return;
    this.term.write(splashFrame({ cols: this.term.cols, rows: this.term.rows, steps: this.steps, progress: this.p, fill: this.fill, tick: this.tick }));
  }
  done() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = 0;
    this.term.write("\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[?25h");
  }
}
