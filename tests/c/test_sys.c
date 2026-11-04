#include "sys.h"
#include "t.h"

#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>

/* local time through libc with our TZif as /etc/localtime */
static int local_is(const char *dir, const char *rule, time_t t, const char *want)
{
	static int n; /* libc caches TZ by name: a new file each time */
	char f[300], buf[64];
	snprintf(f, sizeof f, "%s/lt%d", dir, n++);
	if (write_tzif(f, rule) != 0)
		return 0;
	setenv("TZ", f, 1);
	tzset();
	struct tm tm;
	localtime_r(&t, &tm);
	strftime(buf, sizeof buf, "%Y-%m-%d %H:%M %z", &tm);
	if (strcmp(buf, want))
		fprintf(stderr, "  %s at %lld: got %s want %s\n", rule, (long long)t, buf, want);
	return !strcmp(buf, want);
}

static void put_stat(const char *proc, int pid, int sid, unsigned tty, int tpgid, const char *cwd)
{
	char p[256];
	snprintf(p, sizeof p, "%s/%d", proc, pid);
	mkdir(p, 0755);
	snprintf(p, sizeof p, "%s/%d/stat", proc, pid);
	FILE *f = fopen(p, "w");
	/* comm with spaces and a paren, like real procfs can have */
	fprintf(f, "%d (we ird) name) S 1 %d %d %u %d 0 0\n", pid, pid, sid, tty, tpgid);
	fclose(f);
	snprintf(p, sizeof p, "%s/%d/cwd", proc, pid);
	symlink(cwd, p);
}

int main(void)
{
	/* TZif: two v2 blocks and the rule as footer */
	uint8_t b[512];
	long n = tzif_bytes("<+05>-5", b, sizeof b);
	/* v1 block: 44 header + 4 time + 1 idx + 6 ttinfo + 4 chars = 59; v2: 63 */
	CHECK(n == 59 + 63 + 9);
	CHECK(!memcmp(b, "TZif2", 5) && !memcmp(b + 59, "TZif2", 5));
	CHECK(b[35] == 1 && b[39] == 1);           /* timecnt, typecnt */
	CHECK(b[59 + 35] == 1 && b[59 + 39] == 1);
	CHECK(!memcmp(b + n - 9, "\n<+05>-5\n", 9));
	CHECK(tzif_bytes("UTC0", b, 10) == -1);

	char path[] = "/tmp/tzXXXXXX";
	CHECK(mkdtemp(path) != NULL);
	char f[300];
	snprintf(f, sizeof f, "%s/localtime", path);
	CHECK(write_tzif(f, "CET-1CEST,M3.5.0,M10.5.0/3") == 0);
	struct stat st;
	CHECK(stat(f, &st) == 0 && st.st_size == 59 + 63 + 28);
	CHECK(write_tzif(f, "bad\nzone") == -1);

	/* libc really applies the rule (musl ignores it with no transitions) */
	CHECK(local_is(path, "<+05>-5", 1767225600, "2026-01-01 05:00 +0500"));
	CHECK(local_is(path, "<+01>-1<+02>,M3.5.0,M10.5.0/3", 1767225600, "2026-01-01 01:00 +0100"));
	CHECK(local_is(path, "<+01>-1<+02>,M3.5.0,M10.5.0/3", 1782864000, "2026-07-01 02:00 +0200"));
	CHECK(local_is(path, "<-05>5<-04>,M3.2.0,M11.1.0", 1782864000, "2026-06-30 20:00 -0400"));
	CHECK(local_is(path, "<+0530>-5:30", 0, "1970-01-01 05:30 +0530"));
	unsetenv("TZ");

	CHECK(tz_valid("UTC0"));
	CHECK(tz_valid("<-03>3"));
	CHECK(!tz_valid(""));
	CHECK(tz_valid("EST5EDT,M3.2.0/2,M11.1.0/2"));
	CHECK(!tz_valid("x\ny"));
	CHECK(!tz_valid("has space"));

	/* upload names */
	char o[64];
	safe_name("../../etc/passwd", o, sizeof o);
	CHECK(!strcmp(o, "passwd"));
	safe_name(".hidden", o, sizeof o);
	CHECK(!strcmp(o, "hidden"));
	safe_name("...", o, sizeof o);
	CHECK(!strcmp(o, "upload"));
	safe_name("a\nb\x01" "c", o, sizeof o);
	CHECK(!strcmp(o, "a_b_c"));
	safe_name("отчёт.pdf", o, sizeof o);
	CHECK(!strcmp(o, "отчёт.pdf"));
	safe_name("dir/", o, sizeof o);
	CHECK(!strcmp(o, "upload"));
	safe_name("aaaaaaaaaaaaaaaaaaaa", o, 8);
	CHECK(strlen(o) == 7);

	/* tty numbers as procfs prints them: hvc0 is 229:0, ttyS0 4:64 */
	CHECK(tty_nr_of(makedev(229, 0)) == 58624);
	CHECK(tty_nr_of(makedev(4, 64)) == 1088);
	CHECK(tty_nr_of(makedev(136, 300)) == ((300 & 0xff) | (136 << 8) | ((300 & ~0xff) << 12)));

	/* foreground cwd from a fake /proc */
	char proc[] = "/tmp/procXXXXXX";
	CHECK(mkdtemp(proc) != NULL);
	put_stat(proc, 10, 1, 0, -1, "/");          /* not on the terminal */
	put_stat(proc, 20, 20, 58624, 30, "/root"); /* the shell, session leader */
	put_stat(proc, 30, 20, 58624, 30, "/root/projects"); /* foreground job */
	char cwd[256];
	fg_cwd(proc, 58624, "/fallback", cwd, sizeof cwd);
	CHECK(!strcmp(cwd, "/root/projects"));
	fg_cwd(proc, 1088, "/fallback", cwd, sizeof cwd);
	CHECK(!strcmp(cwd, "/fallback"));
	CHECK(tty_idle(proc, 58624) == 0);        /* job 30 is in the foreground */
	CHECK(tty_idle(proc, 1088) == -1);        /* nobody on ttyS0 */
	char idleproc[] = "/tmp/procXXXXXX";
	CHECK(mkdtemp(idleproc) != NULL);
	put_stat(idleproc, 20, 20, 58624, 20, "/root"); /* shell at its prompt */
	CHECK(tty_idle(idleproc, 58624) == 1);
	fg_cwd("/nonexistent", 58624, "/x", cwd, sizeof cwd);
	CHECK(!strcmp(cwd, "/x"));

	/* HELLO header parsing */
	const char *h = "browser=firefox_140\ntz=<+05>-5\ntime=1767225600123\nempty=\n";
	char v[64];
	CHECK(hello_get(h, strlen(h), "tz", v, sizeof v) && !strcmp(v, "<+05>-5"));
	CHECK(hello_get(h, strlen(h), "time", v, sizeof v) && !strcmp(v, "1767225600123"));
	CHECK(hello_get(h, strlen(h), "empty", v, sizeof v) == 1 && v[0] == 0);
	CHECK(!hello_get(h, strlen(h), "t", v, sizeof v));
	CHECK(!hello_get(h, strlen(h), "missing", v, sizeof v));
	CHECK(hello_get("k=last", 6, "k", v, sizeof v) && !strcmp(v, "last"));
	CHECK(hello_get("k=0123456789", 12, "k", v, 4) && !strcmp(v, "012"));
	DONE();
}
