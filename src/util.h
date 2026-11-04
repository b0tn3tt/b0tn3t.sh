/* Tiny string helpers so the static binaries don't pull in musl's stdio
 * (printf/scanf alone would double their size). */
#ifndef VMD_UTIL_H
#define VMD_UTIL_H

#include <stddef.h>

/* Concatenate NUL-terminated strings (list ends with NULL) into out,
 * always NUL-terminated, truncated to cap. Returns the length written. */
size_t join(char *out, size_t cap, ...);

/* Unsigned/signed decimal into buf (at least 24 bytes); returns a pointer
 * inside buf to the first digit. */
char *u2s(unsigned long long v, char *buf);
char *i2s(long long v, char *buf);

/* write(2) the NULL-terminated list of strings */
void eput(const char *first, ...);

/* "ab" -> 0xab; -1 when not two hex digits */
int hex2(const char *s);

#endif
