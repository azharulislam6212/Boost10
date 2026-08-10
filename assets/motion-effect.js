/**
 * motion-effect.js — Boost10
 *
 * `<motion-effect>` is the declarative face of the motion engine. A Liquid
 * section requests an animation without a line of JavaScript:
 *
 *   <motion-effect data-effect="words-slide-up">
 *     <h2>{{ section.settings.heading }}</h2>
 *   </motion-effect>
 *
 *   <motion-effect data-effect="reveal-up" data-target="img">
 *     {{ image }}
 *   </motion-effect>
 *
 *   <motion-effect data-effect="fade-up" data-children data-stagger="90">
 *     {%- for block in section.blocks -%}<div>…</div>{%- endfor -%}
 *   </motion-effect>
 *
 * On load and on scroll are one code path. `reveal()` observes the element, and
 * IntersectionObserver fires immediately for anything already on screen, so
 * above-the-fold content animates during the first paint window with a short
 * cascade, and everything below animates as the customer scrolls to it. Lenis
 * scrolls the real document, so nothing here needs to know it exists.
 *
 * Content is hidden by JavaScript, not by CSS. The resting state is written
 * inline at the moment this element takes charge, so if the script never loads,
 * nothing was ever hidden — a failed animation must not cost a sale.
 *
 * Attributes, all optional:
 *
 *   data-effect          Preset name. See the table below. Default: fade-up
 *   data-target          Selector for descendants to animate instead of the host
 *   data-children        Animate direct children, staggered
 *   data-duration        Milliseconds. Overrides the preset default
 *   data-delay           Milliseconds before the first target
 *   data-stagger         Milliseconds between targets
 *   data-distance        Travel distance in pixels for slide and reveal presets
 *   data-threshold       Intersection ratio required to trigger (default 0.12)
 *   data-root-margin     Intersection root margin
 *   data-once            "false" to replay every time it enters the viewport
 *   data-load-cascade    "false" to opt out of the on-load stagger
 *   data-speed           Parallax rate, or marquee pixels per second
 *   data-direction       left | right, for marquee
 *   data-axis            x | y, for parallax
 *   data-pause-on-hover  "false" to keep a marquee running under the pointer
 *
 * Text presets (the element's text is split automatically):
 *   split-text, words-slide-up, words-rotate-in, words-slide-from-right,
 *   letters-slide-up, letters-slide-down, letters-fade-in,
 *   letters-fade-in-random
 *
 * Image and block presets:
 *   fade, fade-in, fade-up, slide-up, slide-down, slide-left, slide-right,
 *   zoom-in, zoom-out, reveal-left, reveal-right, reveal-up, reveal-down,
 *   scale, blur
 *
 * Continuous effects, which run instead of an entrance animation:
 *   parallax, marquee
 *
 * @module @theme/motion-effect
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { reveal, parallax, marquee, unsplitText, getPreset, motionEnabled } from '@theme/motion-engine';

/** Effects that run continuously rather than once on entry. */
const CONTINUOUS = new Set(['parallax', 'marquee']);

export class MotionEffect extends BaseComponent {
  /** @type {(() => void)|null} */
  #cancelReveal = null;

  /** @type {{ destroy: () => void }|null} */
  #instance = null;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    // `setup()` runs again whenever the element is moved in the DOM, which
    // morphing does routinely, so any previous run must be undone first.
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

  /* --------------------------------------------------------- public API -- */

