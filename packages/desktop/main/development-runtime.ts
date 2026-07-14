import path from 'node:path';

const DEVELOPMENT_DIRECTORY_NAME = 'DocBlocks-dev';

export function isDevelopmentRuntime(isPackaged: boolean, nodeEnv: string | undefined): boolean {
  return !isPackaged && nodeEnv !== 'production';
}

export function developmentUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, DEVELOPMENT_DIRECTORY_NAME);
}

export function developmentWorkspacePath(documentsPath: string): string {
  return path.join(documentsPath, DEVELOPMENT_DIRECTORY_NAME);
}
