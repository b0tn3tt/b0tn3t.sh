/* vmd wire protocol, shared by vmd, vm and the kernel driver.
 *
 * A frame is a 9-byte header followed by `len` payload bytes:
 *
 *     u8 type | u32le id | u32le len | payload[len]
 *
 * A message is START(type, id, header) [DATA(id, bytes)]... END(id).
 * Frames of different ids may interleave. The browser side lives in
 * web/proto.js and must stay byte-compatible with this file.
 */
#ifndef VMD_PROTO_H
#define VMD_PROTO_H

#include <stddef.h>
#include <stdint.h>

/* Ids picked by the browser have the top bit set, ids picked by the
 * guest never do, so both sides can start messages without colliding. */
#define VMD_BROWSER_ID 0x80000000u

#define VMD_HDR 9
#define VMD_MAX_FRAME (64u * 1024u)
#define VMD_CHUNK 4000u /* payload per DATA frame: hdr + chunk fits a 4 KiB virtio buffer */

enum vmd_frame {
	VMD_DATA = 'D',
	VMD_END = 'E',
};

/* START types */
enum vmd_msg {
	/* browser -> guest */
	VMD_HELLO = 'H',   /* header: key=value lines (time, seed, tz, browser...) */
	VMD_REPLY = 'Y',   /* header: status byte ('0' ok, '1' error); data: body */
	VMD_FILE = 'O',    /* header: file name; data: contents (upload) */
	VMD_EXEC = 'X',    /* header: shell command; reply is VMD_RESULT */
	VMD_PING = 'P',
	/* guest -> browser */
	VMD_READY = 'R',   /* header: "version\n" */
	VMD_REQUEST = 'Q', /* header: verb NUL arg; data: optional body */
	VMD_RESULT = 'Z',  /* header: exit code as decimal text; data: output */
	VMD_PONG = 'p',
	VMD_NOTICE = 'N',  /* header: text the page shows as a toast */
};

struct vmd_frame_hdr {
	uint8_t type;
	uint32_t id;
	uint32_t len;
};

static inline void vmd_put32(uint8_t *p, uint32_t v)
{
	p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24;
}

static inline uint32_t vmd_get32(const uint8_t *p)
{
	return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static inline void vmd_encode_hdr(uint8_t *out, uint8_t type, uint32_t id, uint32_t len)
{
	out[0] = type;
	vmd_put32(out + 1, id);
	vmd_put32(out + 5, len);
}

/* Incremental decoder. Feed it bytes; it calls `on_frame` once per
 * complete frame. Returns -1 (and stops) on a frame larger than
 * VMD_MAX_FRAME, which can only mean a corrupted stream. */
struct vmd_parser {
	uint8_t buf[VMD_HDR + VMD_MAX_FRAME];
	size_t have;
};

typedef void (*vmd_frame_cb)(void *ctx, const struct vmd_frame_hdr *h, const uint8_t *payload);

int vmd_parse(struct vmd_parser *p, const uint8_t *data, size_t n, vmd_frame_cb cb, void *ctx);

#endif
