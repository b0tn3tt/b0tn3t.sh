// The browser end of the vmd link. Runs in the page, in the Node
// integration tests and in the build-time warm-up, so all three exercise
// the same code.

import { BROWSER_ID, CHUNK, MessageParser, T, frame, message, splitRequest, text, toBytes } from "./proto.js";

export class VmLink {
  // send(Uint8Array) writes to the guest; drain() (optional) resolves when
  // the outgoing queue is small again, for big uploads.
  constructor({ send, drain = () => Promise.resolve(), onRequest = null, onNotice = () => {}, onStart = () => {} }) {
    this.sendBytes = send;
    this.drain = drain;
    this.onRequest = onRequest;
    this.onNotice = onNotice;
    this.onStart = onStart;
    this.nextId = 1;
    this.waiting = new Map(); // our id -> resolve(message)
    this.active = new Map();  // guest request id -> AbortController
    this.version = null;
    this.parser = new MessageParser((m) => this.onMessage(m), (id) => this.onCancel(id));
  }

  id() {
    const id = (BROWSER_ID | this.nextId++) >>> 0;
    if (this.nextId > 0x7ffffff0) this.nextId = 1;
    return id;
  }

  // Called from inside v86's virtio handler, before v86 has completed the
  // guest's buffer. Anything heavy (saving the machine!) must not run in
  // that stack, or the snapshot holds a guest waiting forever for that
  // buffer. So messages are handled on a microtask, in order.
  feed(bytes) {
    const copy = new Uint8Array(bytes);
    queueMicrotask(() => this.parser.push(copy));
  }

  // answer a request that a restored machine is still waiting for
  replyTo(id, ok, text) {
    this.sendMessage(T.REPLY, id, ok ? "0" : "1", text);
  }

  sendMessage(type, id, header, body) {
    for (const f of message(type, id, header, body)) this.sendBytes(f);
  }

  call(type, header = "", { timeout = 30000, body = null } = {}) {
    const id = this.id();
    return new Promise((resolve, reject) => {
      const t = timeout && setTimeout(() => { this.waiting.delete(id); reject(new Error(`vmd: no answer to ${type}`)); }, timeout);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.sendMessage(type, id, header, body);
    });
  }

  async hello(fields, opts) {
    const header = Object.entries(fields).filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}`).join("\n") + "\n";
    const m = await this.call(T.HELLO, header, opts);
    this.version = text(m.header).trim();
    return this.version;
  }

  async ping(timeout = 3000) {
    try { await this.call(T.PING, "", { timeout }); return true; } catch { return false; }
  }

  // true when the guest shell waits at its prompt (vmd knows); null if unknown
  async idle(timeout = 3000) {
    try {
      const m = await this.call(T.PING, "", { timeout });
      const h = text(m.header);
      return h === "idle=1" ? true : h === "idle=0" ? false : null;
    } catch { return null; }
  }

  async exec(cmd, opts) {
    const m = await this.call(T.EXEC, cmd, { timeout: 120000, ...opts });
    return { code: +text(m.header), out: text(m.body), bytes: m.body };
  }

  // a file dropped onto the page: vmd saves it in the shell's directory
  async dropFile(name, data) {
    const id = this.id();
    await this.streamFile(id, name, data);
  }

  async streamFile(id, name, data) {
    this.sendBytes(frame(T.FILE, id, name));
    if (data instanceof Blob) {
      for (let o = 0; o < data.size; o += 256 * 1024) {
        const part = new Uint8Array(await data.slice(o, o + 256 * 1024).arrayBuffer());
        for (let p = 0; p < part.length; p += CHUNK) this.sendBytes(frame(T.DATA, id, part.subarray(p, p + CHUNK)));
        await this.drain(1 << 20);
      }
    } else {
      const b = toBytes(data);
      for (let p = 0; p < b.length; p += CHUNK) this.sendBytes(frame(T.DATA, id, b.subarray(p, p + CHUNK)));
    }
    this.sendBytes(frame(T.END, id));
  }

  onCancel(id) {
    const c = this.active.get(id);
    if (c) { c.abort(); this.active.delete(id); }
  }

  onMessage(m) {
    const w = this.waiting.get(m.id);
    if (w) { this.waiting.delete(m.id); w(m); return; }
    switch (m.type) {
      case T.READY:
        this.version = text(m.header).trim();
        if (m.id === 0) this.onStart(this.version); // vmd (re)started: say hello again
        break;
      case T.NOTICE:
        this.onNotice(text(m.header));
        break;
      case T.REQUEST:
        this.handleRequest(m);
        break;
    }
  }

  async handleRequest(m) {
    const { verb, arg } = splitRequest(m.header);
    const ctl = new AbortController();
    this.active.set(m.id, ctl);
    const req = {
      id: m.id, verb, arg, body: m.body, signal: ctl.signal,
      sendFile: (name, data) => this.streamFile(m.id, name, data),
    };
    let ok = true, out = "";
    try {
      if (!this.onRequest) throw new Error("this page does not handle requests");
      const r = await this.onRequest(req);
      if (r != null) out = r;
    } catch (e) {
      ok = false;
      out = (e && e.message ? e.message : String(e)) + "\n";
    }
    this.active.delete(m.id);
    if (ctl.signal.aborted) return; // vm went away, nobody to answer
    const body = toBytes(out);
    this.sendBytes(frame(T.REPLY, m.id, ok ? "0" : "1"));
    for (let p = 0; p < body.length; p += CHUNK) this.sendBytes(frame(T.DATA, m.id, body.subarray(p, p + CHUNK)));
    this.sendBytes(frame(T.END, m.id));
  }
}
