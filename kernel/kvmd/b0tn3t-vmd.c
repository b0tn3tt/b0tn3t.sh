// SPDX-License-Identifier: GPL-2.0
/*
 * vmd in the kernel (experimental): the guest half of the b0tn3t.sh browser
 * link, speaking the same frames as the userspace vmd (src/proto.h).
 *
 *  - attaches its own line discipline to /dev/hvc1, the virtio console
 *    port the page talks to;
 *  - /dev/vmd: one session per open(); `vm` writes request frames, reads
 *    the reply frames, exactly like on the userspace vmd's unix socket;
 *  - HELLO (clock, entropy, timezone, browser info), PING, EXEC (through
 *    the usermode helper) and dropped files are handled here.
 *
 * Disable with vmd.enable=0 to let the userspace vmd own hvc1 instead.
 */
#include <linux/delay.h>
#include <linux/fs.h>
#include <linux/kernel_read_file.h>
#include <linux/kfifo.h>
#include <linux/miscdevice.h>
#include <linux/module.h>
#include <linux/poll.h>
#include <linux/random.h>
#include <linux/slab.h>
#include <linux/timekeeping.h>
#include <linux/tty.h>
#include <linux/tty_ldisc.h>
#include <linux/umh.h>
#include <linux/vmalloc.h>
#include <linux/workqueue.h>
#include <asm/unaligned.h>

#undef MODULE_PARAM_PREFIX
#define MODULE_PARAM_PREFIX "vmd."

static bool enable = true;
module_param(enable, bool, 0444);
MODULE_PARM_DESC(enable, "attach to hvc1 (0: leave it to the userspace vmd)");

#define VERSION "1.0-kernel"
#define HDR 9
#define MAX_FRAME (64 * 1024)
#define CHUNK 4000
#define BROWSER_ID 0x80000000u
#define PORT_DEV MKDEV(229, 1) /* hvc1 */
#define N_VMD N_DEVELOPMENT

enum { T_DATA = 'D', T_END = 'E', T_HELLO = 'H', T_REPLY = 'Y', T_FILE = 'O', T_EXEC = 'X',
       T_PING = 'P', T_READY = 'R', T_RESULT = 'Z', T_PONG = 'p', T_NOTICE = 'N' };

/* ------------------------------------------------------------ framing */

struct parser {
	u8 *buf; /* HDR + MAX_FRAME */
	size_t have;
};

typedef void (*frame_fn)(void *ctx, u8 type, u32 id, const u8 *p, u32 len);

static int parse(struct parser *ps, const u8 *data, size_t n, frame_fn fn, void *ctx)
{
	while (n) {
		size_t need = HDR, take;
		u32 len;

		if (ps->have >= HDR) {
			len = get_unaligned_le32(ps->buf + 5);
			if (len > MAX_FRAME)
				return -EINVAL;
			need += len;
		}
		take = min(need - ps->have, n);
		memcpy(ps->buf + ps->have, data, take);
		ps->have += take;
		data += take;
		n -= take;
		if (ps->have < HDR)
			continue;
		len = get_unaligned_le32(ps->buf + 5);
		if (len > MAX_FRAME)
			return -EINVAL;
		if (ps->have < HDR + len)
			continue;
		ps->have = 0;
		fn(ctx, ps->buf[0], get_unaligned_le32(ps->buf + 1), ps->buf + HDR, len);
	}
	return 0;
}

static void put_hdr(u8 *h, u8 type, u32 id, u32 len)
{
	h[0] = type;
	put_unaligned_le32(id, h + 1);
	put_unaligned_le32(len, h + 5);
}

/* ------------------------------------------------------------ the port */

static struct tty_struct *port;
static DEFINE_MUTEX(port_lock);
static DEFINE_KFIFO(rx, u8, 64 * 1024);
static DEFINE_SPINLOCK(rx_lock);
static struct parser port_parser;
static struct workqueue_struct *wq;
static bool browser_seen;

static void port_write(const u8 *p, size_t n)
{
	while (n && port) {
		int w = port->ops->write(port, p, n);

		if (w < 0)
			return;
		if (!w) {
			usleep_range(500, 1000);
			continue;
		}
		p += w;
		n -= w;
	}
}

static void port_frame(u8 type, u32 id, const void *p, u32 len)
{
	u8 h[HDR];

	put_hdr(h, type, id, len);
	port_write(h, HDR);
	if (len)
		port_write(p, len);
}