  /**
   * Replay the animation from its resting state.
   *
   * Used by the Theme Editor hook below, and available to sections that swap
   * their own content without a full section render.
   */
  replay() {
    this.removeAttribute('data-motion-revealed');
    for (const target of this.#targets()) target.removeAttribute('data-motion-revealed');
    this.setup();
  }

  /* ------------------------------------------------------------ effects -- */

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

    this.#cancelReveal = reveal(preset.split && targets.length === 1 ? targets[0] : this, {
      effect,
      // Text presets split their own target, so no explicit target list is
      // passed for them unless the section asked for several elements.
      targets: preset.split && targets.length <= 1 ? undefined : targets,
      duration: this.#number('duration'),
      delay: this.#number('delay'),
      stagger: this.#number('stagger'),
      distance: this.#number('distance'),
      threshold: this.#number('threshold'),
      rootMargin: this.dataset.rootMargin,
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
   * `marquee()` moves the element it is handed and treats that element's
   * *parent* as the clipping viewport. `#targets()` returns the host when no
   * `data-target` is set, which made the host itself the moving part and its
   * parent — the section wrapper, which does not clip — the viewport. The
   * result was the whole bar sliding off the page once and never coming back.
   *
   * So a marquee resolves its track explicitly: an opted-in `[data-marquee-track]`
   * first, then a `data-target` if the section gave one, then the single child
   * that is doing the job anyway. The host is never returned.
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

  /* ------------------------------------------------------------ helpers -- */

  /**
   * Resolve which elements the effect applies to.
   *
   * With no `data-target` or `data-children`, the host element is the target,
   * which keeps the common case to a single attribute.
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

    // Split text has to be reassembled, or a second setup would split the
    // already-split spans and produce one letter per span per run.
    for (const target of this.#targets()) {
      if (target.hasAttribute('data-motion-split')) unsplitText(target);
    }
    if (this.hasAttribute('data-motion-split')) unsplitText(this);
  }

  /* ------------------------------------------------------- theme editor -- */

  /**
   * Replay when a merchant selects the section, so the effect they just chose is
   * visible without a manual reload.
   */
  sectionSelected() {
    if (!motionEnabled()) return;
    this.replay();
  }

  /**
   * A section re-render replaces the markup underneath this element, so the
   * split spans and inline resting styles are gone and the effect has to be
   * rebuilt from scratch.
   */
  sectionLoaded() {
    if (!motionEnabled()) return;
    this.replay();
  }
}

defineComponent('motion-effect', MotionEffect);

/* ==========================================================================
   <parallax-media>
   ========================================================================== */

/**
 * Background parallax for a hero.
 *
 * Moves a media layer at a fraction of the scroll speed. Three things keep this
 * from being the usual janky implementation:
 *
 * **It writes a custom property, never `top` or `margin`.** The property feeds a
 * `translate3d` in CSS, so the work happens on the compositor and never triggers
 * layout.
 *
 * **The loop stops when the element leaves the viewport.** An IntersectionObserver
 * switches the rAF loop off entirely, so a hero at the top of a long page costs
 * nothing for the rest of the scroll.
 *
 * **Reduced motion means not starting at all.** Parallax is decorative movement
 * tied to scrolling with no user control — exactly what the preference exists to
 * switch off, and there is no slower parallax that becomes acceptable. It is
 * also off on touch, where scroll is driven by a finger and the lag between the
 * two layers reads as a rendering fault rather than an effect.
 *
 * The media is scaled slightly in CSS so the shifted layer never exposes an edge.
 *
 * Markup:
 *
 *   <parallax-media data-speed="0.3">
 *     <img …>
 *   </parallax-media>
 */
export class ParallaxMedia extends BaseComponent {
  /** @type {number|null} */
  #frame = null;

  /** @type {IntersectionObserver|null} */
  #observer = null;

  #active = false;

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

  /** @private */
  #start() {
    if (this.#active) return;
    this.#active = true;
    this.#tick();
  }

  /** @private */
  #stop() {
    this.#active = false;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /** @private */
  #tick = () => {
    if (!this.#active) return;

    const rect = this.getBoundingClientRect();
    const viewport = window.innerHeight;

    // How far through the viewport this element sits, from roughly -1 (below)
    // to 1 (above). Reading the rect is the only layout query, and it happens
    // once per frame rather than once per scroll event.
    const progress = (rect.top + rect.height / 2 - viewport / 2) / viewport;
    const offset = progress * this.speed * rect.height * -1;

    this.style.setProperty('--parallax-offset', `${offset.toFixed(2)}px`);

    this.#frame = requestAnimationFrame(this.#tick);
  };
}

defineComponent('parallax-media', ParallaxMedia);

export default { MotionEffect, ParallaxMedia };
