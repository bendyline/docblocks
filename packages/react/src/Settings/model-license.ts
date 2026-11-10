/**
 * Which model licenses are worth naming before a download.
 *
 * MIT and Apache 2.0 let anyone use, change and ship a model, commercially or
 * not, so naming them on a download row is noise. Every other license stays
 * visible and linked, because it can limit what the person may do with the
 * output: community licenses, RAIL use restrictions, non-commercial terms, a
 * modified MIT ("MIT-Modified"), or a combination ("CC BY 4.0; MIT License").
 * The match is exact after normalizing spelling, so none of those slip
 * through as "contains MIT".
 */

const UNREMARKABLE_LICENSES = new Set([
  'mit',
  'mit license',
  'the mit license',
  'apache 2.0',
  'apache 2.0 license',
  'apache license 2.0',
  'apache license version 2.0',
]);

/** Case, hyphens, commas and spacing vary across catalogs: `Apache-2.0`, `Apache 2.0`. */
function normalize(license: string): string {
  return license
    .trim()
    .toLowerCase()
    .replace(/[\s,_-]+/g, ' ');
}

/** True for MIT and Apache 2.0, which a download row leaves unsaid. */
export function isMitOrApacheLicense(license: string | null | undefined): boolean {
  return typeof license === 'string' && UNREMARKABLE_LICENSES.has(normalize(license));
}

/** The license a download row should name, or `null` when it goes without saying. */
export function shownModelLicense(license: string | null | undefined): string | null {
  return license && !isMitOrApacheLicense(license) ? license : null;
}
