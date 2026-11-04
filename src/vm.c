/* vm: talk to the browser tab this machine runs in.
 * Connects to vmd (/run/vmd.sock) or, when the in-kernel variant is
 * loaded, to /dev/vmd. Same frames either way. */
#include "proto.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <signal.h>
#include <stdio.h> /* rename() only */
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define BLOG_URL "https://blog.b0tn3t.sh"

static const char *usage_text =
	"usage: vm <command> [args]\n"
	"\n"
	"  open <url>          open a browser tab\n"
	"  blog                open " BLOG_URL "\n"
	"  copy [text]         copy text (or stdin) to the clipboard\n"
	"  paste               print the clipboard\n"
	"  up [dir]            upload files from your computer\n"
	"  dl <file|dir>...    download to your computer (dirs as .tar.gz)\n"
	"  get <url> [-o file] fetch a URL through the browser\n"
	"  save [name]         save the machine (name: extra snapshot)\n"
	"  load [name]         restore the save or a snapshot\n"
	"  snaps               list snapshots\n"
	"  reset [-y]          wipe everything and start fresh\n"
	"  info                browser, terminal and storage info\n"
	"  theme [name]        list or set the terminal theme\n"
	"  font [name|size]    list or set the terminal font\n";

static int conn = -1;
static struct vmd_parser parser;
static int status = -1, done;
static int out_fd = 1;
static const char *up_dir = ".";
static int up_fd = -1;
static char up_tmp[1024], up_dst[1024];
static unsigned long up_size;
static char hdr_buf[4096];
static uint8_t cur_type;

static void fail(const char *msg)
{
	eput("vm: ", msg, "\n", (char *)NULL);
	exit(1);
}

static int write_all(int fd, const void *buf, size_t n)
{
	const uint8_t *p = buf;
	while (n) {
		ssize_t w = write(fd, p, n);
		if (w < 0 && errno == EINTR)
			continue;
		if (w <= 0)
			return -1;
		p += w;
		n -= w;
	}
	return 0;
}

static void send_frame(uint8_t type, const void *data, size_t len)
{
	uint8_t h[VMD_HDR];
	vmd_encode_hdr(h, type, 1, len);
	if (write_all(conn, h, VMD_HDR) || (len && write_all(conn, data, len)))
		fail("lost connection to vmd");
}

static void send_body_fd(int fd)
{
	uint8_t buf[VMD_CHUNK];
	ssize_t n;
	while ((n = read(fd, buf, sizeof buf)) > 0)
		send_frame(VMD_DATA, buf, n);
}

static void start(const char *verb, const char *arg)
{
	char h[4096];
	size_t vl = strlen(verb), al = arg ? strlen(arg) : 0;
	if (vl + 1 + al > sizeof h)
		fail("argument too long");
	memcpy(h, verb, vl);
	h[vl] = 0;
	memcpy(h + vl + 1, arg ? arg : "", al);
	send_frame(VMD_REQUEST, h, vl + 1 + al);
}

static void connect_vmd(void)
{
	conn = open("/dev/vmd", O_RDWR | O_CLOEXEC);
	if (conn >= 0)
		return;
	struct sockaddr_un a = { .sun_family = AF_UNIX };
	const char *path = getenv("VMD_SOCKET");
	join(a.sun_path, sizeof a.sun_path, path ? path : "/run/vmd.sock", (char *)NULL);
	conn = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (conn < 0 || connect(conn, (struct sockaddr *)&a, sizeof a) < 0)
		fail("vmd is not running");
}

static void upload_finish(void)
{
	if (up_fd < 0)
		return;
	close(up_fd);
	up_fd = -1;
	char line[1200], n[24];
	if (rename(up_tmp, up_dst) == 0) {
		size_t l = join(line, sizeof line, up_dst, " (", u2s(up_size, n), " bytes)\n", (char *)NULL);
		write_all(1, line, l);
	} else {
		eput("vm: could not save ", up_dst, "\n", (char *)NULL);
	}
}

