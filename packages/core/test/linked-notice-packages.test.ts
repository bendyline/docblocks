import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  linkedNoticePackages,
  verifyLinkedNoticePackage,
} from '../../../scripts/linked-notice-packages.js';

describe('third-party notices for linked packages', () => {
  let temporary: string;
  let root: string;
  let sibling: string;
  const key = 'node_modules/@bendyline/squisq';

  function json(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }

  function link(installed = key): void {
    fs.mkdirSync(path.dirname(path.join(root, installed)), { recursive: true });
    fs.symlinkSync(
      path.join(sibling, 'packages/core'),
      path.join(root, installed),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  beforeEach(() => {
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-notices-')));
    root = path.join(temporary, 'docblocks');
    sibling = path.join(temporary, 'squisq');
    fs.mkdirSync(root);
    json(path.join(sibling, 'packages/core/package.json'), {
      name: '@bendyline/squisq',
      version: '1.0.0',
    });
    json(path.join(sibling, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: {
        'node_modules/cytoscape': { version: '3.34.0', license: 'MIT' },
        'packages/core': { name: '@bendyline/squisq', version: '1.0.0', license: 'MIT' },
        'node_modules/@bendyline/squisq': { link: true, resolved: 'packages/core' },
      },
    });
    json(path.join(sibling, 'node_modules/cytoscape/package.json'), {
      name: 'cytoscape',
      version: '3.34.0',
      license: 'MIT',
    });
    fs.writeFileSync(path.join(sibling, 'node_modules/cytoscape/LICENSE'), 'Upstream license');
  });

  afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

  it('uses the active sibling lock and its package-local license directory', () => {
    link();
    const packages = linkedNoticePackages(root, [key]);
    const component = packages.get('cytoscape@3.34.0');
    expect(component).to.deep.equal({
      directory: path.join(sibling, 'node_modules/cytoscape'),
      lockfile: path.join(sibling, 'package-lock.json'),
      entry: { version: '3.34.0', license: 'MIT' },
    });
    verifyLinkedNoticePackage(component!, 'cytoscape', '3.34.0');
    expect(fs.readFileSync(path.join(component!.directory, 'LICENSE'), 'utf8')).to.equal(
      'Upstream license',
    );
    expect(packages.has('cytoscape@3.34.1')).to.equal(false);
    expect(packages.get('@bendyline/squisq@1.0.0')?.directory).to.equal(
      path.join(sibling, 'packages/core'),
    );
  });

  it('does not trust a sibling checkout that is not actively linked', () => {
    expect(linkedNoticePackages(root, [key]).size).to.equal(0);
    json(path.join(root, key, 'package.json'), { name: '@bendyline/squisq', version: '1.0.0' });
    expect(linkedNoticePackages(root, [key]).size).to.equal(0);
  });

  it('recognizes workspace-local links such as the desktop Gezel service', () => {
    const desktopKey = 'packages/desktop/node_modules/@bendyline/gezel-service';
    link(desktopKey);
    expect(linkedNoticePackages(root, [desktopKey]).has('cytoscape@3.34.0')).to.equal(true);
  });

  it('does not discover lockfiles through arbitrary third-party links', () => {
    const thirdParty = 'node_modules/arbitrary-package';
    link(thirdParty);
    expect(linkedNoticePackages(root, [thirdParty]).size).to.equal(0);
  });

  it('does not treat an internal npm workspace as an external notice source', () => {
    fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/core'), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'packages/core'),
      path.join(root, key),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    json(path.join(root, 'package-lock.json'), { lockfileVersion: 2 });
    expect(linkedNoticePackages(root, [key]).size).to.equal(0);
  });

  it('ignores lock entries outside the linked checkout', () => {
    link();
    json(path.join(sibling, 'package-lock.json'), {
      lockfileVersion: 3,
      packages: {
        '..': { name: 'outside-parent', version: '1.0.0' },
        '../outside': { name: 'outside-sibling', version: '1.0.0' },
      },
    });
    expect(linkedNoticePackages(root, [key]).size).to.equal(0);
  });

  it('rejects installed code that differs from the sibling lockfile', () => {
    link();
    const component = linkedNoticePackages(root, [key]).get('cytoscape@3.34.0')!;
    json(path.join(component.directory, 'package.json'), { name: 'cytoscape', version: '3.34.1' });
    expect(() => verifyLinkedNoticePackage(component, 'cytoscape', '3.34.0')).to.throw(
      'does not match cytoscape@3.34.0',
    );
  });

  it('rejects a missing installed package instead of borrowing another version’s license', () => {
    link();
    const component = linkedNoticePackages(root, [key]).get('cytoscape@3.34.0')!;
    fs.rmSync(component.directory, { recursive: true });
    expect(() => verifyLinkedNoticePackage(component, 'cytoscape', '3.34.0')).to.throw('ENOENT');
  });

  it('rejects unsupported linked lockfiles', () => {
    link();
    json(path.join(sibling, 'package-lock.json'), { lockfileVersion: 2, packages: {} });
    expect(() => linkedNoticePackages(root, [key])).to.throw('requires lockfileVersion 3');
  });
});