/* START + DATA chunks + END, under the port lock */
static void port_msg(u8 type, u32 id, const char *hdr, const void *body, size_t len)
{
	size_t o;

	mutex_lock(&port_lock);
	port_frame(type, id, hdr, hdr ? strlen(hdr) : 0);
	for (o = 0; o < len; o += CHUNK)
		port_frame(T_DATA, id, (const u8 *)body + o, min_t(size_t, CHUNK, len - o));
	port_frame(T_END, id, NULL, 0);
	mutex_unlock(&port_lock);
}

/* ------------------------------------------------------------ /dev/vmd sessions */

struct session {
	struct list_head node;
	u32 id;
	bool replied, eof, dead;
	struct parser parser;
	struct mutex lock;
	u8 *out;      /* frames waiting for read() */
	size_t out_len, out_cap;
	wait_queue_head_t wait;
};

static LIST_HEAD(sessions);
static DEFINE_MUTEX(sessions_lock);
static u32 next_id = 1;

static void session_push(struct session *s, u8 type, const u8 *p, u32 len)
{
	mutex_lock(&s->lock);
	if (s->out_len + HDR + len > s->out_cap) {
		size_t cap = max_t(size_t, s->out_cap * 2, s->out_len + HDR + len);
		u8 *n = kvmalloc(cap, GFP_KERNEL);

		if (!n) {
			mutex_unlock(&s->lock);
			return;
		}
		if (s->out)
			memcpy(n, s->out, s->out_len);
		kvfree(s->out);
		s->out = n;
		s->out_cap = cap;
	}
	put_hdr(s->out + s->out_len, type, 0, len);
	memcpy(s->out + s->out_len + HDR, p, len);
	s->out_len += HDR + len;
	if (type == T_REPLY)
		s->replied = true;
	if (type == T_END && s->replied)
		s->eof = true;
	mutex_unlock(&s->lock);
	wake_up_interruptible(&s->wait);
}

static struct session *session_by_id(u32 id)
{
	struct session *s;

	list_for_each_entry(s, &sessions, node)
		if (s->id == id && !s->dead)
			return s;
	return NULL;
}

static void session_frame(void *ctx, u8 type, u32 id, const u8 *p, u32 len)
{
	struct session *s = ctx;

	if (type != T_DATA && type != T_END) {
		if (!READ_ONCE(browser_seen)) {
			static const char msg[] = "1browser is not connected\n";

			session_push(s, T_REPLY, msg, sizeof(msg) - 1);
			session_push(s, T_END, NULL, 0);
			s->dead = true;
			return;
		}
		mutex_lock(&sessions_lock);
		s->id = next_id++;
		if (next_id >= BROWSER_ID - 2)
			next_id = 1;
		mutex_unlock(&sessions_lock);
	}
	if (s->id && !s->dead) {
		mutex_lock(&port_lock);
		port_frame(type, s->id, p, len);
		mutex_unlock(&port_lock);
	}
}

static int vmd_open(struct inode *inode, struct file *f)
{
	struct session *s = kzalloc(sizeof(*s), GFP_KERNEL);

	if (!s)
		return -ENOMEM;
	s->parser.buf = kvmalloc(HDR + MAX_FRAME, GFP_KERNEL);
	if (!s->parser.buf) {
		kfree(s);
		return -ENOMEM;
	}
	mutex_init(&s->lock);
	init_waitqueue_head(&s->wait);
	mutex_lock(&sessions_lock);
	list_add(&s->node, &sessions);
	mutex_unlock(&sessions_lock);
	f->private_data = s;
	return 0;
}

static int vmd_release(struct inode *inode, struct file *f)
{
	struct session *s = f->private_data;

	mutex_lock(&sessions_lock);
	list_del(&s->node);
	mutex_unlock(&sessions_lock);
	if (s->id && !s->replied && port) {
		mutex_lock(&port_lock);
		port_frame(T_END, s->id, NULL, 0); /* tell the page to drop it */
		mutex_unlock(&port_lock);
	}
	kvfree(s->parser.buf);
	kvfree(s->out);
	kfree(s);
	return 0;
}

static ssize_t vmd_write(struct file *f, const char __user *ubuf, size_t n, loff_t *off)
{
	struct session *s = f->private_data;
	u8 *k;
	int r;

	if (!port)
		return -ENODEV;
	n = min_t(size_t, n, 64 * 1024);
	k = memdup_user(ubuf, n);
	if (IS_ERR(k))
		return PTR_ERR(k);
	r = parse(&s->parser, k, n, session_frame, s);
	kfree(k);
	return r < 0 ? r : n;
}

