/**
 * Linux desktop-entry policy for packaged DocBlocks artifacts.
 *
 * electron-builder's AppImage target writes `Exec=AppRun --no-sandbox %U` into
 * the embedded desktop entry whenever `appImage.executableArgs` is absent, so
 * every menu, file-association, and protocol launch would start Chromium with
 * process sandboxing disabled. `scripts/check-electron-builder-config.ts`
 * forbids that configuration; this module proves it on the shipped bytes,
 * because the flag is generated at package time rather than written by us.
 *
 * The embedded AppRun script keeps its own conditional fallback: it probes
 * `unshare -Ur true` and adds the flag only on hosts without usable user
 * namespaces. That is a runtime decision, not a launcher default, so it is
 * deliberately out of scope here.
 */

/** Chromium flags that turn off OS-level process isolation. */
export const SANDBOX_DISABLING_ARGUMENTS: readonly string[] = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--disable-namespace-sandbox',
  '--disable-seccomp-filter-sandbox',
];

export interface DesktopEntry {
  /** Where the entry was read from, for failure messages. */
  readonly source: string;
  readonly text: string;
}

export interface LauncherViolation {
  readonly source: string;
  readonly detail: string;
}

/**
 * Read the `Exec=` value from the `[Desktop Entry]` group.
 *
 * Freedesktop entries are grouped INI: later groups such as `[Desktop Action …]`
 * carry their own `Exec=` keys, and only the main group's value is used for an
 * ordinary launch. Returns null when the group or key is absent.
 */
export function desktopEntryExec(text: string): string | null {
  let inDesktopEntryGroup = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.length === 0) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inDesktopEntryGroup = line === '[Desktop Entry]';
      continue;
    }
    if (!inDesktopEntryGroup) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() !== 'Exec') continue;
    return line.slice(separator + 1).trim();
  }
  return null;
}

/**
 * Split an `Exec=` value into its arguments.
 *
 * The freedesktop spec quotes reserved characters with double quotes and
 * escapes with backslashes; electron-builder emits quoted arguments through
 * `desktopExecArgEscape`, so an unquoted scan would miss `"--no-sandbox"`.
 */
export function desktopExecArguments(exec: string): readonly string[] {
  const argumentList: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (let index = 0; index < exec.length; index += 1) {
    const character = exec[index];
    if (character === '\\' && index + 1 < exec.length) {
      index += 1;
      current += exec[index];
      started = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      if (started) argumentList.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) argumentList.push(current);
  return argumentList;
}

/**
 * Check one desktop entry against the launcher policy. A missing `Exec=` key is
 * a violation rather than a pass: an entry we cannot read is an entry we cannot
 * clear, and every packaged launcher is expected to declare one.
 */
export function desktopEntryViolations(entry: DesktopEntry): readonly LauncherViolation[] {
  const exec = desktopEntryExec(entry.text);
  if (exec === null) {
    return [{ source: entry.source, detail: 'no [Desktop Entry] Exec= key was found' }];
  }

  const violations: LauncherViolation[] = [];
  for (const argument of desktopExecArguments(exec)) {
    if (!SANDBOX_DISABLING_ARGUMENTS.includes(argument)) continue;
    violations.push({
      source: entry.source,
      detail: `launches with ${argument}, which disables the Chromium sandbox: ${exec}`,
    });
  }
  return violations;
}

/**
 * Check every packaged launcher. Requiring a non-empty entry list is what stops
 * an empty or mis-globbed artifact directory from reporting success.
 */
export function launcherViolations(entries: readonly DesktopEntry[]): readonly LauncherViolation[] {
  if (entries.length === 0) {
    return [{ source: '(no artifacts)', detail: 'no packaged desktop entries were inspected' }];
  }
  return entries.flatMap((entry) => desktopEntryViolations(entry));
}

/**
 * Byte offset of the filesystem image appended to an AppImage.
 *
 * A type-2 AppImage is an ELF runtime with a SquashFS image concatenated after
 * the section headers, which is where `AppRun` and the desktop entry live.
 */
export function appImageFilesystemOffset(header: Buffer): number {
  if (header.length < 64 || header.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error('not an ELF executable, so it is not a type-2 AppImage');
  }
  if (header[4] !== 2) {
    throw new Error('only 64-bit AppImage runtimes are supported');
  }
  if (header[5] !== 1) {
    throw new Error('only little-endian AppImage runtimes are supported');
  }
  const sectionHeaderOffset = Number(header.readBigUInt64LE(0x28));
  const sectionHeaderSize = header.readUInt16LE(0x3a);
  const sectionHeaderCount = header.readUInt16LE(0x3c);
  const offset = sectionHeaderOffset + sectionHeaderSize * sectionHeaderCount;
  if (!Number.isSafeInteger(offset) || offset <= 0) {
    throw new Error('AppImage ELF section headers do not describe a filesystem offset');
  }
  return offset;
}

/** SquashFS superblock magic (`hsqs`), verified at the computed offset. */
export const SQUASHFS_MAGIC = 0x73717368;

export function isSquashfsSuperblock(magic: Buffer): boolean {
  return magic.length >= 4 && magic.readUInt32LE(0) === SQUASHFS_MAGIC;
}

/**
 * Members of a Debian archive. `.deb` is a plain `ar` archive whose member
 * headers are fixed-width ASCII, so the data tarball can be located without a
 * dependency. GNU `ar` stores short names with a trailing slash; BSD `ar` does
 * not, and the two disagree about which tools can read the other's output.
 */
export interface ArchiveMember {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export function parseArMembers(archive: Buffer): readonly ArchiveMember[] {
  if (archive.subarray(0, 8).toString('ascii') !== '!<arch>\n') {
    throw new Error('not an ar archive, so it is not a Debian package');
  }
  const members: ArchiveMember[] = [];
  let cursor = 8;
  while (cursor + 60 <= archive.length) {
    const header = archive.subarray(cursor, cursor + 60);
    if (header.subarray(58, 60).toString('ascii') !== '`\n') {
      throw new Error(`corrupt ar member header at byte ${cursor}`);
    }
    const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/u, '');
    const size = Number.parseInt(header.subarray(48, 58).toString('ascii').trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`corrupt ar member size for ${name}`);
    }
    const offset = cursor + 60;
    members.push({ name, offset, size });
    // Members are padded to an even boundary.
    cursor = offset + size + (size % 2);
  }
  return members;
}
