import type { OnBeforeSendHeadersListenerDetails } from 'electron';

type OnlineVideoRequestDetails = Pick<
  OnBeforeSendHeadersListenerDetails,
  'url' | 'resourceType' | 'requestHeaders'
>;

/**
 * YouTube refuses an embed whose request carries no `Referer` ("Error 153:
 * Video player configuration error"). Chromium never sends one from the
 * packaged app:// renderer, because a referrer must be an http(s) URL, so the
 * player frame arrives anonymous. YouTube asks apps without a web origin to
 * identify themselves with a Referer whose domain is the application ID —
 * electron-builder.yml's `appId`.
 */
export const DESKTOP_APP_REFERRER = 'https://com.bendyline.docblocks/';

/** Player frame requests that must identify the app. */
const PLAYER_FRAMES = [
  { origin: 'https://www.youtube-nocookie.com', path: '/embed/' },
  { origin: 'https://www.youtube.com', path: '/embed/' },
] as const;

/** Player request patterns for `webRequest.onBeforeSendHeaders` filters. */
export const ONLINE_VIDEO_REFERRER_URLS = PLAYER_FRAMES.map(
  ({ origin, path }) => `${origin}${path}*`,
);

/**
 * Request headers for a player frame that Chromium sent without a Referer, or
 * null to leave the request unchanged. A request that already names its
 * referrer (the development renderer on http://localhost) keeps it.
 */
export function onlineVideoRequestHeaders(
  details: OnlineVideoRequestDetails,
): Record<string, string> | null {
  if (details.resourceType !== 'subFrame') return null;

  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }
  const isPlayerFrame = PLAYER_FRAMES.some(
    ({ origin, path }) => url.origin === origin && url.pathname.startsWith(path),
  );
  if (!isPlayerFrame) return null;

  const hasReferrer = Object.keys(details.requestHeaders).some(
    (name) => name.toLowerCase() === 'referer',
  );
  if (hasReferrer) return null;

  return { ...details.requestHeaders, Referer: DESKTOP_APP_REFERRER };
}
