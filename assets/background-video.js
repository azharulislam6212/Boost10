/**
 * background-video.js — Boost10
 *
 * `<background-video>` — a decorative video behind content.
 *
 * ## Why not `<deferred-media>`
 *
 * `<deferred-media>` exists for a video a customer chose to watch: it loads on
 * click or on first intersection, and once loaded it stays loaded and playing.
 * That is right for a product video and wrong for a backdrop, which has three
 * obligations the other has none of:
 *
 *   1. **Stop when it is not on screen.** A looping video decoding frames three
 *      screens above the fold is a laptop fan and a phone battery, and the
 *      customer sees nothing for it. This pauses on exit and resumes on entry.
 *   2. **Do not autoplay under reduced motion.** A full-bleed moving image is
 *      exactly what that setting is about. The poster stays; nothing moves.
 *   3. **Survive a refused autoplay.** Every browser can decline, and a
 *      background video has no controls to fall back on. The poster has to stay
 *      visible rather than leaving a black rectangle.
 *
 * ## Events
 *
 * One, and it already existed: `EVENTS.MEDIA_LOADED`, dispatched when the video
 * is in the DOM. No new constant was added to `assets/events.js` — a background
 * video is not a new category of thing, it is media finishing loading, and the
 * registry already says so.
 *
 * Nothing is dispatched for play and pause. Those fire on every scroll past the
 * section, and no part of the theme needs to know: an event nobody listens to is
 * a listener slot and a name to maintain for nothing.
 *
 * ## Iframes
 *
 * A YouTube or Vimeo embed cannot be paused from here without loading their
 * player API, which is a third-party script on every page for a decorative
 * loop. So the iframe is torn down when it leaves the viewport and rebuilt when
 * it returns. The `src` is the only lever we have, and removing it is the only
 * reliable stop.
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
   * Read once at load time rather than from the live element, because pausing
   * an embed means clearing `src` — after which the element no longer knows
   * where it came from.
   *
   * @type {string|null}
   */
  #embedSrc = null;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    // Reduced motion: the poster is already in the DOM and is a still frame of
    // the same footage, so there is nothing further to do. Deliberately not
    // "load it but do not play it" — an unplayed video is a download nobody
    // asked for.
    if (prefersReducedMotion()) {
      this.setAttribute('data-motion-blocked', '');
      return;
    }

    this.#watch();
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;

    // Not a `pause()`: the element may be being removed entirely, and a video
    // still holding a decode pipeline is the leak this avoids.
    this.#unload();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Insert the template's contents and begin playback.
   *
   * Idempotent — a second call while already loaded resumes instead.
   */
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
      // An embed is decoration and must not be a tab stop; there is nothing in
      // it to operate.
      media.setAttribute('tabindex', '-1');
      this.setAttribute('data-loaded', '');
      this.dispatch(EVENTS.MEDIA_LOADED, { media });
      return;
    }

    // A hosted video reveals the poster only once it has a frame to show, so
    // there is never a gap between the two.
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

    // A rejected promise here is the browser declining autoplay, which is it
    // working as intended. Removing `data-playing` puts the poster back, so the
    // section shows a still image rather than a black rectangle.
    media.play().catch(() => {
      this.removeAttribute('data-playing');
    });
  }

  /** Stop playback without discarding what has already been downloaded. */
  pause() {
    const media = this.#media;
    if (!media) return;

    if (media instanceof HTMLIFrameElement) {
      // Nothing short of this stops an embed without its player API.
      media.removeAttribute('src');
      return;
    }

    media.pause();
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * One observer, two jobs.
   *
   * The first intersection loads; every one after that toggles playback. They
   * are the same signal, so splitting them across two observers would mean two
   * sets of callbacks answering the same scroll.
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
      // Clearing the source and reloading is what actually releases the decoder;
      // `pause()` alone leaves it attached.
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
