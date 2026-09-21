/**
 * `<background-video>` — a decorative video behind content.
 *
 * @module @theme/background-video
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { prefersReducedMotion } from '@theme/utilities';
import { EVENTS } from '@theme/events';

/** Load a little before the element arrives, so it is ready when it does. */
const LOAD_MARGIN = '200px';

/** Pause only once it is properly gone, not on a one-pixel scroll wobble. */
const PLAY_THRESHOLD = 0.1;

export class BackgroundVideo extends BaseComponent {
  static requiredRefs = ['template'];

  /** @type {IntersectionObserver|null} */
  #observer = null;

  /** @type {HTMLVideoElement|HTMLIFrameElement|null} */
  #media = null;

  /**
   * The iframe's original `src`, kept so it can be restored.
   *
   * @type {string|null}
   */
  #embedSrc = null;

  /* ------------------------------------------------------------ lifecycle ---- */

  setup() {
    if (prefersReducedMotion()) {
      this.setAttribute('data-motion-blocked', '');
      return;
    }

    this.#watch();
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;

    this.#unload();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** Insert the template's contents and begin playback. */
  load() {
    if (this.#media) {
      this.play();
      return;
    }

    const template = this.refs.template;
    if (!(template instanceof HTMLTemplateElement)) return;

    this.appendChild(template.content.cloneNode(true));

    const media = this.querySelector('video, iframe');
    if (!(media instanceof HTMLVideoElement) && !(media instanceof HTMLIFrameElement)) return;

    this.#media = media;

    if (media instanceof HTMLIFrameElement) {
      this.#embedSrc = media.getAttribute('src');
      media.setAttribute('tabindex', '-1');
      this.setAttribute('data-loaded', '');
      this.dispatch(EVENTS.MEDIA_LOADED, { media });
      return;
    }

    this.on(media, 'playing', () => this.setAttribute('data-playing', ''), { once: true });

    this.setAttribute('data-loaded', '');
    this.play();

    this.dispatch(EVENTS.MEDIA_LOADED, { media });
  }

  /** Resume, or start, playback. */
  play() {
    const media = this.#media;
    if (!media) return;

    if (media instanceof HTMLIFrameElement) {
      if (!media.getAttribute('src') && this.#embedSrc) media.setAttribute('src', this.#embedSrc);
      return;
    }

    media.play().catch(() => {
      this.removeAttribute('data-playing');
    });
  }

  /** Stop playback without discarding what has already been downloaded. */
  pause() {
    const media = this.#media;
    if (!media) return;

    if (media instanceof HTMLIFrameElement) {
      media.removeAttribute('src');
      return;
    }

    media.pause();
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * One observer, two jobs.
   *
   * @private
   */
  #watch() {
    if (!('IntersectionObserver' in window)) {
      this.load();
      return;
    }

    this.#observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);

        if (visible) {
          this.load();
        } else if (this.#media) {
          this.pause();
        }
      },
      { rootMargin: LOAD_MARGIN, threshold: PLAY_THRESHOLD }
    );

    this.#observer.observe(this);
  }

  /** @private */
  #unload() {
    const media = this.#media;
    this.#media = null;

    if (!media) return;

    if (media instanceof HTMLVideoElement) {
      media.pause();
      media.removeAttribute('src');
      media.load();
    } else {
      media.removeAttribute('src');
    }

    media.remove();
    this.removeAttribute('data-loaded');
    this.removeAttribute('data-playing');
  }
}

defineComponent('background-video', BackgroundVideo);

export default { BackgroundVideo };
