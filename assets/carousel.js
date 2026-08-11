/**
 * carousel.js — Boost10
 *
 * `<swiper-carousel>` — a thin, opinionated adapter over Swiper.
 *
 * Swiper owns the sliding. This file owns five things Swiper does not do for
 * us, and deliberately nothing else:
 *
 *   1. Turning one JSON attribute into a Swiper config, and tagging the slides
 *      Swiper needs to find.
 *   2. Deciding *whether* to be a carousel at the current breakpoint, so a
 *      section can be a CSS grid on desktop and a carousel on mobile using the
 *      same nodes.
 *   3. Finding its arrows, whether they are nested inside it or somewhere else
 *      in the document pointing back with `data-carousel-for`.
 *   4. Accessibility. The bundled build has no A11y module, so the arrows are
 *      real buttons in the markup and the position is announced from here.
 *   5. Theme-editor lifecycle.
 *
 * ## The options contract
 *
 * Everything is passed as JSON in `data-options`:
 *
 *   <swiper-carousel data-options='{"slidesPerView":1,"loop":true}'>
 *
 * That is merged over the defaults below, and a small set of runtime values is
 * merged over the result — element references for navigation and pagination,
 * the module list, and the reduced-motion overrides. Those depend on the DOM
 * and on the customer's OS settings rather than on a section setting, so they
 * are not negotiable from Liquid.
 *
 * Precedence: defaults → data-options → runtime.
 *
 * ## What the bundled Swiper contains
 *
 * `assets/swiper.js` exports exactly: `Swiper`, `Navigation`, `Pagination`,
 * `Autoplay`, `Mousewheel`.
 *
 * No Scrollbar, no Thumbs, no FreeMode, no Grid, no A11y, no Zoom, no
 * Controller. Passing `scrollbar` or `thumbs` in `data-options` does nothing —
 * silently, because Swiper ignores config for modules that were not registered.
 * To add one, rebuild the bundle from swiperjs.com with that module included
 * and add it to `MODULES`.
 *
 * @module @theme/carousel
 */

import { Swiper, Navigation, Pagination, Autoplay, Mousewheel } from '@theme/swiper';
import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { themeString, prefersReducedMotion } from '@theme/utilities';
import { renderControls, findExternalControls, toggleControls } from '@theme/carousel-controls';

/**
 * Registered once per instance. Adding a module here without adding it to the
 * bundle is a silent no-op, which is the failure mode this comment prevents.
 */
const MODULES = [Navigation, Pagination, Autoplay, Mousewheel];

/** Matches the 750px breakpoint used throughout base.css. */
const DESKTOP_QUERY = '(min-width: 750px)';

/**
 * Conservative defaults. Anything a section wants to change belongs in
 * `data-options` — this is the behaviour of a carousel given no configuration.
 */
const DEFAULTS = {
  slidesPerView: 1,
  speed: 500,
  spaceBetween: 0,
  watchOverflow: true,
  grabCursor: true,
  threshold: 5,
  longSwipesRatio: 0.25,
  resistanceRatio: 0.85,
  centeredSlides: false,
  loop: false,

  // Off by default. `observer` walks the subtree on every mutation, which on a
  // product carousel means every variant swatch preview and every quick-add
  // re-render triggers a full Swiper update.
  observer: false,
  observeParents: false,
  resizeObserver: true,
  updateOnWindowResize: true,
};

export class SwiperCarousel extends BaseComponent {
  static requiredRefs = ['track'];

  /** @type {import('swiper').Swiper|null} */
  #swiper = null;

  /** @type {MediaQueryList|null} */
  #desktop = null;

  /** @type {ResizeObserver|null} */
  #resize = null;

  /** @type {MutationObserver|null} */
  #slides = null;

  /** Controls that live outside this element and point back at it. */
  #external = { previous: null, next: null, current: null, total: null, bar: null };

  /** Set once the customer interacts; autoplay never restarts after it. */
  #interacted = false;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    this.#desktop = window.matchMedia(DESKTOP_QUERY);

