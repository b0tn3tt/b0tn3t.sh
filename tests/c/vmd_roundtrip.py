#!/usr/bin/env python3
"""vmd <-> vm round trip on the real target, with this script as the browser.

    vmd_roundtrip.py <vmd> <vm>

A pty stands in for /dev/hvc1. Every `vm` subcommand is exercised against
canned browser replies, plus the messages the browser starts itself.
"""
import os
import pty
import select
import struct
import subprocess
import sys
import tempfile
import time
import tty

VMD, VM = sys.argv[1], sys.argv[2]
B = 0x80000000
fails = 0
checks = 0


def check(cond, what):
    global fails, checks
    checks += 1
    if not cond:
        fails += 1
        print("FAIL", what, file=sys.stderr)


def frame(t, i, payload=b""):
    return struct.pack("<BII", ord(t), i, len(payload)) + payload


def msg(t, i, header=b"", body=b""):
    out = frame(t, i, header)
    for o in range(0, len(body), 4000):
        out += frame("D", i, body[o:o + 4000])
    return out + frame("E", i)


class Browser:
    def __init__(self, fd):
        self.fd = fd
        self.buf = b""

    def send(self, data):
        os.write(self.fd, data)

    def frame(self, timeout=10):
        end = time.time() + timeout
        while True:
            if len(self.buf) >= 9:
                t, i, n = struct.unpack("<BII", self.buf[:9])
                if len(self.buf) >= 9 + n:
                    p = self.buf[9:9 + n]
                    self.buf = self.buf[9 + n:]
                    return chr(t), i, p
            left = end - time.time()
            if left <= 0:
                raise TimeoutError("no frame from vmd")
            r, _, _ = select.select([self.fd], [], [], left)
            if r:
                self.buf += os.read(self.fd, 65536)

    def message(self, timeout=10):
        """one whole message: (type, id, header, body)"""
        t, i, h = self.frame(timeout)
        body = b""
        while True:
            ft, fi, p = self.frame(timeout)
            assert fi == i, (ft, fi, i)
            if ft == "D":
                body += p
            elif ft == "E":
                return t, i, h, body


