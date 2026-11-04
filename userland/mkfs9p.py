#!/usr/bin/env python3
"""Pack a directory into v86's lazy 9p format, deterministically.

    mkfs9p.py <rootfs-dir> <fs.json> <flat-dir> [--epoch=N] [--cache=DIR]

fs.json (version 3) holds the tree; every regular file's contents go to
<flat-dir>/<sha256>.bin.zst and are fetched by the browser only when the
guest opens the file. Owner is always root, mtime is the epoch, modes are
normalised, children are sorted, so the same input gives the same bytes.
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys

VERSION = 3
S_IFLNK, S_IFREG, S_IFDIR = 0xA000, 0x8000, 0x4000
# directories whose mode is not plain 0755
SPECIAL_DIRS = {"tmp": 0o1777, "root": 0o700}


def norm_mode(rel, st):
    if stat.S_ISDIR(st.st_mode):
        return S_IFDIR | SPECIAL_DIRS.get(rel, 0o755)
    if stat.S_ISLNK(st.st_mode):
        return S_IFLNK | 0o777
    perm = 0o755 if st.st_mode & 0o111 else 0o644
    return S_IFREG | perm


CACHE = None  # dir of already compressed blobs, keyed like the output (sha256)


def compress(src, dst):
    if os.path.exists(dst):
        return
    cached = os.path.join(CACHE, os.path.basename(dst)) if CACHE else None
    if cached and os.path.exists(cached):
        shutil.copyfile(cached, dst)
        return
    tmp = dst + ".tmp"
    with open(src, "rb") as fi, open(tmp, "wb") as fo:
        subprocess.run(["zstd", "-19", "-q", "--no-progress", "-c"], stdin=fi, stdout=fo, check=True)
    if cached:
        shutil.copyfile(tmp, cached + ".tmp")
        os.replace(cached + ".tmp", cached)
    os.replace(tmp, dst)


def walk(root, rel, epoch, flat, stats):
    out = []
    path = os.path.join(root, rel) if rel else root
    for name in sorted(os.listdir(path)):
        r = f"{rel}/{name}" if rel else name
        full = os.path.join(root, r)
        st = os.lstat(full)
        mode = norm_mode(r, st)
        node = [name, 0, epoch, mode, 0, 0, None]
        if stat.S_ISDIR(st.st_mode):
            node[6] = walk(root, r, epoch, flat, stats)
        elif stat.S_ISLNK(st.st_mode):
            node[6] = os.readlink(full)
        elif stat.S_ISREG(st.st_mode):
            with open(full, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()
            node[1] = st.st_size
            node[6] = digest + ".bin.zst"
            compress(full, os.path.join(flat, node[6]))
            stats["files"] += 1
            stats["bytes"] += st.st_size
        else:
            raise SystemExit(f"mkfs9p: unsupported file type: {r}")
        out.append(node)
    return out


def main(argv):
    global CACHE
    args = [a for a in argv if not a.startswith("--")]
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    for a in argv:
        if a.startswith("--epoch="):
            epoch = int(a.split("=", 1)[1])
        if a.startswith("--cache="):
            CACHE = a.split("=", 1)[1]
            os.makedirs(CACHE, exist_ok=True)
    if len(args) != 3:
        raise SystemExit(__doc__)
    root, out_json, flat = args
    os.makedirs(flat, exist_ok=True)
    stats = {"files": 0, "bytes": 0}
    tree = walk(root, "", epoch, flat, stats)
    with open(out_json, "w") as f:
        json.dump({"fsroot": tree, "version": VERSION, "size": stats["bytes"]}, f, separators=(",", ":"))
    print(f"mkfs9p: {stats['files']} files, {stats['bytes']} bytes", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
