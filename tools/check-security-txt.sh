#!/bin/sh
# Days left before each live security.txt expires (RFC 9116 Expires).
# Prints "<url> <days>" per file, or "<url> unreachable"/"<url> no-expires";
# exits 1 if any is unreachable, has no Expires, or has fewer than $MIN_DAYS left.
MIN_DAYS=${MIN_DAYS:-30}
now=$(date -u +%s); bad=0
for url in "$@"; do
  body=$(curl -fsS --max-time 30 "$url" 2>/dev/null) || { echo "$url unreachable"; bad=1; continue; }
  exp=$(printf '%s\n' "$body" | sed -n 's/^Expires: *//p' | head -1)
  t=$(date -u -d "$exp" +%s 2>/dev/null) || { echo "$url no-expires"; bad=1; continue; }
  days=$(( (t - now) / 86400 ))
  echo "$url $days"
  [ "$days" -lt "$MIN_DAYS" ] && bad=1
done
exit $bad
