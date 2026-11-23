import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContextMenuProvider, EditorProvider } from '@bendyline/squisq-editor-react';
import {
  aiDeviceFit,
  type AiDeviceFit,
  type AiPreferences,
  type AiStatus,
  type DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiToolbarControl } from '../src/Ai/AiEditorAssistant.js';
import {
  aiInvitationDismissed,
  dismissAiInvitation,
  useAiInvitation,
} from '../src/Ai/ai-invitation.js';
import { advanceTime, renderHook } from './helpers/renderHook.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const DISMISSED_KEY = 'docblocks:aiInvitationDismissed';
const OFF: AiStatus = { kind: 'unavailable', reason: 'opt-out' };
const GIB = 1024 ** 3;

function unused(): never {
  throw new Error('Not used by the AI invitation');
}

function fakeAi(options: { enabled?: boolean; fit?: AiDeviceFit | null; status?: AiStatus }) {
  const listeners = new Set<(status: AiStatus) => void>();
  const state = { fitAsked: 0, enabled: options.enabled ?? false, set: [] as string[] };
  const preferences = (): AiPreferences => ({
    enabled: state.enabled,
    model: null,
    reviewMode: 'explicit',
  });
  const api: DocBlocksHostAiAPI = {
    providerInstalled: async () => false,
    status: async () => options.status ?? OFF,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPreferences: async () => preferences(),
    setPreferences: async (patch) => {
      state.set.push(JSON.stringify(patch));
      if (patch.enabled !== undefined) state.enabled = patch.enabled;
      return preferences();
    },
    connect: unused,
    disconnect: unused,
    models: unused,
    chat: unused,
    ...(options.fit === null
      ? {}
      : {
          deviceFit: async () => {
            state.fitAsked += 1;
            return options.fit ?? aiDeviceFit('unified', 32 * GIB);
          },
        }),
  };
  const emit = (status: AiStatus) => {
    for (const listener of listeners) listener(status);
  };
  return { api, state, emit };
}

beforeEach(() => localStorage.removeItem(DISMISSED_KEY));
afterEach(() => localStorage.removeItem(DISMISSED_KEY));

