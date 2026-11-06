/* fetch: system info with a logo, in the spirit of neofetch.
 * Also installed as neofetch, fastfetch, screenfetch and pfetch.
 * No stdio on purpose: static musl printf/scanf would triple the size. */
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/utsname.h>
#include <unistd.h>

#define C(n) "\033[" #n "m"
#define RST "\033[0m"

/* a happy cat (eyes closed) with a heart, behind a laptop */
static const char *logo[] = {
	"        " C(91) "♥" "        ",
	C(97) "    /\\_____/\\    ",
	C(97) "   /  " C(96) "^   ^" C(97) "  \\   ",
	C(97) "  ( " C(95) "*" C(97) "   ω   " C(95) "*" C(97) " )  ",
	C(37) " ▄▄▄" C(97) "(\")" C(37) "▄▄▄" C(97) "(\")" C(37) "▄▄▄ ",
	C(37) " █             █ ",
	C(37) " █      " C(91) "♥" C(37) "      █ ",
	C(37) " █             █ ",
	C(37) " ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ",
	C(90) "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
};
#define LOGO_LINES (int)(sizeof logo / sizeof *logo)
#define BLANK "                 "

/* ------------------------------------------------ tiny output buffer */
static char out[8192];
static size_t olen;

static void put(const char *s)
{
	size_t n = strlen(s);
	if (olen + n > sizeof out) {
		write(1, out, olen);
		olen = 0;
	}
	memcpy(out + olen, s, n);
	olen += n;
}

static char *utoa(unsigned long v, char *buf) /* buf: 24 bytes, returns start */
{
	char *p = buf + 23;
	*p = 0;
	do
		*--p = '0' + v % 10;
	while (v /= 10);
	return p;
}

/* ------------------------------------------------ info lines */
static char lines[24][256];
static int nlines;

static void line(const char *key, const char *a, const char *b, const char *c)
{
	if (nlines >= 24)
		return;
	char *l = lines[nlines++];
	l[0] = 0;
	if (key) {
		strcat(l, C(1;36));
		strcat(l, key);
		strcat(l, RST);
		for (size_t i = strlen(key); i < 10; i++)
			strcat(l, " ");
	}
	size_t room = 255 - strlen(l);
	for (const char *s = a; s; s = s == a ? b : s == b ? c : NULL) {
		strncat(l, s, room);
		room = 255 - strlen(l);
	}
}

/* whole small file into buf; returns length or -1 */
static int slurp(const char *path, char *buf, size_t cap)
{
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return -1;
	ssize_t n = read(fd, buf, cap - 1);
	close(fd);
	if (n < 0)
		return -1;
	buf[n] = 0;
	return n;
}

/* value of "key=value" or "key<spaces>: value" in a file, quotes trimmed */
static int field(const char *path, const char *key, char sep, char *val, size_t cap)
{
	static char buf[8192];
	if (slurp(path, buf, sizeof buf) < 0)
		return 0;
	size_t kl = strlen(key);
	for (char *l = buf; l && *l; l = strchr(l, '\n'), l = l ? l + 1 : NULL) {
		if (strncmp(l, key, kl))
			continue;
		char *v = l + kl;
		while (*v == ' ' || *v == '\t')
			v++;
		if (*v != sep)
			continue;
		v++;
		while (*v == ' ' || *v == '\t' || *v == '"')
			v++;
		size_t n = strcspn(v, "\"\n");
		if (n >= cap)
			n = cap - 1;
		memcpy(val, v, n);
		val[n] = 0;
		return 1;
	}
	return 0;
}

static void uptime(char *s)
{
	char buf[64], t[24];
	unsigned long up = slurp("/proc/uptime", buf, sizeof buf) > 0 ? strtoul(buf, NULL, 10) : 0;
	unsigned long d = up / 86400, h = up / 3600 % 24, m = up / 60 % 60;
	s[0] = 0;
	if (d) { strcat(s, utoa(d, t)); strcat(s, "d "); }
	if (d || h) { strcat(s, utoa(h, t)); strcat(s, "h "); }
	if (d || h || m) { strcat(s, utoa(m, t)); strcat(s, d || h ? "m" : " min"); }
	else { strcat(s, utoa(up, t)); strcat(s, " sec"); }
}

