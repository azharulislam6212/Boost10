/**
 * `<motion-effect>` is the declarative face of the motion engine. A Liquid
 * section requests an animation without a line of JavaScript:
 *
 * @module @theme/motion-effect
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { reveal, parallax, marquee, unsplitText, getPreset, motionEnabled, subscribeToTicker, EASING } from '@theme/motion-engine';
import { isDesignMode } from '@theme/utilities';

/** Effects that run continuously rather than once on entry. */
const CONTINUOUS = new Set(['parallax', 'marquee']);

/**
 * True once the Theme Editor preview has finished its first load. Anything that
 * connects after that is a section the editor re-rendered.
 *
 * @type {boolean}
 */
let editorReady = false;

if (isDesignMode()) {
  if (document.readyState === 'complete') {
    editorReady = true;
  } else {
    window.addEventListener('load', () => (editorReady = true), { once: true });
  }
}

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

  /** True inside `replay()`, which always animates. @type {boolean} */
  #replaying = false;

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

    // The editor re-renders a section on every setting change. Replaying its
    // entrance from invisible each time made every edit feel like a slow reload,
    // so content that arrives after the preview has loaded simply appears.
    if (editorReady && !this.#replaying) {
      this.removeAttribute('data-motion-pending');
      this.setAttribute('data-motion-revealed', '');
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
    this.#replaying = true;
    this.setup();
    this.#replaying = false;
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

  /** @type {ResizeObserver|null} */
  #resizeObserver = null;

  /**
   * Untransformed centre in document coordinates and rendered height, read once
   * and reused so a scroll frame never has to ask the browser for layout.
   *
   * @type {{ centre: number, height: number }|null}
   */
  #geometry = null;

  /** The offset last written, in pixels. @type {number} */
  #offset = 0;

  setup() {
    if (!motionEnabled()) {
      this.dataset.parallax = 'off';
      return;
    }

    this.#resizeObserver = new ResizeObserver(this.#invalidate);
    this.#resizeObserver.observe(this);
    this.on(window, 'resize', this.#invalidate, { passive: true });

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
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#geometry = null;
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
  #invalidate = () => {
    this.#geometry = null;
  };

  /** @private */
  #measure() {
    const rect = this.getBoundingClientRect();
    // The layer is translated by its own offset; take it back out so the centre
    // is where layout put it. Scaling is about the centre and does not move it.
    this.#geometry = {
      centre: rect.top + rect.height / 2 + window.scrollY - this.#offset,
      height: rect.height
    };
  }

  /** @private */
  #tick = (scrollY = window.scrollY) => {
    if (!this.#geometry) this.#measure();
    const { centre, height } = /** @type {{ centre: number, height: number }} */ (this.#geometry);

    const viewport = window.innerHeight;
    const strength = this.speed * height;

    // The resting point of the old read-every-frame loop, whose measured centre
    // included the offset it had just written: solved once instead of chased.
    const distance = centre - scrollY - viewport / 2;
    const offset = (-distance * strength) / (viewport + strength);

    this.#offset = offset;
    this.style.setProperty('--parallax-offset', `${offset.toFixed(2)}px`);
  };
}

defineComponent('parallax-media', ParallaxMedia);

export default { MotionEffect, ParallaxMedia };