def main():
    tmp = tempfile.mkdtemp()
    sock = os.path.join(tmp, "vmd.sock")
    run = os.path.join(tmp, "run")
    master, slave = pty.openpty()
    tty.setraw(master)
    slave_path = os.ttyname(slave)
    vmd = subprocess.Popen([VMD, slave_path, sock, run, "/nonexistent-term"])
    # keep our slave fd open: with no slave open at all, reads on master fail with EIO
    br = Browser(master)
    env = dict(os.environ, VMD_SOCKET=sock)

    def vm(*args, stdin=None, argv0=None):
        return subprocess.Popen([argv0 or VM, *args], executable=VM, env=env, cwd=tmp,
                                stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def finish(p, stdin=None):
        out, err = p.communicate(stdin, timeout=10)
        return p.returncode, out, err

    try:
        t, i, h, _ = br.message()
        check(t == "R" and i == 0 and h == b"1.0\n", "READY on start")

        rc, out, err = finish(vm("info"))
        check(rc == 1 and b"not connected" in err, "vm before HELLO fails clearly")

        hello = b"browser=firefox_140\nscreen=1920x1080\ntz=<+05>-5\nzone=Asia/Almaty\ntime=1767225600000\nseed=" + b"ab" * 32 + b"\n"
        br.send(msg("H", B | 1, hello))
        t, i, h, _ = br.message()
        check(t == "R" and i == B | 1, "READY answers HELLO with the same id")
        envfile = open(os.path.join(run, "env"), "rb").read()
        check(b"zone=Asia/Almaty" in envfile, "env file written")
        lt = open(os.path.join(run, "localtime"), "rb").read()
        check(lt.startswith(b"TZif2") and lt.endswith(b"\n<+05>-5\n"), "localtime written")

        br.send(msg("P", B | 2))
        t, i, h, _ = br.message()
        check(t == "p" and i == B | 2 and h == b"idle=?", f"PING -> PONG {h}")

        br.send(msg("X", B | 3, b"echo hi; echo err >&2; exit 3"))
        t, i, h, body = br.message()
        check(t == "Z" and i == B | 3 and h == b"3" and body == b"hi\nerr\n", f"EXEC result {h} {body}")

        # copy from args
        p = vm("copy", "hello", "world")
        t, i, h, body = br.message()
        check(t == "Q" and h == b"copy\0" and body == b"hello world", "copy request")
        br.send(msg("Y", i, b"0"))
        rc, _, _ = finish(p)
        check(rc == 0, "copy ok")

        # copy from stdin
        p = vm("copy", stdin=b"")
        p.stdin.write(b"from stdin\n")
        p.stdin.close()
        t, i, h, body = br.message()
        check(body == b"from stdin\n", "copy from stdin")
        br.send(msg("Y", i, b"0"))
        p.wait(10)

        # paste
        p = vm("paste")
        t, i, h, _ = br.message()
        check(h == b"paste\0", "paste request")
        br.send(msg("Y", i, b"0", "буфер обмена".encode()))
        rc, out, _ = finish(p)
        check(rc == 0 and out == "буфер обмена".encode(), "paste prints clipboard")

        # error from the browser
        p = vm("load", "nope")
        t, i, h, _ = br.message()
        check(h == b"load\0nope", "load request")
        br.send(msg("Y", i, b"1no snapshot nope\n"))
        rc, out, err = finish(p)
        check(rc == 1 and err == b"no snapshot nope\n", "errors go to stderr with status 1")

        # get into a file, larger than one frame
        big = os.urandom(150_000)
        p = vm("get", "https://example.com/x.bin", "-o", "x.bin")
        t, i, h, _ = br.message()
        check(h == b"get\0https://example.com/x.bin", "get request")
        br.send(msg("Y", i, b"0", big))
        rc, _, _ = finish(p)
        check(rc == 0 and open(os.path.join(tmp, "x.bin"), "rb").read() == big, "get -o writes the file")

        # upload two files into a directory
        os.mkdir(os.path.join(tmp, "in"))
        p = vm("up", "in")
        t, i, h, _ = br.message()
        check(h == b"up\0", "up request")
        br.send(msg("O", i, b"../a.txt", b"AAA") + msg("O", i, b"b.bin", big) + msg("Y", i, b"0"))
        rc, out, _ = finish(p)
        check(rc == 0 and open(os.path.join(tmp, "in", "a.txt"), "rb").read() == b"AAA", "up writes a.txt (no ../)")
        check(open(os.path.join(tmp, "in", "b.bin"), "rb").read() == big, "up writes big file")
        check(b"a.txt (3 bytes)" in out, "up lists files")

        # download a file and a directory
        with open(os.path.join(tmp, "dl.bin"), "wb") as f:
            f.write(big)
        p = vm("dl", "dl.bin")
        t, i, h, body = br.message()
        check(h == b"dl\0dl.bin" and body == big, "dl streams the file")
        br.send(msg("Y", i, b"0"))
        check(finish(p)[0] == 0, "dl ok")
        p = vm("dl", "in")
        t, i, h, body = br.message()
        check(h == b"dl\0in.tar.gz" and body[:2] == b"\x1f\x8b", "dl of a dir sends a tar.gz")
        br.send(msg("Y", i, b"0"))
        finish(p)
        rc, _, err = finish(vm("dl", "missing"))
        check(rc == 1 and b"missing" in err, "dl of a missing file fails")

        # blog through the argv[0] alias, and vm blog
        os.symlink(VM, os.path.join(tmp, "blog"))
        p = subprocess.Popen([os.path.join(tmp, "blog")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        t, i, h, _ = br.message()
        check(h == b"open\0https://blog.b0tn3t.sh", "blog opens the blog")
        br.send(msg("Y", i, b"0"))
        check(finish(p)[0] == 0, "blog ok")

        for args, header in [(("theme", "amber"), b"theme\0amber"), (("font", "16"), b"font\x0016"),
                             (("save", "snap1"), b"save\0snap1"), (("snaps",), b"snaps\0"), (("snaps", "rm", "old"), b"snaps\0rm old"), (("reset", "-y"), b"reset\0")]:
            p = vm(*args)
            t, i, h, _ = br.message()
            check(h == header, f"{args} -> {h}")
            br.send(msg("Y", i, b"0ok\n"))
            rc, out, _ = finish(p)
            check(rc == 0 and out == b"ok\n", f"{args} ok")

        rc, _, err = finish(vm("reset"))
        check(rc == 1 and b"-y" in err, "reset refuses without a tty or -y")
        rc, out, _ = finish(vm("help"))
        check(rc == 0 and b"vm <command>" in out, "help")
        rc, _, err = finish(vm("bogus"))
        check(rc == 1 and b"unknown command" in err, "unknown command")

        # vm dies mid-request: the browser gets an END so it can drop it
        p = vm("paste")
        t, i, h, _ = br.message()
        p.kill()
        p.wait()
        ft, fi, _ = br.frame()
        check(ft == "E" and fi == i, "dropped client -> END")
        br.send(msg("Y", i, b"0late"))  # a late reply must not crash vmd
        br.send(msg("P", B | 9))
        check(br.message()[0] == "p", "vmd alive after a late reply")

        # a new page (HELLO) fails stale requests but keeps the one it resumes
        p1 = vm("paste")
        _, i1, _, _ = br.message()
        p2 = vm("save")
        _, i2, _, _ = br.message()
        br.send(msg("H", B | 20, f"time=0\nkeep={i2}\n".encode()))
        t, i, _, _ = br.message()
        check(t == "R" and i == B | 20, "READY after second HELLO")
        rc, _, err = finish(p1)
        check(rc == 1 and b"page was reloaded" in err, "stale request failed on HELLO")
        br.send(msg("Y", i2, b"0machine saved\n"))
        rc, out, _ = finish(p2)
        check(rc == 0 and out == b"machine saved\n", "kept request answered after HELLO")

        # a file dropped onto the page lands in the fallback dir (/root)
        if os.access("/root", os.W_OK):
            br.send(msg("O", B | 10, b"dropped.txt", b"drop"))
            t, i, h, _ = br.message()
            check(t == "N" and b"saved /root/dropped.txt" in h, f"drop notice {h}")
            check(open("/root/dropped.txt", "rb").read() == b"drop", "dropped file saved")
    finally:
        vmd.kill()
    print(f"vmd_roundtrip: {checks - fails}/{checks} ok")
    sys.exit(1 if fails else 0)


main()
