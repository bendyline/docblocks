import { registerPlugin } from '@capacitor/core';
import type { MobileExportRequest, MobileFsRequest } from '@bendyline/docblocks/host/mobile';

/** The app's own native plugin (DocBlocksMobilePlugin on Android and iOS). */
export interface MobilePlugin {
  bootstrap(): Promise<unknown>;
  exportFile(options: { request: MobileExportRequest }): Promise<unknown>;
  request(options: { request: MobileFsRequest }): Promise<unknown>;
  openExternal(options: { url: string }): Promise<void>;
  writeText(options: { text: string }): Promise<void>;
  backUnhandled(): Promise<void>;
  takeOpenRequests(): Promise<unknown>;
  pickFolder(): Promise<unknown>;
  forgetFolder(options: { workspaceId: string }): Promise<void>;
  /** Android only: the one-time choice between a shared folder and device storage. */
  chooseStorage(): Promise<unknown>;
  /** Android only: make a picked folder the workspace opened by default. */
  setDefaultFolder(options: { workspaceId: string }): Promise<void>;
  /** Android only: whether the native launch splash still covers the page. */
  splashHeld(): Promise<{ held: boolean }>;
  /** Android only: let the native launch splash go. */
  releaseSplash(): Promise<void>;
}

export const native = registerPlugin<MobilePlugin>('DocBlocksMobile');
