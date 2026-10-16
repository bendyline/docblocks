// The default import serves the classic JSX transform the Mocha suite runs.
import React, { Component, type ReactNode } from 'react';

interface EditorErrorBoundaryProps {
  /** A new value clears a caught error: another document gets a fresh editor. */
  resetKey: string;
  children: ReactNode;
}

interface EditorErrorBoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * Keeps an editor crash inside the editor area. Without a boundary, an error
 * thrown while rendering the editor unmounts the whole shell -- the file tree,
 * the workspace picker and every way back -- and leaves a blank page.
 *
 * The document is unaffected: its content and saving belong to the document
 * session, not to the editor that failed to draw it.
 */
export class EditorErrorBoundary extends Component<
  EditorErrorBoundaryProps,
  EditorErrorBoundaryState
> {
  state: EditorErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<EditorErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: EditorErrorBoundaryProps,
    state: EditorErrorBoundaryState,
  ): Partial<EditorErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="db-shell-empty db-shell-empty--workspace" role="alert">
        <div className="db-workspace-empty-content">
          <h1>This document couldn&rsquo;t be displayed</h1>
          <p>The editor ran into a problem drawing it. The document itself is unaffected.</p>
          <div className="db-workspace-empty-actions">
            <button type="button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
          <p className="db-workspace-empty-hint">{error.message}</p>
        </div>
      </div>
    );
  }
}
