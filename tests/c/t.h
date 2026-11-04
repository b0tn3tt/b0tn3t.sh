/* tiny test harness: CHECK(cond) counts failures, DONE() reports */
#ifndef T_H
#define T_H
#include <stdio.h>

static int t_fail, t_run;
#define CHECK(c) do { t_run++; if (!(c)) { t_fail++; fprintf(stderr, "%s:%d: FAIL %s\n", __FILE__, __LINE__, #c); } } while (0)
#define DONE() do { printf("%s: %d/%d ok\n", __FILE__, t_run - t_fail, t_run); return t_fail != 0; } while (0)
#endif
