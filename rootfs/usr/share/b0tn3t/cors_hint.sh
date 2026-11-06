# cors_hint <prog> <url>: why a request failed. The machine's network ends
# in the page, which fetch()es each URL; browsers only let a page read
# sites that allow it (CORS headers), so many sites stay out of reach.
cors_hint() {
  h=${2#*://}; h=${h%%/*}
  printf '%s: %s does not let web pages read it (no CORS), and this machine\n' "$1" "${h:-the site}" >&2
  printf '%*s  goes online through your browser. Try: curl ifconfig.me/ip, curl wttr.in/?format=3\n' "${#1}" "" >&2
}
