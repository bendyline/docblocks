import path from 'node:path';

const DEVELOPMENT_DIRECTORY_NAME = 'DocBlocks-dev';

/** Names a throwaway profile root for a source build; `npm run app:new` sets it. */
export const DEVELOPMENT_PROFILE_ENV = 'DOCBLOCKS_DEV_PROFILE_DIR';

export interface DevelopmentProfilePaths {
  readonly userData: string;
  readonly documents: string;
}

/**
 * The userData and Documents folders a source build uses when it is pointed
 * at a throwaway profile, or null for the everyday DocBlocks-dev profile.
 * Documents moves too because the development workspace lives inside it.
 */
export function developmentProfileOverride(env: NodeJS.ProcessEnv): DevelopmentProfilePaths | null {
  const root = env[DEVELOPMENT_PROFILE_ENV]?.trim();
  if (!root) return null;
  const absoluteRoot = path.resolve(root);
  return {
    userData: path.join(absoluteRoot, 'userData'),
    documents: path.join(absoluteRoot, 'Documents'),
  };
}

export function isDevelopmentRuntime(isPackaged: boolean, nodeEnv: string | undefined): boolean {
  return !isPackaged && nodeEnv !== 'production';
}

export function developmentUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, DEVELOPMENT_DIRECTORY_NAME);
}

export function developmentWorkspacePath(documentsPath: string): string {
  return path.join(documentsPath, DEVELOPMENT_DIRECTORY_NAME);
}
