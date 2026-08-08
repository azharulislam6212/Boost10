/**
 * share-button.js — Boost10, Phase 6 replacement
 *
 * Sharing: the native share sheet where it exists, explicit network links
 * where it does not, and copy-to-clipboard everywhere.
 *
 * ## Why both, when the previous version had only the sheet
 *
 * The old comment in `product-share.liquid` called nine social icons "a 2015
 * pattern", and on mobile that is right — `navigator.share` opens the sheet the
 * customer already has, with the apps they actually use.
 *
 * On desktop it is wrong. `navigator.share` is unavailable in desktop Firefox
 * and, until recently, desktop Chrome on Linux, so the block degraded to a
 * copy-link button on exactly the platform where a merchant most wants a
 * Pinterest link. Pinterest in particular is desktop-heavy and is the one
 * network where a share genuinely drives traffic for product photography.
 *
 * So: sheet when available, explicit links when not. The merchant chooses which
 * networks; the component chooses the presentation.
 *
 * ## Popups, not navigations
 *
 * Network links open in a sized popup with `noopener`. Without `noopener` the
 * opened page gets a handle on `window.opener` and can navigate the store tab
 * somewhere else — a real phishing vector, not a theoretical one.
 *
 * The links are real `<a href>` in the markup, so they work with the module
 * unloaded and respond to middle-click and modifier-click as links should. The
 * popup is an enhancement layered on top, and it steps aside when the customer
 * signals they want a tab.
 *
 * @element share-button
 * @attr {string} data-url    Absolute URL to share
 * @attr {string} data-title  Title passed to the share sheet
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { themeString } from '@theme/utilities';

/** How long the copy confirmation stays on screen. */
const FEEDBACK_MS = 2500;

export class ShareButton extends BaseComponent {
  /** @type {number|null} */
  #timer = null;

  setup() {
    // The sheet is only offered where the browser has one. Rendering the
    // button and failing on click is worse than never showing it.
    if (this.refs.button) {
      this.refs.button.toggleAttribute('hidden', !navigator.share);
      this.on(this.refs.button, 'click', () => this.shareNative());
    }

    if (this.refs.copy) {
      this.on(this.refs.copy, 'click', () => this.copy());
    }

    this.on(this, 'click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('[data-share-network]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;

      // A modifier-click means the customer asked for a tab. Honour it.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      window.open(link.href, 'share', 'width=600,height=520,noopener,noreferrer');
    });
  }

  teardown() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /* --------------------------------------------------------- public API -- */

  get url() {
    return this.dataset.url || window.location.href;
  }

  async shareNative() {
    if (!navigator.share) return this.copy();

    try {
      await navigator.share({ title: this.dataset.title || document.title, url: this.url });
    } catch (error) {
      // A dismissed sheet rejects with AbortError. That is the customer
      // changing their mind, not a failure, and must not surface as one.
      if (error?.name !== 'AbortError') {
        console.error('[Boost10] Share failed.', error);
      }
    }
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.url);
      this.#feedback(themeString('shareCopied', 'Link copied'));
    } catch {
      // Clipboard access is denied outside a secure context and in some
      // embedded webviews. Selecting the text lets the customer copy manually,
      // which is a real fallback rather than a silent failure.
      this.#selectFallback();
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {string} message
   * @private
   */
  #feedback(message) {
    const target = this.refs.feedback;
    if (!(target instanceof HTMLElement)) return;

    target.textContent = message;
    target.removeAttribute('hidden');

    // `role="status"` is on the element in Liquid, so setting textContent is
    // what announces it. No separate announce() call — that would read twice.

    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      target.setAttribute('hidden', '');
      target.textContent = '';
      this.#timer = null;
    }, FEEDBACK_MS);
  }

  /** @private */
  #selectFallback() {
    const input = this.refs.urlInput;
    if (!(input instanceof HTMLInputElement)) return;

    input.removeAttribute('hidden');
    input.value = this.url;
    input.select();
    this.#feedback(themeString('shareCopyManual', 'Copy the link below'));
  }
}

defineComponent('share-button', ShareButton);

export default { ShareButton };
