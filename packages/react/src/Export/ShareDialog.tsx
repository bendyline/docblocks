import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SHARED_DOCUMENT_LIMITS, type SharedDocumentMode } from '@bendyline/docblocks/share';
import { buildSharedDocumentUrl, createSharedDocumentArchive } from './shared-document.js';

export interface ShareDialogProps {
  markdown: string;
  selectedFile: string | null;
  baseUrl: string;
  onClose: () => void;
}

const MODES: ReadonlyArray<{ value: SharedDocumentMode | ''; label: string }> = [
  { value: '', label: 'Write (no default)' },
  { value: 'slideshow', label: 'Slideshow' },
  { value: 'video', label: 'Video' },
  { value: 'page', label: 'Page' },
  { value: 'document', label: 'Document' },
  { value: 'narrate', label: 'Narrate' },
];

export function ShareDialog({ markdown, selectedFile, baseUrl, onClose }: ShareDialogProps) {
  const [mode, setMode] = useState<SharedDocumentMode | ''>('');
  const [archive, setArchive] = useState<Uint8Array | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const linkRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setArchive(null);
    setArchiveError(null);
    void createSharedDocumentArchive(markdown, selectedFile)
      .then((nextArchive) => {
        if (!cancelled) setArchive(nextArchive);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setArchiveError(
            error instanceof Error ? error.message : 'DocBlocks could not create the shared link.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [markdown, selectedFile]);

  const linkResult = useMemo(() => {
    if (!archive) return { url: '', error: archiveError };
    try {
      return { url: buildSharedDocumentUrl(baseUrl, archive, mode || null), error: null };
    } catch (error: unknown) {
      return {
        url: '',
        error:
          error instanceof Error ? error.message : 'DocBlocks could not create the shared link.',
      };
    }
  }, [archive, archiveError, baseUrl, mode]);

  useEffect(() => setCopyStatus('idle'), [linkResult.url]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const copyLink = useCallback(async () => {
    if (!linkResult.url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(linkResult.url);
      } else {
        linkRef.current?.focus();
        linkRef.current?.select();
        if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) {
          throw new Error('Clipboard access is unavailable.');
        }
      }
      setCopyStatus('copied');
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopyStatus('failed');
    }
  }, [linkResult.url]);

  const isLong = linkResult.url.length > SHARED_DOCUMENT_LIMITS.portableUrlCharacters;

  return (
    <div
      className="db-dialog-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="db-dialog db-export-dialog db-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-share-dialog-title"
      >
        <div className="db-dialog-header">
          <h2 className="db-dialog-title" id="db-share-dialog-title">
            Share document via URL
          </h2>
          <button className="db-dialog-close" type="button" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="db-dialog-body">
          <div className="db-share-warning" role="note">
            The contents of this document are embedded in the URL. Anyone with the link receives a
            copy of the document, so do not use it for secrets.
          </div>

          <div className="db-export-field">
            <label className="db-export-label" htmlFor="db-share-mode">
              Default mode (optional)
            </label>
            <select
              id="db-share-mode"
              className="db-export-select"
              value={mode}
              onChange={(event) => setMode(event.target.value as SharedDocumentMode | '')}
            >
              {MODES.map((option) => (
                <option key={option.value || 'write'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="db-export-hint">
              Without a default, the copied document opens in Write. Other choices open directly in
              Use.
            </span>
          </div>

          <div className="db-export-field">
            <label className="db-export-label" htmlFor="db-share-link">
              Share link
            </label>
            <textarea
              ref={linkRef}
              id="db-share-link"
              className="db-share-link"
              value={linkResult.url}
              readOnly
              rows={3}
              spellCheck={false}
              aria-describedby="db-share-link-status"
              placeholder={linkResult.error ? '' : 'Creating link...'}
            />
            <span
              id="db-share-link-status"
              className={`db-export-hint${isLong ? ' db-share-length-warning' : ''}`}
            >
              {linkResult.error
                ? linkResult.error
                : linkResult.url
                  ? isLong
                    ? `${linkResult.url.length.toLocaleString()} characters. Links longer than 4,096 characters may be truncated by messaging or email tools.`
                    : `${linkResult.url.length.toLocaleString()} characters.`
                  : 'Compressing this document into a Markdown-only DBK...'}
            </span>
          </div>

          <p className="db-share-temporary-note">
            Opening the link creates a temporary workspace. Changes there do not alter this document
            or the link.
          </p>
        </div>

        <div className="db-export-footer">
          <button
            className="db-export-btn db-export-btn--secondary"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="db-export-btn db-export-btn--primary"
            type="button"
            onClick={() => void copyLink()}
            disabled={!linkResult.url}
          >
            {copyStatus === 'copied'
              ? 'Copied'
              : copyStatus === 'failed'
                ? 'Select and copy'
                : 'Copy link'}
          </button>
        </div>
      </div>
    </div>
  );
}
