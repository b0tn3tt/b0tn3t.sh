#!/bin/sh
# Build a minimal i386 bzImage for v86.
#   build.sh <linux-src> <out-bzImage> <fragment>...
# Every fragment line "CONFIG_X=y|n|value" is verified after olddefconfig,
# so a silently dropped option fails the build instead of shipping.
set -eu
src=$1 out=$2
shift 2
cd "$src"
export ARCH=i386
make -s tinyconfig
scripts/kconfig/merge_config.sh -m -O . .config "$@" >/dev/null
make -s olddefconfig

fail=0
for frag in "$@"; do
  grep -E '^CONFIG_[A-Z0-9_]+=' "$frag" | while IFS='=' read -r key val; do
    if [ "$val" = n ]; then
      if grep -q "^$key=" .config; then echo "kernel: $key wanted off, got $(grep "^$key=" .config)"; exit 1; fi
    elif ! grep -qx "$key=$val" .config; then
      echo "kernel: $key=$val missing (have: $(grep "^$key=\|# $key " .config || echo nothing))"; exit 1
    fi
  done || fail=1
done
[ "$fail" = 0 ]

# ccache when it is there (the Docker build mounts its cache), plain gcc otherwise
cc=gcc
command -v ccache >/dev/null && cc="ccache gcc"
nice -n 19 make -s -j"${JOBS:-3}" CC="$cc" bzImage
cp arch/x86/boot/bzImage "$out"
cp .config "$out.config"
