// Saved machines in IndexedDB. The machine state is gzip-compressed;
// everything together stays under LIMIT.

export const LIMIT = 512 * 1024 * 1024;
export const MAIN = "save";
export const SNAP = "snap:";

export function snapKey(name) {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) throw new Error("snapshot names: 1-32 of A-Z a-z 0-9 . _ -");
  return SNAP + name;
}

// Would storing `size` bytes under `key` break the limit? `entries` is
// [{key, size}] of what is stored now; the old value under `key` is replaced.
export function checkQuota(entries, key, size, limit = LIMIT) {
  const others = entries.filter((e) => e.key !== key).reduce((n, e) => n + e.size, 0);
  if (size > limit) throw new Error(`the machine state is ${mb(size)}, more than the ${mb(limit)} limit`);
  if (others + size > limit) {
    throw new Error(`no room: snapshots use ${mb(others)}, limit is ${mb(limit)} (vm snaps rm <name>)`);
  }
}

export const mb = (n) => (n / 1048576).toFixed(1) + " MB";

function chunks(bytes, size = 1 << 20) {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.subarray(o, o + size));
      o += size;
    },
  });
}

export async function gzip(bytes) {
  return new Response(chunks(bytes).pipeThrough(new CompressionStream("gzip"))).blob();
}

export async function gunzip(blob) {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

export class StateStore {
  constructor(idb = globalThis.indexedDB, name = "b0tn3t") {
    this.idb = idb;
    this.name = name;
    this.db = null;
  }

  open() {
    this.db ||= new Promise((resolve, reject) => {
      const r = this.idb.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("kv", mode);
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("storage aborted"));
    });
  }

  get(key) { return this.tx("readonly", (s) => s.get(key)); }
  del(key) { return this.tx("readwrite", (s) => s.delete(key)); }
  keys() { return this.tx("readonly", (s) => s.getAllKeys()); }

  async entries() {
    const out = [];
    for (const key of await this.keys()) {
      const v = await this.get(key);
      if (v) out.push({ key, size: v.size || 0, created: v.created, build: v.build });
    }
    return out;
  }

  async put(key, value) {
    checkQuota(await this.entries(), key, value.size || 0);
    return this.tx("readwrite", (s) => s.put(value, key));
  }

  async wipe() {
    if (this.db) (await this.db).close();
    this.db = null;
    await new Promise((resolve) => {
      const r = this.idb.deleteDatabase(this.name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
}
