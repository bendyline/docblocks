export type SetupWebviewMessage =
  | { type: 'runChecks' }
  | { type: 'openNodeDownload' }
  | { type: 'installCli' }
  | { type: 'configureMcp' }
  | { type: 'initProject' };

/** Setup commands are a fixed capability list; no path, URL, or shell text crosses the boundary. */
export function parseSetupWebviewMessage(value: unknown): SetupWebviewMessage | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  switch (value.type) {
    case 'runChecks':
    case 'openNodeDownload':
    case 'installCli':
    case 'configureMcp':
    case 'initProject':
      return { type: value.type };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
