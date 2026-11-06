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
# commands never rebuilds the kernel, busybox or micropython. On top of the
# layers, BuildKit cache mounts keep the apk download cache, a ccache for
# the kernel and micropython (a config change recompiles only what changed) and
# the zstd-compressed rootfs blobs (an unchanged file is never recompressed).
# `make repro` sets CCACHE_DISABLE=1 so its two builds stay independent.

ARG SOURCE_DATE_EPOCH=1767225600
ARG I386_ALPINE=docker.io/i386/alpine:3.21@sha256:af1f32347969e4c5a282602cee5d6a28a624cb6ab5f8dc1105dc9780de4996d8
ARG NODE=docker.io/library/node:22-alpine@sha256:025b8e975a61d94e33abeafaad1255ef44e4898cf1a1b6446860009c72e6d284

ARG LINUX_VERSION=6.6.161
ARG LINUX_SHA256=7d34405be5cd4989b2a5e9cbefa798e3a175218901271e034af3fe4e840b71c6
ARG BUSYBOX_VERSION=1.37.0
ARG BUSYBOX_SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
ARG MICROPYTHON_VERSION=1.29.0
ARG MICROPYTHON_SHA256=d925a7c664e79a2bdf3dfcb285ba5e2237041cc35a0bd4ee573b6c5711efeca0
ARG IPROUTE2_VERSION=6.19.0
ARG IPROUTE2_SHA256=9332213d35480b647086a70c302de8568de83455a98774d35de216c4ce191006
ARG NCURSES_VERSION=6.5
ARG NCURSES_SHA256=136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6
ARG HTOP_VERSION=3.5.3
ARG HTOP_SHA256=a8b164386494cb85bb255a415a3f5f80afe7a0c4491da5d113b3a0f951087e65
ARG NCDU_VERSION=1.22
ARG NCDU_SHA256=0ad6c096dc04d5120581104760c01b8f4e97d4191d6c9ef79654fa3c691a176b
# tinycc has had no release since 0.9.27 (2017, no musl); a pinned mob commit
ARG TCC_COMMIT=2ba12e83b3599ca8f5d50c179fe5138fe956f0c9
ARG TCC_SHA256=4eb5f0266d4d9deabe9650abedc3f0261dc06295f89ad798bb495abf680dc074
ARG PDPMAKE_VERSION=2.0.4
ARG PDPMAKE_SHA256=7e19294d54edf360591d76d3b7a0a511864902ac3a75a0b5b11c7b3cae14c13f

# ---------------------------------------------------------------- toolchain
FROM --platform=linux/386 ${I386_ALPINE} AS toolchain
RUN --mount=type=cache,target=/etc/apk/cache,id=apk-i386,sharing=locked \
    apk add ccache=4.10.2-r0 \
      gcc=14.2.0-r4 make=4.4.1-r2 musl-dev=1.2.5-r12 linux-headers=6.6-r1 \
      binutils=2.43.1-r3 bc=1.07.1-r5 flex=2.6.4-r6 bison=3.8.2-r1 \
      perl=5.40.4-r0 xz=5.8.4-r0 zstd=1.5.6-r2 python3=3.12.16-r0 \
      bzip2=1.0.8-r6 diffutils=3.10-r0 findutils=4.10.0-r0
ARG SOURCE_DATE_EPOCH
ARG CCACHE_DISABLE=
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    CCACHE_DISABLE=${CCACHE_DISABLE} CCACHE_DIR=/ccache CCACHE_MAXSIZE=1G \
    CCACHE_COMPILERCHECK=content CCACHE_NOHASHDIR=1 \
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
RUN --mount=type=cache,target=/ccache,id=ccache-i386,sharing=locked \
    export KBUILD_BUILD_TIMESTAMP="$(date -u -d @${SOURCE_DATE_EPOCH} '+%Y-%m-%d')" && \
    mkdir -p /out && sh /kernel/build.sh /src/linux /out/bzImage /kernel/b0tn3t.config

FROM scratch AS kernel-out
COPY --from=kernel /out/ /

