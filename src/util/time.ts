import type { Env } from '../env';

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function partsIn(tz: string, date: Date): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** Calendar day 'YYYY-MM-DD' in the given timezone. */
export function dayString(tz: string, date = new Date()): string {
  const p = partsIn(tz, date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Monday of the local calendar week, formatted as YYYY-MM-DD. */
export function weekStartString(tz: string, date = new Date()): string {
  const p = partsIn(tz, date);
  const isoWeekday = WEEKDAYS[p.weekday ?? ''] ?? 1;
  const localMidnight = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  return new Date(localMidnight - (isoWeekday - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Minutes since local midnight and ISO weekday (Mon=1..Sun=7) in the timezone. */
export function localNow(tz: string, date = new Date()): { minutesOfDay: number; isoWeekday: number } {
  const p = partsIn(tz, date);
  return {
    minutesOfDay: Number(p.hour) * 60 + Number(p.minute),
    isoWeekday: WEEKDAYS[p.weekday ?? ''] ?? 1,
  };
}

/** Timezone offset from UTC in minutes at the given instant (positive = ahead of UTC). */
function tzOffsetMinutes(tz: string, date: Date): number {
  const p = partsIn(tz, date);
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

export function parseWindow(window: string): { startMin: number; endMin: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return { startMin: 9 * 60, endMin: 17 * 60 };
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

export function parseDays(days: string): Set<number> {
  const set = new Set<number>();
  for (const part of days.split(',')) {
    const n = Number.parseInt(part.trim(), 10);
    if (n >= 1 && n <= 7) set.add(n);
  }
  return set.size > 0 ? set : new Set([1, 2, 3, 4, 5]);
}

/** True when "now" is inside the configured send window on an allowed day. */
export function isInSendWindow(env: Env, date = new Date()): boolean {
  const { startMin, endMin } = parseWindow(env.SEND_WINDOW);
  const days = parseDays(env.SEND_DAYS);
  const { minutesOfDay, isoWeekday } = localNow(env.TIMEZONE, date);
  return days.has(isoWeekday) && minutesOfDay >= startMin && minutesOfDay < endMin;
}

/**
 * Seconds until the NEXT window opening strictly in the future.
 * If we are currently inside the window (e.g. the daily cap was hit), this
 * returns the time to the next allowed day's window start.
 */
export function secondsToNextWindowOpen(env: Env, from = new Date()): number {
  const { startMin } = parseWindow(env.SEND_WINDOW);
  const days = parseDays(env.SEND_DAYS);
  const tz = env.TIMEZONE;
  const offsetMs = tzOffsetMinutes(tz, from) * 60000;

  for (let d = 0; d <= 8; d++) {
    const probe = new Date(from.getTime() + d * 86400000);
    const { minutesOfDay, isoWeekday } = localNow(tz, probe);
    if (!days.has(isoWeekday)) continue;
    if (d === 0 && minutesOfDay >= startMin) continue; // today's opening already passed (or in progress)
    const p = partsIn(tz, probe);
    const wallAsUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, startMin);
    const epoch = wallAsUTC - offsetMs;
    const seconds = Math.ceil((epoch - from.getTime()) / 1000);
    if (seconds > 0) return Math.max(60, seconds);
  }
  return 3600; // defensive fallback: try again in an hour
}
