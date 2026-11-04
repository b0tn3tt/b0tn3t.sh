# syntax=docker/dockerfile:1.7
#
# b0tn3t LFS: everything that ends up on the site is built here.
#
#   docker buildx build --target site --output type=local,dest=dist .
#
# Reproducibility: every base image is pinned by digest, every source by
# sha256 (ADD --checksum), every apk package by exact version, and all
# timestamps come from SOURCE_DATE_EPOCH. `make repro` builds twice and
# compares hashes.
# Caching: one stage per component, so editing the page or the text
# commands never rebuilds the kernel, busybox or micropython.

ARG SOURCE_DATE_EPOCH=1767225600
ARG I386_ALPINE=docker.io/i386/alpine:3.21@sha256:af1f32347969e4c5a282602cee5d6a28a624cb6ab5f8dc1105dc9780de4996d8
ARG NODE=docker.io/library/node:22-alpine@sha256:025b8e975a61d94e33abeafaad1255ef44e4898cf1a1b6446860009c72e6d284

ARG LINUX_VERSION=6.6.161
ARG LINUX_SHA256=7d34405be5cd4989b2a5e9cbefa798e3a175218901271e034af3fe4e840b71c6
ARG BUSYBOX_VERSION=1.37.0
ARG BUSYBOX_SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
ARG MICROPYTHON_VERSION=1.29.0
ARG MICROPYTHON_SHA256=d925a7c664e79a2bdf3dfcb285ba5e2237041cc35a0bd4ee573b6c5711efeca0

# ---------------------------------------------------------------- toolchain
FROM --platform=linux/386 ${I386_ALPINE} AS toolchain
RUN apk add --no-cache \
      gcc=14.2.0-r4 make=4.4.1-r2 musl-dev=1.2.5-r12 linux-headers=6.6-r1 \
      binutils=2.43.1-r3 bc=1.07.1-r5 flex=2.6.4-r6 bison=3.8.2-r1 \
      perl=5.40.4-r0 xz=5.8.4-r0 zstd=1.5.6-r2 python3=3.12.16-r0 \
      bzip2=1.0.8-r6 diffutils=3.10-r0 findutils=4.10.0-r0
ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    LC_ALL=C TZ=UTC \
    CFLAGS="-Os -march=i686 -mtune=generic -pipe -ffunction-sections -fdata-sections -fno-asynchronous-unwind-tables -fno-ident" \
    LDFLAGS="-static -Wl,--gc-sections -Wl,--build-id=none -s"

# ---------------------------------------------------------------- kernel
FROM toolchain AS linux-src
ARG LINUX_VERSION LINUX_SHA256
ADD --checksum=sha256:${LINUX_SHA256} https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${LINUX_VERSION}.tar.xz /tmp/linux.tar.xz
RUN mkdir -p /src && tar -xJf /tmp/linux.tar.xz -C /src && mv /src/linux-${LINUX_VERSION} /src/linux && rm /tmp/linux.tar.xz

FROM linux-src AS kernel
ENV KBUILD_BUILD_USER=b0tn3t KBUILD_BUILD_HOST=lfs KBUILD_BUILD_VERSION=1
COPY kernel/build.sh kernel/b0tn3t.config /kernel/
RUN export KBUILD_BUILD_TIMESTAMP="$(date -u -d @${SOURCE_DATE_EPOCH} '+%Y-%m-%d')" && \
    mkdir -p /out && sh /kernel/build.sh /src/linux /out/bzImage /kernel/b0tn3t.config

FROM scratch AS kernel-out
COPY --from=kernel /out/ /

# experimental: the same kernel with vmd built in (drivers/char/b0tn3t-vmd.c)
FROM linux-src AS kernel-kvmd
ENV KBUILD_BUILD_USER=b0tn3t KBUILD_BUILD_HOST=lfs KBUILD_BUILD_VERSION=1
COPY kernel/build.sh kernel/b0tn3t.config kernel/kvmd/ /kernel/
RUN cp /kernel/b0tn3t-vmd.c /src/linux/drivers/char/ && \
    sed -i '$ d' /src/linux/drivers/char/Kconfig && \
    printf 'config B0TN3T_VMD\n\tbool "b0tn3t.sh browser link (vmd) in the kernel"\n\tdepends on TTY\n\nendmenu\n' >> /src/linux/drivers/char/Kconfig && \
    echo 'obj-$(CONFIG_B0TN3T_VMD) += b0tn3t-vmd.o' >> /src/linux/drivers/char/Makefile && \
    echo 'CONFIG_B0TN3T_VMD=y' > /kernel/kvmd.config && \
    export KBUILD_BUILD_TIMESTAMP="$(date -u -d @${SOURCE_DATE_EPOCH} '+%Y-%m-%d')" && \
    mkdir -p /out && sh /kernel/build.sh /src/linux /out/bzImage-kvmd /kernel/b0tn3t.config /kernel/kvmd.config

