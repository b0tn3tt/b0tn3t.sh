#!/usr/bin/env python3
"""Write image/manifest.json for the page.

    manifest.py <image-dir> <mem-MB> <vga-MB> <cmdline-file>

The build id is a hash of everything the machine is made of, so a saved
machine from another build is recognised as incompatible and the page
can bust caches with ?v=<build>.
"""
import hashlib
import json
import os
import sys

image, mem, vga, cmdline = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), open(sys.argv[4]).read().strip()
h = hashlib.sha256()
files = {}
for name in ["bzImage", "fs.json", "state.bin.zst", "screen.bin"]:
    data = open(os.path.join(image, name), "rb").read()
    h.update(name.encode() + b"\0" + hashlib.sha256(data).digest())
    files[name] = len(data)
flat = os.path.join(image, "flat")
files["flat"] = sum(os.path.getsize(os.path.join(flat, f)) for f in os.listdir(flat))
tick_file = os.path.join(image, "tick")
tick = int(open(tick_file).read()) if os.path.exists(tick_file) else 0
if os.path.exists(tick_file):
    os.remove(tick_file)
# tick: the emulator clock (ms) when the warm state was saved; the page
# starts its clock there so timers in the state don't fire late
manifest = {"build": h.hexdigest()[:12], "mem": mem, "vga": vga, "cmdline": cmdline, "tick": tick, "files": files}
with open(os.path.join(image, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1, sort_keys=True)
print(json.dumps(manifest, sort_keys=True))
