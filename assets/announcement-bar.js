/**
 * Dismissal, and only dismissal. Slider and marquee behaviour belong to
 * `<carousel-slider>` and `<motion-effect>`, which are already inside.
 *
 * @element announcement-bar
 * @attr {boolean} data-dismissible
 */

import { BaseComponent, defineComponent } from '@theme/component';

const STORAGE_PREFIX = 'boost10:announcement:';

export class AnnouncementBar extends BaseComponent {
  setup() {
    if (!this.hasAttribute('data-dismissible')) {
      this.#reveal();
      return;
    }

    if (this.#isDismissed()) {
      this.setAttribute('data-dismissed', '');
      return;
    }

    this.#reveal();
    this.#bindClose();
  }

  /**
   * The theme editor re-renders this section in place, which replaces the close
   * button with a new node while this element stays connected. Without
   * re-binding, closing the bar works once and then stops for the rest of the
   * editing session.
   */
  sectionLoaded() {
    this.refreshRefs();

    if (!this.hasAttribute('data-dismissible')) {
      this.#reveal();
      return;
    }

    if (this.#isDismissed()) {
      this.setAttribute('data-dismissed', '');
      return;
    }

    this.removeAttribute('data-dismissed');
    this.#reveal();
    this.#bindClose();
  }

  /* --------------------------------------------------------- public API -- ---- */

  dismiss() {
    this.setAttribute('data-dismissed', '');

    try {
      sessionStorage.setItem(this.#key, '1');
    } catch {}

    window.dispatchEvent(new Event('resize'));
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #bindClose() {
    const close = this.refs.close;
    if (!close || close.dataset.bound === 'true') return;

    close.dataset.bound = 'true';
    this.on(close, 'click', () => this.dismiss());
  }

  /** @private */
  #reveal() {
    this.setAttribute('data-ready', '');
  }

  /**
   * The storage key, preferring the one Liquid stamped on the element.
   *
   * @private
   */
  get #key() {
    const key = this.dataset.dismissKey || this.#contentHash;
    return `${STORAGE_PREFIX}${this.dataset.sectionId}:${key}`;
  }

  /**
   * A small non-cryptographic hash of the visible text. Only needs to change
   * when the wording does; collisions cost a customer one extra dismissal.
   *
   * @private
   */
  get #contentHash() {
    const source = this.querySelectorAll('.announcement__text');
    const text = (
      source.length > 0
        ? Array.from(source)
            .filter((node) => !node.closest('[data-marquee-clone]'))
            .map((node) => node.textContent ?? '')
            .join(' ')
        : (this.textContent ?? '')
    )
      .replace(/\s+/g, ' ')
      .trim();

    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }

    return Math.abs(hash).toString(36);
  }

  /** @private */
  #isDismissed() {
    try {
      return sessionStorage.getItem(this.#key) === '1';
    } catch {
      return false;
    }
  }
}

defineComponent('announcement-bar', AnnouncementBar);

export default { AnnouncementBar };