FROM scratch AS kvmd-out
COPY --from=kernel-kvmd /out/bzImage-kvmd /

# ---------------------------------------------------------------- busybox
FROM toolchain AS busybox
ARG BUSYBOX_VERSION BUSYBOX_SHA256 JOBS=3
ADD --checksum=sha256:${BUSYBOX_SHA256} https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2 /tmp/bb.tar.bz2
COPY userland/busybox.config userland/kconfig-merge.py /build/
RUN mkdir -p /src && tar -xjf /tmp/bb.tar.bz2 -C /src && cd /src/busybox-${BUSYBOX_VERSION} && \
    export KCONFIG_NOTIMESTAMP=1 && \
    make -s allnoconfig >/dev/null && \
    python3 /build/kconfig-merge.py .config /build/busybox.config && \
    (yes "" | make -s oldconfig >/dev/null) && \
    python3 /build/kconfig-merge.py --check .config /build/busybox.config && \
    nice -n 19 make -s -j${JOBS} CONFIG_EXTRA_CFLAGS="$CFLAGS" CONFIG_EXTRA_LDFLAGS="$LDFLAGS" busybox && \
    make -s CONFIG_PREFIX=/out install >/dev/null && \
    rm -f /out/linuxrc && ls -la /out/bin/busybox

# ---------------------------------------------------------------- micropython
FROM toolchain AS micropython
ARG MICROPYTHON_VERSION MICROPYTHON_SHA256 JOBS=3
ADD --checksum=sha256:${MICROPYTHON_SHA256} https://github.com/micropython/micropython/releases/download/v${MICROPYTHON_VERSION}/micropython-${MICROPYTHON_VERSION}.tar.xz /tmp/mp.tar.xz
RUN mkdir -p /src && nice -n 19 tar -xJf /tmp/mp.tar.xz -C /src && rm /tmp/mp.tar.xz && \
    cd /src/micropython-${MICROPYTHON_VERSION} && \
    nice -n 19 make -s -j${JOBS} -C mpy-cross CFLAGS_EXTRA=-DMICROPY_FLOAT_USE_NATIVE_FLT16=0 && \
    nice -n 19 make -s -j${JOBS} -C ports/unix VARIANT=standard \
      MICROPY_PY_FFI=0 MICROPY_PY_SSL=0 MICROPY_PY_SOCKET=0 MICROPY_PY_BTREE=0 MICROPY_PY_THREAD=0 \
      COPT="-Os -DNDEBUG -march=i686 -fdata-sections -ffunction-sections -DMICROPY_FLOAT_USE_NATIVE_FLT16=0" \
      LDFLAGS_EXTRA="-static -Wl,--gc-sections -Wl,--build-id=none" && \
    mkdir -p /out && strip -o /out/micropython ports/unix/build-standard/micropython && ls -la /out

# ---------------------------------------------------------------- our tools
FROM toolchain AS tools
COPY src/ /src/
RUN mkdir -p /out && cd /src && \
    gcc $CFLAGS -Wall -Wextra -Werror -DVMD_VERSION='"1.0"' -o /out/vmd vmd.c proto.c sys.c util.c $LDFLAGS && \
    gcc $CFLAGS -Wall -Wextra -Werror -o /out/vm vm.c proto.c util.c $LDFLAGS && \
    gcc $CFLAGS -Wall -Wextra -Werror -o /out/fetch fetch.c $LDFLAGS && \
    ls -la /out

# C unit tests and the vmd <-> vm round trip, run on the real i386 target
FROM toolchain AS test-c
COPY src/ /src/
COPY tests/c/ /tests/c/
COPY --from=tools /out/ /tools/
RUN cd /tests/c && for t in test_*.c; do \
      gcc -O1 -g -Wall -Wextra -Werror -fsanitize=undefined -fsanitize-trap=undefined -fstack-protector-all \
        -I/src -o /tmp/${t%.c} $t /src/proto.c /src/sys.c /src/util.c && /tmp/${t%.c} || exit 1; done && \
    python3 /tests/c/vmd_roundtrip.py /tools/vmd /tools/vm && touch /ok

# ---------------------------------------------------------------- rootfs
FROM toolchain AS rootfs
COPY --from=busybox /out/ /rootfs/
COPY --from=micropython /out/micropython /rootfs/usr/bin/micropython
COPY --from=tools /out/vmd /rootfs/sbin/vmd
COPY --from=tools /out/vm /out/fetch /rootfs/usr/bin/
COPY rootfs/ /rootfs/
COPY content/ /content/
COPY userland/gen-commands.sh userland/mkfs9p.py /build/
RUN cd /rootfs && \
    mkdir -p dev proc sys run tmp root mnt usr/local/bin && \
    for n in python python3; do ln -sf micropython usr/bin/$n; done && \
    for n in neofetch fastfetch screenfetch pfetch; do ln -sf fetch usr/bin/$n; done && \
    ln -sf vm usr/bin/blog && \
    ln -sf /run/vmd/localtime etc/localtime && \
    sh /build/gen-commands.sh /content /rootfs && \
    chmod 755 etc/rc sbin/vmd usr/bin/vm usr/bin/fetch && \
    mkdir -p /out && python3 /build/mkfs9p.py /rootfs /out/fs.json /out/flat && \
    du -sh /rootfs /out/flat

