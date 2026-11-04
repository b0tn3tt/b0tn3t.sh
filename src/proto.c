#include "proto.h"

#include <string.h>

int vmd_parse(struct vmd_parser *p, const uint8_t *data, size_t n, vmd_frame_cb cb, void *ctx)
{
	while (n) {
		size_t need = VMD_HDR;
		if (p->have >= VMD_HDR) {
			uint32_t len = vmd_get32(p->buf + 5);
			if (len > VMD_MAX_FRAME)
				return -1;
			need += len;
		}
		size_t take = need - p->have;
		if (take > n)
			take = n;
		memcpy(p->buf + p->have, data, take);
		p->have += take;
		data += take;
		n -= take;
		if (p->have < VMD_HDR)
			continue;
		uint32_t len = vmd_get32(p->buf + 5);
		if (len > VMD_MAX_FRAME)
			return -1;
		if (p->have < VMD_HDR + len)
			continue;
		struct vmd_frame_hdr h = { p->buf[0], vmd_get32(p->buf + 1), len };
		p->have = 0;
		cb(ctx, &h, p->buf + VMD_HDR);
	}
	return 0;
}
