/**
 * `<testimonial-showcase>`: the lanes of video reviews on
 * `sections/testimonials-showcase.liquid`, and the modal one of them opens.
 *
 * @module @theme/testimonial-showcase
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { prefersReducedMotion } from '@theme/utilities';

/** Below this width a lane is a row rather than a column. */
const ROW_QUERY = '(max-width: 749px)';

/** Speed below which the movement is not movement, and above which it is unreadable. */
const SPEED_MIN = 2;
const SPEED_MAX = 400;

/** One lane: a clipped viewport, a track inside it, and a loop. */
class Lane {
  /** @param {HTMLElement} element The lane viewport. */
  constructor(element) {
    /** @type {HTMLElement} */
    this.element = element;

    /** @type {HTMLElement|null} */
    this.track = element.querySelector('[data-showcase-track]');

    /** @type {Element[]} */
    this.originals = this.track
      ? Array.from(this.track.children).filter((node) => !node.hasAttribute('data-showcase-clone'))
      : [];

    /** @type {Element[]} */
    this.clones = [];

    /** @type {Animation|null} */
    this.animation = null;

    /** Held by a pointer, by focus, or by the lane being off screen. */
    this.holds = new Set();
  }

  /** @returns {boolean} Whether this lane is a row at the current width. */
  get isRow() {
    return window.matchMedia(ROW_QUERY).matches;
  }

  /** @returns {'up'|'down'|'left'|'right'} */
  get direction() {
    const data = this.element.dataset;
    if (this.isRow) return data.directionMobile === 'right' ? 'right' : 'left';
    return data.directionDesktop === 'down' ? 'down' : 'up';
  }

  /**
   * How far into its own loop the lane starts, as a share of one cycle.
   *
   * @returns {number} 0 to 1.
   */
  get offset() {
    const value = Number(this.element.dataset.offset);
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 100) / 100;
  }

  /** @returns {number} Pixels per second, clamped. */
  get speed() {
    const raw = this.isRow ? this.element.dataset.speedMobile : this.element.dataset.speed;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 40;
    return Math.min(Math.max(value, SPEED_MIN), SPEED_MAX);
  }

  /**
   * Clone the originals until the track covers twice its viewport, and return
   * the length of one cycle.
   *
   * @returns {number}
   * @private
   */
  build() {
    const track = this.track;
    if (!track || this.originals.length === 0) return 0;

    for (const clone of this.clones) clone.remove();
    this.clones = [];

    const row = this.isRow;
    const viewport = row ? this.element.offsetWidth : this.element.offsetHeight;
    const base = row ? track.scrollWidth : track.scrollHeight;
    if (base === 0) return 0;

    const copies = Math.max(2, Math.ceil((viewport * 2) / base) + 1);

    for (let copy = 1; copy < copies; copy += 1) {
      for (const node of this.originals) {
        const clone = /** @type {Element} */ (node.cloneNode(true));
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('data-showcase-clone', '');

        for (const focusable of clone.querySelectorAll('a, button, input, select, textarea')) {
          focusable.setAttribute('tabindex', '-1');
        }

        clone.removeAttribute('data-shopify-editor-block');
        for (const marked of clone.querySelectorAll('[data-shopify-editor-block]')) {
          marked.removeAttribute('data-shopify-editor-block');
        }

        track.appendChild(clone);
        this.clones.push(clone);
      }
    }

    const first = /** @type {HTMLElement} */ (track.children[0]);
    const next = /** @type {HTMLElement} */ (track.children[this.originals.length]);
    if (!first || !next) return base;

    return row ? next.offsetLeft - first.offsetLeft : next.offsetTop - first.offsetTop;
  }

  /** Measure, clone and start. Safe to call again at any time. */
  start() {
    this.animation?.cancel();
    this.animation = null;

    if (prefersReducedMotion()) {
      this.element.setAttribute('data-showcase-static', '');
      return;
    }

    this.element.removeAttribute('data-showcase-static');

    const distance = this.build();
    if (!distance || !this.track) return;

    const duration = (distance / this.speed) * 1000;
    const row = this.isRow;
    const backwards = this.direction === 'down' || this.direction === 'right';

    const from = backwards ? -distance : 0;
    const to = backwards ? 0 : -distance;

    const frame = (value) =>
      row ? `translate3d(${value}px, 0, 0)` : `translate3d(0, ${value}px, 0)`;

    this.animation = this.track.animate(
      [{ transform: frame(from) }, { transform: frame(to) }],
      { duration, easing: 'linear', iterations: Infinity }
    );

    if (this.offset > 0) this.animation.currentTime = duration * this.offset;

    if (this.holds.size > 0) this.animation.pause();
  }

  /**
   * Hold the lane still for a named reason. Every reason has to be released
   * before it moves again — a pointer leaving while the lane is off screen
   * must not start it.
   *
   * @param {string} reason
   */
  hold(reason) {
    this.holds.add(reason);
    this.animation?.pause();
  }

  /** @param {string} reason */
  release(reason) {
    this.holds.delete(reason);
    if (this.holds.size === 0) this.animation?.play();
  }

  destroy() {
    this.animation?.cancel();
    this.animation = null;
    for (const clone of this.clones) clone.remove();
    this.clones = [];
  }
}