FROM scratch AS rootfs-out
COPY --from=kernel /out/bzImage /bzImage
COPY --from=rootfs /out/ /

# ---------------------------------------------------------------- xterm.js
FROM toolchain AS xterm
ADD --checksum=sha256:908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6 https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz /pkg/xterm.tgz
ADD --checksum=sha256:26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0 https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz /pkg/addon-fit.tgz
ADD --checksum=sha256:bf463cfff1af4bb1903509830c62ed06bcd0589039f15ea5fba71d7bae5a86da https://registry.npmjs.org/@xterm/addon-web-links/-/addon-web-links-0.12.0.tgz /pkg/addon-web-links.tgz
ADD --checksum=sha256:b665667792f916873fe946ba98cc98a1a742af08e163fb66e1c0809c120ca42e https://registry.npmjs.org/@xterm/addon-unicode11/-/addon-unicode11-0.9.0.tgz /pkg/addon-unicode11.tgz
ADD --checksum=sha256:f9a290923dc9c6178446e3fc082c29812a7096a1664fd7bf904022c141c5bbfb https://registry.npmjs.org/@xterm/addon-serialize/-/addon-serialize-0.14.0.tgz /pkg/addon-serialize.tgz
ADD --checksum=sha256:b51c9ca08dfd1b35e1f1b833334497a9a8412110569b26e03cb6e1ab7341fb61 https://registry.npmjs.org/@xterm/addon-webgl/-/addon-webgl-0.19.0.tgz /pkg/addon-webgl.tgz
RUN mkdir -p /out && cd /pkg && \
    tar -xzf xterm.tgz -O package/lib/xterm.mjs > /out/xterm.mjs && \
    tar -xzf xterm.tgz -O package/css/xterm.css > /out/xterm.css && \
    tar -xzf xterm.tgz -O package/LICENSE > /out/LICENSE && \
    for a in fit web-links unicode11 serialize webgl; do \
      tar -xzf addon-$a.tgz -O package/lib/addon-$a.mjs | sed 's|//# sourceMappingURL=.*||' > /out/addon-$a.mjs; done && \
    sed -i 's|//# sourceMappingURL=.*||' /out/xterm.mjs && ls -la /out

# ---------------------------------------------------------------- warm state
# Boot the image once under Node with the page's own link code, warm the
# page cache, save the machine. Runs on the build host's arch (amd64).
FROM ${NODE} AS state
WORKDIR /b
COPY vendor/libv86.mjs vendor/v86.wasm vendor/seabios.bin vendor/vgabios.bin vendor/
COPY kernel/cmdline kernel/
COPY web/js/ web/js/
COPY tools/guest.mjs tools/warm.mjs tools/
COPY --from=kernel /out/bzImage /image/bzImage
COPY --from=rootfs /out/ /image/
ARG SOURCE_DATE_EPOCH
RUN SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} nice -n 19 node tools/warm.mjs /image /out && ls -la /out

# ---------------------------------------------------------------- image
FROM toolchain AS image
COPY --from=kernel /out/bzImage /image/bzImage
COPY --from=rootfs /out/ /image/
COPY --from=state /out/state.bin /out/screen.bin /out/mem /out/tick /image/
COPY kernel/cmdline /build/cmdline
COPY userland/manifest.py /build/
RUN nice -n 19 zstd -19 -q -T2 --rm /image/state.bin -o /image/state.bin.zst && \
    python3 /build/manifest.py /image "$(cat /image/mem)" 2 /build/cmdline && rm /image/mem

# ---------------------------------------------------------------- site
FROM scratch AS site
COPY web/index.html web/style.css /
COPY cat_paw_loading.gif /favicon.gif
COPY web/js/ /js/
COPY --from=xterm /out/ /vendor/xterm/
COPY vendor/libv86.mjs vendor/v86.wasm vendor/seabios.bin vendor/vgabios.bin /vendor/v86/
COPY --from=image /image/ /image/

# ---------------------------------------------------------------- reproducibility
# Everything that must be bit-for-bit identical between two clean builds
# (`make repro`). The warm snapshot is not here: it records a live
# machine, its bytes depend on timing.
FROM scratch AS repro
COPY --from=kernel /out/bzImage /kernel/
COPY --from=kernel-kvmd /out/bzImage-kvmd /kernel/
COPY --from=busybox /out/bin/busybox /bin/
COPY --from=micropython /out/micropython /bin/
COPY --from=tools /out/ /bin/
COPY --from=rootfs /out/ /rootfs/
COPY --from=xterm /out/ /xterm/