# experimental: the same kernel with vmd built in (drivers/char/b0tn3t-vmd.c)
FROM linux-src AS kernel-kvmd
ENV KBUILD_BUILD_USER=b0tn3t KBUILD_BUILD_HOST=lfs KBUILD_BUILD_VERSION=1
COPY kernel/build.sh kernel/b0tn3t.config kernel/kvmd/ /kernel/
RUN --mount=type=cache,target=/ccache,id=ccache-i386,sharing=locked \
    cp /kernel/b0tn3t-vmd.c /src/linux/drivers/char/ && \
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
# no ccache here: it changed busybox's bytes (kernel and micropython come
# out identical with it), and busybox only takes seconds to build
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
RUN --mount=type=cache,target=/ccache,id=ccache-i386,sharing=locked \
    mkdir -p /src && nice -n 19 tar -xJf /tmp/mp.tar.xz -C /src && rm /tmp/mp.tar.xz && \
    cd /src/micropython-${MICROPYTHON_VERSION} && \
    nice -n 19 make -s -j${JOBS} -C mpy-cross CC="ccache gcc" CFLAGS_EXTRA=-DMICROPY_FLOAT_USE_NATIVE_FLT16=0 && \
    nice -n 19 make -s -j${JOBS} -C ports/unix VARIANT=standard CC="ccache gcc" \
      MICROPY_PY_FFI=0 MICROPY_PY_SSL=0 MICROPY_PY_SOCKET=0 MICROPY_PY_BTREE=0 MICROPY_PY_THREAD=0 \
      COPT="-Os -DNDEBUG -march=i686 -fdata-sections -ffunction-sections -DMICROPY_FLOAT_USE_NATIVE_FLT16=0" \
      LDFLAGS_EXTRA="-static -Wl,--gc-sections -Wl,--build-id=none" && \
    mkdir -p /out && strip -o /out/micropython ports/unix/build-standard/micropython && ls -la /out

# ---------------------------------------------------------------- iproute2
# the real `ip` (colors, -br, -j, every object); only lib/ and ip/ are built
FROM toolchain AS iproute2
ARG IPROUTE2_VERSION IPROUTE2_SHA256 JOBS=3
ADD --checksum=sha256:${IPROUTE2_SHA256} https://mirrors.edge.kernel.org/pub/linux/utils/net/iproute2/iproute2-${IPROUTE2_VERSION}.tar.xz /tmp/ipr.tar.xz
RUN mkdir -p /src /out && tar -xJf /tmp/ipr.tar.xz -C /src && cd /src/iproute2-${IPROUTE2_VERSION} && \
    ./configure >/dev/null && \
    nice -n 19 make -s -j${JOBS} CCOPTS="$CFLAGS" LDFLAGS="$LDFLAGS" SUBDIRS="lib ip" 2>&1 | grep -v 'warning\|^ *CC\|^ *LINK\|^ *AR' || true; \
    cp ip/ip /out/ip && ls -la /out

# ---------------------------------------------------------------- ncurses, htop, ncdu
# A small static ncursesw: -Os with gc-sections (Alpine's ncurses-static is
# neither) and no terminfo database at all: xterm-256color, xterm, vt100
# and linux are compiled in, so nothing is read from disk.
FROM toolchain AS ncurses
ARG NCURSES_VERSION NCURSES_SHA256 JOBS=3
RUN --mount=type=cache,target=/etc/apk/cache,id=apk-i386,sharing=locked \
    apk add ncurses=6.5_p20241006-r3 ncurses-terminfo-base=6.5_p20241006-r3 pkgconf=2.3.0-r0
ADD --checksum=sha256:${NCURSES_SHA256} https://ftp.gnu.org/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz /tmp/nc.tar.gz
RUN mkdir -p /src && tar -xzf /tmp/nc.tar.gz -C /src && cd /src/ncurses-${NCURSES_VERSION} && \
    ./configure -q --prefix=/opt/nc --without-cxx --without-cxx-binding --without-ada --without-progs \
      --without-tests --without-manpages --enable-widec --disable-database \
      --with-fallbacks=xterm-256color,xterm,vt100,linux --without-shared --with-normal --without-debug \
      --without-profile --disable-home-terminfo --without-gpm --without-dlsym --disable-termcap \
      --without-trace --disable-leaks --enable-pc-files --with-pkg-config-libdir=/opt/nc/lib/pkgconfig --disable-stripping >/dev/null 2>&1 && \
    nice -n 19 make -s -j${JOBS} >/dev/null 2>&1 && make -s install >/dev/null 2>&1 && ls /opt/nc/lib
ENV NC_CPPFLAGS="-I/opt/nc/include/ncursesw -I/opt/nc/include" NC_LDFLAGS="-L/opt/nc/lib" PKG_CONFIG_PATH=/opt/nc/lib/pkgconfig