static void on_frame(void *ctx, const struct vmd_frame_hdr *h, const uint8_t *p)
{
	(void)ctx;
	switch (h->type) {
	case VMD_REPLY:
		cur_type = VMD_REPLY;
		status = h->len && p[0] == '0' ? 0 : 1;
		if (status)
			out_fd = 2;
		if (h->len > 1)
			write_all(out_fd, p + 1, h->len - 1);
		break;
	case VMD_FILE: {
		cur_type = VMD_FILE;
		size_t n = h->len < sizeof hdr_buf - 1 ? h->len : sizeof hdr_buf - 1;
		memcpy(hdr_buf, p, n);
		hdr_buf[n] = 0;
		char *name = basename(hdr_buf);
		while (*name == '.')
			name++;
		if (!*name)
			name = "upload";
		join(up_dst, sizeof up_dst, up_dir, "/", name, (char *)NULL);
		join(up_tmp, sizeof up_tmp, up_dir, "/.", name, ".part", (char *)NULL);
		up_fd = open(up_tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
		up_size = 0;
		if (up_fd < 0)
			eput("vm: cannot write ", up_tmp, "\n", (char *)NULL);
		break;
	}
	case VMD_DATA:
		if (cur_type == VMD_FILE) {
			if (up_fd >= 0 && write_all(up_fd, p, h->len) == 0)
				up_size += h->len;
		} else {
			write_all(out_fd, p, h->len);
		}
		break;
	case VMD_END:
		if (cur_type == VMD_FILE)
			upload_finish();
		else if (cur_type == VMD_REPLY)
			done = 1;
		cur_type = 0;
		break;
	}
}

static int wait_reply(void)
{
	uint8_t buf[16384];
	while (!done) {
		ssize_t n = read(conn, buf, sizeof buf);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			fail("vmd closed the connection");
		if (vmd_parse(&parser, buf, n, on_frame, NULL) < 0)
			fail("protocol error");
	}
	if (up_fd >= 0)
		unlink(up_tmp);
	return status;
}

static int simple(const char *verb, const char *arg)
{
	start(verb, arg);
	send_frame(VMD_END, NULL, 0);
	return wait_reply();
}

static int cmd_copy(int argc, char **argv)
{
	start("copy", "");
	if (argc > 0) {
		for (int i = 0; i < argc; i++) {
			if (i)
				send_frame(VMD_DATA, " ", 1);
			send_frame(VMD_DATA, argv[i], strlen(argv[i]));
		}
	} else {
		if (isatty(0))
			fail("usage: vm copy <text>  (or pipe text in)");
		send_body_fd(0);
	}
	send_frame(VMD_END, NULL, 0);
	return wait_reply();
}

static int dl_one(const char *path)
{
	struct stat st;
	if (stat(path, &st) < 0) {
		eput("vm: ", path, ": ", strerror(errno), "\n", (char *)NULL);
		return 1;
	}
	char tmp[1024], name[1100];
	join(tmp, sizeof tmp, path, (char *)NULL);
	char *base = basename(tmp);
	if (S_ISDIR(st.st_mode)) {
		char parent[1024];
		join(parent, sizeof parent, path, (char *)NULL);
		int p[2];
		if (pipe(p) < 0)
			return 1;
		pid_t pid = fork();
		if (pid == 0) {
			dup2(p[1], 1);
			close(p[0]);
			close(p[1]);
			execlp("tar", "tar", "-czf", "-", "-C", dirname(parent), base, (char *)NULL);
			_exit(127);
		}
		close(p[1]);
		join(name, sizeof name, strcmp(base, "/") ? base : "root", ".tar.gz", (char *)NULL);
		start("dl", name);
		send_body_fd(p[0]);
		close(p[0]);
		waitpid(pid, NULL, 0);
	} else {
		int fd = open(path, O_RDONLY | O_CLOEXEC);
		if (fd < 0) {
			eput("vm: ", path, ": ", strerror(errno), "\n", (char *)NULL);
			return 1;
		}
		start("dl", base);
		send_body_fd(fd);
		close(fd);
	}
	send_frame(VMD_END, NULL, 0);
	return wait_reply();
}

static int cmd_get(int argc, char **argv)
{
	const char *url = NULL, *out = NULL;
	for (int i = 0; i < argc; i++) {
		if (!strcmp(argv[i], "-o") && i + 1 < argc)
			out = argv[++i];
		else if (!url)
			url = argv[i];
	}
	if (!url)
		fail("usage: vm get <url> [-o file]");
	if (out && strcmp(out, "-")) {
		out_fd = open(out, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
		if (out_fd < 0)
			fail("cannot open output file");
	}
	return simple("get", url);
}

int main(int argc, char **argv)
{
	signal(SIGPIPE, SIG_IGN);
	const char *self = strrchr(argv[0], '/');
	self = self ? self + 1 : argv[0];
	if (!strcmp(self, "blog")) {
		connect_vmd();
		return simple("open", BLOG_URL);
	}
	if (argc < 2 || !strcmp(argv[1], "-h") || !strcmp(argv[1], "--help") || !strcmp(argv[1], "help")) {
		write_all(argc < 2 ? 2 : 1, usage_text, strlen(usage_text));
		return argc < 2;
	}
	const char *cmd = argv[1];
	argc -= 2;
	argv += 2;
	const char *arg = argc > 0 ? argv[0] : "";

	if (!strcmp(cmd, "dl")) {
		if (!argc)
			fail("usage: vm dl <file|dir>...");
		int rc = 0;
		for (int i = 0; i < argc; i++) {
			connect_vmd();
			memset(&parser, 0, sizeof parser);
			done = 0;
			status = -1;
			rc |= dl_one(argv[i]);
			close(conn);
		}
		return rc;
	}

	connect_vmd();
	if (!strcmp(cmd, "open")) {
		if (!argc)
			fail("usage: vm open <url>");
		return simple("open", arg);
	}
	if (!strcmp(cmd, "blog"))
		return simple("open", BLOG_URL);
	if (!strcmp(cmd, "copy"))
		return cmd_copy(argc, argv);
	if (!strcmp(cmd, "paste"))
		return simple("paste", "");
	if (!strcmp(cmd, "up")) {
		up_dir = argc ? arg : ".";
		struct stat st;
		if (stat(up_dir, &st) < 0 || !S_ISDIR(st.st_mode))
			fail("no such directory");
		if (access(up_dir, W_OK) < 0)
			fail("directory is not writable");
		eput("choose files in the browser (Ctrl+C to cancel)\n", (char *)NULL);
		return simple("up", "");
	}
	if (!strcmp(cmd, "get"))
		return cmd_get(argc, argv);
	if (!strcmp(cmd, "save") || !strcmp(cmd, "load") || !strcmp(cmd, "theme") || !strcmp(cmd, "font"))
		return simple(cmd, arg);
	if (!strcmp(cmd, "snaps") || !strcmp(cmd, "info"))
		return simple(cmd, "");
	if (!strcmp(cmd, "reset")) {
		if (strcmp(arg, "-y")) {
			if (!isatty(0))
				fail("refusing to reset without -y");
			eput("wipe the saved machine and all files? [y/N] ", (char *)NULL);
			char a[8] = "";
			if (read(0, a, sizeof a) <= 0 || (a[0] != 'y' && a[0] != 'Y'))
				return 1;
		}
		return simple("reset", "");
	}
	eput("vm: unknown command '", cmd, "'\n\n", usage_text, (char *)NULL);
	return 1;
}
