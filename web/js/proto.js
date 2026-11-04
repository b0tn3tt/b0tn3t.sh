// vmd wire protocol, browser side. Byte-compatible with src/proto.h:
//   frame   = u8 type | u32le id | u32le len | payload
//   message = START(type, id, header) DATA(id, bytes)* END(id)

export const HDR = 9;
export const CHUNK = 4000;
export const MAX_FRAME = 64 * 1024;
export const BROWSER_ID = 0x80000000;

export const T = Object.freeze({
  DATA: "D", END: "E",
  HELLO: "H", REPLY: "Y", FILE: "O", EXEC: "X", PING: "P",
  READY: "R", REQUEST: "Q", RESULT: "Z", PONG: "p", NOTICE: "N",
});

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBytes(x) {
  if (x == null) return new Uint8Array(0);
  if (typeof x === "string") return enc.encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError("toBytes: unsupported " + typeof x);
}

export function frame(type, id, payload) {
  const p = toBytes(payload);
  if (p.length > MAX_FRAME) throw new RangeError("frame too large");
  const out = new Uint8Array(HDR + p.length);
  const dv = new DataView(out.buffer);
  out[0] = type.charCodeAt(0);
  dv.setUint32(1, id >>> 0, true);
  dv.setUint32(5, p.length, true);
  out.set(p, HDR);
  return out;
}

// Whole message as a list of frames; body is chunked to CHUNK bytes.
export function message(type, id, header = "", body = null) {
  const out = [frame(type, id, header)];
  const b = toBytes(body);
  for (let o = 0; o < b.length; o += CHUNK) out.push(frame(T.DATA, id, b.subarray(o, o + CHUNK)));
  out.push(frame(T.END, id));
  return out;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Incremental frame decoder. push() bytes, get callbacks per frame.
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = new Uint8Array(0);
  }

  push(bytes) {
    bytes = toBytes(bytes);
    let buf = this.buf.length ? concat([this.buf, bytes]) : bytes;
    let o = 0;
    while (buf.length - o >= HDR) {
      const dv = new DataView(buf.buffer, buf.byteOffset + o, HDR);
      const len = dv.getUint32(5, true);
      if (len > MAX_FRAME) {
        this.buf = new Uint8Array(0);
        throw new RangeError("corrupt stream: frame of " + len + " bytes");
      }
      if (buf.length - o < HDR + len) break;
      const type = String.fromCharCode(buf[o]);
      const id = dv.getUint32(1, true);
      this.onFrame(type, id, buf.slice(o + HDR, o + HDR + len));
      o += HDR + len;
    }
    this.buf = buf.slice(o);
  }
}

// Groups frames into messages: onMessage({type, id, header, body}).
// An END for an id whose message already completed is reported via
// onCancel(id): the guest-side `vm` process went away.
export class MessageParser {
  constructor(onMessage, onCancel = () => {}) {
    this.open = new Map();
    this.onMessage = onMessage;
    this.onCancel = onCancel;
    this.frames = new FrameParser((t, id, p) => this.frame(t, id, p));
  }

  push(bytes) { this.frames.push(bytes); }

  frame(type, id, payload) {
    if (type === T.DATA) {
      const m = this.open.get(id);
      if (m) m.parts.push(payload);
      return;
    }
    if (type === T.END) {
      const m = this.open.get(id);
      if (!m) { this.onCancel(id); return; }
      this.open.delete(id);
      this.onMessage({ type: m.type, id, header: m.header, body: concat(m.parts) });
      return;
    }
    this.open.set(id, { type, header: payload, parts: [] });
  }
}

export const text = (bytes) => dec.decode(bytes);

// "verb\0arg" request header
export function splitRequest(header) {
  const h = toBytes(header);
  const z = h.indexOf(0);
  return z < 0 ? { verb: text(h), arg: "" } : { verb: text(h.subarray(0, z)), arg: text(h.subarray(z + 1)) };
}
