/**
 * media-gallery.js — Boost10
 *
 * `<media-gallery>` and `<media-thumbnails>` — the product media viewer.
 *
 * The gallery is a scroll-snapping list of media, the same mechanism as
 * `<swiper-carousel>`, plus the parts that are specific to product media:
 * thumbnails that stay in sync, video and 3D models that only load when asked,
 * and pausing anything playing when the customer moves to another item.
 *
 * The stage is a scroll container rather than an absolutely positioned stack.
 * That means every image is in the document at its natural position, lazy
 * loading works, and a customer can swipe through media before any JavaScript
 * has run. A stack of `position: absolute` slides with `opacity: 0` downloads
 * every image immediately and shows nothing until a script sorts it out.
 *
 * Markup:
 *
 *   <media-gallery data-layout="stacked">
 *     <div data-ref="stage" tabindex="0" role="group" aria-label="…">
 *       <div data-media data-media-id="123" data-media-type="image">…</div>
 *       <div data-media data-media-id="124" data-media-type="video">
 *         <deferred-media>…</deferred-media>
 *       </div>
 *     </div>
 *     <media-thumbnails data-ref="thumbnails">
 *       <button data-thumbnail data-media-id="123" aria-current="true">…</button>
 *     </media-thumbnails>
 *     <p data-ref="status" class="visually-hidden" role="status"></p>
 *   </media-gallery>
 *
 * @module @theme/media-gallery
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, mediaSelectDetail } from '@theme/events';
import { rafThrottle, debounce, themeString, prefersReducedMotion, isRTL } from '@theme/utilities';
import { renderControls, findExternalControls, toggleControls } from '@theme/carousel-controls';

/* ==========================================================================
   <media-gallery>
   ========================================================================== */

export class MediaGallery extends BaseComponent {
  static requiredRefs = ['stage'];

  /** @type {string|null} */
  #activeId = null;

  /** @type {ResizeObserver|null} */
  #observer = null;

  /**
   * The arrows and readout rendered by `snippets/carousel-controls.liquid`.
   *
   * The gallery is not a Swiper carousel — it coordinates zoom, video playback
   * and the thumbnail strip, none of which Swiper would simplify — but it
   * renders the same control bar so the product page and the collection
   * carousels stay visually identical. `@theme/carousel-controls` is the shared
   * part; nothing about Swiper leaks in here.
   *
   * @type {import('@theme/carousel-controls').ControlRefs}
   */
  #external = { previous: null, next: null, current: null, total: null, bar: null };

