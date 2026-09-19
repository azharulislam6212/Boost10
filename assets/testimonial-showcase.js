/**
 * testimonial-showcase.js — Boost10
 *
 * `<testimonial-showcase>`: the lanes of video reviews on
 * `sections/testimonials-showcase.liquid`, and the modal one of them opens.
 *
 * ## Why this is not `motion-engine`'s marquee
 *
 * That one travels on one axis and this one changes axis at a breakpoint: the
 * lanes are columns running up and down a desktop and rows running left and
 * right on a phone. Teaching the shared marquee a second axis would have meant
 * changing the element the announcement bar and `sections/marquee-scroll.liquid`
 * both run on, for a behaviour neither of them wants — so the loop is
 * reimplemented here, against the same measured-cycle rule, and nothing that
 * already scrolls is touched.
 *
 * ## One cycle is measured, never divided
 *
 * The track is cloned until it covers twice its viewport, and the distance
 * animated is the offset from the first original child to the first child of
 * the next copy. `scrollHeight / 2` looks equivalent and is not: it does not
 * know where the seam is once a flex `gap` and an odd number of copies are
 * involved, and the loop drifts by a gap per lap until a blank stretch appears.
 * That is the bug `motion-engine.js` documents, and this file inherits the fix
 * rather than the maths that caused it.
 *
 * ## The video is never in the page until it is asked for
 *
 * Each card carries a `<template>` holding a whole `<deferred-media>` — poster,
 * play control and a second `<template>` with the real video or embed. Both are
 * inert markup: nothing is fetched for a lane of twelve reviews, not even a
 * poster's worth of metadata for the eleven nobody opens.
 *
 * Opening a card clones that template into the modal. Closing empties the
 * modal, which is also what stops playback — removing the element is the only
 * stop that works for a third-party iframe as well as for a hosted video.
 *
 * @module @theme/testimonial-showcase
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { prefersReducedMotion } from '@theme/utilities';

/**
 * Below this width a lane is a row rather than a column.
 *
 * It is the theme's own mobile breakpoint, and it is stated here as well as in
 * `base.css` because the stylesheet decides the lane's *shape* and this file
 * decides which axis it travels on. If the two disagree there is a width where
 * a lane is laid out as a row and animated as a column, which reads as a
 * section that has stopped working rather than as one pixel out.
 */
const ROW_QUERY = '(max-width: 749px)';

/** Speed below which the movement is not movement, and above which it is unreadable. */
const SPEED_MIN = 2;
const SPEED_MAX = 400;

/**
 * One lane: a clipped viewport, a track inside it, and a loop.
 *
 * Not a custom element. A lane has no behaviour that outlives the section — it
 * is rebuilt on every breakpoint change and destroyed with the host — and
 * registering a tag for it would put a second upgrade step between the
 * merchant's setting and the movement it describes.
 */
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
   * The design offsets the second column so the two do not arrive at the same
   * seam, and this is how that is expressed: the movement is identical and only
   * the starting frame differs. A margin or a padding would do it too and would
   * also move the lane's clip box, which is the thing that has to stay aligned
   * with its neighbour.
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

        // A cloned control must not be a second tab stop for the same review.
        // Its play button still works under a pointer — the delegated handler
        // on the host finds the card either way — it simply cannot be tabbed to.
        for (const focusable of clone.querySelectorAll('a, button, input, select, textarea')) {
          focusable.setAttribute('tabindex', '-1');
        }

        // A copy is not the block. Leaving the editor's own attribute on it
        // gives the theme editor four elements claiming to be the same review,
        // and selecting that block in the sidebar then highlights whichever
        // copy the editor found first — usually one that is off screen.
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

    // Reduced motion stops the lane dead rather than slowing it down. A wall of
    // reviews travelling past with no control is exactly the movement the
    // preference exists to switch off, so the cards become a list the customer
    // scrolls themselves — `base.css` hands the lane its own scroll under the
    // same attribute.
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

    // A lane travelling towards its start edge begins one cycle back, so the
    // first frame is already full of cards rather than an empty strip catching
    // up with itself.
    const from = backwards ? -distance : 0;
    const to = backwards ? 0 : -distance;

    const frame = (value) =>
      row ? `translate3d(${value}px, 0, 0)` : `translate3d(0, ${value}px, 0)`;

    this.animation = this.track.animate(
      [{ transform: frame(from) }, { transform: frame(to) }],
      { duration, easing: 'linear', iterations: Infinity }
    );

    // Seek rather than delay: a delay would hold the lane still for its first
    // pass and only then match its neighbour, and the first pass is the one the
    // customer sees.
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

/**
 * The section: its lanes, and the modal its cards open.
 *
 * The modal is one element for the whole section rather than one per card.
 * Twelve reviews is twelve `<dialog>` elements, twelve focus traps and twelve
 * copies of the same chrome, and the browser's top layer only ever holds one of
 * them. What is per-card is the `<template>`, which is markup rather than
 * behaviour and costs nothing until it is cloned.
 */
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

    // One delegated handler rather than one per card: the lanes clone their
    // cards, and a listener bound at build time would be missing from every
    // copy — which is most of what is on the screen.
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

  /* ------------------------------------------------------------- the modal */

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

    // The name of the person speaking, so the dialog is announced as this
    // review rather than as "dialog" — the same label the card already carries.
    const label = card instanceof HTMLElement ? card.dataset.showcaseLabel : '';
    const dialog = modal.querySelector('dialog');
    if (dialog && label) dialog.setAttribute('aria-label', label);

    // `open()` is `<modal-dialog>`'s, so focus trapping, scroll locking and the
    // entrance are the theme's rather than a second implementation of them.
    // `@theme/dialog` is imported eagerly by `global.js`, so by the time this
    // file has loaded the method is there; the guard is for the one case it is
    // not — a failed overlay module — where doing nothing is better than
    // throwing over a half-filled stage.
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

    // The element upgrades synchronously once it is in the document, but only
    // if its module has already run. A frame's grace covers the case where it
    // has not, and a poster that stays put is the honest fallback.
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

  /* ---------------------------------------------------------- the holding */

  /** @private */
  #watchPointer() {
    if (this.dataset.pauseOnHover === 'false') return;

    for (const lane of this.#lanes) {
      this.on(lane.element, 'pointerenter', () => lane.hold('pointer'));
      this.on(lane.element, 'pointerleave', () => lane.release('pointer'));

      // Focus counts as a pointer here. A keyboard user tabbing into a review
      // is reading it, and a lane that keeps moving takes it away from them.
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

/**
 * Emptying the stage on close is what stops playback.
 *
 * `pause()` works for a hosted video and does nothing at all for a YouTube
 * iframe, which keeps playing behind the closed modal with no way to reach it.
 * Removing the element is the one stop that works for both.
 *
 * Bound at module scope rather than inside the component because the modal is a
 * sibling of the section rather than a descendant — it has to be, to be in the
 * browser's top layer — so the event never passes through the host.
 */
document.addEventListener(EVENTS.OVERLAY_CLOSE, (event) => {
  const modal = event.target;
  if (!(modal instanceof HTMLElement)) return;

  const stage = modal.querySelector('[data-showcase-stage]');
  if (stage instanceof HTMLElement) stage.replaceChildren();
});

export default TestimonialShowcase;