static ssize_t vmd_read(struct file *f, char __user *ubuf, size_t n, loff_t *off)
{
	struct session *s = f->private_data;
	size_t take;
	int r;

	r = wait_event_interruptible(s->wait, s->out_len || s->eof || s->dead);
	if (r)
		return r;
	mutex_lock(&s->lock);
	take = min(n, s->out_len);
	if (take && copy_to_user(ubuf, s->out, take)) {
		mutex_unlock(&s->lock);
		return -EFAULT;
	}
	memmove(s->out, s->out + take, s->out_len - take);
	s->out_len -= take;
	mutex_unlock(&s->lock);
	return take;
}

static __poll_t vmd_poll(struct file *f, poll_table *pt)
{
	struct session *s = f->private_data;

	poll_wait(f, &s->wait, pt);
	return (s->out_len || s->eof ? EPOLLIN | EPOLLRDNORM : 0) | EPOLLOUT | EPOLLWRNORM;
}

static const struct file_operations vmd_fops = {
	.owner = THIS_MODULE,
	.open = vmd_open,
	.release = vmd_release,
	.read = vmd_read,
	.write = vmd_write,
	.poll = vmd_poll,
	.llseek = noop_llseek,
};

static struct miscdevice vmd_misc = {
	.minor = MISC_DYNAMIC_MINOR,
	.name = "vmd",
	.fops = &vmd_fops,
	.mode = 0666,
};

/* ------------------------------------------------------------ files from the kernel */

static int write_file(const char *path, const void *data, size_t len, umode_t mode)
{
	struct file *f = filp_open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
	loff_t pos = 0;
	ssize_t w;

	if (IS_ERR(f))
		return PTR_ERR(f);
	w = kernel_write(f, data, len, &pos);
	filp_close(f, NULL);
	return w == len ? 0 : -EIO;
}

static int hello_get(const char *h, size_t len, const char *key, char *out, size_t cap)
{
	size_t kl = strlen(key);
	const char *p = h, *end = h + len;

	while (p < end) {
		const char *nl = memchr(p, '\n', end - p), *le = nl ? nl : end;

		if (le - p > kl && !memcmp(p, key, kl) && p[kl] == '=') {
			size_t vl = min_t(size_t, le - p - kl - 1, cap - 1);

			memcpy(out, p + kl + 1, vl);
			out[vl] = 0;
			return 1;
		}
		p = le + 1;
	}
	return 0;
}

/* TZif v2 with one transition at the epoch and the POSIX rule as footer */
static void write_tz(const char *rule)
{
	static const u8 block[] = {
		'T', 'Z', 'i', 'f', '2', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 4,
	};
	u8 buf[300], *p = buf;
	size_t n = strlen(rule);

	if (!n || n > 120 || strpbrk(rule, " \n\t"))
		return;
	memcpy(p, block, sizeof(block)); p += sizeof(block);
	memset(p, 0, 5); p += 5;                       /* time 0, type 0 */
	memset(p, 0, 6); p += 6;                       /* ttinfo */
	memcpy(p, "UTC", 4); p += 4;
	memcpy(p, block, sizeof(block)); p += sizeof(block);
	memset(p, 0, 9); p += 9;                       /* 64-bit time 0, type 0 */
	memset(p, 0, 6); p += 6;
	memcpy(p, "UTC", 4); p += 4;
	*p++ = '\n';
	memcpy(p, rule, n); p += n;
	*p++ = '\n';
	write_file("/run/vmd/localtime", buf, p - buf, 0644);
}

static void apply_hello(const char *h, size_t len)
{
	char v[160];

	write_file("/run/vmd/env", h, len, 0644);
	if (hello_get(h, len, "time", v, sizeof(v))) {
		s64 ms;

		if (!kstrtos64(v, 10, &ms) && ms > 0) {
			s32 rem;
			struct timespec64 ts;

			ts.tv_sec = div_s64_rem(ms, 1000, &rem); /* no 64-bit % on i386 */
			ts.tv_nsec = rem * NSEC_PER_MSEC;
			do_settimeofday64(&ts);
		}
	}
	if (hello_get(h, len, "seed", v, sizeof(v))) {
		u8 seed[64];
		size_t n = strlen(v) / 2;

		if (n > sizeof(seed))
			n = sizeof(seed);
		if (!hex2bin(seed, v, n))
			add_device_randomness(seed, n);
	}
	if (hello_get(h, len, "tz", v, sizeof(v)))
		write_tz(v);
}

