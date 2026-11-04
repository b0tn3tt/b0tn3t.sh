#include "util.h"

#include <stdarg.h>
#include <string.h>
#include <unistd.h>

size_t join(char *out, size_t cap, ...)
{
	va_list ap;
	size_t o = 0;
	if (!cap)
		return 0;
	va_start(ap, cap);
	for (const char *s = va_arg(ap, const char *); s; s = va_arg(ap, const char *)) {
		size_t n = strlen(s);
		if (n > cap - 1 - o)
			n = cap - 1 - o;
		memcpy(out + o, s, n);
		o += n;
	}
	va_end(ap);
	out[o] = 0;
	return o;
}

char *u2s(unsigned long long v, char *buf)
{
	char *p = buf + 23;
	*p = 0;
	do
		*--p = '0' + v % 10;
	while (v /= 10);
	return p;
}

char *i2s(long long v, char *buf)
{
	if (v >= 0)
		return u2s(v, buf);
	char *p = u2s(-(unsigned long long)v, buf);
	*--p = '-';
	return p;
}

void eput(const char *first, ...)
{
	char buf[1024];
	va_list ap;
	size_t o = 0;
	va_start(ap, first);
	for (const char *s = first; s; s = va_arg(ap, const char *)) {
		size_t n = strlen(s);
		if (n > sizeof buf - o)
			n = sizeof buf - o;
		memcpy(buf + o, s, n);
		o += n;
	}
	va_end(ap);
	(void)!write(2, buf, o);
}

static int nib(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

int hex2(const char *s)
{
	int a = nib(s[0]), b = a < 0 ? -1 : nib(s[1]);
	return a < 0 || b < 0 ? -1 : a << 4 | b;
}
