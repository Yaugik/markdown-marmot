import { FoundationServiceError } from "@/services/foundation/errors";

export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export type RecurrenceRule = {
  id: string;
  frequency: RecurrenceFrequency;
  intervalCount: number;
  byWeekday: number[];
  byMonthDay: number | null;
  localTime: string;
  timeZone: string;
  startsOn: string;
  endsOn: string | null;
  countLimit: number | null;
};

export type RecurrenceOccurrence = {
  occurrenceKey: string;
  localDate: string;
  scheduledFor: string;
  dstAdjustment: "exact" | "gap_forward" | "overlap_earlier";
};

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timePattern = /^(\d{2}):(\d{2})(?::\d{2})?$/;

function parseDate(value: string): { year: number; month: number; day: number } {
  const match = datePattern.exec(value);
  if (!match) throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence date is invalid.");
  }
  return { year, month, day };
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = timePattern.exec(value);
  if (!match) throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence time must use HH:mm.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence time is invalid.");
  }
  return { hour, minute };
}

function dateKey(parts: Pick<LocalParts, "year" | "month" | "day">) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function utcDate(value: string): Date {
  const parts = parseDate(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function addMonths(date: Date, amount: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));
}

function localPartsAt(instant: Date, timeZone: string): LocalParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new FoundationServiceError("VALIDATION_FAILED", "Time zone is not supported.", { timeZone });
  }
  const values = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: values.year!, month: values.month!, day: values.day!,
    hour: values.hour!, minute: values.minute!,
  };
}

function localStamp(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function equalLocal(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

export function zonedLocalToUtc(
  localDate: string,
  localTime: string,
  timeZone: string,
): { instant: Date; dstAdjustment: RecurrenceOccurrence["dstAdjustment"] } {
  const date = parseDate(localDate);
  const time = parseTime(localTime);
  const desired: LocalParts = { ...date, ...time };
  const naive = localStamp(desired);

  const exactMatches: Date[] = [];
  for (let deltaMinutes = -14 * 60; deltaMinutes <= 14 * 60; deltaMinutes += 15) {
    const candidate = new Date(naive + deltaMinutes * 60_000);
    if (equalLocal(localPartsAt(candidate, timeZone), desired)) exactMatches.push(candidate);
  }
  if (exactMatches.length > 0) {
    exactMatches.sort((left, right) => left.getTime() - right.getTime());
    return {
      instant: exactMatches[0]!,
      dstAdjustment: exactMatches.length > 1 ? "overlap_earlier" : "exact",
    };
  }

  // A nonexistent local time occurs during a forward DST transition. Resolve it by
  // selecting the first valid local minute after the requested wall-clock time.
  for (let deltaMinutes = 1; deltaMinutes <= 180; deltaMinutes += 1) {
    const shiftedLocal = new Date(naive + deltaMinutes * 60_000);
    const shiftedDate = dateKey({
      year: shiftedLocal.getUTCFullYear(),
      month: shiftedLocal.getUTCMonth() + 1,
      day: shiftedLocal.getUTCDate(),
    });
    const shiftedTime = `${String(shiftedLocal.getUTCHours()).padStart(2, "0")}:${String(shiftedLocal.getUTCMinutes()).padStart(2, "0")}`;
    const resolved = zonedLocalToUtcExact(shiftedDate, shiftedTime, timeZone);
    if (resolved) return { instant: resolved, dstAdjustment: "gap_forward" };
  }
  throw new FoundationServiceError("VALIDATION_FAILED", "The local recurrence time could not be resolved.", {
    localDate, localTime, timeZone,
  });
}

function zonedLocalToUtcExact(localDate: string, localTime: string, timeZone: string): Date | null {
  const date = parseDate(localDate);
  const time = parseTime(localTime);
  const desired: LocalParts = { ...date, ...time };
  const naive = localStamp(desired);
  const matches: Date[] = [];
  for (let deltaMinutes = -14 * 60; deltaMinutes <= 14 * 60; deltaMinutes += 15) {
    const candidate = new Date(naive + deltaMinutes * 60_000);
    if (equalLocal(localPartsAt(candidate, timeZone), desired)) matches.push(candidate);
  }
  matches.sort((left, right) => left.getTime() - right.getTime());
  return matches[0] ?? null;
}

function validateRule(rule: RecurrenceRule) {
  if (!Number.isInteger(rule.intervalCount) || rule.intervalCount < 1 || rule.intervalCount > 365) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence interval must be between 1 and 365.");
  }
  parseDate(rule.startsOn);
  if (rule.endsOn) parseDate(rule.endsOn);
  parseTime(rule.localTime);
  localPartsAt(new Date(), rule.timeZone);
  if (rule.byWeekday.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence weekdays must be between Sunday (0) and Saturday (6).");
  }
  if (rule.frequency === "weekly" && rule.byWeekday.length === 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Weekly recurrence requires at least one weekday.");
  }
  if (rule.frequency === "monthly" && (rule.byMonthDay === null || rule.byMonthDay < 1 || rule.byMonthDay > 31)) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Monthly recurrence requires a month day between 1 and 31.");
  }
}

export function expandRecurrence(
  rule: RecurrenceRule,
  windowStart: string,
  windowEnd: string,
  maximum = 500,
): RecurrenceOccurrence[] {
  validateRule(rule);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5000) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence expansion limit is invalid.");
  }
  const start = utcDate(rule.startsOn);
  const lower = utcDate(windowStart);
  const upper = utcDate(windowEnd);
  const ruleEnd = rule.endsOn ? utcDate(rule.endsOn) : null;
  if (upper < lower) throw new FoundationServiceError("VALIDATION_FAILED", "Recurrence window end precedes its start.");

  const dates: Date[] = [];
  if (rule.frequency === "daily") {
    for (let cursor = start; cursor <= upper; cursor = addDays(cursor, rule.intervalCount)) dates.push(cursor);
  } else if (rule.frequency === "weekly") {
    for (let cursor = start; cursor <= upper; cursor = addDays(cursor, 1)) {
      const elapsedDays = Math.floor((cursor.getTime() - start.getTime()) / 86_400_000);
      const week = Math.floor(elapsedDays / 7);
      if (week % rule.intervalCount === 0 && rule.byWeekday.includes(cursor.getUTCDay())) dates.push(cursor);
    }
  } else {
    for (let month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); month <= upper; month = addMonths(month, rule.intervalCount)) {
      const day = rule.byMonthDay!;
      const candidate = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day));
      if (candidate.getUTCMonth() === month.getUTCMonth() && candidate >= start) dates.push(candidate);
    }
  }

  const countLimit = rule.countLimit ?? Number.POSITIVE_INFINITY;
  const occurrences: RecurrenceOccurrence[] = [];
  let ordinal = 0;
  for (const date of dates) {
    if (ruleEnd && date > ruleEnd) break;
    ordinal += 1;
    if (ordinal > countLimit) break;
    if (date < lower || date > upper) continue;
    const localDate = dateKey({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    });
    const resolved = zonedLocalToUtc(localDate, rule.localTime, rule.timeZone);
    occurrences.push({
      occurrenceKey: `${rule.id}:${localDate}T${rule.localTime.slice(0, 5)}@${rule.timeZone}`,
      localDate,
      scheduledFor: resolved.instant.toISOString(),
      dstAdjustment: resolved.dstAdjustment,
    });
    if (occurrences.length >= maximum) break;
  }
  return occurrences;
}
