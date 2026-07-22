import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import { hasSubstantiveTextChange } from '@bendyline/docblocks/vscode';

type SetContentMessage = Extract<ExtensionToWebviewMessage, { type: 'setContent' }>;
type EditMessage = Extract<WebviewToExtensionMessage, { type: 'edit' }>;
type SaveMessage = Extract<WebviewToExtensionMessage, { type: 'save' }>;

export interface WebviewDocumentScope {
  sessionId: string;
  generation: number;
}

interface ClientSession extends WebviewDocumentScope {
  baseDocumentVersion: number;
  observedEditorContent: string;
  clientRevision: number;
  editIntent: 'substantive' | 'whitespace' | null;
  hasSubstantiveEdit: boolean;
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
      observedEditorContent: message.content,
      clientRevision: message.acknowledgedClientRevision,
      editIntent: null,
      hasSubstantiveEdit: false,
    };
    return Object.freeze({ sessionId: message.sessionId, generation: this.generation });
  }

  public createEdit(scope: WebviewDocumentScope, content: string): EditMessage | null {
    const session = this.session;
    if (!session || !sameScope(session, scope)) return null;
    if (!session.hasSubstantiveEdit) {
      const intent = session.editIntent;
      const priorEditorContent = session.observedEditorContent;
      session.editIntent = null;
      session.observedEditorContent = content;
      if (intent === null || intent === 'whitespace') return null;
      if (!hasSubstantiveTextChange(priorEditorContent, content)) return null;
      session.hasSubstantiveEdit = true;
    }
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
   * Record a content-changing user gesture before accepting its change
   * callback. EditorShell may normalize its WYSIWYG snapshot during hydration
   * or navigation; interaction alone must not relabel that snapshot as an
   * authored edit. The first accepted snapshot must also differ from the last
   * observed editor snapshot by more than whitespace.
   */
  public armEdits(scope: WebviewDocumentScope, substantive = true): boolean {
    const session = this.session;
    if (!session || !sameScope(session, scope)) return false;
    session.editIntent = substantive ? 'substantive' : 'whitespace';
    return true;
  }

  /** Cancel a transient toolbar intent that produced no document change. */
  public disarmEdits(scope: WebviewDocumentScope): boolean {
    const session = this.session;
    if (!session || !sameScope(session, scope) || session.hasSubstantiveEdit) return false;
    session.editIntent = null;
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
}

function sameScope(left: WebviewDocumentScope, right: WebviewDocumentScope): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}
