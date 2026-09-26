/**
 * Proves the shipped editor is fixed for GHSA-CP6Q-959Q-F8RH.
 *
 * Tiptap's `mergeAttributes()` used to assign keys with bracket syntax, so an
 * own `__proto__` key — exactly what `JSON.parse` produces from document or
 * model output — replaced the merged object's prototype. ProseMirror's DOM
 * serializer reads attributes with `for…in`, so the injected keys became real
 * attributes, such as an `onerror` handler.
 *
 * Tiptap fixed it in 3.30.4 and backported the same guard to 2.27.3, which
 * Squisq ships. The advisory still lists every 2.x release as affected, so
 * `npm audit` keeps reporting it. This test is what the audit disposition
 * points at instead of an expiry date: it checks the `@tiptap/core` DocBlocks
 * actually installs and bundles, so a downgrade or an unpatched migration fails
 * the build rather than waiting for a calendar reminder.
 */
import { expect } from 'chai';
import { mergeAttributes } from '@tiptap/core';

function enumeratedKeys(value: object): string[] {
  const keys: string[] = [];
  // Deliberately `for…in`: it is how ProseMirror's serializer reads attributes,
  // and unlike Object.keys it reaches inherited properties.
  for (const key in value) keys.push(key);
  return keys;
}

describe('shipped Tiptap: mergeAttributes prototype safety (GHSA-CP6Q-959Q-F8RH)', () => {
  it('keeps an own __proto__ key from becoming the merged prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"onerror": "alert(1)"}}') as Record<string, unknown>;

    const merged = mergeAttributes({ class: 'db-node' }, hostile);

    expect(Object.getPrototypeOf(merged)).to.equal(Object.prototype);
    expect(enumeratedKeys(merged)).not.to.include('onerror');
  });

  it('still merges ordinary attributes normally', () => {
    expect(mergeAttributes({ class: 'a', title: 'x' }, { class: 'b' })).to.deep.equal({
      class: 'a b',
      title: 'x',
    });
  });
});
