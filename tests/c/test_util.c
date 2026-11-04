#include "util.h"
#include "t.h"

#include <string.h>

int main(void)
{
	char b[16], n[24];
	CHECK(join(b, sizeof b, "/root", "/", "file.txt", (char *)NULL) == 14 && !strcmp(b, "/root/file.txt"));
	CHECK(join(b, sizeof b, "0123456789", "abcdefghij", (char *)NULL) == 15 && !strcmp(b, "0123456789abcde"));
	CHECK(join(b, sizeof b, (char *)NULL) == 0 && b[0] == 0);
	CHECK(join(b, 1, "x", (char *)NULL) == 0 && b[0] == 0);

	CHECK(!strcmp(u2s(0, n), "0"));
	CHECK(!strcmp(u2s(18446744073709551615ull, n), "18446744073709551615"));
	CHECK(!strcmp(i2s(-42, n), "-42"));
	CHECK(!strcmp(i2s(-9223372036854775807ll - 1, n), "-9223372036854775808"));
	CHECK(!strcmp(i2s(127, n), "127"));

	CHECK(hex2("ab") == 0xab);
	CHECK(hex2("FF") == 255);
	CHECK(hex2("0g") == -1);
	CHECK(hex2("") == -1);
	CHECK(hex2("x") == -1);
	DONE();
}