describe('useAiInvitation', () => {
  it('invites on a capable device while AI is off, after a short wait', async () => {
    const { api, state } = fakeAi({});
    const hook = await renderHook(({ ai }) => useAiInvitation(ai, 5), { ai: api });
    try {
      expect(hook.result.current.invite).to.equal(false);
      await advanceTime(30);
      expect(hook.result.current.invite).to.equal(true);
      expect(state.fitAsked).to.equal(1);
    } finally {
      await hook.unmount();
    }
  });

  for (const [device, fit] of [
    ['a Mac with 8 GB', aiDeviceFit('unified', 8 * GIB)],
    ['a PC with a 6 GB card', aiDeviceFit('gpu', 6 * GIB)],
    ['a PC without a graphics card', aiDeviceFit('system', 64 * GIB)],
    ['a phone that does not report its memory', aiDeviceFit('mobile', null)],
  ] as const) {
    it(`does not invite on ${device}`, async () => {
      const { api } = fakeAi({ fit });
      const hook = await renderHook(({ ai }) => useAiInvitation(ai, 5), { ai: api });
      try {
        await advanceTime(30);
        expect(hook.result.current.invite).to.equal(false);
      } finally {
        await hook.unmount();
      }
    });
  }

  it('never invites without an AI host, or a host that cannot measure the device', async () => {
    const { api } = fakeAi({ fit: null });
    for (const ai of [undefined, api]) {
      const hook = await renderHook(({ ai: host }) => useAiInvitation(host, 5), { ai });
      try {
        await advanceTime(30);
        expect(hook.result.current.invite).to.equal(false);
      } finally {
        await hook.unmount();
      }
    }
  });

  it('does not measure once dismissed, and remembers the dismissal', async () => {
    const first = fakeAi({});
    const hook = await renderHook(({ ai }) => useAiInvitation(ai, 5), { ai: first.api });
    await advanceTime(30);
    expect(hook.result.current.invite).to.equal(true);
    await act(async () => hook.result.current.dismiss());
    expect(hook.result.current.invite).to.equal(false);
    expect(aiInvitationDismissed()).to.equal(true);
    await hook.unmount();

    const second = fakeAi({});
    const again = await renderHook(({ ai }) => useAiInvitation(ai, 5), { ai: second.api });
    try {
      await advanceTime(30);
      expect(again.result.current.invite).to.equal(false);
      expect(second.state.fitAsked).to.equal(0);
    } finally {
      await again.unmount();
    }
  });

  it('treats AI already on as an answer, so turning it off later does not invite', async () => {
    const { api, state } = fakeAi({ enabled: true });
    const hook = await renderHook(({ ai }) => useAiInvitation(ai, 5), { ai: api });
    try {
      await advanceTime(30);
      expect(hook.result.current.invite).to.equal(false);
      expect(state.fitAsked).to.equal(0);
      expect(aiInvitationDismissed()).to.equal(true);
    } finally {
      await hook.unmount();
    }
  });

  it('ends the invitation when AI is turned on another way, such as Settings', async () => {
    const { api, emit } = fakeAi({});
    const hook = await renderHook(({ ai }) => useAiInvitation(ai, 5), { ai: api });
    try {
      await advanceTime(30);
      expect(hook.result.current.invite).to.equal(true);
      await act(async () =>
        emit({ kind: 'connecting', step: 'detecting', verificationCode: null, progress: null }),
      );
      expect(hook.result.current.invite).to.equal(false);
      expect(aiInvitationDismissed()).to.equal(true);
    } finally {
      await hook.unmount();
    }
  });

  it('keeps quiet when storage cannot be read', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(aiInvitationDismissed()).to.equal(true);
      expect(() => dismissAiInvitation()).not.to.throw();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('AI toolbar invitation', () => {
  const mounted: { root: Root; host: HTMLElement }[] = [];

  afterEach(async () => {
    for (const { root, host } of mounted.splice(0)) {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  async function renderControl(
    ai: DocBlocksHostAiAPI,
    props: { invite: boolean; onAcceptInvite?: () => void; onDeclineInvite?: () => void },
  ) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () =>
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: '# Notes\n',
          fileName: 'notes.md',
          children: createElement(EditorContextMenuProvider, {
            rootRef: { current: host },
            children: createElement(AiToolbarControl, {
              ai,
              openPanel: null,
              onOpenPanel: () => undefined,
              ...props,
            }),
          }),
        }),
      ),
    );
    await advanceTime(20);
    return host;
  }

  const trigger = () => document.body.querySelector<HTMLButtonElement>('.db-ai-toolbar-trigger');
  const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
  const item = (label: string) =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  it('stays hidden while AI is off and the device is not invited', async () => {
    const { api } = fakeAi({});
    await renderControl(api, { invite: false });
    expect(trigger()).to.equal(null);
  });

  it('shows while AI is off on an invited device, and offers to turn AI on', async () => {
    const { api } = fakeAi({});
    let accepted = 0;
    let declined = 0;
    await renderControl(api, {
      invite: true,
      onAcceptInvite: () => (accepted += 1),
      onDeclineInvite: () => (declined += 1),
    });
    expect(trigger()?.dataset.tooltip).to.equal('Turn on AI');
    expect(trigger()?.classList.contains('db-ai-toolbar-trigger--invite')).to.equal(true);

    await act(async () => trigger()?.click());
    expect(menu()?.textContent).to.contain('AI that stays on this device');
    expect(menu()?.textContent).to.contain('Nothing you write leaves it.');
    // Only the invitation: no AI actions before AI is on.
    expect(item('Review document…')).to.equal(undefined);
    await act(async () => item('Turn on AI…')?.click());
    expect(accepted).to.equal(1);
    expect(menu()).to.equal(null);

    await act(async () => trigger()?.click());
    await act(async () => item('Not now')?.click());
    expect(declined).to.equal(1);
  });
});
