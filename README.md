# b0tn3t.sh

A tiny Linux machine that runs in the browser: **b0tn3t LFS**, built from
source for the [v86](https://github.com/copy/v86) emulator, with a full
featured terminal and a link between the machine and the page.

```
whois · contacts · blog · fetch · python · help · vm
ip · curl · wget · cc · make · htop · ncdu · reboot
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
| Linux 6.6 LTS kernel | 1.2 MB | `kernel/b0tn3t.config` on top of `tinyconfig`: one i686 CPU, PCI virtio console, 9p and net, IPv4 only, no modules, no block layer |
| busybox 1.37 (static, musl) | 0.6 MB | shell with history, Ctrl-R, tab completion, colors, UTF-8, wget, nc, ping, archives; `userland/busybox.config` |
| MicroPython 1.29 | 0.4 MB | `python`, `python3`, `py` |
| iproute2 6.19 `ip` | 0.5 MB | the real one: `ip -br -c a`, `-j`, every object |
| tcc + musl + pdpmake | 0.3 MB + libc | `cc`, `tcc -run`, `make`; links static (there is no dynamic loader) |
| htop 3.5, ncdu 1.22 | 0.45/0.3 MB | on a small ncursesw (`-Os`, gc-sections, terminfo compiled in) |
| `vmd`, `vm`, `fetch` | 46/25/21 KB | `src/`, C without stdio |
| warm machine state | 1.9 MB | booted, page cache warm, motd on screen |

The root filesystem is served over 9p and fetched **per file, on first
use** (`image/flat/<sha256>.bin.zst`). The page restores a machine that was
booted and warmed at build time, so it answers in about half a second.

### Network

The machine has a virtio network card whose other end is v86's fetch
adapter in the page (`web/js/net.js`). The kernel configures
`eth0 192.168.86.100/24` from its command line (`ip=`), the adapter plays
the router and DNS at `192.168.86.1`, and every HTTP request becomes a
`fetch()` by the page (HTTPS when the page is on HTTPS). So `curl` and
`wget` (small wrappers, `userland/bin/`) reach sites that allow
cross-origin requests; there is no TLS inside the machine, an `https://`
URL is sent as plain HTTP to the page, which makes it HTTPS.

### reboot and poweroff

v86 cannot boot again a machine that started from a snapshot (the kernel
it loaded is not in memory any more), so `web/js/power.js` puts the
bzImage back on every reset, like a boot loader; it starts downloading
it as soon as init announces the shutdown. `reboot`, `poweroff` and
`halt` are small wrappers (`userland/bin/reboot`) that print a dot every
half second until init stops them; `vm reboot` does the same through the
page. While the new kernel boots (quietly: its serial log would cost 3 s)
the page shows `booting...`, then the banner on a clean screen.
`poweroff` and `halt` are noticed on the kernel console; the page then
shows a small menu: Enter starts the machine again, `r` wipes
everything, `q` closes the tab (where the browser allows it). The root
filesystem lives in the page, so files survive.

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
| JS unit | `tests/js/` | protocol, flow control, time zones, keys, settings, storage, link, clock, kernel loader and power |
| integration | `tests/integration/` | the built image in v86 under Node through the page's own link code: network (`ip`, `wget`, `curl` against a local server), C, htop/ncdu, reboot/poweroff |
| e2e | `tests/e2e/` | Selenium, Firefox and Chromium: typing, blog tab, clipboard, up/dl, drag & drop, save/reload, autosave, snapshots, reset, network, reboot/poweroff, mobile key bar |

## Notes on v86

Four v86 behaviours are worked around in `web/js/` and documented there:
the virtio console resize message swaps rows and columns (`pump.js`),
input is dropped when the guest has no free buffer (`pump.js`), saved
states hold absolute `performance.now()` readings (`clock.js`), and a
reboot after a restored state has no kernel to boot (`power.js`). Snapshots
are only taken at quiet moments (`quiet.js`) and, for autosave, while the
shell waits at its prompt.
