# b0tn3t.sh: build, test and serve the b0tn3t LFS machine.
#
#   make            build dist/site (and dist/bzImage-kvmd)
#   make test       every test level: C, JS, Node integration, browser e2e
#   make repro      two clean builds must give identical hashes
#   make serve      http://localhost:8000
#
# Heavy work runs at low priority with CPU/RAM caps (LIMIT, the builder).
# In CI: make BUILDER=default LIMIT= NICE=

BUILDER  ?= b0tn3t-lowprio
BUILDKIT ?= moby/buildkit:v0.34.2
NICE     ?= nice -n 19 ionice -c3
LIMIT    ?= systemd-run --user --scope -q -p MemoryMax=1800M -p MemorySwapMax=0 -p CPUQuota=300% nice -n 19
BUILD     = $(NICE) docker buildx build --builder $(BUILDER) --progress=plain
VENV      = .venv
E2E      ?= firefox chromium

.PHONY: all build site kvmd builder test test-c test-js test-int test-e2e repro serve clean

all: build

builder:
	@[ "$(BUILDER)" = default ] || docker buildx inspect $(BUILDER) >/dev/null 2>&1 || \
	  docker buildx create --name $(BUILDER) --driver docker-container \
	    --driver-opt "image=$(BUILDKIT),memory=2g,memory-swap=2g,cpu-quota=300000,cpu-period=100000,cpu-shares=128"

build: site kvmd

site: builder
	rm -rf dist/site
	$(BUILD) --target site --output type=local,dest=dist/site .

kvmd: builder
	$(BUILD) --target kvmd-out --output type=local,dest=dist .

test: test-c test-js test-int test-e2e

test-c: builder
	$(BUILD) --target test-c --output type=cacheonly .

test-js:
	$(LIMIT) node --test --test-timeout=30000 tests/js/*.test.mjs

test-int:
	$(LIMIT) node --test --test-concurrency=1 --test-timeout=300000 tests/integration/*.test.mjs

$(VENV)/bin/pytest: tests/e2e/requirements.txt
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r tests/e2e/requirements.txt
	touch $@

test-e2e: $(VENV)/bin/pytest
	for b in $(E2E); do $(LIMIT) $(VENV)/bin/pytest -c tests/e2e/pytest.ini tests/e2e --browser $$b -q || exit 1; done

repro: builder
	tools/repro.sh $(BUILDER)

serve:
	python3 -m http.server 8000 -b 127.0.0.1 -d dist/site

clean:
	rm -rf dist
