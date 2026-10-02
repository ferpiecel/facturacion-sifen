const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Asuncion',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Calendar and clock fields of an instant in Paraguay time, independent of the runtime's locale data. */
function asuncion(iso: string, offsetSeconds = 0) {
  const date = new Date(Date.parse(iso) + offsetSeconds * 1000);
  const parts = Object.fromEntries(PARTS.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
    hms: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/** `02/10/2026 15:42` in Paraguay time. */
export function formatIssuedAt(iso: string, offsetSeconds = 0): string {
  const { date, hm } = asuncion(iso, offsetSeconds);
  return `${date} ${hm}`;
}

/** `15:42:01` in Paraguay time, `offsetSeconds` after the instant. */
export function formatClock(iso: string, offsetSeconds = 0): string {
  return asuncion(iso, offsetSeconds).hms;
}

/** `2026-10-02T15:42:00`, the local form of the XML date fields. */
export function formatXmlDateTime(iso: string): string {
  const { isoDate, hms } = asuncion(iso);
  return `${isoDate}T${hms}`;
}

/** IVA 10% included in a gross total (total / 11), rounded to the Guaraní. */
export function iva10(total: number): number {
  return Math.round(total / 11);
}
