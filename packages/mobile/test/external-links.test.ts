import { expect } from 'chai';
import { routeExternalLinks } from '../src/external-links';

function link(href: string, parent: HTMLElement = document.body) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.textContent = href;
  parent.append(anchor);
  return anchor;
}

/** Click, then cancel navigation so happy-dom never loads the link. */
function click(element: Element) {
  let routed = false;
  const settle = (event: Event) => {
    routed = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener('click', settle, { once: true });
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return routed;
}

describe('mobile external links', () => {
  let opened: string[];
  let stop: () => void;
  beforeEach(() => {
    opened = [];
    stop = routeExternalLinks(async (url) => {
      opened.push(url);
    });
  });
  afterEach(() => {
    stop();
    document.body.replaceChildren();
  });

  it('opens activated external HTTP links through the host instead of the blocked WebView', () => {
    expect(click(link('https://docs.example.invalid/guide/'))).to.equal(true);
    expect(opened).to.deep.equal(['https://docs.example.invalid/guide/']);
  });

  it('leaves links that another handler took, non-HTTP links and same-origin links alone', () => {
    const handled = link('https://example.invalid/handled');
    handled.addEventListener('click', (event) => event.preventDefault());
    click(handled);
    click(link('mailto:someone@example.invalid'));
    click(link(`${location.origin}/index.html#settings`));
    expect(opened).to.deep.equal([]);
  });

  it('never opens a link the person clicked to place the caret in editable text', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    expect(click(link('https://example.invalid/in-document', editor))).to.equal(false);
    expect(opened).to.deep.equal([]);
  });

  it('stops routing once removed', () => {
    stop();
    click(link('https://example.invalid/after'));
    expect(opened).to.deep.equal([]);
  });
});
