import { isNodeErrorCode } from './node-error.js';

/**
 * Errnos that mean "this filesystem cannot create hard links at all", as
 * opposed to "this particular link was refused".
 *
 * Hard-link publication is an elegant atomic create-if-absent on NTFS and
 * ext4, but FAT32/exFAT and some SMB/network mounts have no hard-link concept.
 * POSIX specifies EPERM for "the filesystem does not support links", Linux
 * vfat returns EPERM, and Windows surfaces the same refusal for exFAT targets.
 * ENOSYS/ENOTSUP/EOPNOTSUPP appear on other non-linking mounts, EXDEV means the
 * two names are not on one filesystem, and EMLINK means the link count is
 * exhausted — in every case no link can be created, but an exclusive create
 * still can.
 *
 * EEXIST is deliberately absent: it means the target is genuinely occupied and
 * MUST still refuse rather than fall back. EACCES is likewise absent: it is a
 * genuine permission denial, not a missing filesystem feature.
 */
const LINK_UNSUPPORTED_CODES: readonly string[] = [
  'EPERM',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EXDEV',
  'EMLINK',
];

/** True when `error` proves the filesystem cannot publish through a hard link. */
export function isLinkUnsupportedError(error: unknown): boolean {
  return isNodeErrorCode(error, LINK_UNSUPPORTED_CODES);
}
