// A continuous clock for v86.
//
// v86 reads time through performance.now() (bound once, when libv86 is
// evaluated) and stores absolute readings in its saved state: the PIT's
// counter start times, among others. A machine restored in a new page,
// where performance.now() starts again near 0, then has timers armed "in
// the future": a `sleep` that was running when the state was saved wakes
// up minutes late and the shell looks dead.
//
// So: patch performance.now() before libv86 loads (import this module
// first), and before restoring a state move the clock forward to at least
// the tick the state was saved at. Emulated time never goes backwards.

const real = performance.now.bind(performance);
let offset = 0;

export const now = () => real() + offset;

export function install() {
  if (performance.now.b0tn3tClock) return;
  const f = () => real() + offset;
  f.b0tn3tClock = true;
  performance.now = f;
}

// make sure now() >= tick (only ever moves forward)
export function atLeast(tick) {
  const behind = tick - now();
  if (behind > 0) offset += behind;
}

install();
