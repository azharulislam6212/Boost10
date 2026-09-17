/**
 * carousel.js — Boost10
 *
 * `<carousel-slider>` — the theme's own carousel engine. No Swiper, no third
 * party anything.
 *
 * ## What it is
 *
 * A transform-driven track. The slides are laid out by CSS as a flex row (or
 * column), and this component does exactly four things to them:
 *
 *   1. Measures where each slide sits, once, and again when the box resizes.
 *   2. Translates the track to one of those positions.
 *   3. Keeps the controls — arrows, dots, counter, progress, thumbnails — in
 *      step with the current position.
 *   4. Reveals the slides that are actually in view and resets the ones that
 *      have left, so an entrance animation replays where it can be seen.
 *
 * Everything else is CSS. **This file never writes a width, a height or a gap.**
 * The layout lives in `carousel-vars.liquid` and `carousel.css` and nowhere
 * else, so the CSS that sizes a slide before the module loads is the same CSS
 * that sizes it afterwards: there is no mount jump to hide, and no slide
 * spacing number to keep in sync with a `gap`.
 *
 * ## Markup
 *
 *   <carousel-slider
 *     id="carousel-x"
 *     class="carousel-shell"
 *     data-layout="carousel"
 *     data-layout-mobile="carousel"
 *     data-direction="horizontal"
 *     data-options='{"speed":500,"loop":true}'
 *     style="--carousel-slides-desktop: 3; --carousel-gap: 2.4rem;"
 *   >
 *     <div class="carousel-shell__track" data-ref="track">
 *       <div>…</div>
 *     </div>
 *
 *     <div class="carousel-nav" data-carousel-nav>
 *       <button data-ref="previous">…</button>
 *       <button data-ref="next">…</button>
 *     </div>
 *
 *     <div class="carousel-shell__dots" data-ref="pagination"></div>
 *     <div class="product-media__thumbnails" data-ref="thumbnails">
 *       <button data-thumbnail>…</button>
 *     </div>
 *
 *     <button data-ref="pause">…</button>
 *     <p class="visually-hidden" data-ref="status" role="status"></p>
 *   </carousel-slider>
 *
 * That is the shape `snippets/carousel-shell.liquid` renders, refs and all.
 * Controls rendered outside the element link back with `data-carousel-for="<id>"`,
 * through the same `@theme/carousel-controls` helpers `<media-gallery>` uses.
 *
 * ## The options contract
 *
 * One JSON attribute, merged over the defaults below:
 *
 *   <carousel-slider data-options='{"loop":true,"autoplay":{"delay":5000}}'>
 *
 * The keys are deliberately the ones `snippets/carousel-options.liquid`
 * already emits — `slidesPerView`, `breakpoints`, `speed`, `loop`, `rewind`,
 * `autoplay`, `pagination.type`, `direction` — so that snippet does not have to
 * change when the sections are migrated. Two of them are read differently:
 *
 *   `slidesPerView` seeds `--carousel-slides-*` **only when Liquid did not**,
 *   because `carousel-vars` writes those properties and CSS is where the
 *   breakpoint arithmetic belongs. A carousel rendered by the shell never takes
 *   this path; hand-written markup does.
 *
 *   `spaceBetween` is ignored. The gap is `--carousel-gap`, in CSS, full stop.
 *
 * ## Direction
 *
 * Horizontal unless `data-direction="vertical"` says otherwise, and the two
 * share one code path: the axis is a pair of property names picked once in
 * `#axis`. Nothing switches on screen width — a carousel is vertical because a
 * section asked for it, never because a phone is narrow.
 *
 * @module @theme/carousel
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { prefersReducedMotion, themeString, rafThrottle, isRTL } from '@theme/utilities';
import { renderControls, findExternalControls, toggleControls } from '@theme/carousel-controls';

/** Matches the 750px breakpoint used throughout `base.css`. */
const TABLET_QUERY = '(min-width: 750px)';

/** Matches the 990px breakpoint used throughout `base.css`. */
const DESKTOP_QUERY = '(min-width: 990px)';

/**
 * The behaviour of a carousel given no configuration at all.
 *
 * Anything a section wants to change belongs in `data-options`.
 */
const DEFAULTS = {
  /** Fallback for `--carousel-slides-*` when Liquid did not write them. */
  slidesPerView: 1,

  /** Slides advanced per press. 0 means "derive it": 1 across, a page down. */
  slidesPerGroup: 0,

  /** Transition duration in milliseconds. */
  speed: 500,

  /** True loop, with clones at both ends. Refused when there are too few slides. */
  loop: false,

  /** Jump back to the first slide from the last, without clones. */
  rewind: false,

  /** Centre the active slide in the track rather than aligning it to the start. */
  centeredSlides: false,

  /** `horizontal` | `vertical`. `data-direction` wins over this. */
  direction: 'horizontal',

  /** `false`, or `{ delay, disableOnInteraction, pauseOnMouseEnter }`. */
  autoplay: false,

  /** `null`, or `{ type: 'bullets' | 'fraction' | 'progressbar' }`. */
  pagination: null,

  /** Arrow keys, Home and End on the focused track. */
  keyboard: true,

  /** Pointer drag and touch swipe. */
  drag: true,

  /**
   * Animate a slide in when it enters the viewport of the track, and reset it
   * again when it leaves. See the reveal section for what the component writes
   * and what the stylesheet does with it.
   */
  reveal: true,

  /** `{ "750": { slidesPerGroup }, "990": { … } }`. */
  breakpoints: null
};

/** Pixels of pointer travel before a press becomes a drag. Swiper's `threshold`. */
const DRAG_THRESHOLD = 5;

/** Fraction of a slide that counts as a deliberate swipe. Swiper's `longSwipesRatio`. */
const LONG_SWIPE_RATIO = 0.25;

/** Tolerance in px for "this position is the end". Sub-pixel layout, mostly. */
const EPSILON = 1;

/**
 * The property names for one axis.
 *
 * Writing the engine against these rather than against `left` and `top` is what
 * keeps vertical from being a second implementation — see the class docblock.
 *
 * @type {Record<'horizontal'|'vertical', {offset: 'offsetLeft'|'offsetTop', size: 'offsetWidth'|'offsetHeight', client: 'clientWidth'|'clientHeight'}>}
 */
const AXIS = {
  horizontal: { offset: 'offsetLeft', size: 'offsetWidth', client: 'clientWidth' },
  vertical: { offset: 'offsetTop', size: 'offsetHeight', client: 'clientHeight' }
};

