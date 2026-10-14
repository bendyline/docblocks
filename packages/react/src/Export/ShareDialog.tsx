import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SHARED_DOCUMENT_LIMITS, type SharedDocumentMode } from '@bendyline/docblocks/share';
import {
  buildSharedDocumentQrUrl,
  buildSharedDocumentUrl,
  createSharedDocumentArchive,
  sharedDocumentQrFilename,
} from './shared-document.js';
import { qrPngDataUrlToBlob, renderSharedDocumentQrPng } from './share-qr.js';
import { Dialog } from '../components/Dialog.js';

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

export function ShareDialog({
  markdown,
  selectedFile,
  baseUrl,
  onClose,
}: ShareDialogProps): React.ReactElement {
  const [mode, setMode] = useState<SharedDocumentMode | ''>('');
  const [archive, setArchive] = useState<Uint8Array | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrRenderError, setQrRenderError] = useState<string | null>(null);
  const [qrCopyStatus, setQrCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
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

  const qrLinkResult = useMemo(() => {
    if (!archive) return { url: '', error: archiveError };
    try {
      return { url: buildSharedDocumentQrUrl(archive, mode || null), error: null };
    } catch (error: unknown) {
      return {
        url: '',
        error: error instanceof Error ? error.message : 'DocBlocks could not create the QR code.',
      };
    }
  }, [archive, archiveError, mode]);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrRenderError(null);
    setQrCopyStatus('idle');
    if (!qrLinkResult.url) return;

    void renderSharedDocumentQrPng(qrLinkResult.url)
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQrRenderError(
            error instanceof Error ? error.message : 'DocBlocks could not render the QR code.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [qrLinkResult.url]);

  useEffect(() => setCopyStatus('idle'), [linkResult.url]);

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

  const copyQrImage = useCallback(async () => {
    if (!qrDataUrl) return;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Image clipboard access is unavailable.');
      }
      const png = qrPngDataUrlToBlob(qrDataUrl);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setQrCopyStatus('copied');
    } catch {
      setQrCopyStatus('failed');
    }
  }, [qrDataUrl]);

  const saveQrImage = useCallback(() => {
    if (!qrDataUrl) return;
    const download = document.createElement('a');
    download.href = qrDataUrl;
    download.download = sharedDocumentQrFilename(selectedFile);
    download.style.display = 'none';
    document.body.append(download);
    download.click();
    download.remove();
  }, [qrDataUrl, selectedFile]);

  const isLong = linkResult.url.length > SHARED_DOCUMENT_LIMITS.portableUrlCharacters;
  const qrError = qrLinkResult.error ?? qrRenderError;

  return (
    <Dialog
      title="Share document"
      onClose={onClose}
      className="db-export-dialog db-share-dialog"
      footerClassName="db-export-footer"
      footer={
        <>
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
        </>
      }
    >
      <div className="db-share-warning" role="note">
        The text and formatting of this document are embedded in the URL. Anyone with the link can
        read the shared copy, so do not use it for secrets.
      </div>
      <p className="db-export-hint" role="note">
        Images are excluded from share links. Image descriptions are kept when available. Your
        original document is unchanged.
      </p>

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
          Without a default, the copied document opens in Write. Other choices open directly in Use.
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
              : 'Creating a link with the shared text and formatting...'}
        </span>
      </div>

      <section className="db-share-qr" aria-labelledby="db-share-qr-title">
        <div className="db-share-qr-heading">
          <div>
            <h3 id="db-share-qr-title">QR code</h3>
            <span className="db-export-hint">
              A self-contained docblocks.com link to the shared text. No document content is
              uploaded.
            </span>
          </div>
          <div className="db-share-qr-actions">
            <button
              className="db-export-btn db-export-btn--secondary"
              type="button"
              onClick={() => void copyQrImage()}
              disabled={!qrDataUrl}
            >
              {qrCopyStatus === 'copied'
                ? 'Copied QR'
                : qrCopyStatus === 'failed'
                  ? 'Copy unavailable'
                  : 'Copy QR image'}
            </button>
            <button
              className="db-export-btn db-export-btn--secondary"
              type="button"
              onClick={saveQrImage}
              disabled={!qrDataUrl}
            >
              Save QR PNG
            </button>
          </div>
        </div>

        {qrDataUrl ? (
          <img
            className="db-share-qr-image"
            src={qrDataUrl}
            alt="QR code for this shared DocBlocks document"
          />
        ) : (
          <div
            className={`db-share-qr-placeholder${qrError ? ' db-share-qr-placeholder--error' : ''}`}
            role={qrError ? 'note' : 'status'}
          >
            {qrError ?? 'Rendering QR code...'}
          </div>
        )}

        <span className="db-export-hint db-share-qr-status" aria-live="polite">
          {qrCopyStatus === 'failed'
            ? 'This browser could not copy the PNG. Save it instead.'
            : qrDataUrl
              ? `${qrLinkResult.url.length.toLocaleString()} of ${SHARED_DOCUMENT_LIMITS.qrUrlCharacters.toLocaleString()} supported QR characters.`
              : ''}
        </span>
      </section>

      <p className="db-share-temporary-note">
        Opening the link creates a temporary workspace. Changes there do not alter this document or
        the link.
      </p>
    </Dialog>
  );
}
