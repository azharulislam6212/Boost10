/**
 * Dismissal, and only dismissal. Slider and marquee behaviour belong to
 * `<carousel-slider>` and `<motion-effect>`, which are already inside.
 *
 * @element announcement-bar
 * @attr {boolean} data-dismissible
 */

import { BaseComponent, defineComponent } from '@theme/component';

const STORAGE_PREFIX = 'theme:announcement:';

export class AnnouncementBar extends BaseComponent {
  setup() {
    this.#init();
  }

  /**
   * The editor re-renders the section in place, replacing the close button
   * while this element stays connected, so the button is bound again.
   */
  sectionLoaded() {
    this.refreshRefs();
    this.#init(true);
  }

  dismiss() {
    this.setAttribute('data-dismissed', '');

    try {
      sessionStorage.setItem(this.#key, '1');
    } catch {}

    window.dispatchEvent(new Event('resize'));
  }

  /** @param {boolean} [reloaded] */
  #init(reloaded = false) {
    if (this.hasAttribute('data-dismissible')) {
      if (this.#isDismissed()) {
        this.setAttribute('data-dismissed', '');
        return;
      }
      if (reloaded) this.removeAttribute('data-dismissed');
      this.#bindClose();
    }

    this.setAttribute('data-ready', '');
  }

  #bindClose() {
    const { close } = this.refs;
    if (!close || close.dataset.bound === 'true') return;

    close.dataset.bound = 'true';
    this.on(close, 'click', () => this.dismiss());
  }

  /** Liquid stamps a hash of the announcement text, so new wording shows again. */
  get #key() {
    return `${STORAGE_PREFIX}${this.dataset.sectionId}:${this.dataset.dismissKey}`;
  }

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
