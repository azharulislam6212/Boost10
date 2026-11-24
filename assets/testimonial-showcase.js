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
const ROW_QUERY = window.matchMedia('(max-width: 749px)');

/** Longest wait for the modal poster to decode before opening anyway, in milliseconds. */
const POSTER_WAIT = 600;

/** Pixels per second: slower is not movement, faster is unreadable. */
const SPEED_MIN = 2;
const SPEED_MAX = 400;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** One lane: a clipped viewport, a track inside it, and a loop. */
class Lane {
  /** @type {Element[]} */
  clones = [];

  /** @type {Animation|null} */
  animation = null;

  /** Held by a pointer, by focus, by the modal, or by being off screen. */
  holds = new Set();

  /** @param {HTMLElement} element The lane viewport. */
  constructor(element) {
    this.element = element;
    /** @type {HTMLElement|null} */
    this.track = element.querySelector('[data-showcase-track]');
    this.originals = this.track ? [...this.track.children].filter((node) => !node.hasAttribute('data-showcase-clone')) : [];
  }

  /**
   * Clone the originals until the track covers twice its viewport.
   *
   * @param {boolean} row
   * @returns {number} The length of one cycle.
   */
  build(row) {
    const { element, track, originals } = this;
    if (!track || originals.length === 0) return 0;

    this.clear();

    const viewport = row ? element.offsetWidth : element.offsetHeight;
    const base = row ? track.scrollWidth : track.scrollHeight;
    if (base === 0) return 0;

    const copies = Math.max(2, Math.ceil((viewport * 2) / base) + 1);

    for (let copy = 1; copy < copies; copy += 1) {
      for (const node of originals) {
        const clone = /** @type {Element} */ (node.cloneNode(true));
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('data-showcase-clone', '');
        clone.removeAttribute('data-shopify-editor-block');
        clone.querySelectorAll('[data-shopify-editor-block]').forEach((el) => el.removeAttribute('data-shopify-editor-block'));
        clone.querySelectorAll('a, button, input, select, textarea').forEach((el) => el.setAttribute('tabindex', '-1'));
        track.append(clone);
        this.clones.push(clone);
      }
    }

    const first = /** @type {HTMLElement} */ (track.children[0]);
    const next = /** @type {HTMLElement} */ (track.children[originals.length]);
    if (!first || !next) return base;

    return row ? next.offsetLeft - first.offsetLeft : next.offsetTop - first.offsetTop;
  }

  /** Measure, clone and start. Safe to call again at any time. */
  start() {
    this.animation?.cancel();
    this.animation = null;

    const reduced = prefersReducedMotion();
    this.element.toggleAttribute('data-showcase-static', reduced);
    if (reduced) return;

    const row = ROW_QUERY.matches;
    const distance = this.build(row);
    if (!distance || !this.track) return;

    const { speed, offset, directionDesktop, directionMobile } = this.element.dataset;
    const duration = (distance / clamp(Number(speed) || 40, SPEED_MIN, SPEED_MAX)) * 1000;
    const backwards = row ? directionMobile === 'right' : directionDesktop === 'down';
    const frame = (value) => (row ? `translate3d(${value}px, 0, 0)` : `translate3d(0, ${value}px, 0)`);

    this.animation = this.track.animate(
      [{ transform: frame(backwards ? -distance : 0) }, { transform: frame(backwards ? 0 : -distance) }],
      { duration, easing: 'linear', iterations: Infinity }
    );

    const start = clamp(Number(offset) || 0, 0, 100) / 100;
    if (start > 0) this.animation.currentTime = duration * start;
    if (this.holds.size > 0) this.animation.pause();
  }

  /**
   * Hold the lane still for a named reason. Every reason has to be released
   * before it moves again, so a pointer leaving an off-screen lane can't start it.
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

  clear() {
    this.clones.forEach((clone) => clone.remove());
    this.clones = [];
  }

  destroy() {
    this.animation?.cancel();
    this.animation = null;
    this.clear();
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

  setup() {
    this.#lanes = [...this.querySelectorAll('[data-showcase-lane]')].map((element) => new Lane(/** @type {HTMLElement} */ (element)));
    this.#restart();

    for (const lane of this.#lanes) {
      this.on(lane.element, 'pointerenter', () => lane.hold('pointer'));
      this.on(lane.element, 'pointerleave', () => lane.release('pointer'));
      this.on(lane.element, 'focusin', () => lane.hold('focus'));
      this.on(lane.element, 'focusout', () => lane.release('focus'));
    }

    this.#visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const lane = this.#lanes.find((candidate) => candidate.element === entry.target);
          if (entry.isIntersecting) lane?.release('offscreen');
          else lane?.hold('offscreen');
        }
      },
      { rootMargin: '200px' }
    );
    this.#lanes.forEach((lane) => this.#visibility?.observe(lane.element));

    let width = this.offsetWidth;
    this.#resize = new ResizeObserver(() => {
      if (this.offsetWidth === width) return;
      width = this.offsetWidth;
      this.#restart();
    });
    this.#resize.observe(this);

    this.on(ROW_QUERY, 'change', () => this.#restart());

    this.on(this, 'click', (event) => {
      const trigger = /** @type {Element} */ (event.target).closest?.('[data-showcase-play]');
      if (!trigger) return;
      event.preventDefault();
      this.openVideo(trigger.closest('[data-showcase-card]'));
    });

    this.on(document, EVENTS.OVERLAY_CLOSE, (event) => {
      if (event.target === this.#modal) this.#lanes.forEach((lane) => lane.release('modal'));
    });
  }

  teardown() {
    this.#lanes.forEach((lane) => lane.destroy());
    this.#lanes = [];
    this.#resize?.disconnect();
    this.#resize = null;
    this.#visibility?.disconnect();
    this.#visibility = null;
  }

  /**
   * Show one card's video.
   *
   * @param {Element|null} card
   */
  async openVideo(card) {
    const modal = /** @type {any} */ (this.#modal);
    const stage = modal?.querySelector('[data-showcase-stage]');
    const template = card?.querySelector('template[data-showcase-video]');

    if (!(stage instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) return;
    if (modal.isOpen || typeof modal.open !== 'function') return;

    stage.replaceChildren(template.content.cloneNode(true));

    const label = card instanceof HTMLElement ? card.dataset.showcaseLabel : '';
    if (label) modal.querySelector('dialog')?.setAttribute('aria-label', label);

    const image = stage.querySelector('img');
    if (image) await Promise.race([image.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, POSTER_WAIT))]);

    this.#lanes.forEach((lane) => lane.hold('modal'));
    modal.open();
  }

  #restart() {
    this.#lanes.forEach((lane) => lane.start());
  }

  /** @returns {HTMLElement|null} */
  get #modal() {
    const id = this.dataset.modal;
    return id ? document.getElementById(id) : null;
  }
}

defineComponent('testimonial-showcase', TestimonialShowcase);

/** Emptying the stage on close is what stops playback. */
document.addEventListener(EVENTS.OVERLAY_CLOSE, (event) => {
  const modal = event.target;
  if (modal instanceof HTMLElement) modal.querySelector('[data-showcase-stage]')?.replaceChildren();
});

export default TestimonialShowcase;