/* ------------------------------------------------------------ exec */

struct job {
	struct work_struct work;
	u32 id;
	char *cmd;
};

static void job_run(struct work_struct *w)
{
	struct job *j = container_of(w, struct job, work);
	char out[40], *script;
	char *argv[] = { "/bin/sh", "-c", NULL, NULL };
	char *envp[] = { "HOME=/root", "TERM=dumb", "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", NULL };
	void *buf = NULL;
	size_t size = 0;
	int status;
	char code[16];

	snprintf(out, sizeof(out), "/run/vmd/exec.%u", j->id);
	script = kasprintf(GFP_KERNEL, "cd /root 2>/dev/null; exec >%s 2>&1 </dev/null; %s", out, j->cmd);
	if (!script)
		goto done;
	argv[2] = script;
	status = call_usermodehelper(argv[0], argv, envp, UMH_WAIT_PROC);
	kfree(script);
	if (kernel_read_file_from_path(out, 0, &buf, 8 << 20, &size, READING_UNKNOWN) < 0)
		size = 0;
	snprintf(code, sizeof(code), "%d", status < 0 ? 127 : (status >> 8) & 0xff);
	port_msg(T_RESULT, j->id, code, buf, size);
	vfree(buf);
	{
		char *rm[] = { "/bin/rm", "-f", out, NULL };

		call_usermodehelper(rm[0], rm, envp, UMH_WAIT_PROC);
	}
done:
	kfree(j->cmd);
	kfree(j);
}

/* ------------------------------------------------------------ messages from the page */

struct incoming {
	u32 id;
	u8 type;
	char hdr[4096];
	size_t hlen;
	struct file *file;
	loff_t pos;
	char path[300];
};

#define MAX_IN 8
static struct incoming in[MAX_IN];

static struct incoming *in_by_id(u32 id)
{
	int i;

	for (i = 0; i < MAX_IN; i++)
		if (in[i].type && in[i].id == id)
			return &in[i];
	return NULL;
}

static void safe_name(const char *s, size_t n, char *out, size_t cap)
{
	const char *base = s, *end = s + n, *p;
	size_t o = 0;

	for (p = s; p < end; p++)
		if (*p == '/')
			base = p + 1;
	while (base < end && *base == '.')
		base++;
	for (; base < end && o + 1 < cap; base++)
		out[o++] = ((u8)*base < 0x20 || *base == 0x7f) ? '_' : *base;
	out[o] = 0;
	if (!o)
		strscpy(out, "upload", cap);
}

