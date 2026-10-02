const ISSUED_AT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Asuncion',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `02/10/2026 15:42` in Paraguay time, independent of the runtime's locale data. */
export function formatIssuedAt(iso: string): string {
  const parts = Object.fromEntries(
    ISSUED_AT.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/** IVA 10% included in a gross total (total / 11), rounded to the Guaraní. */
export function iva10(total: number): number {
  return Math.round(total / 11);
}
