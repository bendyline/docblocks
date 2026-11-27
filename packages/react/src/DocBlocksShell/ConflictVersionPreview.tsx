import React, { Component, useMemo, type ReactNode } from 'react';
import { LinearDocView } from '@bendyline/squisq-react/page';
import { markdownToDoc, resolveThemeForDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';

/** A version's exact text, for files that are not Markdown and as the fallback for those that are. */
export function VersionText({ label, content }: { label: string; content: string }) {
  return (
    <textarea
      className="db-conflict-preview"
      aria-label={`${label} preview`}
      value={content}
      readOnly
      spellCheck={false}
    />
  );
}

interface RenderBoundaryProps {
  /** A new value clears a caught error: a changed version gets another try. */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

class RenderBoundary extends Component<RenderBoundaryProps, { failed: boolean; resetKey: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: RenderBoundaryProps,
    state: { failed: boolean; resetKey: string },
  ): { failed: boolean; resetKey: string } | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * One version as the editor's preview draws it. A version that cannot be
 * parsed or drawn falls back to its exact text: every version must stay
 * readable, or there is nothing to choose between.
 */
export function RenderedVersion({
  label,
  content,
  defaultThemeId,
}: {
  label: string;
  content: string;
  defaultThemeId?: string;
}) {
  const rendered = useMemo(() => {
    try {
      const doc = markdownToDoc(parseMarkdown(content));
      // The workspace default applies only when the version names no theme.
      return { doc, theme: resolveThemeForDoc(doc, doc.themeId ? undefined : defaultThemeId) };
    } catch {
      return null;
    }
  }, [content, defaultThemeId]);
  const text = <VersionText label={label} content={content} />;
  if (!rendered) return text;
  return (
    <RenderBoundary resetKey={content} fallback={text}>
      <div
        className="db-conflict-preview db-conflict-preview--rendered"
        role="region"
        aria-label={`${label} preview`}
        tabIndex={0}
        style={{ background: rendered.theme.colors.background }}
      >
        <LinearDocView
          doc={rendered.doc}
          theme={rendered.theme}
          variant="document"
          showCover={false}
          thinMargins
          animationsEnabled={false}
        />
      </div>
    </RenderBoundary>
  );
}
