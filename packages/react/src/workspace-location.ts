/**
 * A workspace folder's location as Finder or File Explorer names it.
 *
 * iCloud Drive keeps its folders under `~/Library/Mobile Documents`, with
 * container ids such as `com~apple~CloudDocs` or
 * `iCloud~com~bendyline~docblocks/Documents` where people expect to read
 * "iCloud Drive" and an app's name. Only the start of the path is rewritten;
 * the folders inside it are left as they are. Any other location comes back
 * unchanged, so callers can apply this to every path they show.
 */

const ICLOUD_DRIVE = 'iCloud Drive';

/** iCloud Drive's own folder, as opposed to an app's folder inside it. */
const ICLOUD_DRIVE_CONTAINER = 'com~apple~CloudDocs';

/**
 * App folders whose Finder name the container id does not spell. Others are
 * named from the id's last part, which matches Finder for most apps.
 */
const APP_FOLDER_NAMES: Readonly<Record<string, string>> = {
  'iCloud~com~bendyline~docblocks': 'DocBlocks',
};

/** macOS, and the same layout on iOS under /private/var/mobile. */
const MAC_MOBILE_DOCUMENTS = /^.*?\/Library\/Mobile Documents\/([^/]+)(?:\/(.*))?$/u;

/** iCloud for Windows, which keeps iCloud Drive at %USERPROFILE%\iCloudDrive. */
const WINDOWS_ICLOUD_DRIVE = /^[a-z]:\\Users\\[^\\]+\\iCloudDrive(?:\\(.*))?$/iu;

function segments(rest: string | undefined, separator: string): string[] {
  return (rest ?? '').split(separator).filter((segment) => segment.length > 0);
}

function appFolderName(container: string): string {
  const known = APP_FOLDER_NAMES[container];
  if (known) return known;
  const last = container.split('~').at(-1) ?? '';
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : container;
}

function isAppContainer(name: string): boolean {
  return name.includes('~');
}

export function friendlyWorkspaceLocation(location: string): string {
  const mac = MAC_MOBILE_DOCUMENTS.exec(location);
  if (mac) {
    const [, container, rest] = mac;
    const inside = segments(rest, '/');
    if (container === ICLOUD_DRIVE_CONTAINER) {
      return [ICLOUD_DRIVE, ...inside].join('/');
    }
    // An app's folder in iCloud Drive is the `Documents` folder inside its
    // container. The rest of the container is hidden from Finder, so a path
    // into it has no friendlier name than its own.
    if (isAppContainer(container) && inside[0] === 'Documents') {
      return [ICLOUD_DRIVE, appFolderName(container), ...inside.slice(1)].join('/');
    }
    return location;
  }

  const windows = WINDOWS_ICLOUD_DRIVE.exec(location);
  if (windows) {
    const inside = segments(windows[1], '\\');
    if (inside[0] && isAppContainer(inside[0])) inside[0] = appFolderName(inside[0]);
    return [ICLOUD_DRIVE, ...inside].join('\\');
  }

  return location;
}
