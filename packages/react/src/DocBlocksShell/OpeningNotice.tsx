import type { OpeningNoticeState } from './useOpeningNotice.js';

/** Says which document is still opening, and after a while, why it may be slow. */
export function OpeningNotice({ notice }: { notice: OpeningNoticeState | null }) {
  if (!notice) return null;
  return (
    <div className="db-opening-notice" role="status" aria-live="polite">
      <span className="db-ai-spinner" aria-hidden="true" />
      <span>
        {notice.slow
          ? `Still opening “${notice.name}”. If it's stored in OneDrive, iCloud, or another sync service, it may be downloading first.`
          : `Opening “${notice.name}”…`}
      </span>
    </div>
  );
}
