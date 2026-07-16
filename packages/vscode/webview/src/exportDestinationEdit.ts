import { isSafeExportFilename } from '@bendyline/docblocks/vscode';

export interface ExportDestinationEditResult {
  filename: string | null;
  error: string | null;
}

/**
 * Validate a webview edit without treating the displayed path as authority.
 * An existing opaque grant authorizes the host to derive one sibling basename;
 * changing its displayed parent still requires VS Code's native picker.
 */
export function validateExportDestinationEdit(
  value: string,
  grantedDisplayLabel: string | null,
  suggestedFilename: string,
): ExportDestinationEditResult {
  const edited = splitDisplayLabel(value);

  if (grantedDisplayLabel) {
    const granted = splitDisplayLabel(grantedDisplayLabel);
    const isBasenameOnly = edited.parent === '' && edited.suffix === '';
    if (!isBasenameOnly && (edited.parent !== granted.parent || edited.suffix !== granted.suffix)) {
      return invalid(
        'Only the file name can be edited here. Use ... to choose a different folder.',
      );
    }
  } else if (edited.parent || edited.suffix) {
    return invalid('Enter a file name only. Use ... to choose a folder.');
  }

  if (!isSafeExportFilename(edited.filename)) {
    return invalid('Enter a valid file name without path separators or invalid characters.');
  }

  const expectedExtension = extensionOf(suggestedFilename);
  if (!expectedExtension || extensionOf(edited.filename).toLowerCase() !== expectedExtension) {
    return invalid(
      `The file name must end in ${expectedExtension || 'the selected format extension'}.`,
    );
  }

  return { filename: edited.filename, error: null };
}

function splitDisplayLabel(value: string): {
  parent: string;
  filename: string;
  suffix: string;
} {
  const suffixIndex = firstSuffixIndex(value);
  const pathPart = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : value.slice(suffixIndex);
  const separatorIndex = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  return {
    parent: separatorIndex === -1 ? '' : pathPart.slice(0, separatorIndex + 1),
    filename: pathPart.slice(separatorIndex + 1),
    suffix,
  };
}

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot > 0 ? value.slice(dot).toLowerCase() : '';
}

function firstSuffixIndex(value: string): number {
  const query = value.indexOf('?');
  const fragment = value.indexOf('#');
  if (query === -1) return fragment;
  if (fragment === -1) return query;
  return Math.min(query, fragment);
}

function invalid(error: string): ExportDestinationEditResult {
  return { filename: null, error };
}
