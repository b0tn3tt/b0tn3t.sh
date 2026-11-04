/* Small helpers shared by vmd and its unit tests. */
#ifndef VMD_SYS_H
#define VMD_SYS_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* Write a TZif v2 file whose only content is the POSIX TZ rule in the
 * footer, e.g. "<+05>-5" or "CET-1CEST,M3.5.0,M10.5.0/3". musl applies the
 * footer rule for every time, which is all a browser can tell us.
 * Returns 0 or -1 (errno set). */
int write_tzif(const char *path, const char *posix_tz);
/* The same bytes into a buffer; returns the length or -1 if it does not fit. */
long tzif_bytes(const char *posix_tz, uint8_t *out, size_t cap);

/* Accept only sane POSIX TZ strings: printable, no spaces or newlines. */
int tz_valid(const char *tz);

/* Make an upload name safe: basename only, no leading dots, no control
 * characters. Writes into out (cap bytes). Never returns an empty name. */
void safe_name(const char *in, char *out, size_t cap);

/* tty_nr as it appears in /proc/<pid>/stat for a device number. */
unsigned tty_nr_of(dev_t rdev);

/* Find the working directory of the foreground job on the terminal with
 * the given tty_nr by scanning procfs at `proc` (normally "/proc").
 * Falls back to `fallback`. */
void fg_cwd(const char *proc, unsigned tty_nr, const char *fallback, char *out, size_t cap);

/* Parse one "key=value" line of a HELLO header. Returns 1 when the key
 * matches and copies the value (NUL-terminated) into out. */
int hello_get(const char *hdr, size_t len, const char *key, char *out, size_t cap);

#endif
