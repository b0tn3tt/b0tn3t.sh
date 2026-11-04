# b0tn3t.sh

A tiny Linux machine that runs in the browser: **b0tn3t LFS**, built from
source for the [v86](https://github.com/copy/v86) emulator, with a full
featured terminal and a link between the machine and the page.

```
whois · contacts · blog · fetch · python · help · vm
```

## Editing the texts

`whois`, `contacts`, `help` and the login banner are plain files:

```
content/whois.txt      content/contacts.txt
content/help.txt       content/motd.txt
```

Add `content/<name>.txt` and `<name>` becomes a command. At build time each
file turns into a shell function inside the already-running shell (no
program to start, no file to read), plus `/usr/bin/<name>` for scripts.

## What is inside

| part | size | |
|---|---|---|
| Linux 6.6 LTS kernel | 1.0 MB | `kernel/b0tn3t.config` on top of `tinyconfig`: one i686 CPU, PCI virtio console + 9p, no modules, no block layer, no IP stack |
| busybox 1.37 (static, musl) | 0.5 MB | shell with history, Ctrl-R, tab completion, colors, UTF-8; `userland/busybox.config` |
| MicroPython 1.29 | 0.4 MB | `python`, `python3`, `py` |
| `vmd`, `vm`, `fetch` | 46/25/21 KB | `src/`, C without stdio |
| warm machine state | 1.9 MB | booted, page cache warm, motd on screen |

The root filesystem is served over 9p and fetched **per file, on first
use** (`image/flat/<sha256>.bin.zst`). The page restores a machine that was
booted and warmed at build time, so it answers in about half a second.

### The browser link: `vmd` and `vm`

The terminal is virtio console port 0 (`/dev/hvc0`). Port 1 (`/dev/hvc1`)
carries a small framed protocol (`src/proto.h`, `web/js/proto.js`) between
`vmd` in the machine and the page:

```
vm open <url>        vm copy [text]       vm save [name]     vm theme [name]
vm blog              vm paste             vm load [name]     vm font [name|size]
vm up [dir]          vm get <url> [-o f]  vm snaps [rm name] vm info
vm dl <file|dir>     vm reset [-y]
```

The page also sends the clock, time zone, entropy and browser info at
start, saves the machine to IndexedDB (gzip, 512 MB limit for everything,
autosave when the tab is hidden or after 20 s of quiet at the prompt) and
uploads files dropped onto the page into the shell's current directory.

**Experimental:** `kernel/kvmd/b0tn3t-vmd.c` is the same `vmd` as a built-in
kernel driver (a line discipline on hvc1 and `/dev/vmd`); `make kvmd`
builds `dist/bzImage-kvmd`, `tests/integration/kvmd.test.mjs` tests it.
`vmd.enable=0` on the kernel command line hands hvc1 back to userspace.

### The terminal

xterm.js 6 (vendored, sha256-pinned), WebGL renderer with DOM fallback,
Unicode 11 widths, clickable links, OSC 52 clipboard, Ctrl+Shift+C/V,
Ctrl+=/−/0 zoom, five themes, Google Fonts on demand, the shell's title in
the tab. On touch screens: a key bar with Esc/Tab/arrows/F-keys and sticky
Ctrl/Alt (tap: next key, double tap: lock; Ctrl works on a Russian
layout too), pinch to zoom.

## Build, test, run

Everything is built in Docker; heavy work runs at low priority in a
builder capped at 2 GB RAM and 3 CPUs.

```sh
make            # dist/site and dist/bzImage-kvmd
make test       # C, JS, Node integration, Firefox + Chromium e2e
make repro      # two clean builds, identical hashes
make serve      # http://localhost:8000
```

- **Reproducible:** base images pinned by digest, sources by sha256
  (`ADD --checksum`), apk packages by exact version, `SOURCE_DATE_EPOCH`
  for every timestamp. `make repro` builds the `repro` target twice with
  `--no-cache` and compares every file. The warm machine state is the one
  exception: it is a recording of a live machine and its bytes depend on
  timing; everything it is made of is checked.
- **Cached:** one stage per component, so changing the page or a text file
  rebuilds in seconds; CI keeps the stages in the GitHub Actions cache.
  BuildKit cache mounts add an apk download cache, ccache for the kernel
  and MicroPython (a config change recompiles only what changed) and a
  cache of zstd-compressed rootfs blobs. Builds with these caches were
  checked to give the same 39 hashes as clean builds; `make repro`
  disables ccache so its two builds are independent.

### Tests

| level | where | what |
|---|---|---|
| C unit | `tests/c/test_*.c` | framing, TZif (checked through libc), names, procfs, helpers; ASan/UBSan |
| C round trip | `tests/c/vmd_roundtrip.py` | real `vmd` + `vm` on i386 musl, this script as the browser |
| JS unit | `tests/js/` | protocol, flow control, time zones, keys, settings, storage, link, clock |
| integration | `tests/integration/` | the built image in v86 under Node through the page's own link code |
| e2e | `tests/e2e/` | Selenium, Firefox and Chromium: typing, blog tab, clipboard, up/dl, drag & drop, save/reload, autosave, snapshots, reset, mobile key bar |

## Notes on v86

Three v86 behaviours are worked around in `web/js/` and documented there:
the virtio console resize message swaps rows and columns (`pump.js`),
input is dropped when the guest has no free buffer (`pump.js`), and saved
states hold absolute `performance.now()` readings (`clock.js`). Snapshots
are only taken at quiet moments (`quiet.js`) and, for autosave, while the
shell waits at its prompt.
