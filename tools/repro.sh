#!/bin/sh
# Build the deterministic artifacts twice from scratch and compare hashes.
#   tools/repro.sh [builder]
set -eu
builder=${1:-b0tn3t-lowprio}
out=dist/repro
rm -rf "$out"
for n in a b; do
  echo "repro: clean build $n" >&2
  nice -n 19 ionice -c3 docker buildx build --builder "$builder" --no-cache --build-arg CCACHE_DISABLE=1 --progress=quiet \
    --target repro --output "type=local,dest=$out/$n" .
  (cd "$out/$n" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$out/$n.sha256"
done
if diff -u "$out/a.sha256" "$out/b.sha256"; then
  echo "repro: identical, $(wc -l < "$out/a.sha256") files" >&2
  sha256sum "$out/a.sha256" >&2
else
  echo "repro: DIFFERENT" >&2
  exit 1
fi