    // `change` rather than a resize listener: this fires once when the
    // breakpoint is crossed, not sixty times while a window is dragged.
    this.on(this.#desktop, 'change', () => this.#sync());

    this.#external = findExternalControls(this.id);

    const pause = this.refs.pause;
    if (pause) this.on(pause, 'click', () => this.#toggleAutoplay());

    this.#watchForSlides();
    this.#sync();
  }

  teardown() {
    this.#slides?.disconnect();
    this.#slides = null;
    this.#destroy();
  }

  /* -------------------------------------------------------------- editor */

  sectionLoaded() {
    this.#destroy();
    this.refreshRefs();
    this.#external = findExternalControls(this.id);
    this.#watchForSlides();
    this.#sync();
  }

  sectionUnloaded() {
    this.#destroy();
  }

  /* ----------------------------------------------------------- public API */

  /**
   * There is deliberately no `get swiper()` here.
   *
   * Swiper's `mount()` runs `el.swiper = swiper` on its container, and this
   * element *is* the container. A getter with no setter makes that assignment
   * throw — module code is strict, so the write is a `TypeError` rather than a
   * silent no-op, and it happens inside `new Swiper()` before the instance is
   * ever returned:
   *
   *   TypeError: Cannot set property swiper of #<SwiperCarousel>
   *   which has only a getter
   *
   * So `element.swiper` is Swiper's own property, set by Swiper and cleared by
   * `destroy()`. That is also the convention every Swiper integration uses, so
   * anything reaching in from a section or an app finds what it expects.
   *
   * The private `#swiper` field is this component's own handle on the same
   * instance. Do not add a public accessor with a name Swiper writes to.
   *
   * @returns {import('swiper').Swiper|null} The instance, or null before init.
   */
  get instance() {
    return this.#swiper;
  }

  next() {
    this.#swiper?.slideNext();
  }

  previous() {
    this.#swiper?.slidePrev();
  }

  /* ----------------------------------------------------------------- nav */

  /**
   * Nested controls win over external ones. A section that renders both has
   * made a mistake, and the nested pair is the one the customer can see next
   * to the track.
   *
   * @returns {import('@theme/carousel-controls').ControlRefs}
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

  /* --------------------------------------------------------------- state */

  /**
   * Whether this breakpoint should be a carousel at all.
   *
   * `data-layout` is the desktop behaviour and `data-layout-mobile` the phone
   * one; either may be `grid`.
   *
   * @returns {boolean}
   */
  get #shouldRun() {
    const desktop = this.#desktop?.matches ?? true;
    const layout = desktop
      ? this.dataset.layout || 'carousel'
      : this.dataset.layoutMobile || this.dataset.layout || 'carousel';

    return layout === 'carousel';
  }

