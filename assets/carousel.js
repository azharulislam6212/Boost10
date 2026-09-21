/**
 * `<carousel-slider>` — the theme's own carousel engine. No Swiper, no third
 * party anything.
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

/** The behaviour of a carousel given no configuration at all. */
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

  /* -------------------------------------------------------------- state -- ---- */

  /** Slides the merchant authored, clones excluded. @type {HTMLElement[]} */
  #real = [];

  /** Everything in the track, clones included, in DOM order. @type {HTMLElement[]} */
  #slides = [];

  /**
   * Distance from the first slide to each slide, always positive.
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

  /* ---------------------------------------------------------- lifecycle -- ---- */

  setup() {
    this.#options = null;

    this.#controlsBound = false;
    this.#trackBound = false;

    this.#tablet = window.matchMedia(TABLET_QUERY);
    this.#desktop = window.matchMedia(DESKTOP_QUERY);

    this.#external = findExternalControls(this.id);

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

  /* ------------------------------------------------------------ editor -- ---- */

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

  /* -------------------------------------------------------- public API -- ---- */

  /**
   * The merchant's configuration, straight from the attribute.
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

  /* ----------------------------------------------------- run / stand by -- ---- */

  /**
   * Whether this breakpoint should be a carousel.
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

    if (this.running) {
      this.#refit();
      return;
    }

    this.setAttribute('data-direction', this.direction);
    this.setAttribute('data-running', '');

    this.#build();
    this.#measure();

    if (this.options.keyboard !== false && !track.hasAttribute('tabindex')) {
      track.setAttribute('tabindex', '0');
      track.setAttribute('data-carousel-tabindex', '');
    }

    this.#bindTrack();
    this.#watchResize();
    this.#renderPagination();
    this.#goTo(this.#looping ? this.#clones : 0, { instant: true });

    const active = !this.hasAttribute('data-locked');
    toggleControls(this.#controls, active);

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

  /* --------------------------------------------------------- structure -- ---- */

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

    this.#perView = this.#readPerView();
    const locked = total <= Math.floor(this.#perView) || total < 2;
    this.toggleAttribute('data-locked', locked);

    if (locked) {
      this.#looping = false;
      this.#rewinding = false;
    } else {
      this.#buildLoop();
    }

    this.#arm();
  }

  /**
   * Inert clones at both ends, so the track can keep moving in one direction
   * and the seam jump happens where nobody is looking.
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

  /* ----------------------------------------------------- measurement -- ---- */

  /**
   * Slides per view, asked of CSS rather than restated here.
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

    if (this.#looping) return position;

    return bound(position, 0, this.#limit);
  }

  /**
   * The last index that is a distinct stopping place.
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

  /* ---------------------------------------------------------- movement -- ---- */

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
   * @param {number} position Unsigned distance from the first slide.
   * @param {Object} [options]
   * @param {boolean} [options.instant]
   */
  #translate(position, { instant = false } = {}) {
    const track = this.track;
    const speed = instant || prefersReducedMotion() ? 0 : Number(this.options.speed) || 0;

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

  /** Closes the loop seam once the transition has landed. */
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

    this.#markActive();

    this.#reveal();
  }

  /** `data-active` on the slide currently at the start of the track. */
  #markActive() {
    for (const [position, slide] of this.#slides.entries()) {
      slide.toggleAttribute('data-active', position === this.#index);
    }
  }

  /* ------------------------------------------------------------- state -- ---- */

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
   * @param {Object} [options]
   * @param {boolean} [options.changed] Whether the position actually moved.
   */
  #update({ changed = true } = {}) {
    const current = this.index;
    const total = this.#real.length;
    const pageIndex = this.#pageIndex;
    const pageCount = this.#pageCount;
    const ends = !this.#looping && !this.#rewinding;

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

  /* -------------------------------------------------------- pagination -- ---- */

  /** @returns {'bullets'|'fraction'|'progressbar'|null} */
  get #paginationType() {
    const type = this.options.pagination?.type;
    return type === 'fraction' || type === 'progressbar' || type === 'bullets' ? type : null;
  }

  /** Builds the pagination once per slide set, rather than on every change. */
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

    const filled = pageCount > 0 ? (pageIndex + 1) / pageCount : progress;
    fill.style.transform = `scaleX(${filled})`;
  }

  /* -------------------------------------------------------- thumbnails -- ---- */

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

    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';

    if (strip.scrollHeight > strip.clientHeight + EPSILON) {
      strip.scrollTo({ top: active.offsetTop - (strip.clientHeight - active.offsetHeight) / 2, behavior });
    } else if (strip.scrollWidth > strip.clientWidth + EPSILON) {
      strip.scrollTo({ left: active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2, behavior });
    }
  }

  /* ------------------------------------------------------------ reveal -- ---- */

  /** The slide is the unit of reveal. */

  /** Arms the current slide set, or disarms it when it must not animate. */
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

  /** Reveals the slides in view and resets the ones that are not. */
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

      if (stop > origin + EPSILON && start < edge - EPSILON) visible.add(this.#realIndexAt(position));
    }

    return visible;
  }

  /**
   * Reveals what a drag in progress is bringing into view, and resets nothing.
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
   * @param {number} position Index into `#slides`, clones included.
   * @returns {number} Index into `#real`.
   */
  #realIndexAt(position) {
    const total = this.#real.length;
    if (!this.#looping || total === 0) return position;

    return (((position - this.#clones) % total) + total) % total;
  }

  /* --------------------------------------------------------- listeners -- ---- */

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

  /** Re-measures when the box changes size. */
  #watchResize() {
    this.#resize?.disconnect();

    this.#resize = new ResizeObserver(rafThrottle(() => this.#refit()));
    this.#resize.observe(this);
  }

  /** Re-measures a running carousel and keeps the customer where they are. */
  #refit() {
    const before = this.#perView;
    this.#measure();

    if (before === this.#perView) {
      this.#goTo(this.#index, { instant: true });
      return;
    }

    this.#rebuild();
  }

  /**
   * Re-reads the slide set and everything derived from it, keeping the customer
   * on the slide they were looking at.
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

  /** Rebuilds when the track's children change. */
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

      this.refresh();
    });

    this.#mutations.observe(track, { childList: true });
  }

  /* ------------------------------------------------------------- input -- ---- */

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

      if (Math.abs(across) > Math.abs(along)) {
        pointer.id = null;
        return;
      }

      pointer.decided = true;
      this.#dragging = true;
      this.#onInteract();
      this.track.setPointerCapture(event.pointerId);
      this.track.classList.add('is-dragging');

      this.#revealAhead(pointer.start);
    }

    const sign = !vertical && isRTL() ? -1 : 1;
    let position = pointer.start - along * sign;

    if (!this.#looping) {
      if (position < 0) position *= 0.15;
      else if (position > this.#limit) position = this.#limit + (position - this.#limit) * 0.15;
    }

    this.#translate(position, { instant: true });

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
    setTimeout(() => {
      this.#suppressClick = false;
    }, 0);

    const vertical = this.direction === 'vertical';
    const sign = !vertical && isRTL() ? -1 : 1;
    const velocity = pointer.velocity * sign;
    const travelled = this.#position - pointer.start;

    let target = this.#nearest(this.#position);

    if (target === this.#index && travelled !== 0) {
      const slideSize = this.#sizes[this.#index] ?? 0;
      const decisive = Math.abs(travelled) > slideSize * LONG_SWIPE_RATIO || Math.abs(velocity) > 0.3;
      if (decisive) target = this.#index + Math.sign(travelled) * this.#group;
    }

    this.#goTo(target);
  }

  /* ---------------------------------------------------------- autoplay -- ---- */

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

  /** Autoplay stops permanently at the first touch, drag or press. */
  #onInteract() {
    const autoplay = this.#autoplay;
    if (!autoplay || !autoplay.disableOnInteraction || this.#interacted) return;

    this.#interacted = true;
    this.#pauseAutoplay();
  }

  /* ------------------------------------------------------------- setup -- ---- */

  /**
   * Writes `--carousel-slides-*` from `data-options`, and only when Liquid did
   * not.
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