int main(int argc, char **argv)
{
	int plain = argc > 1 && !strcmp(argv[1], "--plain");
	char v[256], v2[256], t1[24], t2[24];
	struct utsname u;
	struct winsize ws;
	int have_ws = ioctl(1, TIOCGWINSZ, &ws) == 0 && ws.ws_col;
	uname(&u);

	const char *user = getenv("USER");
	if (!user)
		user = getuid() == 0 ? "root" : "user";
	line(NULL, C(1;36), user, RST "@" C(1;36));
	strcat(lines[0], u.nodename);
	strcat(lines[0], RST);
	line(NULL, "─────────────────────", NULL, NULL);

	if (!field("/etc/os-release", "PRETTY_NAME", '=', v, sizeof v))
		strcpy(v, "Linux");
	line("OS", v, " ", u.machine);
	line("Host", "v86 (x86 in WebAssembly)", NULL, NULL);
	line("Kernel", u.release, NULL, NULL);
	uptime(v);
	line("Uptime", v, NULL, NULL);
	const char *sh = getenv("SHELL");
	line("Shell", sh && strstr(sh, "bash") ? "bash" : "ash (busybox)", NULL, NULL);
	if (have_ws) {
		strcpy(v, utoa(ws.ws_col, t1));
		strcat(v, "x");
		strcat(v, utoa(ws.ws_row, t2));
		line("Terminal", "xterm.js ", v, NULL);
	} else if (getenv("TERM")) {
		line("Terminal", getenv("TERM"), NULL, NULL);
	}
	if (field("/run/vmd/env", "browser", '=', v, sizeof v)) {
		for (char *c = v; *c; c++)
			if (*c == '_')
				*c = ' ';
		line("Browser", v, NULL, NULL);
	}
	if (field("/run/vmd/env", "screen", '=', v, sizeof v))
		line("Display", v, NULL, NULL);
	if (field("/run/vmd/env", "zone", '=', v, sizeof v))
		line("Timezone", v, NULL, NULL);
	if (field("/proc/cpuinfo", "model name", ':', v, sizeof v))
		line("CPU", v, NULL, NULL);
	if (field("/proc/meminfo", "MemTotal", ':', v, sizeof v) && field("/proc/meminfo", "MemAvailable", ':', v2, sizeof v2)) {
		unsigned long tot = strtoul(v, NULL, 10) / 1024, av = strtoul(v2, NULL, 10) / 1024;
		strcpy(v, utoa(tot - av, t1));
		strcat(v, " MiB / ");
		strcat(v, utoa(tot, t2));
		strcat(v, " MiB");
		line("Memory", v, NULL, NULL);
	}
	line(NULL, "", NULL, NULL);
	if (!plain) {
		static const char *bg[] = { "\033[40m", "\033[41m", "\033[42m", "\033[43m", "\033[44m", "\033[45m", "\033[46m", "\033[47m" };
		static const char *bb[] = { "\033[100m", "\033[101m", "\033[102m", "\033[103m", "\033[104m", "\033[105m", "\033[106m", "\033[107m" };
		for (int row = 0; row < 2; row++) {
			char *l = lines[nlines++];
			l[0] = 0;
			for (int i = 0; i < 8; i++) {
				strcat(l, (row ? bb : bg)[i]);
				strcat(l, "   ");
			}
			strcat(l, RST);
		}
	}

	int with_logo = !plain && !(have_ws && ws.ws_col < 52);
	int rows = nlines > LOGO_LINES ? nlines : LOGO_LINES;
	put("\n");
	for (int i = 0; i < rows; i++) {
		if (with_logo) {
			put(i < LOGO_LINES ? logo[i] : BLANK);
			put(RST "  ");
		}
		if (i < nlines) {
			if (plain) {
				char s[256];
				size_t o = 0;
				for (const char *c = lines[i]; *c && o < sizeof s - 1; c++) {
					if (*c == '\033') {
						while (*c && *c != 'm')
							c++;
						if (!*c)
							break;
						continue;
					}
					s[o++] = *c;
				}
				s[o] = 0;
				put(s);
			} else {
				put(lines[i]);
			}
		}
		put("\n");
	}
	write(1, out, olen);
	return 0;
}