  /**
   * The merchant's configuration, straight from the attribute.
   *
   * A malformed value is logged and ignored rather than thrown: broken JSON in
   * one section setting should not take down every other component on the page.
   *
   * @returns {Record<string, any>}
   */
  get #authored() {
    const raw = this.dataset.options;
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.error('[Boost10] <swiper-carousel> could not parse data-options.', error, raw);
      return {};
    }
  }

  /* --------------------------------------------------------------- config */

  /** @returns {Record<string, any>} */
  #config() {
    const authored = this.#authored;

    /** @type {Record<string, any>} */
    const config = {
      ...DEFAULTS,
      // The measured gap is a *default*, so `authored` spreading after it is
      // what lets a section opt out with an explicit `spaceBetween: 0` — the
      // product card's image slider is full-bleed and must not inherit the
      // product grid's column gap.
      spaceBetween: this.#gap(),
      ...authored,
      modules: MODULES,
    };

    // ---- loop ------------------------------------------------------------
    // Swiper needs at least twice `slidesPerView` slides to loop. Given fewer
    // it logs "Not enough slides for loop mode", turns looping off itself, and
    // — with `loopAdditionalSlides` unset — can leave a duplicated slide behind
    // in the DOM. `carousel-options` already refuses the setting when the
    // caller can count its slides, but two sections pass
    // `{% content_for 'blocks' %}` straight through and cannot, so the same
    // check is repeated here against the real children.
    if (config.loop && !this.#canLoop(config)) {
      config.loop = false;

      // Rewind reaches the same place the merchant asked for — back to the
      // first slide from the last — without needing the duplicates.
      config.rewind = true;
    }

    // ---- navigation -----------------------------------------------------
    const { previous, next } = this.#controls;

    if (previous && next) {
      config.navigation = {
        prevEl: previous,
        nextEl: next,
        disabledClass: 'carousel-button--disabled',
        lockClass: 'carousel-button--locked',
        ...(typeof authored.navigation === 'object' ? authored.navigation : {}),
      };
    } else {
      delete config.navigation;
    }

    // ---- pagination -----------------------------------------------------
    if (this.refs.pagination) {
      const authoredPagination = typeof authored.pagination === 'object' ? authored.pagination : {};

      config.pagination = {
        clickable: true,
        type: 'bullets',
        bulletClass: 'carousel-shell__dot',
        bulletActiveClass: 'carousel-shell__dot--active',
        lockClass: 'carousel-shell__pagination--locked',
        ...authoredPagination,
        el: this.refs.pagination,
      };

      // Fraction and progressbar render their own internals, so the custom
      // bullet classes would be applied to elements that do not exist.
      if (config.pagination.type !== 'bullets') {
        delete config.pagination.bulletClass;
        delete config.pagination.bulletActiveClass;
      }
    } else {
      delete config.pagination;
    }

    // ---- transition -----------------------------------------------------
    // Always `slide`. The theme used to expose a Transition setting with a fade
    // option, and fade cross-fades a stack of absolutely positioned slides — so
    // choosing it silently collapsed a three-across carousel to one, because
    // showing three stacked slides at once is not a thing fade can do. That is
    // a setting whose only honest label would have been "also change your
    // column count", so it is gone, and `EffectFade` is no longer bundled.
    //
    // Forced here rather than trusted from `data-options` so a stored `fade`
    // from before this change cannot reach Swiper without the module present.
    config.effect = 'slide';
    delete config.fadeEffect;

    // ---- reduced motion -------------------------------------------------
    // The carousel still works; it stops moving on its own and stops animating
    // between slides. Removing the control entirely would be worse.
    if (prefersReducedMotion()) {
      config.speed = 0;
      config.autoplay = false;
    }

    // ---- lifecycle ------------------------------------------------------
    config.on = {
      ...(authored.on || {}),
      init: (swiper) => this.#onChange(swiper),
      autoplayTimeLeft: (_swiper, _time, progress) => this.#reflectAutoplayProgress(progress),
      autoplayStart: () => this.#reflectAutoplay(),
      autoplayStop: () => this.#reflectAutoplay(),
      autoplayPause: () => this.#reflectAutoplay(),
      autoplayResume: () => this.#reflectAutoplay(),
      slideChange: (swiper) => this.#onChange(swiper),

      // `progress` fires on every translate, including mid-drag, so the bar
      // tracks a finger rather than jumping once the slide settles. Setting one
      // custom property is cheap enough to do at that rate.
      progress: (swiper) => this.#onProgress(swiper),

      touchStart: () => this.#onInteract(),
    };

    return config;
  }

  /**
   * Whether there are enough slides for Swiper's loop to be coherent at the
   * widest breakpoint this carousel will reach.
   *
   * The widest is what matters: four columns on desktop needs eight slides, and
   * checking against the mobile value would let a carousel loop on a phone and
   * silently stop looping when the same page is opened on a laptop.
   *
   * @param {Record<string, any>} config
   * @returns {boolean}
   */
  #canLoop(config) {
    const counts = [Number(config.slidesPerView) || 1];

    for (const breakpoint of Object.values(config.breakpoints ?? {})) {
      const perView = Number(/** @type {any} */ (breakpoint)?.slidesPerView);
      if (Number.isFinite(perView)) counts.push(perView);
    }

    // `ceil` matches Swiper's own handling of a fractional `slidesPerView`: a
    // peek of 2.3 is three slides' worth of viewport as far as looping is
    // concerned, and asking for the fraction would let a carousel through that
    // Swiper then warns about and un-loops anyway.
    const widest = Math.ceil(Math.max(...counts));
    const slides = this.refs.track?.children.length ?? 0;

    return slides >= widest * 2;
  }

  /**
   * Slide spacing, measured rather than restated. Swiper positions slides with
   * transforms, so it needs a number — a CSS `gap` on the wrapper is ignored by
   * its measurements and the slides would overlap.
   *
   * ## Why this reads `column-gap` and not a custom property
   *
   * It used to read `--grid-gap-x`, which is referenced in four places in
   * `base.css` and **defined in none of them**. An undefined custom property
   * makes every declaration that references it invalid at computed-value time,
   * so those `gap` rules were already resolving to `normal`, and this returned
   * `0` for every carousel in the theme.
   *
   * Reading the track's used `column-gap` asks the browser what the spacing
   * actually is, after all the cascade and all the fallbacks. It is right when
   * the token is defined, right when it is not, and right for a section that
   * sets its own gap in px, rem or anything else — and it is the same number
   * `carousel-vars` puts behind the pre-init slide width, so the slides do not
   * move when Swiper mounts.
   *
   * Called from `#config()`, which runs before `swiper-initialized` lands on the
   * element, so the pre-init `gap` rule is still applying at this moment. That
   * ordering is load-bearing.
   *
   * @returns {number} px
   */
  #gap() {
    const track = this.refs.track;
    if (!track) return 0;

    // `normal` is what an unset gap computes to, and it is not a length.
    const used = getComputedStyle(track).columnGap;
    const measured = Number.parseFloat(used);
    if (Number.isFinite(measured)) return measured;

    // Last resort for a section that sizes itself entirely from the token.
    const token = getComputedStyle(this).getPropertyValue('--grid-gap-x').trim();
    if (!token) return 0;

    // Values arrive in rem against a 62.5% root, so 1rem is 10px.
    if (token.endsWith('rem')) return Number.parseFloat(token) * 10;
    return Number.parseFloat(token) || 0;
  }

  /* ---------------------------------------------------------- init / kill */

  #sync() {
    if (this.#shouldRun) this.#init();
    else this.#destroy();
  }

  /**
   * Puts Swiper's wrapper class on the track, and takes it off again.
   *
   * ## Why Liquid does not write this class
   *
   * `swiper.css` is unlayered, so `.swiper-wrapper { display: flex }` beats the
   * `display: grid` that `@layer components` gives `.product-grid`,
   * `.multicolumn__grid` and `.testimonials__grid`. A section set to *Grid* on
   * desktop and *Carousel* on mobile is the same nodes at both widths, so with
   * the class in the markup its desktop grid rendered as a flex row — every
   * card the same height, no column count, no row gap.
   *
   * Fighting that from the theme's own stylesheet means either `!important` or
   * `revert-layer`, and both are a workaround for a class that simply should not
   * be there yet. So the class arrives with Swiper and leaves with it. At a grid
   * breakpoint the track keeps its own layout and there is nothing to override.
   *
   * Swiper finds its wrapper by this class in `mount()`, which runs inside
   * `new Swiper()` — after this call. The ordering is load-bearing.
   *
   * @param {boolean} on
   */
  #tagTrack(on) {
    this.refs.track?.classList.toggle('swiper-wrapper', on);
  }

  /**
   * Puts Swiper's own class on every direct child of the track.
   *
   * This used to be `slideClass` in `data-options`, pointed at the theme's
   * `carousel-shell__item`. Two things were wrong with that.
   *
   * `swiper.css` styles `.swiper-slide` by name — `position: relative` on the
   * base rule, and every effect rule on top of it, including
   * `.swiper-fade .swiper-slide { pointer-events: none; transition-property:
   * opacity }`. Under a renamed class none of it matches, so `fade` produced a
   * stack of fully clickable, unanimated slides.
   *
   * And `multicolumn` and `testimonials` pass `{% content_for 'blocks' %}`
   * straight into the track, so their slides are block roots with no class the
   * section can reach. Those two matched zero slides and never moved.
   *
   * Doing it here rather than in Liquid is what covers both cases with one
   * mechanism. The class is removed again on destroy, so at a grid breakpoint
   * swiper.css's `width: 100%; height: 100%` is not sitting on grid items.
   *
   * @param {boolean} on
   */
  #tagSlides(on) {
    const track = this.refs.track;
    if (!track) return;

    for (const child of track.children) {
      child.classList.toggle('swiper-slide', on);
    }
  }

  #init() {
    if (this.#swiper && !this.#swiper.destroyed) return;

    const slides = this.refs.track?.children.length ?? 0;
    if (slides < 2) return;

    this.#tagTrack(true);
    this.#tagSlides(true);

    try {
      this.#swiper = new Swiper(this, this.#config());
    } catch (error) {
      console.error('[Boost10] <swiper-carousel> failed to initialise.', error);
      this.#swiper = null;
      this.#tagSlides(false);
      this.#tagTrack(false);
      return;
    }

    this.#reflectAutoplay();
    toggleControls(this.#controls, true);
    this.#watchForReveal();
  }

  /**
   * Recovers a carousel that was built inside a hidden container.
   *
   * The announcement bar is the case that forced this. When "show close" is on,
   * `announcement-bar[data-dismissible]:not([data-ready])` is `display: none`
   * until `announcement-bar.js` has checked storage. `swiper-carousel` connects
   * before that, so Swiper measures a zero-width box, writes `width: 0px` onto
   * every slide, and the bar reveals a carousel that will not move.
   *
   * The same thing happens to any carousel inside a tab panel, a drawer or a
   * closed disclosure.
   *
   * A ResizeObserver fires when the box goes from zero to a real width, which
   * is exactly the moment the measurements need redoing.
   */
  #watchForReveal() {
    this.#resize?.disconnect();

    let last = this.offsetWidth;

    this.#resize = new ResizeObserver(() => {
      const width = this.offsetWidth;
      if (width === last) return;

      const revealed = last === 0 && width > 0;
      last = width;

      if (revealed) this.#swiper?.update();
    });

    this.#resize.observe(this);
  }

  /**
   * Builds — or rebuilds — the carousel when the track's children change.
   *
   * Three sections render an empty track and fill it later:
   * `product-recommendations` and `recently-viewed` fetch their cards after the
   * page loads, and the collection grid morphs new results in after a filter.
   * `#init()` refuses to run on fewer than two slides, so on connect all three
   * correctly did nothing — and then nothing ever told them to try again. Their
   * arrows stayed dead for the life of the page.
   *
   * Already running, the same signal means the slide set changed underneath
   * Swiper: the new children need `swiper-slide` and Swiper needs to re-measure,
   * or the carousel scrolls a stale list.
   *
   * Deliberately not Swiper's own `observer` option, which walks the whole
   * subtree on every mutation — every variant swatch preview and quick-add
   * re-render inside a card would trigger a full update. This watches one
   * element's direct children only.
   */
  #watchForSlides() {
    const track = this.refs.track;
    if (!track) return;

    this.#slides?.disconnect();

    this.#slides = new MutationObserver(() => {
      if (!this.#shouldRun) return;

      if (this.#swiper && !this.#swiper.destroyed) {
        this.#tagSlides(true);
        this.#swiper.update();
        this.#reflectAutoplay();
      } else {
        this.#init();
      }
    });

    this.#slides.observe(track, { childList: true });
  }

  #destroy() {
    if (!this.#swiper) return;

    // `deleteInstance, cleanStyles` — the second argument returns the wrapper
    // and slides to their authored styles so the CSS grid layout can take over
    // at the other breakpoint.
    if (!this.#swiper.destroyed) this.#swiper.destroy(true, true);
    this.#swiper = null;
    this.#tagSlides(false);
    this.#tagTrack(false);

    if (this.refs.pause) this.refs.pause.hidden = true;
    toggleControls(this.#controls, false);

    this.#resize?.disconnect();
    this.#resize = null;
  }

  /* ---------------------------------------------------------- autoplay */

  #toggleAutoplay() {
    const autoplay = this.#swiper?.autoplay;
    if (!autoplay) return;

    if (autoplay.running) {
      autoplay.stop();
      this.refs.pause?.setAttribute('aria-pressed', 'true');
    } else {
      autoplay.start();
      this.refs.pause?.setAttribute('aria-pressed', 'false');
    }
  }

  /**
   * Autoplay stops permanently at the first touch or drag. A slideshow that
   * resumes after the customer has taken control is the most common complaint
   * about carousels, and pausing on hover does not help a touch device.
   */
  #onInteract() {
    if (this.#interacted) return;
    this.#interacted = true;

    this.#swiper?.autoplay?.stop();
    if (this.refs.pause) this.refs.pause.hidden = true;
  }

  #reflectAutoplay() {
    if (!this.refs.pause) return;

    const running = Boolean(this.#swiper?.autoplay?.running);
    this.refs.pause.hidden = !running;
    this.refs.pause.setAttribute('aria-pressed', running ? 'false' : 'true');

    // Paused, the ring stays full rather than freezing mid-sweep: a partial arc
    // that never moves reads as a broken control rather than a stopped one.
    if (!running) this.refs.pause.style.setProperty('--carousel-autoplay-progress', '1');
  }

  /**
   * Drives the ring around the pause button.
   *
   * Swiper's `autoplayTimeLeft` fires on every frame of the delay with the
   * remaining milliseconds, so the ring is the real countdown to the next slide
   * rather than a CSS animation guessing at the same duration — which would
   * drift out of step the first time a customer hovered and paused.
   *
   * `progress` arrives as 1 → 0 (time *left*), so it is inverted: the ring
   * fills as the slide runs out.
   *
   * @param {number} progress Swiper's remaining fraction, 1 down to 0.
   */
  #reflectAutoplayProgress(progress) {
    const pause = this.refs.pause;
    if (!pause || pause.hidden) return;

    const filled = 1 - Math.min(Math.max(progress, 0), 1);
    pause.style.setProperty('--carousel-autoplay-progress', String(filled));
  }

  /* -------------------------------------------------------------- a11y */

  /**
   * Announces the position and publishes a change event.
   *
   * The bundled Swiper has no A11y module, so nothing else does this. The
   * region is polite and carries only the position — the slide content is in
   * the reading order already and repeating it would be noise.
   *
   * @param {import('swiper').Swiper} swiper
   */
  #onChange(swiper) {
    const index = swiper.realIndex + 1;
    const count = swiper.slides.length;

    renderControls(this.#controls, index, count, this.#progressOf(swiper));

    if (this.refs.status) {
      this.refs.status.textContent = themeString('carouselPosition', `${index} / ${count}`, {
        index,
        count,
      });
    }

    this.dispatch(EVENTS.CAROUSEL_CHANGE, { index: swiper.realIndex, count });
  }

  /**
   * Bar-only update. Runs on every translate, so it deliberately does not touch
   * the numbers or the live region — announcing a position sixty times a second
   * during a drag is not an improvement.
   *
   * @param {import('swiper').Swiper} swiper
   */
  #onProgress(swiper) {
    const bar = this.#controls.bar;
    if (!bar) return;

    const value = Math.min(Math.max(this.#progressOf(swiper), 0), 1);
    bar.style.setProperty('--carousel-progress', String(value));
  }

  /**
   * Swiper reports `progress: 0` forever when the slides already fit and
   * nothing can scroll. An empty bar in that state reads as broken, so it is
   * filled instead — there is nowhere left to go, which is what full means.
   *
   * @param {import('swiper').Swiper} swiper
   * @returns {number}
   */
  #progressOf(swiper) {
    if (swiper.isLocked) return 1;
    return swiper.progress;
  }
}

defineComponent('swiper-carousel', SwiperCarousel);
