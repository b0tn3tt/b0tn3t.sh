#!/usr/bin/env python3
"""Merge a CONFIG_X=value fragment into a kconfig .config.

    kconfig-merge.py <.config> <fragment>     # merge
    kconfig-merge.py --check <.config> <fragment>  # verify after oldconfig

Busybox's kconfig ignores KCONFIG_ALLCONFIG, so: allnoconfig, merge this
fragment, `yes "" | make oldconfig`, then --check that every requested
value survived (a typo or an unmet dependency fails the build).
"""
import re
import sys

LINE = re.compile(r"^(CONFIG_[A-Z0-9_]+)=(.*)$")
UNSET = re.compile(r"^# (CONFIG_[A-Z0-9_]+) is not set$")


def fragment(path):
    out = {}
    for line in open(path):
        m = LINE.match(line.strip())
        if m:
            out[m.group(1)] = m.group(2)
    return out


def current(path):
    vals = {}
    for line in open(path):
        line = line.rstrip("\n")
        m = LINE.match(line)
        if m:
            vals[m.group(1)] = m.group(2)
        m = UNSET.match(line)
        if m:
            vals[m.group(1)] = "n"
    return vals


def merge(cfg, frag):
    want = fragment(frag)
    lines, seen = [], set()
    for line in open(cfg):
        line = line.rstrip("\n")
        m = LINE.match(line) or UNSET.match(line)
        key = m.group(1) if m else None
        if key in want:
            seen.add(key)
            v = want[key]
            line = f"# {key} is not set" if v == "n" else f"{key}={v}"
        lines.append(line)
    for key, v in want.items():
        if key not in seen:
            lines.append(f"# {key} is not set" if v == "n" else f"{key}={v}")
    open(cfg, "w").write("\n".join(lines) + "\n")


def check(cfg, frag):
    want, have = fragment(frag), current(cfg)
    bad = [f"{k}: want {v}, have {have.get(k, 'n (unset)')}"
           for k, v in want.items() if have.get(k, "n") != v]
    for b in bad:
        print("kconfig:", b, file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    if sys.argv[1] == "--check":
        sys.exit(check(sys.argv[2], sys.argv[3]))
    merge(sys.argv[1], sys.argv[2])
