// Toronto clock and calendar, for text the family reads and for pill times.
// Pure helpers, no Convex imports. Intl with timeZone handles EST and EDT.

export const TIME_ZONE = "America/Toronto";

function torontoParts(ms: number, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, ...options }).formatToParts(
    new Date(ms),
  );
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

// "2:14 PM"
export function torontoClock(ms: number): string {
  const p = torontoParts(ms, { hour: "numeric", minute: "2-digit" });
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

// "2:14:05 PM": the seconds let the daily summary tell how long the family took.
export function torontoClockWithSeconds(ms: number): string {
  const p = torontoParts(ms, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return `${p.hour}:${p.minute}:${p.second} ${p.dayPeriod}`;
}

// "14:05", the format pill times are stored in. h23 so midnight is "00", never "24".
export function torontoHHMM(ms: number): string {
  const p = torontoParts(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.hour}:${p.minute}`;
}

// "2026-11-21": the Toronto calendar day, so a pill is announced once per local day.
export function torontoDay(ms: number): string {
  const p = torontoParts(ms, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}
