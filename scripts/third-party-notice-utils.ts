export interface NoticePackageManifest {
  readonly homepage?: unknown;
  readonly repository?: unknown;
}

function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

export function normalizeNoticeText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

export function noticeTextMatches(actual: string, expected: string): boolean {
  return normalizeNoticeText(actual) === normalizeNoticeText(expected);
}

export function repositoryUrl(
  manifest: NoticePackageManifest | null,
  name: string,
  platformConstrained: boolean,
): string {
  if (platformConstrained) return npmPackageUrl(name);

  const repository = manifest?.repository;
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' &&
          repository !== null &&
          !Array.isArray(repository) &&
          'url' in repository &&
          typeof repository.url === 'string'
        ? repository.url
        : typeof manifest?.homepage === 'string'
          ? manifest.homepage
          : null;
  if (!raw) return npmPackageUrl(name);
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw)) return `https://github.com/${raw}`;
  return raw
    .replace(/^git\+https:/u, 'https:')
    .replace(/^git:\/\/github\.com\//u, 'https://github.com/')
    .replace(/\.git$/u, '');
}