FROM ncurses AS htop
ARG HTOP_VERSION HTOP_SHA256 JOBS=3
ADD --checksum=sha256:${HTOP_SHA256} https://github.com/htop-dev/htop/releases/download/${HTOP_VERSION}/htop-${HTOP_VERSION}.tar.xz /tmp/htop.tar.xz
RUN mkdir -p /src /out && tar -xJf /tmp/htop.tar.xz -C /src && cd /src/htop-${HTOP_VERSION} && \
    CPPFLAGS="$NC_CPPFLAGS" LDFLAGS="$LDFLAGS $NC_LDFLAGS" LIBS=-lncursesw ./configure -q --enable-static \
      --disable-hwloc --disable-sensors --disable-capabilities --disable-delayacct --disable-affinity && \
    nice -n 19 make -s -j${JOBS} 2>&1 | grep -v warning || true; cp htop /out/ && ls -la /out

FROM ncurses AS ncdu
ARG NCDU_VERSION NCDU_SHA256 JOBS=3
ADD --checksum=sha256:${NCDU_SHA256} https://dev.yorhel.nl/download/ncdu-${NCDU_VERSION}.tar.gz /tmp/ncdu.tar.gz
RUN mkdir -p /src /out && tar -xzf /tmp/ncdu.tar.gz -C /src && cd /src/ncdu-${NCDU_VERSION} && \
    CPPFLAGS="$NC_CPPFLAGS" LDFLAGS="$LDFLAGS $NC_LDFLAGS" ./configure -q --with-ncursesw && \
    nice -n 19 make -s -j${JOBS} && cp ncdu /out/ && ls -la /out

# ---------------------------------------------------------------- C in the machine
# tcc with musl's headers and libc.a, and pdpmake as `make`. There is no
# dynamic loader in the machine, so tcc links statically by default.
FROM toolchain AS cdev
ARG TCC_COMMIT TCC_SHA256 PDPMAKE_VERSION PDPMAKE_SHA256 JOBS=3
ADD --checksum=sha256:${TCC_SHA256} https://github.com/TinyCC/tinycc/archive/${TCC_COMMIT}.tar.gz /tmp/tcc.tar.gz
ADD --checksum=sha256:${PDPMAKE_SHA256} https://github.com/rmyorston/pdpmake/archive/refs/tags/${PDPMAKE_VERSION}.tar.gz /tmp/pdpmake.tar.gz
RUN mkdir -p /src /out/usr/bin && tar -xzf /tmp/tcc.tar.gz -C /src && cd /src/tinycc-${TCC_COMMIT} && \
    sed -i '/^LIBTCCAPI TCCState \*tcc_new(void)/,/^}/ s/^\(\s*\)s->gnu_ext = 1;/&\n\1s->static_link = 1; \/* b0tn3t: no dynamic loader *\//' libtcc.c && \
    grep -q 'b0tn3t: no dynamic loader' libtcc.c && \
    ./configure --prefix=/usr --cpu=i386 --config-musl --triplet= --crtprefix=/usr/lib \
      --libpaths=/usr/lib/tcc:/usr/lib --extra-cflags="$CFLAGS" --extra-ldflags="$LDFLAGS" >/dev/null && \
    nice -n 19 make -s -j${JOBS} >/dev/null 2>&1 && make -s DESTDIR=/out install >/dev/null 2>&1 && \
    rm -rf /out/usr/share /out/usr/include /out/usr/lib/libtcc.a /out/usr/lib/tcc/bcheck.o && \
    # musl's libc.a was built by gcc and calls two libgcc helpers tcc lacks
    cd /tmp && ar x "$(gcc -print-libgcc-file-name)" _divmoddi4.o _udivmoddi4.o && \
    ar rcsD /out/usr/lib/tcc/libtcc1.a _divmoddi4.o _udivmoddi4.o && \
    # musl-dev: headers, crt objects and static libraries (no libc.so: no loader)
    apk info -qL musl-dev | grep -v -e 'libc\.so$' -e 'crt1\.o$' -e '^$' | tar -C / -cf - -T - | tar -C /out -xf - && \
    cp /usr/lib/crt1.o /out/usr/lib/ && strip --strip-debug /out/usr/lib/*.a && \
    ln -s tcc /out/usr/bin/cc && ln -s tcc /out/usr/bin/c99 && \
    mkdir -p /src/pdpmake && tar -xzf /tmp/pdpmake.tar.gz -C /src/pdpmake --strip-components=1 && cd /src/pdpmake && \
    nice -n 19 make -s CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" && cp make /out/usr/bin/make && \
    find /out -exec touch -h -d @${SOURCE_DATE_EPOCH} {} + && du -sh /out && find /out -type f | xargs ls -la | sort -k5 -n | tail -6

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
COPY --from=iproute2 /out/ip /rootfs/sbin/ip
COPY --from=htop /out/htop /rootfs/usr/bin/htop
COPY --from=ncdu /out/ncdu /rootfs/usr/bin/ncdu
COPY --from=cdev /out/ /rootfs/
COPY rootfs/ /rootfs/
COPY content/ /content/
COPY userland/gen-commands.sh userland/mkfs9p.py /build/
COPY userland/bin/ /build/bin/
RUN --mount=type=cache,target=/zcache,id=rootfs-zst \
    cd /rootfs && \
    # curl and wget: shell wrappers that send everything over plain HTTP
    # (the page's fetch() does the HTTPS), replacing busybox's wget link
    for f in /build/bin/*; do rm -f usr/bin/${f##*/}; install -m 755 $f usr/bin/; done && \
    mkdir -p dev proc sys run tmp root mnt usr/local/bin && \
    for n in python python3; do ln -sf micropython usr/bin/$n; done && \
    for n in neofetch fastfetch screenfetch pfetch; do ln -sf fetch usr/bin/$n; done && \
    ln -sf vm usr/bin/blog && \
    ln -sf /run/vmd/localtime etc/localtime && \
    sh /build/gen-commands.sh /content /rootfs && \
    chmod 755 etc/rc sbin/vmd usr/bin/vm usr/bin/fetch && \
    mkdir -p /out && python3 /build/mkfs9p.py /rootfs /out/fs.json /out/flat --cache=/zcache && \
    du -sh /rootfs /out/flat

