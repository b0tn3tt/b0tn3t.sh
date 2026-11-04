/* vmd: the guest half of the browser link.
 *
 * It owns /dev/hvc1 (a raw virtio console port the page talks to) and a
 * unix socket for the `vm` command. Requests from `vm` are forwarded to
 * the browser with a fresh id and the replies are routed back. Messages
 * the browser starts itself (HELLO, EXEC, PING, dropped files) are
 * handled here.
 */
#define _GNU_SOURCE
#include "proto.h"
#include "sys.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/random.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h> /* rename() only */
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#ifndef VMD_VERSION
#define VMD_VERSION "dev"
#endif

static const char *port_path = "/dev/hvc1";
static const char *sock_path = "/run/vmd.sock";
static const char *run_dir = "/run/vmd";
static const char *term_path = "/dev/hvc0";

#define MAX_CLIENTS 16
#define MAX_JOBS 8
#define MAX_IN 8
#define MAX_OUT (8u << 20)

struct client {
	int fd;
	uint32_t id;
	int replied;
	int dead; /* close once the parser has returned */
	struct vmd_parser *parser;
};

struct job {
	uint32_t id;
	pid_t pid;
	int fd;
	char *buf;
	size_t len;
	int status, exited, eof;
};

struct incoming {
	uint32_t id;
	uint8_t type;
	size_t hlen;
	char hdr[4096];
	/* FILE: upload into the foreground directory */
	int fd;
	size_t size;
	char tmp[800], dst[800];
};

static int port = -1, lsock = -1;
static struct client clients[MAX_CLIENTS];
static struct job jobs[MAX_JOBS];
static struct incoming in[MAX_IN];
static struct vmd_parser port_parser;
static uint32_t next_id = 1;
static int browser_seen;

static void die(const char *what)
{
	eput("vmd: ", what, ": ", strerror(errno), "\n", (char *)NULL);
	exit(1);
}

static int write_all(int fd, const void *buf, size_t n)
{
	const uint8_t *p = buf;
	while (n) {
		ssize_t w = write(fd, p, n);
		if (w < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN) {
				struct pollfd pf = { fd, POLLOUT, 0 };
				poll(&pf, 1, 1000);
				continue;
			}
			return -1;
		}
		p += w;
		n -= w;
	}
	return 0;
}

static void send_frame(int fd, uint8_t type, uint32_t id, const void *data, size_t len)
{
	uint8_t hdr[VMD_HDR];
	vmd_encode_hdr(hdr, type, id, len);
	if (write_all(fd, hdr, VMD_HDR) == 0 && len)
		write_all(fd, data, len);
}

/* a whole message: START + DATA chunks + END */
static void send_msg(int fd, uint8_t type, uint32_t id, const char *hdr, const void *body, size_t len)
{
	send_frame(fd, type, id, hdr, hdr ? strlen(hdr) : 0);
	for (size_t o = 0; o < len; o += VMD_CHUNK) {
		size_t n = len - o < VMD_CHUNK ? len - o : VMD_CHUNK;
		send_frame(fd, VMD_DATA, id, (const uint8_t *)body + o, n);
	}
	send_frame(fd, VMD_END, id, NULL, 0);
}

static void notice(const char *text)
{
	send_msg(port, VMD_NOTICE, VMD_BROWSER_ID - 1, text, NULL, 0);
}

/* ------------------------------------------------------------ clients */

static struct client *client_by_id(uint32_t id)
{
	for (int i = 0; i < MAX_CLIENTS; i++)
		if (clients[i].fd >= 0 && clients[i].id == id)
			return &clients[i];
	return NULL;
}

static void client_close(struct client *c)
{
	close(c->fd);
	free(c->parser);
	*c = (struct client){ .fd = -1 };
}

static void client_reply_error(struct client *c, const char *text)
{
	send_msg(c->fd, VMD_REPLY, c->id, "1", text, strlen(text));
	c->dead = 1;
}

static void on_client_frame(void *ctx, const struct vmd_frame_hdr *h, const uint8_t *payload)
{
	struct client *c = ctx;
	if (c->dead)
		return;
	if (h->type != VMD_DATA && h->type != VMD_END) {
		if (!browser_seen) {
			client_reply_error(c, "browser is not connected\n");
			return;
		}
		c->id = next_id++;
		if (next_id >= VMD_BROWSER_ID - 2)
			next_id = 1;
	}
	if (c->id)
		send_frame(port, h->type, c->id, payload, h->len);
}

