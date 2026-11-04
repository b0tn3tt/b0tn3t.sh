// Flow control for v86 virtio-console input.
//
// v86 drops input bytes when the guest has no free receive buffer on the
// port. So we queue, and only hand over a chunk (<= one 4 KiB guest
// buffer) while the port's receive queue has a request available. When it
// does not, the guest is busy; retry shortly.

export const PAGE = 4096;

export function rxQueueIndex(port) {
  return port === 0 ? 0 : 2 * port + 2;
}

export class Pump {
  // canSend(): boolean, deliver(Uint8Array), schedule(fn) for retries
  constructor({ canSend, deliver, schedule = (fn) => setTimeout(fn, 2) }) {
    this.canSend = canSend;
    this.deliver = deliver;
    this.schedule = schedule;
    this.queue = [];
    this.queued = 0;
    this.waiting = false;
    this.drainWaiters = [];
  }

  write(bytes) {
    if (!bytes.length) return;
    this.queue.push(bytes);
    this.queued += bytes.length;
    this.run();
  }

  run() {
    this.waiting = false;
    while (this.queue.length) {
      if (!this.canSend()) {
        if (!this.waiting) {
          this.waiting = true;
          this.schedule(() => this.run());
        }
        break;
      }
      const head = this.queue[0];
      const n = Math.min(PAGE, head.length);
      const chunk = head.subarray(0, n);
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
      this.queued -= n;
      this.deliver(chunk);
    }
    this.notify();
  }

  notify() {
    const ready = this.drainWaiters.filter((w) => this.queued <= w.limit);
    this.drainWaiters = this.drainWaiters.filter((w) => this.queued > w.limit);
    for (const w of ready) w.resolve();
  }

  // resolves once at most `limit` bytes are still queued (backpressure)
  drained(limit = 0) {
    if (this.queued <= limit) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push({ limit, resolve }));
  }
}

// A Pump bound to a live V86 instance and port.
export function portPump(emulator, port) {
  const q = rxQueueIndex(port);
  const dev = () => emulator.v86 && emulator.v86.cpu && emulator.v86.cpu.devices && emulator.v86.cpu.devices.virtio_console;
  return new Pump({
    canSend() {
      const d = dev();
      const queue = d && d.virtio && d.virtio.queues && d.virtio.queues[q];
      // unknown internals: fall back to sending and hoping
      return queue ? queue.is_configured() && queue.has_request() : true;
    },
    deliver(chunk) {
      emulator.bus.send(`virtio-console${port}-input-bytes`, chunk);
    },
  });
}

// v86 writes the virtio-console resize message as (rows, cols) where the
// virtio spec says (cols, rows), so the guest sees them swapped. Passing
// [rows, cols] makes the guest's `stty size` come out right.
export function resizeArgs(cols, rows) {
  return [rows, cols];
}