/** The section: its lanes, and the modal its cards open. */
export class TestimonialShowcase extends BaseComponent {
  /** @type {Lane[]} */
  #lanes = [];

  /** @type {ResizeObserver|null} */
  #resize = null;

  /** @type {IntersectionObserver|null} */
  #visibility = null;

  /** @type {number} */
  #lastSize = 0;

  setup() {
    this.#lanes = Array.from(this.querySelectorAll('[data-showcase-lane]')).map(
      (element) => new Lane(/** @type {HTMLElement} */ (element))
    );

    for (const lane of this.#lanes) lane.start();

    this.#watchPointer();
    this.#watchVisibility();
    this.#watchSize();
    this.#watchBreakpoint();

    this.on(this, 'click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (!target || typeof target.closest !== 'function') return;

      const trigger = target.closest('[data-showcase-play]');
      if (!trigger) return;

      event.preventDefault();
      this.openVideo(trigger.closest('[data-showcase-card]'));
    });
  }

  teardown() {
    for (const lane of this.#lanes) lane.destroy();
    this.#lanes = [];

    this.#resize?.disconnect();
    this.#resize = null;
    this.#visibility?.disconnect();
    this.#visibility = null;
  }

  /* ------------------------------------------------------------- the modal ---- */

  /**
   * Show one card's video.
   *
   * @param {Element|null} card
   */
  openVideo(card) {
    const modal = this.#modal;
    const stage = modal?.querySelector('[data-showcase-stage]');
    const template = card?.querySelector('template[data-showcase-video]');

    if (!modal || !(stage instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) {
      return;
    }

    stage.replaceChildren(template.content.cloneNode(true));

    const label = card instanceof HTMLElement ? card.dataset.showcaseLabel : '';
    const dialog = modal.querySelector('dialog');
    if (dialog && label) dialog.setAttribute('aria-label', label);

    const overlay = /** @type {any} */ (modal);
    if (typeof overlay.open === 'function') overlay.open();

    if (this.dataset.modalAutoplay === 'true') this.#play(stage);
  }

  /**
   * Start the cloned media without waiting for a second press.
   *
   * @param {HTMLElement} stage
   * @private
   */
  #play(stage) {
    const media = stage.querySelector('deferred-media');
    if (!media) return;

    requestAnimationFrame(() => {
      const deferred = /** @type {any} */ (media);
      if (typeof deferred.load === 'function') deferred.load();
    });
  }

  /**
   * @returns {HTMLElement|null}
   * @private
   */
  get #modal() {
    const id = this.dataset.modal;
    return id ? document.getElementById(id) : null;
  }

  /* ---------------------------------------------------------- the holding ---- */

  /** @private */
  #watchPointer() {
    if (this.dataset.pauseOnHover === 'false') return;

    for (const lane of this.#lanes) {
      this.on(lane.element, 'pointerenter', () => lane.hold('pointer'));
      this.on(lane.element, 'pointerleave', () => lane.release('pointer'));

      this.on(lane.element, 'focusin', () => lane.hold('focus'));
      this.on(lane.element, 'focusout', () => lane.release('focus'));
    }
  }

  /**
   * A lane that is not on the screen is animating for nobody. Holding it costs
   * one observer and gives back a composited animation per lane on every page
   * where this section is not the part being looked at.
   *
   * @private
   */
  #watchVisibility() {
    if (!('IntersectionObserver' in window)) return;

    this.#visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const lane = this.#lanes.find((candidate) => candidate.element === entry.target);
          if (!lane) continue;
          if (entry.isIntersecting) lane.release('offscreen');
          else lane.hold('offscreen');
        }
      },
      { rootMargin: '200px' }
    );

    for (const lane of this.#lanes) this.#visibility.observe(lane.element);
  }

  /**
   * A lane built inside a box with no size — a section in a closed tab, or one
   * measured before its images have reserved their space — measures zero and
   * would never move. Rebuilding when the box gains a real size is the same
   * recovery `<carousel-slider>` and the shared marquee both make.
   *
   * @private
   */
  #watchSize() {
    if (!('ResizeObserver' in window)) return;

    this.#lastSize = this.offsetWidth;

    this.#resize = new ResizeObserver(() => {
      const size = this.offsetWidth;
      if (size === this.#lastSize) return;
      this.#lastSize = size;
      for (const lane of this.#lanes) lane.start();
    });

    this.#resize.observe(this);
  }

  /**
   * Crossing the breakpoint changes the axis, and an animation built for the
   * other one translates the track off its own viewport.
   *
   * @private
   */
  #watchBreakpoint() {
    this.on(window.matchMedia(ROW_QUERY), 'change', () => {
      for (const lane of this.#lanes) lane.start();
    });
  }
}

defineComponent('testimonial-showcase', TestimonialShowcase);

/** Emptying the stage on close is what stops playback. */
document.addEventListener(EVENTS.OVERLAY_CLOSE, (event) => {
  const modal = event.target;
  if (!(modal instanceof HTMLElement)) return;

  const stage = modal.querySelector('[data-showcase-stage]');
  if (stage instanceof HTMLElement) stage.replaceChildren();
});

export default TestimonialShowcase;
