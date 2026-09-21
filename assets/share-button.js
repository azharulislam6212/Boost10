/**
 * Sharing: the native share sheet where it exists, explicit network links
 * where it does not, and copy-to-clipboard everywhere.
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
    if (this.refs.button) {
      this.refs.button.toggleAttribute('hidden', !this.canShareNatively);
      this.on(this.refs.button, 'click', () => this.shareNative());
    }

    if (this.refs.copy) {
      this.on(this.refs.copy, 'click', () => this.copy());
    }

    this.on(this, 'click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('[data-share-network]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      window.open(link.href, 'share', 'width=600,height=520,noopener,noreferrer');
    });
  }

  teardown() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  get url() {
    return this.dataset.url || window.location.href;
  }

  /**
   * The device sheet is used only when the browser supports it AND the merchant
   * has left it enabled. `data-native-share` is absent on older markup, so the
   * check is for the explicit opt-out string rather than for truthiness.
   */
  get canShareNatively() {
    return Boolean(navigator.share) && this.dataset.nativeShare !== 'false';
  }

  async shareNative() {
    if (!this.canShareNatively) return this.copy();

    try {
      await navigator.share({ title: this.dataset.title || document.title, url: this.url });
    } catch (error) {
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
      this.#selectFallback();
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {string} message
   * @private
   */
  #feedback(message) {
    const target = this.refs.feedback;
    if (!(target instanceof HTMLElement)) return;

    target.textContent = message;
    target.removeAttribute('hidden');

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
    this.#feedback(themeString('shareCopyManually', 'Copy the link below'));
  }
}

defineComponent('share-button', ShareButton);

export default { ShareButton };