/**
 * Clamp without importing one more symbol for three characters.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function bound(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export class CarouselSlider extends BaseComponent {
  static requiredRefs = ['track'];

  /**
   * A merchant changing a setting in the theme editor re-renders the section in
   * most cases, but a live setting — autoplay delay, transition speed — can
   * arrive as an attribute change on an element that never left the DOM.
   */
  static observedAttributes = ['data-options'];

  /* -------------------------------------------------------------- state -- */

  /** Slides the merchant authored, clones excluded. @type {HTMLElement[]} */
  #real = [];

  /** Everything in the track, clones included, in DOM order. @type {HTMLElement[]} */
  #slides = [];

  /**
   * Distance from the first slide to each slide, always positive.
   *
   * Measured as `Math.abs(slide[i].offset - slide[0].offset)` so the array is
   * monotonic in RTL as well, where slides run right to left and the raw
   * offsets descend. The direction is then re-applied once, in `#translate()`.
   *
   * @type {number[]}
   */
  #positions = [];

  /** Each slide's size on the axis of travel, cached with the positions. */
  #sizes = [];

  /** The track's own size on the axis of travel, cached with the positions. */
  #viewport = 0;

  /** The furthest the track may travel before the last slide is flush. */
  #limit = 0;

  /** Index into `#slides` — so with a loop it counts clones too. */
  #index = 0;

  /** How many clones sit at each end. 0 when not looping. */
  #clones = 0;

  /** Whether a loop is actually running, after the too-few-slides guard. */
  #looping = false;

  /** Whether the merchant's loop was downgraded to a rewind. */
  #rewinding = false;

  /** Resolved slides-per-view, read from CSS. */
  #perView = 1;

  /** The current translate, in px, unsigned. */
  #position = 0;

  /** True while a pointer is down and moving the track. */
  #dragging = false;

  /** Set on the first interaction; autoplay never restarts after it. */
  #interacted = false;

  /** True once a first `#update()` has run, so the initial state is not animated. */
  #ready = false;

  /**
   * True while the slides are carrying `data-motion-armed` — that is, while
   * this component, and not the stylesheet on its own, is holding the ones out
   * of view at their resting state. See the reveal section.
   */
  #armed = false;

  /**
   * The track position the last drag-time reveal pass was measured from, so a
   * finger on the track costs one comparison per pointer event rather than a
   * walk of the slide set. See `#revealAhead()`.
   */
  #reach = 0;

  /** @type {MediaQueryList|null} */
  #tablet = null;

  /** @type {MediaQueryList|null} */
  #desktop = null;

  /** @type {ResizeObserver|null} */
  #resize = null;

  /** @type {MutationObserver|null} */
  #mutations = null;

  /** True while this component is the one rearranging the track. */
  #rearranging = false;

  /** @type {number|undefined} */
  #autoplayTimer;

  /** @type {number|undefined} */
  #frame;

  /** @type {number|undefined} */
  #settleTimer;

  /** Controls rendered outside this element. */
  #external = { previous: null, next: null, current: null, total: null, bar: null };

  /** @type {HTMLElement[]} */
  #dots = [];

  /** Parsed `data-options`, merged over the defaults. @type {Record<string, any>|null} */
  #options = null;

  /** Listeners on the controls are bound once per connection, never per breakpoint. */
  #controlsBound = false;

  /** The same, for the track. */
  #trackBound = false;

  /** True for one task after a drag, so the release does not also follow a link. */
  #suppressClick = false;

  /** Pointer bookkeeping. One gesture at a time, so plain fields are enough. */
  #pointer = {
    id: /** @type {number|null} */ (null),
    x: 0,
    y: 0,
    start: 0,
    last: 0,
    time: 0,
    velocity: 0,
    decided: false
  };

  /* ---------------------------------------------------------- lifecycle -- */

  setup() {
    // `setup()` runs again whenever the element is moved in the DOM, and
    // morphing does exactly that, so nothing cached may survive it.
    this.#options = null;

    // Including the two "already bound" flags. `BaseComponent` aborts one
    // controller per connection, so every listener `on()` added is gone by the
    // time this runs again — leaving the flags set would mean a carousel that
    // was morphed into place came back with dead arrows, no drag and no
    // keyboard. They guard against binding twice *within* one connection, which
    // is what `sectionLoaded()` needs; they must not outlive it.
    this.#controlsBound = false;
    this.#trackBound = false;

    this.#tablet = window.matchMedia(TABLET_QUERY);
    this.#desktop = window.matchMedia(DESKTOP_QUERY);

    this.#external = findExternalControls(this.id);

    // `change` rather than a resize listener: this fires once when a breakpoint
    // is crossed, not sixty times while a window is dragged.
    this.on(this.#tablet, 'change', () => this.#sync());
    this.on(this.#desktop, 'change', () => this.#sync());

    this.#seedSlideVars();
    this.#bindControls();
    this.#watchSlides();
    this.#sync();
  }

  teardown() {
    this.#mutations?.disconnect();
    this.#mutations = null;
    this.#stop();
  }

  /* ------------------------------------------------------------ editor -- */

  sectionLoaded() {
    this.#stop();
    this.refreshRefs();
    this.#external = findExternalControls(this.id);
    this.#bindControls();
    this.#watchSlides();
    this.#sync();
  }

  sectionUnloaded() {
    this.#stop();
  }

  /**
   * Bring a block the merchant just selected into view.
   *
   * @param {CustomEvent} event
   */
  blockSelected(event) {
    const target = /** @type {Node} */ (event.target);
    const index = this.#real.findIndex((slide) => slide === target || slide.contains(target));
    if (index < 0) return;

    this.#pauseAutoplay();
    this.go(index);
  }

  blockDeselected() {
    this.#playAutoplay();
  }

  /* -------------------------------------------------------- public API -- */

  /**
   * The merchant's configuration, straight from the attribute.
   *
   * Parsed once and kept. This used to parse on every read, which reads as
   * harmless until you notice where it is read from: `#positionFor()` asks for
   * `centeredSlides`, and `#nearest()` calls `#positionFor()` once per slide —
   * inside a pointermove handler. A fourteen-slide carousel was running
   * fourteen `JSON.parse` calls per frame of a drag.
   *
   * A malformed value is logged and ignored rather than thrown: broken JSON in
   * one section setting must not take down every other component on the page.
   *
   * @returns {Record<string, any>}
   */
  get options() {
    if (this.#options) return this.#options;

    const raw = this.dataset.options;
    let authored = {};

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') authored = parsed;
      } catch (error) {
        console.error('[Boost10] <carousel-slider> could not parse data-options.', error, raw);
      }
    }

    this.#options = { ...DEFAULTS, ...authored };
    return this.#options;
  }

  /**
   * The element the slides live in.
   *
   * A ref name can be shared — `data-ref="content track"` on the
   * recommendations list — and repeated names collect into an array, so the
   * lookup has to survive both shapes.
   *
   * @returns {HTMLElement}
   */
  get track() {
    const ref = this.refs.track;
    return /** @type {HTMLElement} */ (Array.isArray(ref) ? ref[0] : ref);
  }

  /**
   * The authored slides, clones excluded.
   *
   * @returns {HTMLElement[]}
   */
  get slides() {
    return this.#real;
  }

  /**
   * Position of the current slide among the authored ones, 0-based. With a loop
   * running this is the slide a customer sees, not the clone showing it.
   *
   * @returns {number}
   */
  get index() {
    if (!this.#looping) return this.#index;

    const total = this.#real.length;
    return (((this.#index - this.#clones) % total) + total) % total;
  }

  /**
   * Whether this element is currently behaving as a carousel at all.
   *
   * @returns {boolean}
   */
  get running() {
    return this.hasAttribute('data-running');
  }

  /**
   * `horizontal` | `vertical`. The attribute wins over `data-options` because
   * CSS can only read the attribute, and a carousel whose stylesheet and script
   * disagreed about its own axis would be very hard to see.
   *
   * @returns {'horizontal'|'vertical'}
   */
  get direction() {
    const authored = this.dataset.direction || this.options.direction;
    return authored === 'vertical' ? 'vertical' : 'horizontal';
  }

  next() {
    this.#step(1);
  }

  previous() {
    this.#step(-1);
  }

  /**
   * Move to an authored slide.
   *
   * @param {number} index 0-based, among the authored slides.
   * @param {Object} [options]
   * @param {boolean} [options.instant] Skip the transition.
   */
  go(index, { instant = false } = {}) {
    this.#goTo(this.#looping ? index + this.#clones : index, { instant });
  }

  /** Re-read the slides and re-render. Call after replacing them by hand. */
  refresh() {
    if (!this.running) {
      this.#sync();
      return;
    }

    this.#rebuild();
  }

  /**
   * @param {string} name
   */
  attributeChanged(name) {
    if (name !== 'data-options') return;

    this.#options = null;
    if (this.running) this.#rebuild();
  }

  /* ----------------------------------------------------- run / stand by -- */

  /**
   * Whether this breakpoint should be a carousel.
   *
   * `data-layout` is the desktop behaviour and `data-layout-mobile` the phone
   * one; either may be `grid`. Both default to `carousel`, so an element with
   * neither attribute — the plain `<carousel-slider>` of the brief — runs.
   *
   * @returns {boolean}
   */
  get #shouldRun() {
    const wide = this.#tablet?.matches ?? true;
    const layout = wide
      ? this.dataset.layout || 'carousel'
      : this.dataset.layoutMobile || this.dataset.layout || 'carousel';

    return layout === 'carousel';
  }

  #sync() {
    if (this.#shouldRun) this.#start();
    else this.#stop();
  }

  #start() {
    const track = this.track;
    if (!track) return;

    // Already running, and a breakpoint moved underneath us. Re-fitting keeps
    // the customer where they were; starting again would send them back to the
    // first slide, and dragging a window across 990px is not an instruction to
    // rewind the carousel.
    if (this.running) {
      this.#refit();
      return;
    }

    // `data-running` is what the stylesheet keys the whole carousel layout off,
    // and it has to be on the element *before* anything is measured: the flex
    // track and the slide widths come with it.
    this.setAttribute('data-direction', this.direction);
    this.setAttribute('data-running', '');

    this.#build();
    this.#measure();

    // A tab stop only while there is something to move. At a grid breakpoint
    // the track is a plain list and `#stop()` takes it back out of the order.
    if (this.options.keyboard !== false && !track.hasAttribute('tabindex')) {
      track.setAttribute('tabindex', '0');
      track.setAttribute('data-carousel-tabindex', '');
    }

    this.#bindTrack();
    this.#watchResize();
    this.#renderPagination();
    this.#goTo(this.#looping ? this.#clones : 0, { instant: true });

    // Locked means the slides already fit, so there is nothing for a control to
    // do. Detached controls are not descendants of this element, so no selector
    // can reach them — the attribute `toggleControls` writes is what hides them.
    const active = !this.hasAttribute('data-locked');
    toggleControls(this.#controls, active);

    // The same problem, one element further out. `toggleControls` walks up to a
    // `[data-carousel-nav]` wrapper, and a detached pagination element has no
    // such wrapper — it is the control. `carousel.css` can only reveal a nested one,
    // so the attribute is what a detached row of dots is shown by.
    this.#pagination?.toggleAttribute('data-carousel-active', active);

    this.#playAutoplay();
  }

  #stop() {
    this.#pauseAutoplay();
    this.#resize?.disconnect();
    this.#resize = null;

    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    clearTimeout(this.#settleTimer);

    if (!this.running) return;

    this.#removeClones();

    const track = this.track;
    if (track) {
      track.style.transform = '';
      track.style.transitionDuration = '';
      track.classList.remove('is-dragging');

      if (track.hasAttribute('data-carousel-tabindex')) {
        track.removeAttribute('tabindex');
        track.removeAttribute('data-carousel-tabindex');
      }
    }

    // Disarm before anything else touches the slides. A grid breakpoint, a
    // destroyed carousel and a printed page all have to show every slide, and
    // the resting state is only ever held while this component is running.
    this.#disarm();

    for (const slide of this.#real) {
      slide.removeAttribute('data-active');
    }

    this.#dots = [];
    const pagination = this.#pagination;
    if (pagination) {
      pagination.replaceChildren();
      pagination.removeAttribute('data-carousel-active');
    }

    this.removeAttribute('data-running');
    this.removeAttribute('data-locked');
    this.#ready = false;

    toggleControls(this.#controls, false);
    if (this.refs.pause) /** @type {HTMLElement} */ (this.refs.pause).hidden = true;
  }

  /* --------------------------------------------------------- structure -- */

  /**
   * Reads the slide set, tags it for assistive technology, and builds the loop
   * clones if the options ask for one and there are enough slides to make it
   * coherent.
   */
  #build() {
    const track = this.track;

    this.#removeClones();

    this.#real = /** @type {HTMLElement[]} */ (Array.from(track.children));
    this.#slides = this.#real;

    const total = this.#real.length;

    this.#real.forEach((slide, position) => {
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-roledescription', 'slide');
      if (!slide.hasAttribute('aria-label')) {
        slide.setAttribute('aria-label', `${position + 1} / ${total}`);
      }
    });

    // One slide, or fewer slides than fit, is not a carousel. Swiper called
    // this `watchOverflow` and wrote `--locked` on the arrows; the attribute
    // does the same job for every control at once.
    this.#perView = this.#readPerView();
    const locked = total <= Math.floor(this.#perView) || total < 2;
    this.toggleAttribute('data-locked', locked);

    if (locked) {
      this.#looping = false;
      this.#rewinding = false;
    } else {
      this.#buildLoop();
    }

    // Last, because arming has to see the final slide set: the clones are part
    // of it, and a locked carousel is not armed at all.
    this.#arm();
  }

  /**
   * Inert clones at both ends, so the track can keep moving in one direction
   * and the seam jump happens where nobody is looking.
   *
   * The guard is the same one `carousel-options.liquid` applies in Liquid, and
   * it is repeated here because CSS decides the real slides-per-view: below
   * twice the widest slides-per-view there are not enough slides to fill the
   * side of the seam, so the loop is refused and the merchant gets the rewind
   * they actually asked for — back to the first slide from the last.
   */
  #buildLoop() {
    const options = this.options;
    const total = this.#real.length;
    const needed = Math.ceil(this.#perView) * 2;

    this.#looping = Boolean(options.loop) && total >= needed;
    this.#rewinding = Boolean(options.rewind) || (Boolean(options.loop) && !this.#looping);

    if (!this.#looping) {
      this.#clones = 0;
      return;
    }

    // One more than fills the viewport, so a group step never runs out of
    // clones before the seam is reached.
    this.#clones = Math.min(total, Math.ceil(this.#perView) + 1);

    const track = this.track;
    const head = this.#real.slice(0, this.#clones).map((slide) => this.#clone(slide));
    const tail = this.#real.slice(-this.#clones).map((slide) => this.#clone(slide));

    this.#rearrange(() => {
      track.append(...head);
      track.prepend(...tail);
    });

    this.#slides = /** @type {HTMLElement[]} */ (Array.from(track.children));
  }

  /**
   * A copy of a slide that is invisible to assistive technology, unreachable by
   * keyboard, and carrying none of the original's reveal state.
   *
   * The reveal state is dropped rather than copied because `#arm()` runs
   * immediately after the clones are in the track and writes it back from the
   * real index — copying it would mean a clone made from a slide that happened
   * to be on screen arrived pre-revealed and never animated.
   *
   * The inner `<motion-effect>` is a separate problem and the easy one to
   * miss. A cloned one is a real, upgraded custom element: dropped into the DOM
   * it arms itself, hides its content and waits for an intersection that — for
   * a clone sitting outside the seam — may never come. Setting
   * `data-effect="none"` makes its `setup()` mark itself revealed and return,
   * which is the existing API's own way of saying "this one does not animate".
   * The inline resting styles are cleared too, in case the original was
   * mid-animation when it was copied.
   *
   * @param {HTMLElement} slide
   * @returns {HTMLElement}
   */
  #clone(slide) {
    const copy = /** @type {HTMLElement} */ (slide.cloneNode(true));

    copy.setAttribute('data-carousel-clone', '');
    copy.setAttribute('aria-hidden', 'true');
    copy.setAttribute('inert', '');
    copy.removeAttribute('role');
    copy.removeAttribute('id');
    copy.removeAttribute('data-active');
    copy.removeAttribute('data-motion-armed');
    copy.removeAttribute('data-motion-revealed');

    for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');

    // A clone must never start playing on its own; the original owns playback.
    for (const media of copy.querySelectorAll('[autoplay]')) media.removeAttribute('autoplay');

    for (const effect of copy.querySelectorAll('motion-effect')) {
      effect.setAttribute('data-effect', 'none');
      effect.removeAttribute('data-motion-pending');
      effect.setAttribute('data-motion-revealed', '');
      /** @type {HTMLElement} */ (effect).style.removeProperty('opacity');
      /** @type {HTMLElement} */ (effect).style.removeProperty('transform');
      /** @type {HTMLElement} */ (effect).style.removeProperty('clip-path');
    }

    return copy;
  }

  #removeClones() {
    const track = this.track;
    if (!track) return;

    const clones = track.querySelectorAll(':scope > [data-carousel-clone]');
    if (clones.length) this.#rearrange(() => clones.forEach((clone) => clone.remove()));

    this.#clones = 0;
    this.#looping = false;
    this.#slides = this.#real;
  }

  /**
   * Runs work that rearranges the track without `#watchSlides` answering it.
   *
   * The flag is cleared in a microtask rather than synchronously, because a
   * MutationObserver callback is itself delivered as a microtask queued at
   * mutation time — so it runs before this one and still sees the flag set.
   *
   * @param {() => void} work
   */
  #rearrange(work) {
    this.#rearranging = true;

    try {
      work();
    } finally {
      queueMicrotask(() => {
        this.#rearranging = false;
      });
    }
  }

  /* ----------------------------------------------------- measurement -- */

  /**
   * Slides per view, asked of CSS rather than restated here.
   *
   * `--carousel-slides` is stepped per breakpoint by `carousel.css` from
   * the three properties `carousel-vars.liquid` writes, and it is the same
   * number the slide's own `flex-basis` is built from. Reading it back is what
   * makes it impossible for the layout and the arithmetic to disagree.
   *
   * @returns {number}
   */
  #readPerView() {
    const declared = Number.parseFloat(getComputedStyle(this).getPropertyValue('--carousel-slides'));
    if (Number.isFinite(declared) && declared > 0) return declared;

    const fallback = Number(this.options.slidesPerView);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
  }

  /**
   * Caches every slide's distance from the first, and the furthest the track may
   * travel. The only layout read in the component, and it happens on init, on
   * resize and on nothing else.
   */
  #measure() {
    const track = this.track;
    const axis = AXIS[this.direction];
    const slides = this.#slides;

    this.#perView = this.#readPerView();

    if (!slides.length) {
      this.#positions = [];
      this.#sizes = [];
      this.#viewport = 0;
      this.#limit = 0;
      return;
    }

    const origin = slides[0][axis.offset];

    // One pass, one layout flush, and every number the rest of the component
    // needs comes out of it. Reading and writing alternately here is the
    // classic way to turn a resize into a hundred forced reflows, and asking
    // for a slide's width again from a pointer handler is the same mistake in
    // slow motion.
    this.#positions = slides.map((slide) => Math.abs(slide[axis.offset] - origin));
    this.#sizes = slides.map((slide) => slide[axis.size]);
    this.#viewport = track[axis.client];

    const content = this.#positions[this.#positions.length - 1] + this.#sizes[this.#sizes.length - 1];

    this.#limit = Math.max(0, content - this.#viewport);
  }

  /**
   * Where the track has to sit for a given slide to be in place.
   *
   * @param {number} index
   * @returns {number}
   */
  #positionFor(index) {
    const slides = this.#slides;
    const bounded = bound(index, 0, slides.length - 1);
    let position = this.#positions[bounded] ?? 0;

    if (this.options.centeredSlides) {
      position -= (this.#viewport - (this.#sizes[bounded] ?? 0)) / 2;
    }

    // A loop is free to run into the clones; without one there is nothing past
    // the last slide to show.
    if (this.#looping) return position;

    return bound(position, 0, this.#limit);
  }

  /**
   * The last index that is a distinct stopping place.
   *
   * With three slides showing and seven slides, the track runs out of travel at
   * slide five — that is the last position where three slides still fit — so
   * indices five and six would both resolve to the same translate. Swiper calls
   * this the snap grid; the count of dots and the disabled state of the next
   * arrow are both built from it.
   *
   * @returns {number}
   */
  get #lastIndex() {
    if (this.#looping) return this.#slides.length - 1;
    if (this.options.centeredSlides) return this.#slides.length - 1;

    for (let index = 0; index < this.#positions.length; index += 1) {
      if (this.#positions[index] >= this.#limit - EPSILON) return index;
    }

    return Math.max(0, this.#positions.length - 1);
  }

  /** How many stopping places there are, which is how many dots there are. */
  get #pageCount() {
    return this.#looping ? this.#real.length : this.#lastIndex + 1;
  }

  /** Which stopping place is current. */
  get #pageIndex() {
    return this.#looping ? this.index : bound(this.#index, 0, this.#lastIndex);
  }

  /**
   * Slides advanced per press.
   *
   * Horizontally a customer can see the row move under a half-slide of peek, so
   * one slide is the right step. Vertically there is no peek and a one-slide
   * step reads as a list that scrolled by itself, so a vertical carousel
   * advances a whole screen — the rule `carousel-options.liquid` already
   * encodes as `slidesPerGroup`, honoured here when it sends one.
   *
   * @returns {number}
   */
  get #group() {
    const authored = Number(this.#atBreakpoint('slidesPerGroup'));
    if (Number.isFinite(authored) && authored > 0) return Math.max(1, Math.round(authored));

    return this.direction === 'vertical' ? Math.max(1, Math.ceil(this.#perView)) : 1;
  }

  /**
   * An option at the current breakpoint, falling back through tablet to the
   * base value — the same cascade `data-options` breakpoints already describe.
   *
   * @param {string} key
   * @returns {any}
   */
  #atBreakpoint(key) {
    const options = this.options;
    const breakpoints = options.breakpoints || {};
    let value = options[key];

    if (this.#tablet?.matches && breakpoints['750']?.[key] != null) value = breakpoints['750'][key];
    if (this.#desktop?.matches && breakpoints['990']?.[key] != null) value = breakpoints['990'][key];

    return value;
  }

  /* ---------------------------------------------------------- movement -- */

  /**
   * @param {number} index Index into `#slides`, clones included.
   * @param {Object} [options]
   * @param {boolean} [options.instant]
   */
  #goTo(index, { instant = false } = {}) {
    if (!this.running) return;

    let target = index;

    if (this.#looping) {
      target = bound(target, 0, this.#slides.length - 1);
    } else if (this.#rewinding) {
      const last = this.#lastIndex;
      target = target < 0 ? last : target > last ? 0 : target;
    } else {
      target = bound(target, 0, this.#lastIndex);
    }

    const changed = target !== this.#index || !this.#ready;
    this.#index = target;

    this.#translate(this.#positionFor(target), { instant });
    this.#update({ changed });
    this.#settle();
  }

  /**
   * @param {number} direction 1 or -1.
   */
  #step(direction) {
    if (!this.running || this.hasAttribute('data-locked')) return;

    this.#onInteract();

    const step = this.#group * direction;

    if (!this.#looping && !this.#rewinding) {
      const last = this.#lastIndex;
      // Short final step: with a group of three and two slides left, stepping
      // by three would overshoot and clamp, which reads as a dead press.
      const target = bound(this.#index + step, 0, last);
      if (target === this.#index) return;
      this.#goTo(target);
      return;
    }

    this.#goTo(this.#index + step);
  }

  /**
   * Writes the transform.
   *
   * Two things are deliberate. The value is a `translate3d`, so the movement is
   * a compositor job and never triggers layout. And the duration is written
   * inline rather than toggled with a class, so a drag can hand back a track
   * that is already at 0ms without a second style recalculation.
   *
   * @param {number} position Unsigned distance from the first slide.
   * @param {Object} [options]
   * @param {boolean} [options.instant]
   */
  #translate(position, { instant = false } = {}) {
    const track = this.track;
    const speed = instant || prefersReducedMotion() ? 0 : Number(this.options.speed) || 0;

    // RTL lays the slides out right to left, so the same distance is travelled
    // the other way. Vertical is always top to bottom.
    const sign = this.direction === 'horizontal' && isRTL() ? 1 : -1;
    const value = sign * position;

    this.#position = position;
    track.style.transitionDuration = `${speed}ms`;
    track.style.transform =
      this.direction === 'vertical' ? `translate3d(0, ${value}px, 0)` : `translate3d(${value}px, 0, 0)`;
  }

  /**
   * The index whose resting position is nearest a given translate.
   *
   * @param {number} position
   * @returns {number}
   */
  #nearest(position) {
    const limit = this.#looping ? this.#slides.length - 1 : this.#lastIndex;
    let best = 0;
    let smallest = Infinity;

    for (let index = 0; index <= limit; index += 1) {
      const distance = Math.abs(this.#positionFor(index) - position);
      if (distance < smallest) {
        smallest = distance;
        best = index;
      }
    }

    return best;
  }

  /**
   * Closes the loop seam once the transition has landed.
   *
   * The jump is a translate with the duration at 0, from a clone to the real
   * slide it copies — the same pixels, so there is nothing to see. It is timed
   * off a `transitionend` on the track, with a timer as the fallback for the
   * case `transitionend` never fires: a 0ms move, or a tab that was hidden
   * while the transition was meant to run.
   */
  #settle() {
    clearTimeout(this.#settleTimer);
    if (!this.#looping) return;

    const speed = prefersReducedMotion() ? 0 : Number(this.options.speed) || 0;
    this.#settleTimer = setTimeout(() => this.#wrap(), speed + 50);
  }

  #wrap() {
    if (!this.#looping || this.#dragging) return;

    const total = this.#real.length;
    let index = this.#index;

    if (index < this.#clones) index += total;
    else if (index >= this.#clones + total) index -= total;
    else return;

    this.#index = index;
    this.#translate(this.#positionFor(index), { instant: true });

    // The slide under the customer has not changed — only which copy of it is
    // on screen — so nothing else is re-rendered. The marker has to move with
    // the index, though, or it is left behind on the clone.
    this.#markActive();

    // The reveal is keyed on the *real* index, so the copy that just came on
    // screen is already revealed and this pass writes nothing. It is here for
    // the slide at the far edge, whose neighbour across the seam is a different
    // element before and after the jump.
    this.#reveal();
  }

  /**
   * `data-active` on the slide currently at the start of the track.
   *
   * Separate from `#update()` because the loop seam moves the index without
   * changing anything a customer can see, and re-announcing a position that
   * did not change is noise.
   */
  #markActive() {
    for (const [position, slide] of this.#slides.entries()) {
      slide.toggleAttribute('data-active', position === this.#index);
    }
  }

  /* ------------------------------------------------------------- state -- */

  /**
   * Nested controls win over detached ones. A section that renders both has made
   * a mistake, and the nested pair is the one the customer can see next to the
   * track.
   *
   * @returns {import('@theme/carousel-controls').ControlRefs}
   */
  get #controls() {
    return {
      previous: /** @type {any} */ (this.refs.previous) || this.#external.previous,
      next: /** @type {any} */ (this.refs.next) || this.#external.next,
      current: /** @type {any} */ (this.refs.current) || this.#external.current,
      total: /** @type {any} */ (this.refs.total) || this.#external.total,
      bar: /** @type {any} */ (this.refs.bar) || this.#external.bar
    };
  }

  /**
   * The element the dots, the fraction or the bar are rendered into.
   *
   * Same rule as the controls, and for the same reason: nested wins, and a
   * detached one is only looked for when this element has an id to be addressed
   * by.
   *
   * @returns {HTMLElement|null}
   */
  get #pagination() {
    if (this.refs.pagination) return /** @type {any} */ (this.refs.pagination);
    if (!this.id) return null;

    return document.querySelector(`[data-carousel-for="${CSS.escape(this.id)}"][data-ref="pagination"]`);
  }

  /**
   * The thumbnail strip, nested or detached.
   *
   * @returns {HTMLElement|null}
   */
  get #thumbnails() {
    if (this.refs.thumbnails) return /** @type {any} */ (this.refs.thumbnails);
    if (!this.id) return null;

    return document.querySelector(`[data-carousel-for="${CSS.escape(this.id)}"][data-ref="thumbnails"]`);
  }

  /** @returns {HTMLElement[]} */
  get #thumbs() {
    const strip = this.#thumbnails;
    return strip ? /** @type {HTMLElement[]} */ (Array.from(strip.querySelectorAll('[data-thumbnail]'))) : [];
  }

  /**
   * Position, controls, pagination, thumbnails, live region, reveal — the one
   * place any of them is written.
   *
   * Called on every settle *and* on every re-measure, because a resize can
   * change how many stopping places there are even when the slide under the
   * customer has not moved. The two are told apart by `changed`: the visible
   * state is always rewritten, and the two things that are announcements —
   * the live region and `carousel:change` — happen only when the position
   * really moved.
   *
   * Without that split, a `ResizeObserver` firing as the web fonts land made a
   * screen reader read the position out three times and gave every listener a
   * change event for a change that never happened.
   *
   * @param {Object} [options]
   * @param {boolean} [options.changed] Whether the position actually moved.
   */
  #update({ changed = true } = {}) {
    const current = this.index;
    const total = this.#real.length;
    const pageIndex = this.#pageIndex;
    const pageCount = this.#pageCount;
    const ends = !this.#looping && !this.#rewinding;

    // With no travel at all — the slides already fit — an empty bar reads as
    // broken. Full is the honest answer: there is nowhere left to go.
    const progress = this.#limit > 0 ? bound(this.#position / this.#limit, 0, 1) : 1;

    renderControls(this.#controls, current + 1, total, progress);

    const { previous, next } = this.#controls;
    if (previous instanceof HTMLButtonElement) previous.disabled = ends && pageIndex === 0;
    if (next instanceof HTMLButtonElement) next.disabled = ends && pageIndex >= pageCount - 1;

    previous?.classList.toggle('carousel-button--disabled', ends && pageIndex === 0);
    next?.classList.toggle('carousel-button--disabled', ends && pageIndex >= pageCount - 1);

    this.#markActive();
    this.#reveal();
    this.#updatePagination(pageIndex, pageCount, progress);
    this.#updateThumbs(current);

    if (changed) {
      const status = this.refs.status;
      if (status) {
        /** @type {HTMLElement} */ (status).textContent = themeString(
          'carouselPosition',
          `${current + 1} / ${total}`,
          { index: current + 1, count: total }
        );
      }

      this.dispatch(EVENTS.CAROUSEL_CHANGE, { index: current, count: total });
    }

    this.#ready = true;
  }

  /* -------------------------------------------------------- pagination -- */

  /** @returns {'bullets'|'fraction'|'progressbar'|null} */
  get #paginationType() {
    const type = this.options.pagination?.type;
    return type === 'fraction' || type === 'progressbar' || type === 'bullets' ? type : null;
  }

  /**
   * Builds the pagination once per slide set, rather than on every change.
   *
   * Rebuilding the bullets on every position change is what makes dots flicker
   * on a fast drag. Here the elements are made once and only an attribute moves
   * afterwards.
   */
  #renderPagination() {
    const element = this.#pagination;
    const type = this.#paginationType;

    this.#dots = [];
    if (!element) return;

    if (!type || this.hasAttribute('data-locked')) {
      element.replaceChildren();
      return;
    }

    if (type === 'bullets') {
      const dots = Array.from({ length: this.#pageCount }, (_, position) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'carousel-shell__dot';
        dot.setAttribute('aria-label', themeString('carouselPosition', `${position + 1}`, {
          index: position + 1,
          count: this.#pageCount
        }));
        return dot;
      });

      element.replaceChildren(...dots);
      this.#dots = dots;
      return;
    }

    if (type === 'fraction') {
      element.replaceChildren();
      const current = document.createElement('span');
      current.className = 'carousel-shell__fraction-current';
      const separator = document.createTextNode(' / ');
      const count = document.createElement('span');
      count.className = 'carousel-shell__fraction-total';
      element.append(current, separator, count);
      return;
    }

    const fill = document.createElement('span');
    fill.className = 'carousel-shell__progress-fill';
    element.replaceChildren(fill);
  }

  /**
   * @param {number} pageIndex
   * @param {number} pageCount
   * @param {number} progress
   */
  #updatePagination(pageIndex, pageCount, progress) {
    const element = this.#pagination;
    const type = this.#paginationType;
    if (!element || !type) return;

    if (type === 'bullets') {
      // The dot count follows the slide count, which changes when a fetched
      // section fills an empty track.
      if (this.#dots.length !== pageCount) this.#renderPagination();

      this.#dots.forEach((dot, position) => {
        dot.classList.toggle('carousel-shell__dot--active', position === pageIndex);
        dot.setAttribute('aria-current', position === pageIndex ? 'true' : 'false');
      });
      return;
    }

    if (type === 'fraction') {
      const current = element.querySelector('.carousel-shell__fraction-current');
      const count = element.querySelector('.carousel-shell__fraction-total');
      if (current) current.textContent = String(this.index + 1).padStart(2, '0');
      if (count) count.textContent = String(this.#real.length).padStart(2, '0');
      return;
    }

    const fill = /** @type {HTMLElement|null} */ (element.querySelector('.carousel-shell__progress-fill'));
    if (!fill) return;

    // Slide-based rather than translate-based: the bar is a position readout
    // beside a row of slides, not a scrollbar. The `.carousel-controls__bar`
    // beside the numbers keeps using the translate progress, as it always has.
    //
    // Always `scaleX`, including for a vertical carousel. A vertical carousel's
    // pagination is drawn under it, horizontally, because the element clips to
    // its own height and a bar standing up the side of it has nowhere to be.
    // The bar's own box decides its axis, not the track's.
    const filled = pageCount > 0 ? (pageIndex + 1) / pageCount : progress;
    fill.style.transform = `scaleX(${filled})`;
  }

  /* -------------------------------------------------------- thumbnails -- */

  /**
   * @param {number} current
   */
  #updateThumbs(current) {
    const thumbs = this.#thumbs;
    if (!thumbs.length) return;

    thumbs.forEach((thumb, position) => {
      thumb.setAttribute('aria-current', position === current ? 'true' : 'false');
    });

    const active = thumbs[current];
    const strip = this.#thumbnails;
    if (!active || !strip) return;

    // Keep the active thumbnail in view, on whichever axis the strip actually
    // scrolls. A left- or right-mounted strip is a column; the row under a
    // gallery is a row; the same code covers both because the axis is decided
    // by which dimension overflows rather than by a modifier class.
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';

    if (strip.scrollHeight > strip.clientHeight + EPSILON) {
      strip.scrollTo({ top: active.offsetTop - (strip.clientHeight - active.offsetHeight) / 2, behavior });
    } else if (strip.scrollWidth > strip.clientWidth + EPSILON) {
      strip.scrollTo({ left: active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2, behavior });
    }
  }

  /* ------------------------------------------------------------ reveal -- */

  /**
   * The slide is the unit of reveal.
   *
   * This is the part that used to be wrong, and it was wrong in a way worth
   * writing down. The old implementation reached *inside* the active slide,
   * found every `<motion-effect>` in it and called `replay()`. Three things
   * followed from that, and all three were bugs:
   *
   *   - `data-motion-revealed` landed on whatever wrapper the section happened
   *     to put its text in, so the state of a slide was scattered across the
   *     elements inside it and could not be read, reset or reasoned about.
   *   - A slide with no `<motion-effect>` in it — most of them — never revealed
   *     at all.
   *   - A clone has its effects neutralised by `#clone()`, so a reveal that
   *     landed on one did nothing. Crossing the loop seam produced a slide that
   *     stayed at its resting state, which is the symptom people fix with a
   *     `.clone.revealed { opacity: 1 !important }` rule in the stylesheet —
   *     papering over the index arithmetic rather than doing it.
   *
   * So the state lives on the slide. One attribute, one element:
   *
   *     <li data-motion-armed>                        out of view, at rest
   *     <li data-motion-armed data-motion-revealed>   in view, animated in
   *
   * `#arm()` writes `data-motion-armed` on every slide when the carousel
   * starts, and `carousel.css` holds an armed slide at its resting state
   * for exactly as long as it is not revealed. JavaScript is what hides a
   * slide, which is the rule `motion-engine.js` states and this file has to
   * keep: with the module missing the attribute never appears and nothing was
   * ever hidden.
   *
   * Nothing here observes anything. The set of slides in view is arithmetic on
   * the offsets `#measure()` already cached, run on the same `#update()` that
   * moves the arrows and the dots — so next, previous, a dot, a thumbnail, an
   * autoplay tick and the end of a swipe all reveal through one code path,
   * because every one of them ends in `#goTo()`.
   */

  /**
   * Arms the current slide set, or disarms it when it must not animate.
   *
   * A locked carousel is not armed: its slides all fit, nothing will ever move,
   * and an entrance animation for a row that is really a grid is movement
   * nobody asked for. Reduced motion and `reveal: false` are the other two ways
   * out, and both leave every slide plainly visible.
   *
   * The transition speed is published as a custom property on the way through.
   * It is the one number the stylesheet needs that only `data-options` knows:
   * the reset half of the reveal waits out the track's movement before it
   * applies, and with the two out of step a section that asked for a slower
   * carousel would blink its outgoing slide away while it was still on screen.
   * `#translate()` writes the same number as an inline duration on the track,
   * so this is a publication, not a second source.
   */
  #arm() {
    const speed = Number(this.options.speed);
    this.style.setProperty('--carousel-speed', `${Number.isFinite(speed) && speed >= 0 ? speed : 500}ms`);

    const wanted = this.options.reveal !== false && !prefersReducedMotion() && !this.hasAttribute('data-locked');

    if (!wanted) {
      this.#disarm();
      return;
    }

    this.#armed = true;
    for (const slide of this.#slides) slide.setAttribute('data-motion-armed', '');
  }

  /** Gives every slide back, visible, with no state of ours left on it. */
  #disarm() {
    this.#armed = false;

    for (const slide of this.#slides) {
      slide.removeAttribute('data-motion-armed');
      slide.removeAttribute('data-motion-revealed');
    }
  }

  /**
   * Reveals the slides in view and resets the ones that are not.
   *
   * Written against the *real* index rather than the position in the track,
   * which is the whole of the loop handling. A looping track holds two or three
   * copies of the same authored slide — the slide itself, and a clone at each
   * end — and they are one thing as far as the reveal is concerned. Revealing
   * by real index reveals every copy at once, so the instant, invisible jump
   * from a clone to its original in `#wrap()` swaps one revealed element for
   * another revealed element and there is nothing to see. No clone special
   * case, here or in the stylesheet.
   *
   * The reset is what makes a reveal repeatable: a slide that has left the
   * viewport goes back to its resting state, so it animates again the next time
   * it is stepped, swiped or autoplayed back into view. It does not flicker on
   * the way out, because the stylesheet delays the resting state by the
   * carousel's own transition duration — by the time it applies, the slide is
   * behind the edge of the track.
   */
  #reveal() {
    if (!this.#armed) return;

    const visible = this.#inView();

    for (const [position, slide] of this.#slides.entries()) {
      slide.toggleAttribute('data-motion-revealed', visible.has(this.#realIndexAt(position)));
    }
  }

  /**
   * Which authored slides the track will be showing once it has settled.
   *
   * Measured against the *resting* position of the current index rather than
   * against `#position`, so a drag in progress does not reveal and re-reset
   * slides under the finger: the answer only changes when the index does.
   *
   * With one slide per view this is the active slide and nothing else, which is
   * the plain reading of "reveal the slide that just became active". With a
   * peek, or several slides across, it is every slide a customer can actually
   * see — revealing only the first of three and leaving the other two at
   * opacity 0 would not be a stricter reading of that rule, it would be an
   * empty carousel.
   *
   * @param {number} [from] The track position to measure from. Defaults to the
   *   resting position of the current index.
   * @param {number} [margin] Extra distance either side that counts as in view.
   * @returns {Set<number>} Indices into `#real`.
   */
  #inView(from = this.#positionFor(this.#index), margin = 0) {
    const visible = new Set();

    const origin = from - margin;
    const edge = from + this.#viewport + margin;

    for (let position = 0; position < this.#slides.length; position += 1) {
      const start = this.#positions[position] ?? 0;
      const stop = start + (this.#sizes[position] ?? 0);

      // Overlapping the track's own box at all is enough, so the sliver a peek
      // of 1.2 slides-per-view leaves showing is revealed rather than left
      // blank at the edge.
      if (stop > origin + EPSILON && start < edge - EPSILON) visible.add(this.#realIndexAt(position));
    }

    return visible;
  }

  /**
   * Reveals what a drag in progress is bringing into view, and resets nothing.
   *
   * A drag moves the track without moving the index, so `#reveal()` — which
   * measures from the resting position of the index — would keep insisting the
   * same slide is the only one on screen for the whole gesture. This measures
   * from where the track actually is, with a screen's worth of margin either
   * side so a slide is already fading up by the time its edge appears.
   *
   * Add-only, deliberately. A drag that turns back on itself must not un-reveal
   * the slide it was heading for, and the release runs `#reveal()` anyway,
   * which resets whatever ended up off screen.
   *
   * @param {number} position The track's current translate.
   */
  #revealAhead(position) {
    this.#reach = position;
    if (!this.#armed) return;

    const visible = this.#inView(position, this.#viewport);

    for (const [index, slide] of this.#slides.entries()) {
      if (visible.has(this.#realIndexAt(index))) slide.setAttribute('data-motion-revealed', '');
    }
  }

  /**
   * The authored slide a position in the track belongs to.
   *
   * The same arithmetic as the public `index` getter, for an arbitrary position
   * rather than the current one: the track runs `[tail clones][real slides][head
   * clones]`, so subtracting the clone count and wrapping into the real length
   * turns any of the three copies into the one slide they all show.
   *
   * @param {number} position Index into `#slides`, clones included.
   * @returns {number} Index into `#real`.
   */
  #realIndexAt(position) {
    const total = this.#real.length;
    if (!this.#looping || total === 0) return position;

    return (((position - this.#clones) % total) + total) % total;
  }

  /* --------------------------------------------------------- listeners -- */

  /**
   * Controls are bound once, on connect, and survive a `#stop()` — they are the
   * same buttons at every breakpoint, and rebinding them on each crossing was
   * one listener per crossing for the life of the page.
   */
  #bindControls() {
    if (this.#controlsBound) return;
    this.#controlsBound = true;

    const { previous, next } = this.#controls;

    if (previous) this.on(previous, 'click', () => this.previous());
    if (next) this.on(next, 'click', () => this.next());

    const pagination = this.#pagination;
    if (pagination) {
      this.on(pagination, 'click', (event) => {
        const dot = /** @type {HTMLElement|null} */ (event.target)?.closest?.('.carousel-shell__dot');
        if (!dot) return;

        const position = this.#dots.indexOf(/** @type {HTMLElement} */ (dot));
        if (position < 0) return;

        this.#onInteract();
        this.go(position);
      });
    }

    const strip = this.#thumbnails;
    if (strip) {
      this.on(strip, 'click', (event) => {
        const thumb = /** @type {HTMLElement|null} */ (event.target)?.closest?.('[data-thumbnail]');
        if (!thumb) return;

        const position = this.#thumbs.indexOf(/** @type {HTMLElement} */ (thumb));
        if (position < 0) return;

        event.preventDefault();
        this.#onInteract();
        this.go(position);
      });
    }

    const pause = this.refs.pause;
    if (pause) this.on(pause, 'click', () => this.#toggleAutoplay());

    const autoplay = this.options.autoplay;
    if (autoplay && autoplay.pauseOnMouseEnter !== false) {
      this.on(this, 'mouseenter', () => this.#pauseAutoplay());
      this.on(this, 'mouseleave', () => this.#playAutoplay());
    }

    if (autoplay) {
      this.on(document, 'visibilitychange', () => {
        if (document.hidden) this.#pauseAutoplay();
        else this.#playAutoplay();
      });
    }
  }

  /**
   * Track listeners. Bound once as well — `#bindTrack` guards on a flag rather
   * than on the running state, because `this.on()` ties every listener to the
   * connection, not to the breakpoint.
   */
  #bindTrack() {
    if (this.#trackBound) return;
    this.#trackBound = true;

    const track = this.track;

    if (this.options.keyboard !== false) {
      this.on(track, 'keydown', (event) => this.#onKeydown(/** @type {KeyboardEvent} */ (event)));
    }

    if (this.options.drag !== false) {
      this.on(track, 'pointerdown', (event) => this.#onPointerDown(/** @type {PointerEvent} */ (event)));
      this.on(track, 'pointermove', (event) => this.#onPointerMove(/** @type {PointerEvent} */ (event)));
      this.on(track, 'pointerup', (event) => this.#onPointerEnd(/** @type {PointerEvent} */ (event)));
      this.on(track, 'pointercancel', (event) => this.#onPointerEnd(/** @type {PointerEvent} */ (event)));
      this.on(track, 'dragstart', (event) => event.preventDefault());

      // A drag that ends over a link must not also follow it.
      this.on(
        track,
        'click',
        (event) => {
          if (!this.#suppressClick) return;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true }
      );
    }

    this.on(track, 'transitionend', (event) => {
      if (event.target !== track || /** @type {TransitionEvent} */ (event).propertyName !== 'transform') return;
      this.#wrap();
    });
  }

  /**
   * Re-measures when the box changes size.
   *
   * This is also what recovers a carousel built inside a hidden container — a
   * tab panel, a drawer, a dismissible announcement bar. Measured at zero width
   * every position is zero; the observer fires the moment the box becomes real.
   */
  #watchResize() {
    this.#resize?.disconnect();

    this.#resize = new ResizeObserver(rafThrottle(() => this.#refit()));
    this.#resize.observe(this);
  }

  /**
   * Re-measures a running carousel and keeps the customer where they are.
   *
   * Called from the `ResizeObserver` and from `#start()` when a breakpoint
   * changed under a carousel that was already running — the same work in both
   * cases, because "the box is a different size now" and "the stylesheet gives
   * it a different number of slides now" are the same problem.
   */
  #refit() {
    const before = this.#perView;
    this.#measure();

    // A changed slides-per-view changes how many clones a loop needs and how
    // many stopping places there are, so the structure is rebuilt rather than
    // just re-measured.
    if (before === this.#perView) {
      this.#goTo(this.#index, { instant: true });
      return;
    }

    this.#rebuild();
  }

  /**
   * Re-reads the slide set and everything derived from it, keeping the customer
   * on the slide they were looking at.
   *
   * The index has to be converted on the way through. `#index` counts clones
   * and a rebuild changes how many there are, so it is read as a *real* index
   * first and translated back after — without that, crossing 990px on a looping
   * carousel moved the customer sideways by exactly the difference in clone
   * count.
   *
   * The control visibility is redone as well, because the reason for a rebuild
   * is often that the slide count changed: a carousel that had two slides and
   * now has one is locked, and one that was empty and has just been filled is
   * not.
   */
  #rebuild() {
    const current = this.index;

    this.#build();
    this.#measure();
    this.#renderPagination();

    const active = !this.hasAttribute('data-locked');
    toggleControls(this.#controls, active);
    this.#pagination?.toggleAttribute('data-carousel-active', active);

    this.#goTo(this.#looping ? current + this.#clones : current, { instant: true });
    this.#playAutoplay();
  }

  /**
   * Rebuilds when the track's children change.
   *
   * Three sections render an empty track and fill it later:
   * `product-recommendations` and `recently-viewed` fetch their cards after the
   * page loads, and the collection grid morphs new results in after a filter.
   * Without this their arrows would stay dead for the life of the page.
   *
   * Scoped to one element's direct children, and deaf to this component's own
   * clone work — without both, the observer re-enters itself on every loop wrap.
   */
  #watchSlides() {
    const track = this.track;
    if (!track) return;

    this.#mutations?.disconnect();

    this.#mutations = new MutationObserver((records) => {
      if (this.#rearranging) return;

      const content = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) => node instanceof Element && !node.hasAttribute('data-carousel-clone')
        )
      );

      if (!content) return;

      // `refresh()` rather than `#sync()`. A track that was empty and has just
      // been filled by a fetch is still at the same breakpoint and still the
      // same width, so nothing `#sync()` looks at has changed — it would decide
      // the carousel is already running correctly and leave the new cards
      // unmeasured, with the arrows dead for the life of the page. The slide
      // set is what changed, so the slide set is what is re-read.
      this.refresh();
    });

    this.#mutations.observe(track, { childList: true });
  }

  /* ------------------------------------------------------------- input -- */

  /**
   * @param {KeyboardEvent} event
   */
  #onKeydown(event) {
    const vertical = this.direction === 'vertical';

    /** @type {Record<string, () => void>} */
    const actions = {
      [vertical ? 'ArrowDown' : 'ArrowRight']: () => (isRTL() && !vertical ? this.previous() : this.next()),
      [vertical ? 'ArrowUp' : 'ArrowLeft']: () => (isRTL() && !vertical ? this.next() : this.previous()),
      Home: () => this.go(0),
      End: () => this.go(this.#real.length - 1)
    };

    const action = actions[event.key];
    if (!action) return;

    event.preventDefault();
    action();
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerDown(event) {
    if (event.button !== 0 || !this.running || this.hasAttribute('data-locked')) return;

    this.#pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: this.#position,
      last: this.direction === 'vertical' ? event.clientY : event.clientX,
      time: event.timeStamp,
      velocity: 0,
      decided: false
    };
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerMove(event) {
    const pointer = this.#pointer;
    if (pointer.id === null || event.pointerId !== pointer.id) return;

    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    const vertical = this.direction === 'vertical';
    const along = vertical ? dy : dx;
    const across = vertical ? dx : dy;

    if (!pointer.decided) {
      if (Math.abs(along) < DRAG_THRESHOLD && Math.abs(across) < DRAG_THRESHOLD) return;

      // A gesture across the carousel's axis belongs to the page, not to us.
      // Releasing it here is what keeps vertical page scroll — Lenis included —
      // working over a horizontal carousel.
      if (Math.abs(across) > Math.abs(along)) {
        pointer.id = null;
        return;
      }

      pointer.decided = true;
      this.#dragging = true;
      this.#onInteract();
      this.track.setPointerCapture(event.pointerId);
      this.track.classList.add('is-dragging');

      // The index does not move until the finger lifts, so without this the
      // slide being dragged into view would arrive at its resting state and sit
      // there blank until the release.
      this.#revealAhead(pointer.start);
    }

    const sign = !vertical && isRTL() ? -1 : 1;
    let position = pointer.start - along * sign;

    // Resistance past either end, so a non-looping carousel feels bounded
    // rather than broken. `resistanceRatio: 0.85` was the Swiper setting this
    // reproduces.
    if (!this.#looping) {
      if (position < 0) position *= 0.15;
      else if (position > this.#limit) position = this.#limit + (position - this.#limit) * 0.15;
    }

    this.#translate(position, { instant: true });

    // One subtraction per pointer event, and the walk of the slide set only
    // when the track has actually travelled far enough for the answer to have
    // changed. A long drag keeps revealing as it goes; a short one never runs
    // this at all.
    if (Math.abs(position - this.#reach) > (this.#sizes[this.#index] ?? 0) / 2) this.#revealAhead(position);

    const current = vertical ? event.clientY : event.clientX;
    const elapsed = event.timeStamp - pointer.time;
    if (elapsed > 0) {
      pointer.velocity = (current - pointer.last) / elapsed;
      pointer.last = current;
      pointer.time = event.timeStamp;
    }
  }

  /**
   * @param {PointerEvent} event
   */
  #onPointerEnd(event) {
    const pointer = this.#pointer;
    if (pointer.id === null || event.pointerId !== pointer.id) return;

    pointer.id = null;
    if (!pointer.decided) return;

    this.#dragging = false;
    this.track.classList.remove('is-dragging');
    if (this.track.hasPointerCapture?.(event.pointerId)) this.track.releasePointerCapture(event.pointerId);

    this.#suppressClick = true;
    // A microtask is too early — the click is dispatched after this task — and
    // a timer longer than a tick would swallow a genuine click that follows.
    setTimeout(() => {
      this.#suppressClick = false;
    }, 0);

    const vertical = this.direction === 'vertical';
    const sign = !vertical && isRTL() ? -1 : 1;
    const velocity = pointer.velocity * sign;
    const travelled = this.#position - pointer.start;

    // Where the track was let go, snapped to the nearest stopping place — not
    // that position projected forward by the release velocity.
    //
    // Inertia is the obvious thing to add here and it is the wrong one. Swiper
    // only has it under `freeMode.momentum`, which this theme has never turned
    // on; without it a drag ends where the finger ended, so a customer who
    // pulls the row two slides across gets two slides and a customer who flicks
    // gets one. Projecting instead means an identical-looking gesture lands
    // three slides away because it happened to finish fast, and there is no
    // velocity constant that makes that feel deliberate.
    let target = this.#nearest(this.#position);

    // A short, decisive flick that did not travel far enough to change the
    // nearest slide still has to move one — otherwise a quick swipe snaps back,
    // which reads as the carousel refusing the gesture. `longSwipesRatio` is
    // Swiper's own name and default for the distance half of this test.
    if (target === this.#index && travelled !== 0) {
      const slideSize = this.#sizes[this.#index] ?? 0;
      const decisive = Math.abs(travelled) > slideSize * LONG_SWIPE_RATIO || Math.abs(velocity) > 0.3;
      if (decisive) target = this.#index + Math.sign(travelled) * this.#group;
    }

    this.#goTo(target);
  }

  /* ---------------------------------------------------------- autoplay -- */

  /** @returns {{delay: number, disableOnInteraction: boolean}|null} */
  get #autoplay() {
    const authored = this.options.autoplay;
    if (!authored) return null;

    const delay = Number(typeof authored === 'object' ? authored.delay : authored);
    if (!Number.isFinite(delay) || delay <= 0) return null;

    return {
      delay,
      disableOnInteraction: typeof authored === 'object' ? authored.disableOnInteraction !== false : true
    };
  }

  #playAutoplay() {
    const autoplay = this.#autoplay;
    const pause = /** @type {HTMLElement|undefined} */ (this.refs.pause);

    // Reduced motion does not pause the slideshow, it removes it — there is no
    // slower automatic advance that becomes acceptable, and a "pause" button for
    // something that was never going to move is a control that reports the
    // wrong state.
    const available = Boolean(autoplay) && !prefersReducedMotion();

    if (pause) pause.hidden = !available;
    if (!available) return;

    if (!this.running || this.#interacted || document.hidden) return;
    if (this.hasAttribute('data-locked')) return;

    clearTimeout(this.#autoplayTimer);
    this.#autoplayTimer = setTimeout(() => {
      this.#step(1);
      this.#playAutoplay();
    }, autoplay.delay);

    if (pause) {
      pause.setAttribute('aria-pressed', 'false');
      this.#runRing(autoplay.delay);
    }
  }

  #pauseAutoplay() {
    clearTimeout(this.#autoplayTimer);
    this.#autoplayTimer = undefined;

    const pause = /** @type {HTMLElement|undefined} */ (this.refs.pause);
    if (!pause || pause.hidden) return;

    pause.setAttribute('aria-pressed', 'true');
    // Paused, the ring stays full rather than freezing mid-sweep: a partial arc
    // that never moves reads as a broken control rather than a stopped one.
    this.#stopRing();
  }

  #toggleAutoplay() {
    if (this.#autoplayTimer === undefined) {
      this.#interacted = false;
      this.#playAutoplay();
    } else {
      this.#interacted = true;
      this.#pauseAutoplay();
    }
  }

  /**
   * Drives the countdown ring around the pause button.
   *
   * `--carousel-autoplay-progress` is the property `carousel.css` builds the
   * ring's conic gradient from. It is set to 0 and then to 1 and a CSS
   * transition sweeps it over the autoplay delay, so nothing runs in JavaScript
   * between one slide and the next. `carousel.css` registers the property with
   * `@property` so it can be interpolated — without that registration it is a
   * string and the ring simply steps, which is the graceful degradation.
   *
   * One `requestAnimationFrame` per slide, not a loop: the property has to be
   * set to 0 and then to 1 in two different style recalculations, and a frame
   * is the way to get that without reading layout to force one.
   *
   * @param {number} delay
   */
  #runRing(delay) {
    const pause = /** @type {HTMLElement|undefined} */ (this.refs.pause);
    if (!pause) return;

    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);

    pause.style.setProperty('--carousel-autoplay-duration', '0ms');
    pause.style.setProperty('--carousel-autoplay-progress', '0');

    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      pause.style.setProperty('--carousel-autoplay-duration', `${delay}ms`);
      pause.style.setProperty('--carousel-autoplay-progress', '1');
    });
  }

  #stopRing() {
    const pause = /** @type {HTMLElement|undefined} */ (this.refs.pause);
    if (!pause) return;

    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;

    pause.style.setProperty('--carousel-autoplay-duration', '0ms');
    pause.style.setProperty('--carousel-autoplay-progress', '1');
  }

  /**
   * Autoplay stops permanently at the first touch, drag or press.
   *
   * A slideshow that resumes after the customer has taken control is the most
   * common complaint about carousels, and pausing on hover does not help a
   * touch device. The pause button can start it again.
   */
  #onInteract() {
    const autoplay = this.#autoplay;
    if (!autoplay || !autoplay.disableOnInteraction || this.#interacted) return;

    this.#interacted = true;
    this.#pauseAutoplay();
  }

  /* ------------------------------------------------------------- setup -- */

  /**
   * Writes `--carousel-slides-*` from `data-options`, and only when Liquid did
   * not.
   *
   * `snippets/carousel-vars.liquid` is the source of these in the theme, and it
   * renders the same numbers `carousel-options` puts in the JSON, from one
   * shared snippet — so for a section this is a no-op. Hand-written markup that
   * carries only `data-options` gets them seeded here instead, which is what
   * keeps `<carousel-slider data-options='{"slidesPerView":3}'>` a complete
   * instruction on its own.
   *
   * Written once, on connect, never on a breakpoint change: the breakpoints are
   * in the stylesheet.
   */
  #seedSlideVars() {
    if (this.style.getPropertyValue('--carousel-slides-mobile')) return;

    const options = this.options;
    const breakpoints = options.breakpoints || {};

    const mobile = Number(options.slidesPerView) || 1;
    const tablet = Number(breakpoints['750']?.slidesPerView) || mobile;
    const desktop = Number(breakpoints['990']?.slidesPerView) || tablet;

    this.style.setProperty('--carousel-slides-mobile', String(mobile));
    this.style.setProperty('--carousel-slides-tablet', String(tablet));
    this.style.setProperty('--carousel-slides-desktop', String(desktop));
  }
}

defineComponent('carousel-slider', CarouselSlider);

export default CarouselSlider;