static void client_read(struct client *c)
{
	uint8_t buf[16384];
	ssize_t n = read(c->fd, buf, sizeof buf);
	if (n <= 0) {
		/* the vm process is gone: tell the browser to drop the request */
		if (c->id && !c->replied)
			send_frame(port, VMD_END, c->id, NULL, 0);
		client_close(c);
		return;
	}
	if (vmd_parse(c->parser, buf, n, on_client_frame, c) < 0 || c->dead)
		client_close(c);
}

static void client_accept(void)
{
	int fd = accept4(lsock, NULL, NULL, SOCK_CLOEXEC);
	if (fd < 0)
		return;
	for (int i = 0; i < MAX_CLIENTS; i++) {
		if (clients[i].fd < 0) {
			clients[i] = (struct client){ .fd = fd, .parser = calloc(1, sizeof(struct vmd_parser)) };
			if (!clients[i].parser)
				client_close(&clients[i]);
			return;
		}
	}
	close(fd);
}

/* ------------------------------------------------------------ exec jobs */

static void job_start(uint32_t id, const char *cmd)
{
	struct job *j = NULL;
	for (int i = 0; i < MAX_JOBS; i++)
		if (!jobs[i].pid) {
			j = &jobs[i];
			break;
		}
	if (!j) {
		send_msg(port, VMD_RESULT, id, "127", "vmd: too many jobs\n", 19);
		return;
	}
	int p[2];
	if (pipe2(p, O_CLOEXEC) < 0)
		return;
	pid_t pid = fork();
	if (pid == 0) {
		setsid();
		int nul = open("/dev/null", O_RDONLY);
		dup2(nul, 0);
		dup2(p[1], 1);
		dup2(p[1], 2);
		if (chdir("/root") < 0 && chdir("/") < 0)
			_exit(126);
		setenv("HOME", "/root", 1);
		setenv("TERM", "dumb", 1);
		execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
		_exit(127);
	}
	close(p[1]);
	if (pid < 0) {
		close(p[0]);
		return;
	}
	fcntl(p[0], F_SETFL, O_NONBLOCK);
	*j = (struct job){ .id = id, .pid = pid, .fd = p[0] };
}

static void job_read(struct job *j)
{
	char buf[16384];
	ssize_t n;
	while ((n = read(j->fd, buf, sizeof buf)) > 0) {
		if (j->len + n > MAX_OUT)
			continue;
		char *nb = realloc(j->buf, j->len + n);
		if (!nb)
			continue;
		j->buf = nb;
		memcpy(j->buf + j->len, buf, n);
		j->len += n;
	}
	if (n == 0)
		j->eof = 1;
}

static void jobs_reap(void)
{
	for (int i = 0; i < MAX_JOBS; i++) {
		struct job *j = &jobs[i];
		if (!j->pid)
			continue;
		if (!j->exited) {
			int st;
			if (waitpid(j->pid, &st, WNOHANG) == j->pid) {
				j->exited = 1;
				j->status = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
			}
		}
		if (j->exited) {
			job_read(j); /* whatever is left; a background child may hold the pipe */
			char code[24];
			send_msg(port, VMD_RESULT, j->id, i2s(j->status, code), j->buf, j->len);
			close(j->fd);
			free(j->buf);
			*j = (struct job){ 0 };
		}
	}
}

/* ------------------------------------------------------------ browser */

static void apply_hello(const char *hdr, size_t len)
{
	char v[256];
	mkdir(run_dir, 0755);
	char path[256];
	join(path, sizeof path, run_dir, "/env", (char *)NULL);
	char tmp[264];
	join(tmp, sizeof tmp, path, ".new", (char *)NULL);
	int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd >= 0) {
		write_all(fd, hdr, len);
		if (len && hdr[len - 1] != '\n')
			write_all(fd, "\n", 1);
		close(fd);
		rename(tmp, path);
	}
	if (hello_get(hdr, len, "time", v, sizeof v)) {
		long long ms = strtoll(v, NULL, 10);
		struct timeval tv = { ms / 1000, (ms % 1000) * 1000 };
		if (ms > 0)
			settimeofday(&tv, NULL);
	}
	if (hello_get(hdr, len, "tz", v, sizeof v)) {
		join(path, sizeof path, run_dir, "/localtime", (char *)NULL);
		write_tzif(path, v);
	}
	if (hello_get(hdr, len, "seed", v, sizeof v)) {
		struct {
			int count, size;
			unsigned char buf[64];
		} ent = { 0, 0, { 0 } };
		size_t n = strlen(v) / 2;
		if (n > sizeof ent.buf)
			n = sizeof ent.buf;
		for (size_t i = 0; i < n; i++) {
			int b = hex2(v + 2 * i);
			if (b < 0)
				break;
			ent.buf[i] = b;
			ent.size = i + 1;
		}
		ent.count = ent.size * 8;
		int rfd = open("/dev/urandom", O_WRONLY);
		if (rfd >= 0) {
			ioctl(rfd, RNDADDENTROPY, &ent);
			close(rfd);
		}
	}
}

