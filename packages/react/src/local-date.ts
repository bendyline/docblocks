/**
 * `YYYY-MM-DD` for the calendar day `date` falls on where the person is.
 *
 * `toISOString().slice(0, 10)` is the UTC day: every evening west of
 * Greenwich it reads as tomorrow (and every morning east of it as yesterday),
 * which is how a report filed on the 15th came to say the 16th.
 */
export function localDateStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The build date to show. A full timestamp (what the surfaces now stamp)
 * becomes the viewer's local calendar day; a bare `YYYY-MM-DD` is shown as
 * given, since parsing it would land on UTC midnight and shift it a day.
 */
export function displayBuildDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : localDateStamp(instant);
}
