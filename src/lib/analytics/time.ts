import type { TimeGrain } from "./semantic";

/** All date math is done on YYYY-MM-DD strings in UTC to avoid timezone drift. */

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(s: string, n: number): string {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function startOfMonth(s: string): string {
  return `${s.slice(0, 7)}-01`;
}

export function addMonths(s: string, n: number): string {
  const d = toDate(startOfMonth(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fmt(d);
}

export function endOfMonth(s: string): string {
  return addDays(addMonths(s, 1), -1);
}

/** Monday of the ISO week containing s. */
export function startOfWeek(s: string): string {
  const dow = (toDate(s).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(s, -dow);
}

export function startOfQuarter(s: string): string {
  const m = Number(s.slice(5, 7));
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${s.slice(0, 4)}-${String(qm).padStart(2, "0")}-01`;
}

/** Bucket key for a date at the given grain (ISO date of the bucket start). */
export function bucketStart(s: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return s;
    case "week":
      return startOfWeek(s);
    case "month":
      return startOfMonth(s);
    case "quarter":
      return startOfQuarter(s);
  }
}

export function nextBucket(s: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return addDays(s, 1);
    case "week":
      return addDays(s, 7);
    case "month":
      return addMonths(s, 1);
    case "quarter":
      return addMonths(s, 3);
  }
}

/** Every bucket between two dates (inclusive), so empty periods show as zero, not as gaps. */
export function enumerateBuckets(from: string, to: string, grain: TimeGrain): string[] {
  const out: string[] = [];
  for (let b = bucketStart(from, grain); b <= to; b = nextBucket(b, grain)) out.push(b);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function bucketLabel(s: string, grain: TimeGrain): string {
  const y = s.slice(0, 4);
  const m = Number(s.slice(5, 7));
  switch (grain) {
    case "day":
      return s;
    case "week":
      return `Wk of ${MONTHS[m - 1]} ${Number(s.slice(8, 10))}`;
    case "month":
      return `${MONTHS[m - 1]} ${y}`;
    case "quarter":
      return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  }
}

export const TIME_PRESETS = [
  "all_time",
  "last_n_days",
  "last_n_weeks",
  "last_n_months",
  "previous_month",
  "current_month",
  "previous_quarter",
  "current_quarter",
  "year_to_date",
  "custom",
] as const;
export type TimePreset = (typeof TIME_PRESETS)[number];

export interface TimeRangeInput {
  preset: TimePreset;
  n: number | null;
  start: string | null;
  end: string | null;
}

export interface ResolvedRange {
  start: string | null;
  end: string | null;
  description: string;
}

/**
 * Resolve a relative preset against the dataset's as-of date (latest order).
 * "Last N months/weeks" = N full calendar periods ending with the as-of period.
 * "Previous month" = the full calendar month before the as-of month.
 */
export function resolveTimeRange(input: TimeRangeInput, asOf: string): ResolvedRange {
  const n = Math.max(1, Math.floor(input.n ?? 1));
  switch (input.preset) {
    case "all_time":
      return { start: null, end: null, description: "All time" };
    case "last_n_days":
      return { start: addDays(asOf, -(n - 1)), end: asOf, description: `Last ${n} day${n > 1 ? "s" : ""} up to ${asOf}` };
    case "last_n_weeks": {
      const start = addDays(startOfWeek(asOf), -7 * (n - 1));
      return { start, end: addDays(startOfWeek(asOf), 6), description: `Last ${n} calendar week${n > 1 ? "s" : ""} (Mon–Sun)` };
    }
    case "last_n_months": {
      const start = addMonths(asOf, -(n - 1));
      return { start, end: endOfMonth(asOf), description: `Last ${n} calendar month${n > 1 ? "s" : ""}` };
    }
    case "previous_month": {
      const start = addMonths(asOf, -1);
      return { start, end: endOfMonth(start), description: `Previous calendar month (${bucketLabel(start, "month")})` };
    }
    case "current_month":
      return { start: startOfMonth(asOf), end: endOfMonth(asOf), description: `Current month (${bucketLabel(asOf, "month")})` };
    case "previous_quarter": {
      const start = addMonths(startOfQuarter(asOf), -3);
      return { start, end: addDays(startOfQuarter(asOf), -1), description: `Previous quarter (${bucketLabel(start, "quarter")})` };
    }
    case "current_quarter": {
      const start = startOfQuarter(asOf);
      return { start, end: addDays(addMonths(start, 3), -1), description: `Current quarter (${bucketLabel(start, "quarter")})` };
    }
    case "year_to_date":
      return { start: `${asOf.slice(0, 4)}-01-01`, end: asOf, description: `Year to date (${asOf.slice(0, 4)})` };
    case "custom": {
      const start = input.start ?? null;
      const end = input.end ?? null;
      return { start, end, description: `Custom: ${start ?? "beginning"} → ${end ?? "latest"}` };
    }
  }
}