static struct incoming *in_by_id(uint32_t id)
{
	for (int i = 0; i < MAX_IN; i++)
		if (in[i].id == id && in[i].type)
			return &in[i];
	return NULL;
}

static void upload_begin(struct incoming *m)
{
	char name[256], dir[400];
	struct stat st;
	m->hdr[m->hlen] = 0;
	safe_name(m->hdr, name, sizeof name);
	if (stat(term_path, &st) == 0)
		fg_cwd("/proc", tty_nr_of(st.st_rdev), "/root", dir, sizeof dir);
	else
		join(dir, sizeof dir, "/root", (char *)NULL);
	const char *d = strcmp(dir, "/") ? dir : "";
	char n[24];
	join(m->dst, sizeof m->dst, d, "/", name, (char *)NULL);
	for (int i = 1; i < 1000 && access(m->dst, F_OK) == 0; i++)
		join(m->dst, sizeof m->dst, d, "/", name, ".", i2s(i, n), (char *)NULL);
	join(m->tmp, sizeof m->tmp, d, "/.", name, ".part", (char *)NULL);
	m->fd = open(m->tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
	m->size = 0;
}

static void on_port_frame(void *ctx, const struct vmd_frame_hdr *h, const uint8_t *payload)
{
	(void)ctx;
	struct client *c = client_by_id(h->id);
	if (c) {
		send_frame(c->fd, h->type, 0, payload, h->len);
		if (h->type == VMD_REPLY)
			c->replied = 1;
		if (h->type == VMD_END && c->replied)
			client_close(c);
		return;
	}
	struct incoming *m = in_by_id(h->id);
	if (h->type == VMD_DATA) {
		if (m && m->type == VMD_FILE && m->fd >= 0) {
			if (write_all(m->fd, payload, h->len) == 0)
				m->size += h->len;
		}
		return;
	}
	if (h->type == VMD_END) {
		if (!m)
			return;
		switch (m->type) {
		case VMD_HELLO: {
			/* A new page: requests started before it was loaded will never
			 * be answered, except `keep` (a `vm save` the page resumes). */
			char keep[24] = "";
			hello_get(m->hdr, m->hlen, "keep", keep, sizeof keep);
			uint32_t k = strtoul(keep, NULL, 10);
			for (int i = 0; i < MAX_CLIENTS; i++)
				if (clients[i].fd >= 0 && clients[i].id && !clients[i].replied && clients[i].id != k) {
					send_msg(clients[i].fd, VMD_REPLY, 0, "1", "the page was reloaded\n", 22);
					client_close(&clients[i]);
				}
			apply_hello(m->hdr, m->hlen);
			browser_seen = 1;
			send_msg(port, VMD_READY, m->id, VMD_VERSION "\n", NULL, 0);
			break;
		}
		case VMD_PING: {
			/* the answer says whether the shell sits at its prompt: the
			 * page only autosaves then (snapshots of busy jobs can restore
			 * into a stuck terminal) */
			struct stat st;
			int idle = stat(term_path, &st) == 0 ? tty_idle("/proc", tty_nr_of(st.st_rdev)) : -1;
			send_msg(port, VMD_PONG, m->id, idle == 1 ? "idle=1" : idle == 0 ? "idle=0" : "idle=?", NULL, 0);
			break;
		}
		case VMD_EXEC:
			m->hdr[m->hlen] = 0;
			job_start(m->id, m->hdr);
			break;
		case VMD_FILE: {
			char text[900], n[24];
			if (m->fd >= 0 && close(m->fd) == 0 && rename(m->tmp, m->dst) == 0)
				join(text, sizeof text, "saved ", m->dst, " (", u2s(m->size, n), " bytes)", (char *)NULL);
			else
				join(text, sizeof text, "could not save ", m->dst, (char *)NULL);
			notice(text);
			break;
		}
		}
		m->type = 0;
		return;
	}
	/* START of a message the browser begins itself */
	if (!(h->id & VMD_BROWSER_ID))
		return; /* reply for a vm process that already went away */
	if (!m) {
		for (int i = 0; i < MAX_IN && !m; i++)
			if (!in[i].type)
				m = &in[i];
		if (!m)
			return;
	}
	m->id = h->id;
	m->type = h->type;
	m->hlen = h->len < sizeof m->hdr - 1 ? h->len : sizeof m->hdr - 1;
	memcpy(m->hdr, payload, m->hlen);
	m->fd = -1;
	if (m->type == VMD_FILE)
		upload_begin(m);
}

static void port_read(void)
{
	uint8_t buf[16384];
	ssize_t n;
	while ((n = read(port, buf, sizeof buf)) > 0)
		if (vmd_parse(&port_parser, buf, n, on_port_frame, NULL) < 0)
			memset(&port_parser, 0, sizeof port_parser); /* resync on garbage */
}

/* ------------------------------------------------------------ setup */

static int open_port(void)
{
	int fd;
	for (int i = 0; (fd = open(port_path, O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK)) < 0; i++) {
		if (i == 300)
			die(port_path);
		usleep(100000);
	}
	struct termios t;
	if (tcgetattr(fd, &t) == 0) {
		cfmakeraw(&t);
		tcsetattr(fd, TCSANOW, &t);
	}
	return fd;
}

static int open_socket(void)
{
	struct sockaddr_un a = { .sun_family = AF_UNIX };
	join(a.sun_path, sizeof a.sun_path, sock_path, (char *)NULL);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		die("socket");
	unlink(sock_path);
	if (bind(fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(fd, 8) < 0)
		die(sock_path);
	chmod(sock_path, 0666);
	return fd;
}

int main(int argc, char **argv)
{
	/* test hooks: vmd [port] [socket] [run_dir] [terminal] */
	if (argc > 1) port_path = argv[1];
	if (argc > 2) sock_path = argv[2];
	if (argc > 3) run_dir = argv[3];
	if (argc > 4) term_path = argv[4];
	signal(SIGPIPE, SIG_IGN);
	mkdir(run_dir, 0755);
	/* a kernel with the vmd driver built in has /sys/module/vmd: give the
	 * driver a moment to claim hvc1 */
	if (argc == 1 && access("/sys/module/vmd", F_OK) == 0)
		for (int i = 0; i < 30 && access("/dev/vmd", F_OK); i++)
			usleep(100000);
	if (argc == 1 && access("/dev/vmd", F_OK) == 0)
		for (;;)
			pause(); /* the in-kernel vmd owns hvc1; stay put so init won't respawn us */
	for (int i = 0; i < MAX_CLIENTS; i++)
		clients[i].fd = -1;
	port = open_port();
	lsock = open_socket();
	/* id 0: "I just started", the page answers with HELLO */
	send_msg(port, VMD_READY, 0, VMD_VERSION "\n", NULL, 0);

	for (;;) {
		struct pollfd pf[2 + MAX_CLIENTS + MAX_JOBS];
		void *who[2 + MAX_CLIENTS + MAX_JOBS];
		int n = 0, busy = 0;
		pf[n] = (struct pollfd){ port, POLLIN, 0 }; who[n++] = NULL;
		pf[n] = (struct pollfd){ lsock, POLLIN, 0 }; who[n++] = NULL;
		for (int i = 0; i < MAX_CLIENTS; i++)
			if (clients[i].fd >= 0) {
				pf[n] = (struct pollfd){ clients[i].fd, POLLIN, 0 };
				who[n++] = &clients[i];
			}
		for (int i = 0; i < MAX_JOBS; i++)
			if (jobs[i].pid) {
				busy = 1;
				if (!jobs[i].eof) {
					pf[n] = (struct pollfd){ jobs[i].fd, POLLIN, 0 };
					who[n++] = &jobs[i];
				}
			}
		if (poll(pf, n, busy ? 50 : -1) < 0 && errno != EINTR)
			die("poll");
		if (pf[0].revents)
			port_read();
		if (pf[1].revents & POLLIN)
			client_accept();
		for (int i = 2; i < n; i++) {
			if (!pf[i].revents)
				continue;
			if ((char *)who[i] >= (char *)jobs && (char *)who[i] < (char *)(jobs + MAX_JOBS))
				job_read(who[i]);
			else if (((struct client *)who[i])->fd >= 0)
				client_read(who[i]);
		}
		if (busy)
			jobs_reap();
	}
}
