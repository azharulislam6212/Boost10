/**
 * `<motion-effect>` is the declarative face of the motion engine. A Liquid
 * section requests an animation without a line of JavaScript:
 *
 * @module @theme/motion-effect
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { reveal, parallax, marquee, unsplitText, getPreset, motionEnabled, subscribeToTicker, EASING } from '@theme/motion-engine';

/** Effects that run continuously rather than once on entry. */
const CONTINUOUS = new Set(['parallax', 'marquee']);

export class MotionEffect extends BaseComponent {
  /**
   * A decorator, not an owner. This element wraps whatever content a section or
   * a block hands it and animates it — it never reads `this.refs`, so it must
   * not stop a ref inside it from reaching the component around it.
   *
   * @type {boolean}
   */
  static refBoundary = false;

  /** @type {(() => void)|null} */
  #cancelReveal = null;

  /** @type {{ destroy: () => void }|null} */
  #instance = null;

  /* ------------------------------------------------------------ lifecycle ---- */

  setup() {
    this.#teardownEffect();

    const effect = this.dataset.effect || 'fade-up';

    if (effect === 'none' || effect === '') {
      this.setAttribute('data-motion-revealed', '');
      return;
    }

    if (CONTINUOUS.has(effect)) {
      this.#setupContinuous(effect);
      return;
    }

    this.#setupReveal(effect);
  }

  teardown() {
    this.#teardownEffect();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** Replay the animation from its resting state. */
  replay() {
    this.removeAttribute('data-motion-revealed');
    for (const target of this.#targets()) target.removeAttribute('data-motion-revealed');
    this.setup();
  }

  /* ------------------------------------------------------------ effects -- ---- */

  /**
   * @param {string} effect
   * @private
   */
  #setupReveal(effect) {
    const preset = getPreset(effect);

    if (!preset) {
      console.warn(`[Boost10] <motion-effect> has no preset named "${effect}".`);
      this.setAttribute('data-motion-revealed', '');
      return;
    }

    const targets = this.#targets();

    this.setAttribute('data-motion-pending', '');

    this.#cancelReveal = reveal(preset.split && targets.length === 1 ? targets[0] : this, {
      effect,
      onReveal: () => {
        this.removeAttribute('data-motion-pending');
        this.setAttribute('data-motion-revealed', '');
      },
      targets: preset.split && targets.length <= 1 ? undefined : targets,
      duration: this.#number('duration'),
      delay: this.#number('delay'),
      stagger: this.#number('stagger'),
      distance: this.#number('distance'),
      threshold: this.#number('threshold'),
      rootMargin: this.dataset.rootMargin,
      easing: this.dataset.easing ? EASING[this.dataset.easing] || this.dataset.easing : undefined,
      once: this.dataset.once !== 'false',
      loadCascade: this.dataset.loadCascade !== 'false'
    });
  }

  /**
   * @param {string} effect
   * @private
   */
  #setupContinuous(effect) {
    const target = effect === 'marquee' ? this.#marqueeTrack() : this.#targets()[0] || this.firstElementChild || this;

    if (effect === 'parallax') {
      this.#instance = parallax(target, {
        speed: this.#number('speed') ?? 0.2,
        axis: this.dataset.axis === 'x' ? 'x' : 'y'
      });
    } else {
      this.#instance = marquee(target, {
        speed: this.#number('speed') ?? 60,
        direction: this.dataset.direction === 'right' ? 'right' : 'left',
        pauseOnHover: this.dataset.pauseOnHover !== 'false'
      });
    }

    this.setAttribute('data-motion-revealed', '');
  }

  /**
   * The element a marquee actually translates.
   *
   * @returns {HTMLElement}
   * @private
   */
  #marqueeTrack() {
    const opted = /** @type {HTMLElement|null} */ (this.querySelector('[data-marquee-track]'));
    if (opted) return opted;

    if (this.dataset.target) {
      const found = /** @type {HTMLElement|null} */ (this.querySelector(this.dataset.target));
      if (found) return found;
    }

    return /** @type {HTMLElement} */ (this.firstElementChild ?? this);
  }

  /* ------------------------------------------------------------ helpers -- ---- */

  /**
   * Resolve which elements the effect applies to.
   *
   * @returns {HTMLElement[]}
   * @private
   */
  #targets() {
    if (this.dataset.target) {
      const found = Array.from(this.querySelectorAll(this.dataset.target));
      if (found.length > 0) return found;
    }

    if (this.dataset.children !== undefined && this.dataset.children !== 'false') {
      return Array.from(this.children);
    }

    return [this];
  }

  /**
   * @param {string} name
   * @returns {number|undefined}
   * @private
   */
  #number(name) {
    const raw = this.dataset[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  /** @private */
  #teardownEffect() {
    this.#cancelReveal?.();
    this.#cancelReveal = null;

    this.#instance?.destroy();
    this.#instance = null;

    for (const target of this.#targets()) {
      if (target.hasAttribute('data-motion-split')) unsplitText(target);
    }
    if (this.hasAttribute('data-motion-split')) unsplitText(this);
  }
}

defineComponent('motion-effect', MotionEffect);

/* ==========================================================================
   <parallax-media>
   ========================================================================== */

/** Background parallax for a hero. */
export class ParallaxMedia extends BaseComponent {
  /** Transparent to refs for the same reason `MotionEffect` is. @type {boolean} */
  static refBoundary = false;

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  /** @type {IntersectionObserver|null} */
  #observer = null;

  setup() {
    if (!motionEnabled()) {
      this.dataset.parallax = 'off';
      return;
    }

    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.#start();
          else this.#stop();
        }
      },
      { rootMargin: '100px' }
    );

    this.#observer.observe(this);
  }

  teardown() {
    this.#stop();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /**
   * @returns {number} 0 is static, 1 moves with the page. Capped at 0.5, because
   *   past about half the scroll speed the effect reads as a broken sticky
   *   element rather than depth.
   */
  get speed() {
    return Math.min(Math.abs(Number(this.dataset.speed) || 0.3), 0.5);
  }

  /** Follow the scroll while on screen; the ticker is idle when the page is still. @private */
  #start() {
    this.#unsubscribe ??= subscribeToTicker(this.#tick);
  }

  /** @private */
  #stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** @private */
  #tick = () => {

    const rect = this.getBoundingClientRect();
    const viewport = window.innerHeight;

    const progress = (rect.top + rect.height / 2 - viewport / 2) / viewport;
    const offset = progress * this.speed * rect.height * -1;

    this.style.setProperty('--parallax-offset', `${offset.toFixed(2)}px`);
  };
}

defineComponent('parallax-media', ParallaxMedia);

export default { MotionEffect, ParallaxMedia };
