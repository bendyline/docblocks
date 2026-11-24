import { expect } from 'chai';
import {
  buildShellPageHash,
  parseShellPageHash,
  sameShellRoute,
} from '../src/Home/shell-routes.js';

describe('shell page routes', () => {
  it('builds and reads back the home, tasks and folder pages', () => {
    expect(buildShellPageHash('ws-1', { kind: 'home' })).to.equal('#ws-1/:home');
    expect(buildShellPageHash('ws-1', { kind: 'tasks' })).to.equal('#ws-1/:tasks');
    const folder = buildShellPageHash('my ws', { kind: 'folder', path: '/Work/Tasks: 2026' });
    expect(folder).to.equal('#my%20ws/:folder/Work%2FTasks%3A%202026');
    expect(parseShellPageHash(folder)).to.deep.equal({
      workspaceId: 'my ws',
      route: { kind: 'folder', path: '/Work/Tasks: 2026' },
    });
    expect(parseShellPageHash('#ws-1/:home')).to.deep.equal({
      workspaceId: 'ws-1',
      route: { kind: 'home' },
    });
    expect(parseShellPageHash('ws-1/:tasks')?.route).to.deep.equal({ kind: 'tasks' });
    // The workspace root has no page of its own: it is the plain workspace route.
    expect(buildShellPageHash('ws-1', { kind: 'folder', path: '/' })).to.equal('#ws-1');
  });

  it('never reads a document or workspace route as a page', () => {
    // Document paths are percent-encoded, so a colon in one is never raw.
    for (const hash of [
      '',
      '#',
      '#ws-1',
      '#ws-1/notes%2Fa.md',
      '#ws-1/%3Ahome',
      '#ws-1/:homework',
      '#ws-1/:folder/',
      '#/:home',
      '#ws-1/:folder/a%2F..%2Fb',
      '#ws-1/:folder/%E0%A4%A',
      '#%E0%A4%A/:home',
      '#shared(abc)',
    ]) {
      expect(parseShellPageHash(hash), hash).to.equal(null);
    }
  });

  it('compares routes by what they show', () => {
    expect(sameShellRoute({ kind: 'home' }, { kind: 'home' })).to.equal(true);
    expect(sameShellRoute({ kind: 'home' }, { kind: 'tasks' })).to.equal(false);
    expect(sameShellRoute({ kind: 'folder', path: '/A' }, { kind: 'folder', path: '/A' })).to.equal(
      true,
    );
    expect(sameShellRoute({ kind: 'folder', path: '/A' }, { kind: 'folder', path: '/B' })).to.equal(
      false,
    );
    expect(sameShellRoute(null, null)).to.equal(true);
    expect(sameShellRoute(null, { kind: 'home' })).to.equal(false);
  });
});
