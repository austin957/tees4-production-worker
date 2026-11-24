import { WorkerError } from './model.js';

const minuteMs = 60_000;
const protectedStart = 16 * 60 + 20;
const protectedEnd = 21 * 60 + 10;

const central = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

function centralParts(timestamp: number) {
  const fields = Object.fromEntries(central.formatToParts(timestamp).map(part => [part.type, Number(part.value)]));
  return {
    year: fields.year!, month: fields.month!, day: fields.day!,
    minuteOfDay: fields.hour! * 60 + fields.minute!,
  };
}

function centralAfternoon(year: number, month: number, day: number, minuteOfDay: number): number {
  const utcGuess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const local = centralParts(utcGuess);
  // Both the UTC guess and the target are on the same side of any Chicago DST transition.
  const offset = Date.UTC(local.year, local.month - 1, local.day, 0, local.minuteOfDay) - utcGuess;
  return utcGuess - offset;
}

export function protectedUntil(now: number): number | undefined {
  const { minuteOfDay } = centralParts(now);
  if (minuteOfDay < protectedStart || minuteOfDay >= protectedEnd) return undefined;
  return Math.floor(now / minuteMs) * minuteMs + (protectedEnd - minuteOfDay) * minuteMs;
}

export class ProductionWriteDeferred extends WorkerError {
  constructor(code: string, message: string, readonly retryAt: number) {
    super(code, message);
  }
}

export function assertSkuWindow(now: number): void {
  const until = protectedUntil(now);
  if (until !== undefined) {
    throw new ProductionWriteDeferred('HEXTOM_WINDOW', 'Initial SKU writes are deferred until 9:10 PM America/Chicago.', until);
  }
}

export function assertExportWindow(now: number, marginMinutes: number | undefined): void {
  const until = protectedUntil(now);
  if (until !== undefined) {
    throw new ProductionWriteDeferred('MOCKUPIFY_WINDOW', 'Mockupify exports are deferred until 9:10 PM America/Chicago.', until);
  }
  if (marginMinutes === undefined || !Number.isSafeInteger(marginMinutes) || marginMinutes < 1) {
    throw new ProductionWriteDeferred(
      'EXPORT_MARGIN_REQUIRED', 'Configure TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES before starting a new export.', now + minuteMs,
    );
  }
  const { year, month, day, minuteOfDay } = centralParts(now);
  const cutoffDay = day + Number(minuteOfDay >= protectedEnd);
  const cutoff = centralAfternoon(year, month, cutoffDay, protectedStart);
  if (marginMinutes >= (cutoff - now) / minuteMs) {
    const resume = centralAfternoon(year, month, cutoffDay, protectedEnd);
    throw new ProductionWriteDeferred(
      'EXPORT_SAFETY_MARGIN', 'Insufficient time before the next protected window. Mockupify exports resume at 9:10 PM America/Chicago.',
      resume,
    );
  }
}
