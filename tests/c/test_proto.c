#include "proto.h"
#include "t.h"

#include <stdlib.h>
#include <string.h>

struct seen {
	int n;
	struct vmd_frame_hdr h[16];
	char data[16][64];
};

static void cb(void *ctx, const struct vmd_frame_hdr *h, const uint8_t *p)
{
	struct seen *s = ctx;
	s->h[s->n] = *h;
	memcpy(s->data[s->n], p, h->len < 63 ? h->len : 63);
	s->data[s->n][h->len < 63 ? h->len : 63] = 0;
	s->n++;
}

static size_t frame(uint8_t *out, uint8_t type, uint32_t id, const char *s)
{
	size_t n = s ? strlen(s) : 0;
	vmd_encode_hdr(out, type, id, n);
	if (n)
		memcpy(out + VMD_HDR, s, n);
	return VMD_HDR + n;
}

int main(void)
{
	uint8_t buf[256];
	size_t n = 0;
	n += frame(buf + n, VMD_REQUEST, 7, "copy");
	n += frame(buf + n, VMD_DATA, 7, "hello");
	n += frame(buf + n, VMD_END, 7, NULL);

	/* header layout is little endian and 9 bytes */
	CHECK(buf[0] == 'Q' && buf[1] == 7 && buf[2] == 0 && buf[5] == 4 && buf[6] == 0);
	CHECK(vmd_get32((uint8_t[]){ 0x78, 0x56, 0x34, 0x12 }) == 0x12345678);

	/* all at once */
	struct vmd_parser *p = calloc(1, sizeof *p);
	struct seen s = { 0 };
	CHECK(vmd_parse(p, buf, n, cb, &s) == 0);
	CHECK(s.n == 3);
	CHECK(s.h[0].type == 'Q' && s.h[0].id == 7 && !strcmp(s.data[0], "copy"));
	CHECK(s.h[1].type == 'D' && s.h[1].len == 5 && !strcmp(s.data[1], "hello"));
	CHECK(s.h[2].type == 'E' && s.h[2].len == 0);

	/* byte by byte gives the same result */
	memset(p, 0, sizeof *p);
	memset(&s, 0, sizeof s);
	for (size_t i = 0; i < n; i++)
		CHECK(vmd_parse(p, buf + i, 1, cb, &s) == 0);
	CHECK(s.n == 3 && !strcmp(s.data[1], "hello"));

	/* split in the middle of a header */
	memset(p, 0, sizeof *p);
	memset(&s, 0, sizeof s);
	vmd_parse(p, buf, 4, cb, &s);
	CHECK(s.n == 0);
	vmd_parse(p, buf + 4, n - 4, cb, &s);
	CHECK(s.n == 3);

	/* large ids survive */
	memset(p, 0, sizeof *p);
	memset(&s, 0, sizeof s);
	n = frame(buf, VMD_PING, VMD_BROWSER_ID | 5, NULL);
	vmd_parse(p, buf, n, cb, &s);
	CHECK(s.n == 1 && s.h[0].id == (VMD_BROWSER_ID | 5));

	/* an impossible length is rejected */
	memset(p, 0, sizeof *p);
	vmd_encode_hdr(buf, VMD_DATA, 1, VMD_MAX_FRAME + 1);
	CHECK(vmd_parse(p, buf, VMD_HDR, cb, &s) == -1);

	/* a maximum size frame is fine */
	uint8_t *big = calloc(1, VMD_HDR + VMD_MAX_FRAME);
	memset(p, 0, sizeof *p);
	memset(&s, 0, sizeof s);
	vmd_encode_hdr(big, VMD_DATA, 2, VMD_MAX_FRAME);
	CHECK(vmd_parse(p, big, VMD_HDR + VMD_MAX_FRAME, cb, &s) == 0 && s.n == 1 && s.h[0].len == VMD_MAX_FRAME);
	CHECK(VMD_HDR + VMD_CHUNK <= 4096);
	free(big);
	free(p);
	DONE();
}
