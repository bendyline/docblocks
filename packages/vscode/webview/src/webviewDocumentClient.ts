import type {
  DocumentConflictChoice,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';

type SetContentMessage = Extract<ExtensionToWebviewMessage, { type: 'setContent' }>;
type EditMessage = Extract<WebviewToExtensionMessage, { type: 'edit' }>;
type SaveMessage = Extract<WebviewToExtensionMessage, { type: 'save' }>;

export interface WebviewDocumentScope {
  sessionId: string;
  generation: number;
}

interface ClientSession extends WebviewDocumentScope {
  baseDocumentVersion: number;
  clientRevision: number;
  editsArmed: boolean;
}

/**
 * Revision envelope coordinator for one webview.
 *
 * Every mounted EditorShell captures a scope. A setContent response always
 * advances the generation, even when the text is identical, so a callback
 * already queued by the obsolete editor cannot be relabelled as an edit on
 * the new host branch.
 */
export class WebviewDocumentClient {
  private session: ClientSession | null = null;
  private generation = 0;

  public acceptContent(message: SetContentMessage): WebviewDocumentScope {
    this.generation += 1;
    this.session = {
      sessionId: message.sessionId,
      generation: this.generation,
      baseDocumentVersion: message.documentVersion,
      clientRevision: message.acknowledgedClientRevision,
      editsArmed: false,
    };
    return Object.freeze({ sessionId: message.sessionId, generation: this.generation });
  }

  public createEdit(scope: WebviewDocumentScope, content: string): EditMessage | null {
    const session = this.session;
    if (!session || !sameScope(session, scope) || !session.editsArmed) return null;
    session.clientRevision += 1;
    return {
      type: 'edit',
      content,
      sessionId: session.sessionId,
      clientRevision: session.clientRevision,
      baseDocumentVersion: session.baseDocumentVersion,
    };
  }

  /**
   * Mark this mounted editor as user-active before accepting its change
   * callbacks. EditorShell may normalize its initial WYSIWYG snapshot during
   * hydration; those callbacks have no browser input event and must not be
   * relabelled as authored edits.
   */
  public armEdits(scope: WebviewDocumentScope): boolean {
    const session = this.session;
    if (!session || !sameScope(session, scope)) return false;
    session.editsArmed = true;
    return true;
  }

  public createSave(requestId: number): SaveMessage | null {
    const session = this.session;
    if (!session) return null;
    return {
      type: 'save',
      sessionId: session.sessionId,
      requestId,
      clientRevision: session.clientRevision,
      baseDocumentVersion: session.baseDocumentVersion,
    };
  }

  public createConflictResolution(
    choice: DocumentConflictChoice,
  ): Extract<WebviewToExtensionMessage, { type: 'resolveConflict' }> | null {
    const session = this.session;
    return session ? { type: 'resolveConflict', sessionId: session.sessionId, choice } : null;
  }

  public isCurrentSession(sessionId: string): boolean {
    return this.session?.sessionId === sessionId;
  }
}

function sameScope(left: WebviewDocumentScope, right: WebviewDocumentScope): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}