FROM scratch AS rootfs-out
COPY --from=kernel /out/bzImage /bzImage
COPY --from=rootfs /out/ /

# ---------------------------------------------------------------- xterm.js
FROM toolchain AS xterm
ADD --checksum=sha256:908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6 https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz /pkg/xterm.tgz
ADD --checksum=sha256:26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0 https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz /pkg/addon-fit.tgz
ADD --checksum=sha256:b665667792f916873fe946ba98cc98a1a742af08e163fb66e1c0809c120ca42e https://registry.npmjs.org/@xterm/addon-unicode11/-/addon-unicode11-0.9.0.tgz /pkg/addon-unicode11.tgz
ADD --checksum=sha256:f9a290923dc9c6178446e3fc082c29812a7096a1664fd7bf904022c141c5bbfb https://registry.npmjs.org/@xterm/addon-serialize/-/addon-serialize-0.14.0.tgz /pkg/addon-serialize.tgz
ADD --checksum=sha256:b51c9ca08dfd1b35e1f1b833334497a9a8412110569b26e03cb6e1ab7341fb61 https://registry.npmjs.org/@xterm/addon-webgl/-/addon-webgl-0.19.0.tgz /pkg/addon-webgl.tgz
RUN mkdir -p /out && cd /pkg && \
    tar -xzf xterm.tgz -O package/lib/xterm.mjs > /out/xterm.mjs && \
    tar -xzf xterm.tgz -O package/css/xterm.css > /out/xterm.css && \
    tar -xzf xterm.tgz -O package/LICENSE > /out/LICENSE && \
    for a in fit unicode11 serialize webgl; do \
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
# The page's own files get ?v=<hash of all of them> on every URL that
# loads code or styles (index.html, imports): a browser never mixes a
# cached old module with a new one, and needs no reload after an update.
FROM toolchain AS web
COPY web/index.html web/style.css /w/
COPY web/js/ /w/js/
COPY --from=xterm /out/ /w/vendor/xterm/
COPY vendor/libv86.mjs vendor/v86.wasm vendor/seabios.bin vendor/vgabios.bin /w/vendor/v86/
RUN cd /w && v=$(find . -type f | LC_ALL=C sort | xargs cat | sha256sum | cut -c1-12) && \
    sed -i -E "s#((from|import\() *\"\.\.?/[^\"?]+\.m?js)\"#\1?v=$v\"#g" js/*.js && \
    sed -i -E "s#((href|src)=\"(js/app\.js|style\.css|vendor/xterm/xterm\.css))\"#\1?v=$v\"#g" index.html && \
    grep -q "app.js?v=$v" index.html && grep -q "settings.js?v=$v" js/app.js

FROM scratch AS site
COPY --from=web /w/ /
COPY cat_paw_loading.gif /favicon.gif
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
