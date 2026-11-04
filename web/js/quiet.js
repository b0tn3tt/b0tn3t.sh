// Snapshots must be taken while the machine is quiet. A snapshot taken in
// the middle of console or vmd traffic can restore into a guest whose
// foreground program waits forever for a half-finished exchange. So:
// remember when anything last moved and wait for a calm moment.

export class Quiet {
  constructor({ now = () => performance.now(), busy = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.now = now;
    this.busy = busy;   // extra condition: queued input, open requests...
    this.sleep = sleep;
    this.last = now();
  }

  touch() { this.last = this.now(); }

  calmFor() { return this.now() - this.last; }

  // resolves true once there was no traffic for `calm` ms and busy() is
  // false; false if that did not happen within `timeout` ms
  async wait(calm = 250, timeout = 5000) {
    const start = this.now();
    for (;;) {
      if (this.calmFor() >= calm && !this.busy()) return true;
      if (this.now() - start >= timeout) return false;
      await this.sleep(Math.min(50, calm));
    }
  }
}
