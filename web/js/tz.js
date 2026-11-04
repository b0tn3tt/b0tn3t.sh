// POSIX TZ rule for an IANA zone, from what Intl knows about it.
// The guest has no tz database: vmd writes this rule into /etc/localtime.
//
//   Asia/Almaty      -> <+05>-5
//   Asia/Kolkata     -> <+0530>-5:30
//   Europe/Berlin    -> <+01>-1<+02>,M3.5.0,M10.5.0/3
//   America/New_York -> <-05>5<-04>,M3.2.0,M11.1.0

const MIN = 60000;
const DAY = 86400000;

// UTC offset in minutes (east positive) of `zone` at instant `t`
export function offsetAt(zone, t) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(new Date(t));
  const get = (type) => +parts.find((p) => p.type === type).value;
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((local - Math.floor(t / MIN) * MIN) / MIN);
}

const pad2 = (n) => String(n).padStart(2, "0");

// "<+0530>" style name for an offset
export function abbr(off) {
  const a = Math.abs(off);
  return `<${off < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}${a % 60 ? pad2(a % 60) : ""}>`;
}

// POSIX offset: hours west of UTC, so the sign is flipped
export function posixOffset(off) {
  const a = Math.abs(off);
  const h = Math.floor(a / 60), m = a % 60;
  return `${off > 0 ? "-" : ""}${h}${m ? ":" + pad2(m) : ""}`;
}

// Find the instants in `year` where the offset changes (to the minute).
export function transitions(zone, year) {
  const start = Date.UTC(year, 0, 1);
  const out = [];
  let prev = offsetAt(zone, start);
  for (let d = 1; d <= 366; d++) {
    const t = start + d * DAY;
    const off = offsetAt(zone, t);
    if (off === prev) continue;
    let lo = t - DAY, hi = t;
    while (hi - lo > MIN) {
      const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
      if (offsetAt(zone, mid) === prev) lo = mid; else hi = mid;
    }
    out.push({ at: hi, from: prev, to: off });
    prev = off;
  }
  return out;
}

// "Mm.w.d[/time]" for a transition, in local time before the change
export function rule(tr, year) {
  const local = new Date(tr.at + tr.from * MIN);
  const month = local.getUTCMonth(), day = local.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const week = day + 7 > daysInMonth ? 5 : Math.ceil(day / 7);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const time = mins === 120 ? "" : "/" + Math.floor(mins / 60) + (mins % 60 ? ":" + pad2(mins % 60) : "");
  return `M${month + 1}.${week}.${local.getUTCDay()}${time}`;
}

export function posixTZ(zone, year = new Date().getUTCFullYear()) {
  const tr = transitions(zone, year);
  if (tr.length !== 2) {
    const now = offsetAt(zone, Date.UTC(year, 6, 1));
    return abbr(now) + posixOffset(now);
  }
  const std = Math.min(tr[0].from, tr[0].to);
  const dst = Math.max(tr[0].from, tr[0].to);
  const toDst = tr.find((t) => t.to === dst);
  const toStd = tr.find((t) => t.to === std);
  return abbr(std) + posixOffset(std) + abbr(dst) + (dst - std === 60 ? "" : posixOffset(dst)) +
    "," + rule(toDst, year) + "," + rule(toStd, year);
}

export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