static void browser_frame(void *ctx, u8 type, u32 id, const u8 *p, u32 len)
{
	struct session *s;
	struct incoming *m;

	mutex_lock(&sessions_lock);
	s = session_by_id(id);
	if (s) {
		session_push(s, type, p, len);
		mutex_unlock(&sessions_lock);
		return;
	}
	mutex_unlock(&sessions_lock);

	m = in_by_id(id);
	if (type == T_DATA) {
		if (m && m->type == T_FILE && !IS_ERR_OR_NULL(m->file))
			kernel_write(m->file, p, len, &m->pos);
		return;
	}
	if (type == T_END) {
		if (!m)
			return;
		switch (m->type) {
		case T_HELLO: {
			struct session *it;
			char keep[16] = "";
			u32 k = 0;

			/* a new page: fail what the old one never answered, except
			 * `keep` (the `vm save` the page resumes after a restore) */
			if (hello_get(m->hdr, m->hlen, "keep", keep, sizeof(keep)) && kstrtou32(keep, 10, &k))
				k = 0;
			mutex_lock(&sessions_lock);
			list_for_each_entry(it, &sessions, node)
				if (it->id && !it->replied && it->id != k) {
					static const char msg[] = "1the page was reloaded\n";

					session_push(it, T_REPLY, msg, sizeof(msg) - 1);
					session_push(it, T_END, NULL, 0);
					it->dead = true;
				}
			mutex_unlock(&sessions_lock);
			apply_hello(m->hdr, m->hlen);
			WRITE_ONCE(browser_seen, true);
			port_msg(T_READY, m->id, VERSION "\n", NULL, 0);
			break;
		}
		case T_PING:
			port_msg(T_PONG, m->id, NULL, NULL, 0);
			break;
		case T_EXEC: {
			struct job *j = kzalloc(sizeof(*j), GFP_KERNEL);

			if (j) {
				j->id = m->id;
				j->cmd = kmemdup_nul(m->hdr, m->hlen, GFP_KERNEL);
				INIT_WORK(&j->work, job_run);
				if (j->cmd)
					queue_work(system_unbound_wq, &j->work);
				else
					kfree(j);
			}
			break;
		}
		case T_FILE: {
			char text[400];

			if (!IS_ERR_OR_NULL(m->file)) {
				filp_close(m->file, NULL);
				snprintf(text, sizeof(text), "saved %s (%lld bytes)", m->path, m->pos);
			} else {
				snprintf(text, sizeof(text), "could not save %s", m->path);
			}
			port_msg(T_NOTICE, BROWSER_ID - 1, text, NULL, 0);
			break;
		}
		}
		m->type = 0;
		return;
	}
	if (!(id & BROWSER_ID))
		return; /* a reply for a session that is gone */
	if (!m) {
		int i;

		for (i = 0; i < MAX_IN && !m; i++)
			if (!in[i].type)
				m = &in[i];
		if (!m)
			return;
	}
	m->id = id;
	m->type = type;
	m->hlen = min_t(size_t, len, sizeof(m->hdr) - 1);
	memcpy(m->hdr, p, m->hlen);
	m->hdr[m->hlen] = 0;
	m->file = NULL;
	m->pos = 0;
	if (type == T_FILE) {
		char name[200];

		/* the kernel variant has no foreground-shell lookup: files go to /root */
		safe_name(m->hdr, m->hlen, name, sizeof(name));
		snprintf(m->path, sizeof(m->path), "/root/%s", name);
		m->file = filp_open(m->path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	}
}

static void rx_work_fn(struct work_struct *w)
{
	u8 buf[1024];
	unsigned int n;

	while ((n = kfifo_out_spinlocked(&rx, buf, sizeof(buf), &rx_lock)))
		if (parse(&port_parser, buf, n, browser_frame, NULL) < 0)
			port_parser.have = 0; /* resync on garbage */
}
static DECLARE_WORK(rx_work, rx_work_fn);

/* ------------------------------------------------------------ line discipline on hvc1 */

static void ldisc_receive(struct tty_struct *tty, const u8 *cp, const u8 *fp, size_t count)
{
	kfifo_in_spinlocked(&rx, cp, count, &rx_lock);
	queue_work(wq, &rx_work);
}

static int ldisc_open(struct tty_struct *tty)
{
	tty->receive_room = 65536;
	return 0;
}

static struct tty_ldisc_ops vmd_ldisc = {
	.owner = THIS_MODULE,
	.num = N_VMD,
	.name = "vmd",
	.open = ldisc_open,
	.receive_buf = ldisc_receive,
};

/* hvc1 appears asynchronously once the virtio console port is ready */
static void attach_fn(struct work_struct *w);
static DECLARE_DELAYED_WORK(attach_work, attach_fn);

static void attach_fn(struct work_struct *w)
{
	static int tries;
	struct tty_struct *tty = tty_kopen_exclusive(PORT_DEV);
	int r;

	if (IS_ERR(tty)) {
		if (++tries < 600)
			schedule_delayed_work(&attach_work, HZ / 10);
		else
			pr_err("vmd: no hvc1 (%ld)\n", PTR_ERR(tty));
		return;
	}
	r = tty->ops->open(tty, NULL);
	tty_unlock(tty);
	if (r) {
		pr_err("vmd: cannot open hvc1 (%d)\n", r);
		tty_kclose(tty);
		return;
	}
	r = tty_set_ldisc(tty, N_VMD);
	if (r) {
		pr_err("vmd: cannot set line discipline (%d)\n", r);
		return;
	}
	port = tty;
	r = misc_register(&vmd_misc);
	pr_info("vmd: attached to hvc1, /dev/vmd %s\n", r ? "failed" : "ready");
	port_msg(T_READY, 0, VERSION "\n", NULL, 0);
}

static int __init vmd_init(void)
{
	int r;

	if (!enable) {
		pr_info("vmd: disabled, leaving hvc1 to userspace\n");
		return 0;
	}
	port_parser.buf = kvmalloc(HDR + MAX_FRAME, GFP_KERNEL);
	wq = alloc_ordered_workqueue("vmd", 0);
	if (!port_parser.buf || !wq)
		return -ENOMEM;
	r = tty_register_ldisc(&vmd_ldisc);
	if (r)
		return r;
	schedule_delayed_work(&attach_work, 0);
	return 0;
}
late_initcall(vmd_init);

MODULE_DESCRIPTION("b0tn3t.sh browser link (vmd) in the kernel");
MODULE_LICENSE("GPL");
