/** Keep a user-edited target name while switching the selected export format. */
export function updateExportTargetExtension(targetPath: string, suggestedFilename: string): string {
  const nextExtension = extensionOf(suggestedFilename);
  if (!nextExtension) return targetPath;
  if (!targetPath.trim()) return suggestedFilename;

  const suffixIndex = firstSuffixIndex(targetPath);
  const pathPart = suffixIndex === -1 ? targetPath : targetPath.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : targetPath.slice(suffixIndex);
  const separatorIndex = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  const dotIndex = pathPart.lastIndexOf('.');
  const stem = dotIndex > separatorIndex ? pathPart.slice(0, dotIndex) : pathPart;
  return `${stem}${nextExtension}${suffix}`;
}

function extensionOf(value: string): string {
  const suffixIndex = firstSuffixIndex(value);
  const pathPart = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  const separatorIndex = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  const dotIndex = pathPart.lastIndexOf('.');
  return dotIndex > separatorIndex ? pathPart.slice(dotIndex) : '';
}

function firstSuffixIndex(value: string): number {
  const query = value.indexOf('?');
  const fragment = value.indexOf('#');
  if (query === -1) return fragment;
  if (fragment === -1) return query;
  return Math.min(query, fragment);
}
