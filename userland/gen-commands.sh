#!/bin/sh
# Turn content/*.txt into commands.
#   gen-commands.sh <content-dir> <rootfs>
# content/NAME.txt becomes
#   - a shell function NAME in /etc/profile.d/20-commands.sh: the text is
#     inside the already-running shell, so it prints with no exec and no
#     disk read at all;
#   - /usr/bin/NAME for non-interactive use (sh -c NAME, scripts).
# content/motd.txt becomes /etc/motd.
set -eu
src=$1 root=$2
funcs=$root/etc/profile.d/20-commands.sh
mkdir -p "$root/etc/profile.d" "$root/usr/bin" "$root/usr/share/b0tn3t"
printf '# generated from content/*.txt by gen-commands.sh, do not edit\n' > "$funcs"

for f in "$src"/*.txt; do
  name=$(basename "$f" .txt)
  case $name in
    motd) cp "$f" "$root/etc/motd"; continue ;;
    *[!a-z0-9_-]*) echo "gen-commands: bad command name '$name'" >&2; exit 1 ;;
  esac
  quoted=$(sed "s/'/'\\\\''/g" "$f"; printf x)
  quoted=${quoted%x}
  printf "%s() { printf '%%s' '%s'; }\n" "$name" "$quoted" >> "$funcs"
  cp "$f" "$root/usr/share/b0tn3t/$name.txt"
  printf '#!/bin/sh\nexec cat /usr/share/b0tn3t/%s.txt\n' "$name" > "$root/usr/bin/$name"
  chmod 755 "$root/usr/bin/$name"
done
