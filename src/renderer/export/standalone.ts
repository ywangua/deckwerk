import '../player/player.css';
import { parseDeck } from '@shared/deck.js';
import { bindPresentKeys } from '../player/keys.js';
import { Player } from '../player/player.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from '../player/links.js';

/**
 * Entry point for the exported standalone bundle.
 *
 * This is built separately as a self-contained IIFE so an exported deck is a
 * plain folder that opens in any browser with no app, no server and no build
 * step — which is also the safest way to present on a machine you don't control.
 *
 * The deck itself is injected as `window.__DECK__` by the generated index.html,
 * so the page needs no fetch and works straight off `file://`.
 */

declare global {
  interface Window {
    __DECK__?: unknown;
    /** Embedded resources for the single-file HTML export. */
    __DECK_ASSETS__?: Record<string, string>;
    /** Test/diagnostic handle for rendering an exact slide build state. */
    __SLIDE_PLAYER__?: Player;
  }
}

function boot(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root');
  if (!window.__DECK__) {
    root.textContent = 'No deck data found in this export.';
    return;
  }

  const deck = parseDeck(window.__DECK__);
  const player = new Player({
    deck,
    container: root,
    // Folder exports use relative paths; single-file exports embed a resource map.
    resolveSrc: (src) => {
      const [path, fragment] = src.split('#', 2);
      let key = path.split('?')[0].replace(/^\.\//, '');
      try { key = decodeURIComponent(key); } catch { /* use the authored path */ }
      const embedded = window.__DECK_ASSETS__?.[key];
      return embedded ? embedded + (fragment ? `#${fragment}` : '') : src;
    },
  });
  window.__SLIDE_PLAYER__ = player;

  bindPresentKeys(window, player);

  // Deep-linking for humans and agents alike: index.html#7 opens slide 7.
  // With this, "render slide N" is one headless-chromium screenshot away —
  // no app, no server.
  const jumpToHash = () => {
    const n = Number.parseInt(location.hash.replace('#', ''), 10);
    if (Number.isFinite(n) && n >= 1) player.goToSlide(n - 1);
  };
  window.addEventListener('hashchange', jumpToHash);
  jumpToHash();

  window.addEventListener('mousedown', (e) => {
    if (slideLinkFromEvent(e) || eventOnInteractiveWeb(e)) return;
    if (e.button === 0) player.next();
    else if (e.button === 2) player.prev();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
