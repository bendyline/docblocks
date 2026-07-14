import { getFileSystemProviderV2, type FileSystemProvider } from './types.js';
import { parseWorkspacePath } from './workspace-path.js';

export type FileSystemPathPresence = 'present' | 'missing' | 'unknown';

export interface FileSystemPartialMoveState {
  readonly source: FileSystemPathPresence;
  readonly destination: FileSystemPathPresence;
  readonly companionSource: FileSystemPathPresence;
  readonly companionDestination: FileSystemPathPresence;
}

export type FileSystemMoveLocation = 'source' | 'destination' | 'both' | 'neither' | 'unknown';

export interface FileSystemEntryMoveState {
  readonly source: FileSystemPathPresence;
  readonly destination: FileSystemPathPresence;
}

function locationFromPresence(
  source: FileSystemPathPresence,
  destination: FileSystemPathPresence,
): FileSystemMoveLocation {
  if (source === 'unknown' || destination === 'unknown') return 'unknown';
  if (source === 'present' && destination === 'present') return 'both';
  if (source === 'present') return 'source';
  if (destination === 'present') return 'destination';
  return 'neither';
}

/**
 * One provider move failed without restoring a provable source-only state.
 * This is backend-neutral: callers must use `location`, never infer from the
 * original exception or a provider's advertised move atomicity.
 */
export class FileSystemMoveRecoveryError extends Error {
  public readonly code = 'partial-move' as const;

  public constructor(
    public readonly sourcePath: string,
    public readonly destinationPath: string,
    public readonly state: FileSystemEntryMoveState,
    public readonly moveError: unknown,
  ) {
    super(
      `The move did not restore one authoritative path. Entry location: ${locationFromPresence(
        state.source,
        state.destination,
      )}.`,
    );
    this.name = 'FileSystemMoveRecoveryError';
  }

  public get location(): FileSystemMoveLocation {
    return locationFromPresence(this.state.source, this.state.destination);
  }

  /** Alias used by DocumentSession's document-retarget recovery protocol. */
  public get documentLocation(): FileSystemMoveLocation {
    return this.location;
  }
}

/**
 * A compound document/companion move failed and the document rollback also
 * failed. Callers must use the recorded post-state instead of assuming the
 * original path is still authoritative.
 */
export class FileSystemPartialMoveError extends Error {
  readonly code = 'partial-move' as const;

  constructor(
    readonly sourcePath: string,
    readonly destinationPath: string,
    readonly companionSourcePath: string,
    readonly companionDestinationPath: string,
    readonly state: FileSystemPartialMoveState,
    readonly moveError: unknown,
    readonly rollbackError: unknown,
  ) {
    super(
      `The document move could not be rolled back. Document location: ${locationFromPresence(
        state.source,
        state.destination,
      )}; companion location: ${locationFromPresence(
        state.companionSource,
        state.companionDestination,
      )}.`,
    );
    this.name = 'FileSystemPartialMoveError';
  }

  get documentLocation(): FileSystemMoveLocation {
    return locationFromPresence(this.state.source, this.state.destination);
  }

  get companionLocation(): FileSystemMoveLocation {
    return locationFromPresence(this.state.companionSource, this.state.companionDestination);
  }
}

export function isFileSystemPartialMoveError(error: unknown): error is FileSystemPartialMoveError {
  return error instanceof FileSystemPartialMoveError;
}

export function isFileSystemMoveRecoveryError(
  error: unknown,
): error is FileSystemMoveRecoveryError {
  return error instanceof FileSystemMoveRecoveryError;
}

export function isFileSystemMoveStateError(
  error: unknown,
): error is FileSystemMoveRecoveryError | FileSystemPartialMoveError {
  return isFileSystemMoveRecoveryError(error) || isFileSystemPartialMoveError(error);
}

async function probePath(
  provider: FileSystemProvider,
  path: string,
): Promise<FileSystemPathPresence> {
  try {
    const providerV2 = getFileSystemProviderV2(provider);
    const present = providerV2
      ? (await providerV2.stat(parseWorkspacePath(path))) !== null
      : await provider.exists(path);
    return present ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}

export async function describePartialMove(
  provider: FileSystemProvider,
  sourcePath: string,
  destinationPath: string,
  companionSourcePath: string,
  companionDestinationPath: string,
): Promise<FileSystemPartialMoveState> {
  const [source, destination, companionSource, companionDestination] = await Promise.all([
    probePath(provider, sourcePath),
    probePath(provider, destinationPath),
    probePath(provider, companionSourcePath),
    probePath(provider, companionDestinationPath),
  ]);
  return { source, destination, companionSource, companionDestination };
}

export async function describeEntryMove(
  provider: FileSystemProvider,
  sourcePath: string,
  destinationPath: string,
): Promise<FileSystemEntryMoveState> {
  const [source, destination] = await Promise.all([
    probePath(provider, sourcePath),
    probePath(provider, destinationPath),
  ]);
  return { source, destination };
}
