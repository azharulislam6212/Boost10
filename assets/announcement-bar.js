/**
 * announcement-bar.js — Boost10
 *
 * Dismissal, and only dismissal. Slider and marquee behaviour belong to
 * `<swiper-carousel>` and `<motion-effect>`, which are already inside.
 *
 * ## Why the flag is keyed by section id
 *
 * A merchant who edits the announcement text is publishing something new, and a
 * customer who dismissed the old one has not dismissed the new one. Keying on
 * the section id alone would keep it hidden forever; keying on the content
 * would resurrect the bar on every typo fix.
 *
 * The compromise is the section id plus a short hash of the rendered text. Edit
 * the announcement and the key changes, so the bar returns once. Reorder or
 * restyle it and the key does not.
 *
 * ## The flash
 *
 * Reading storage in `setup()` runs after first paint, so a returning customer
 * sees the bar appear and then disappear. The section therefore starts hidden
 * via `data-dismissible` in CSS and is *revealed* here once the flag is checked
 * — the inverse of the obvious order, and the only way to avoid the flash
 * without inlining a blocking script in the head.
 *
 * `sessionStorage`, not `localStorage`: a promotional bar dismissed in March
 * should be back in April. A session is the right lifetime for something the
 * customer swatted away rather than opted out of.
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
      // Stays hidden. Removing it from the DOM instead would break the theme
      // editor, which re-renders this section in place and expects to find it.
      this.setAttribute('data-dismissed', '');
      return;
    }

    this.#reveal();

    if (this.refs.close) {
      this.on(this.refs.close, 'click', () => this.dismiss());
    }
  }

  /* --------------------------------------------------------- public API -- */

  dismiss() {
    this.setAttribute('data-dismissed', '');

    try {
      sessionStorage.setItem(this.#key, '1');
    } catch {
      // Private browsing, or storage disabled. The bar still closes for this
      // page view, which is the part the customer asked for.
    }

    // The header publishes `--announcement-height`, and it is now wrong.
    window.dispatchEvent(new Event('resize'));
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #reveal() {
    this.setAttribute('data-ready', '');
  }

  /** @private */
  get #key() {
    return `${STORAGE_PREFIX}${this.dataset.sectionId}:${this.#contentHash}`;
  }

  /**
   * A small non-cryptographic hash of the visible text. Only needs to change
   * when the wording does; collisions cost a customer one extra dismissal.
   * @private
   */
  get #contentHash() {
    const text = (this.textContent ?? '').replace(/\s+/g, ' ').trim();

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
