#include "sys.h"
#include "util.h"

#include <stdio.h> /* rename() only */

#define TZIF_V1 (44 + 4 + 1 + 6 + 4)
#define TZIF_V2 (44 + 8 + 1 + 6 + 4)

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysmacros.h>
#include <unistd.h>

static uint8_t *put32be(uint8_t *p, uint32_t v)
{
	p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
	return p + 4;
}

/* Header, one transition at the epoch, one ttinfo, "UTC\0". musl uses
 * the footer rule only for times after the last transition, and with no
 * transitions at all it would use the ttinfo (UTC) forever. */
static uint8_t *tzif_block(uint8_t *p, int v2)
{
	memcpy(p, "TZif2", 5);
	memset(p + 5, 0, 15);
	p += 20;
	p = put32be(p, 0); /* isutcnt */
	p = put32be(p, 0); /* isstdcnt */
	p = put32be(p, 0); /* leapcnt */
	p = put32be(p, 1); /* timecnt */
	p = put32be(p, 1); /* typecnt */
	p = put32be(p, 4); /* charcnt */
	if (v2)
		p = put32be(p, 0); /* high half of the 64-bit time */
	p = put32be(p, 0); /* transition at 1970-01-01 */
	*p++ = 0;          /* ...to type 0 */
	p = put32be(p, 0); /* utoff */
	*p++ = 0;          /* isdst */
	*p++ = 0;          /* abbrind */
	memcpy(p, "UTC", 4);
	return p + 4;
}

int tz_valid(const char *tz)
{
	size_t n = strlen(tz);
	if (n == 0 || n > 120)
		return 0;
	for (const char *c = tz; *c; c++)
		if (!isprint((unsigned char)*c) || *c == ' ')
			return 0;
	return 1;
}

long tzif_bytes(const char *tz, uint8_t *out, size_t cap)
{
	size_t n = strlen(tz);
	if (cap < TZIF_V1 + TZIF_V2 + n + 2)
		return -1;
	uint8_t *p = tzif_block(out, 0);
	p = tzif_block(p, 1);
	*p++ = '\n';
	memcpy(p, tz, n);
	p += n;
	*p++ = '\n';
	return p - out;
}

int write_tzif(const char *path, const char *tz)
{
	uint8_t buf[512];
	if (!tz_valid(tz)) {
		errno = EINVAL;
		return -1;
	}
	long n = tzif_bytes(tz, buf, sizeof buf);
	char tmp[256];
	join(tmp, sizeof tmp, path, ".new", (char *)NULL);
	int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd < 0)
		return -1;
	if (write(fd, buf, n) != n) {
		close(fd);
		unlink(tmp);
		return -1;
	}
	close(fd);
	return rename(tmp, path);
}

void safe_name(const char *in, char *out, size_t cap)
{
	const char *base = strrchr(in, '/');
	base = base ? base + 1 : in;
	while (*base == '.')
		base++;
	size_t o = 0;
	for (; *base && o + 1 < cap; base++) {
		unsigned char c = *base;
		out[o++] = (c < 0x20 || c == 0x7f || c == '\\') ? '_' : c;
	}
	out[o] = 0;
	if (!o)
		join(out, cap, "upload", (char *)NULL);
}

unsigned tty_nr_of(dev_t rdev)
{
	unsigned ma = major(rdev), mi = minor(rdev);
	return (mi & 0xff) | (ma << 8) | ((mi & ~0xffu) << 12);
}

static int read_cwd(const char *proc, long pid, char *out, size_t cap)
{
	char link[600];
	char num[24];
	join(link, sizeof link, proc, "/", i2s(pid, num), "/cwd", (char *)NULL);
	ssize_t n = readlink(link, out, cap - 1);
	if (n <= 0)
		return -1;
	out[n] = 0;
	return 0;
}

void fg_cwd(const char *proc, unsigned tty_nr, const char *fallback, char *out, size_t cap)
{
	DIR *d = opendir(proc);
	struct dirent *e;
	long leader = -1, fg = -1;
	while (d && (e = readdir(d))) {
		if (!isdigit((unsigned char)e->d_name[0]))
			continue;
		char path[600], buf[512];
		join(path, sizeof path, proc, "/", e->d_name, "/stat", (char *)NULL);
		int fd = open(path, O_RDONLY);
		if (fd < 0)
			continue;
		ssize_t n = read(fd, buf, sizeof buf - 1);
		close(fd);
		if (n <= 0)
			continue;
		buf[n] = 0;
		char *rp = strrchr(buf, ')');
		/* "pid (comm) state ppid pgrp session tty_nr tpgid ..." */
		if (!rp || rp[1] != ' ' || !rp[2] || rp[3] != ' ')
			continue;
		long pid = strtol(buf, NULL, 10), f[5];
		char *p = rp + 4;
		int ok = 1;
		for (int i = 0; i < 5 && ok; i++) {
			char *end;
			f[i] = strtol(p, &end, 10);
			ok = end != p;
			p = end;
		}
		if (!ok)
			continue;
		long sid = f[2], tpgid = f[4];
		unsigned tty = (unsigned)f[3];
		if (tty == tty_nr && pid == sid) {
			leader = pid;
			fg = tpgid;
			break;
		}
	}
	if (d)
		closedir(d);
	if (fg > 0 && read_cwd(proc, fg, out, cap) == 0)
		return;
	if (leader > 0 && read_cwd(proc, leader, out, cap) == 0)
		return;
	join(out, cap, fallback, (char *)NULL);
}

int hello_get(const char *hdr, size_t len, const char *key, char *out, size_t cap)
{
	size_t kl = strlen(key);
	const char *p = hdr, *end = hdr + len;
	while (p < end) {
		const char *nl = memchr(p, '\n', end - p);
		const char *le = nl ? nl : end;
		if ((size_t)(le - p) > kl && !memcmp(p, key, kl) && p[kl] == '=') {
			size_t vl = le - p - kl - 1;
			if (vl >= cap)
				vl = cap - 1;
			memcpy(out, p + kl + 1, vl);
			out[vl] = 0;
			return 1;
		}
		p = le + 1;
	}
	return 0;
}