  setup() {
    this.#activeId = this.media[0]?.dataset.mediaId ?? null;
    this.#external = findExternalControls(this.id);

    // Controls may be nested or detached; either way the buttons step the
    // gallery rather than reaching into it.
    this.on(this, 'click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-ref="previous"], [data-ref="next"]') : null;
      if (!button) return;

      event.preventDefault();
      this.step(button.dataset.ref === 'next' ? 1 : -1);
    });

    for (const button of [this.#external.previous, this.#external.next]) {
      if (!button) continue;
      this.on(button, 'click', (event) => {
        event.preventDefault();
        this.step(button.dataset.ref === 'next' ? 1 : -1);
      });
    }

    const onScroll = rafThrottle(() => this.#syncFromScroll());
    this.on(this.refs.stage, 'scroll', onScroll, { passive: true });
    this.on(this.refs.stage, 'keydown', this.#onKeydown);

    // Thumbnails report their own clicks rather than this element reaching into
    // them, so the two stay independently testable.
    this.on(this, 'click', (event) => {
      const thumb = event.target instanceof Element ? event.target.closest('[data-thumbnail]') : null;
      if (!thumb) return;

      event.preventDefault();
      this.goToMedia(thumb.dataset.mediaId, { focusStage: true });
    });

    this.#observer = new ResizeObserver(debounce(() => this.#syncFromScroll(), 150));
    this.#observer.observe(this.refs.stage);

    this.#syncControls();
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {HTMLElement[]}
   */
  get media() {
    return Array.from(this.refs.stage.querySelectorAll('[data-media]'));
  }

  /**
   * @returns {string|null}
   */
  get activeMediaId() {
    return this.#activeId;
  }

  /**
   * @returns {HTMLElement|null}
   */
  get activeMedia() {
    return this.media.find((item) => item.dataset.mediaId === this.#activeId) || null;
  }

  /**
   * Show a specific media item.
   *
   * Called directly by `<media-coordinator>` when the variant changes, and by
   * thumbnail clicks.
   *
   * @param {string|number} mediaId
   * @param {Object} [options]
   * @param {boolean} [options.animate=true]
   * @param {boolean} [options.focusStage=false] Move focus to the stage afterwards.
   * @returns {boolean} True when the media exists in this gallery.
   */
  goToMedia(mediaId, { animate = true, focusStage = false } = {}) {
    const id = String(mediaId);
    const target = this.media.find((item) => item.dataset.mediaId === id);
    if (!target) return false;

    // Anything playing in the item being left must stop, or a customer ends up
    // with audio from an image they can no longer see.
    this.#pauseAllExcept(target);

    this.refs.stage.scrollTo({
      left: target.offsetLeft - this.refs.stage.offsetLeft,
      behavior: animate && !prefersReducedMotion() ? 'smooth' : 'auto'
    });

    this.#setActive(id);

    if (focusStage) {
      // Focus the stage, not the media: focusing an image says nothing useful,
      // and focusing a video steals the play button's own announcement.
      this.refs.stage.focus({ preventScroll: true });
    }

    return true;
  }

  /**
   * Pause every video and model in the gallery.
   */
  pauseAll() {
    this.#pauseAllExcept(null);
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Derive the active item from the scroll position.
   *
   * Reading the scroll offset rather than tracking an index keeps the state
   * correct however the customer moved: swipe, trackpad, keyboard, thumbnail, or
   * a browser restoring scroll on a Back navigation.
   *
   * @private
   */
  #syncFromScroll() {
    const stage = this.refs.stage;
    const items = this.media;
    if (items.length === 0) return;

    const position = isRTL() ? Math.abs(stage.scrollLeft) : stage.scrollLeft;

    let closest = items[0];
    let smallest = Infinity;

    for (const item of items) {
      const distance = Math.abs(item.offsetLeft - stage.offsetLeft - position);
      if (distance < smallest) {
        smallest = distance;
        closest = item;
      }
    }

    if (closest.dataset.mediaId === this.#activeId) return;

    this.#pauseAllExcept(closest);
    this.#setActive(closest.dataset.mediaId);
  }

  /**
   * @param {string} id
   * @private
   */
  #setActive(id) {
    this.#activeId = id;
    this.dataset.activeMedia = id;

    this.#syncControls();
    this.#announce();

    const item = this.media.find((node) => node.dataset.mediaId === id);
    this.dispatch(
      EVENTS.MEDIA_SELECT,
      mediaSelectDetail(id, this.#indexOf(id), item?.dataset.mediaType || 'image')
    );
  }

  /**
   * Moves by one item, clamped at both ends.
   *
   * Clamped rather than wrapping, because the arrows are disabled at the ends
   * and a control that looks dead but still acts is worse than one that does
   * neither.
   *
   * @param {number} delta
   */
  step(delta) {
    const items = this.media;
    const index = this.#indexOf(this.#activeId);
    const next = Math.min(Math.max(index + delta, 0), items.length - 1);

    if (next === index) return;
    this.goToMedia(items[next]?.dataset.mediaId);
  }

  /**
   * Nested controls win over detached ones, same rule as the carousel.
   *
   * @returns {import('@theme/carousel-controls').ControlRefs}
   * @private
   */
  get #controls() {
    return {
      previous: this.refs.previous || this.#external.previous,
      next: this.refs.next || this.#external.next,
      current: this.refs.current || this.#external.current,
      total: this.refs.total || this.#external.total,
      bar: this.refs.bar || this.#external.bar,
    };
  }

  /** @private */
  #syncControls() {
    const index = this.#indexOf(this.#activeId);
    const count = this.media.length;
    const controls = this.#controls;

    renderControls(controls, index + 1, count);
    toggleControls(controls, count > 1);

    // Disabled at the ends. The gallery does not loop unless the merchant asked
    // for it, so the first and last item are real boundaries.
    const loop = this.dataset.loop === 'true';
    controls.previous?.classList.toggle('carousel-button--disabled', !loop && index <= 0);
    controls.next?.classList.toggle('carousel-button--disabled', !loop && index >= count - 1);

    for (const item of this.media) {
      const current = item.dataset.mediaId === this.#activeId;
      item.toggleAttribute('data-active', current);
    }

    this.refs.thumbnails?.setActive?.(this.#activeId);
    this.dataset.index = String(index);
  }

  /**
   * @param {string|null} id
   * @returns {number}
   * @private
   */
  #indexOf(id) {
    return this.media.findIndex((item) => item.dataset.mediaId === id);
  }

  /**
   * @param {HTMLElement|null} keep
   * @private
   */
  #pauseAllExcept(keep) {
    for (const item of this.media) {
      if (item === keep) continue;

      for (const video of item.querySelectorAll('video')) {
        if (!video.paused) video.pause();
      }

      for (const frame of item.querySelectorAll('iframe')) {
        // Both YouTube and Vimeo accept a postMessage pause. Sending both is
        // harmless: each ignores the other's vocabulary.
        frame.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
        frame.contentWindow?.postMessage('{"method":"pause"}', '*');
      }

      const model = item.querySelector('model-viewer');
      if (model?.pause) model.pause();
    }
  }

  /** @private */
  #announce() {
    const message = themeString('mediaPosition', '', {
      index: this.#indexOf(this.#activeId) + 1,
      count: this.media.length
    });

    if (this.refs.status instanceof HTMLElement) this.refs.status.textContent = message;
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown = (event) => {
    const items = this.media;
    const index = this.#indexOf(this.#activeId);

    const forward = isRTL() ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRTL() ? 'ArrowRight' : 'ArrowLeft';

    let next = null;

    if (event.key === forward) next = Math.min(index + 1, items.length - 1);
    else if (event.key === backward) next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;

    event.preventDefault();
    this.goToMedia(items[next]?.dataset.mediaId);
  };
}

defineComponent('media-gallery', MediaGallery);

/* ==========================================================================
   <media-thumbnails>
   ========================================================================== */

/**
 * The thumbnail strip.
 *
 * A list of buttons, not links, because they change what is displayed rather
 * than navigating. `aria-current` marks the active one, and the strip scrolls
 * the active thumbnail into view when the gallery moves — otherwise swiping
 * through ten images leaves the thumbnails showing the first three.
 *
 * `setActive()` is called directly by `<media-gallery>`. No event, no listener:
 * the gallery owns the active media, and this displays it.
 */
export class MediaThumbnails extends BaseComponent {
  /**
   * @returns {HTMLElement[]}
   */
  get thumbnails() {
    return Array.from(this.querySelectorAll('[data-thumbnail]'));
  }

  /**
   * Mark a thumbnail as current and scroll it into view.
   *
   * @param {string|null} mediaId
   */
  setActive(mediaId) {
    const id = mediaId === null ? null : String(mediaId);
    let active = null;

    for (const thumb of this.thumbnails) {
      const current = thumb.dataset.mediaId === id;
      thumb.setAttribute('aria-current', current ? 'true' : 'false');
      thumb.toggleAttribute('data-active', current);
      if (current) active = thumb;
    }

    // `nearest` scrolls the strip and leaves the page alone.
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

defineComponent('media-thumbnails', MediaThumbnails);

export default { MediaGallery, MediaThumbnails };
