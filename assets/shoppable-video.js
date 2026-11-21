/**
 * `<shoppable-video>`: the centre-focused video carousel of
 * `sections/shoppable-video.liquid`.
 *
 * Every slide is told how far it sits from the active one (`data-offset`);
 * `base.css` turns that distance into a size and a place. While a pointer
 * drags, the same table is interpolated here so the slides follow the finger,
 * and the release settles them on the nearest slide, as Swiper does.
 *
 * Looping copies the slides until there are enough that the one wrapping
 * round is always out of sight, so nothing jumps across the visible stage.
 * The component also plays the active video (uploaded, or a YouTube/Vimeo
 * embed kept in a `<template>` until first play), drives the arrows and the
 * pagination, and autoplays when asked to.
 *
 * @module @theme/shoppable-video
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { prefersReducedMotion, isRTL } from '@theme/utilities';

/** Furthest distance from the active slide that is still drawn. */
const VISIBLE = 3;

/** Slides needed for the wrap to happen out of sight: both visible sides, plus one hidden each side. */
const LOOP_MINIMUM = (VISIBLE + 1) * 2 + 1;

/** Pixels of travel before a press becomes a drag. Swiper's `threshold`. */
const DRAG_THRESHOLD = 6;

/** Share of one step that counts as a deliberate swipe. */
const SWIPE_RATIO = 0.18;

/** Pointer speed, in px per ms, that counts as a flick whatever the distance. */
const FLICK_SPEED = 0.35;

/** How far past the first or last slide a drag may pull, as a share of the excess. */
const RESISTANCE = 0.3;

/**
 * @typedef {{ x: number[], w: number[] }} SlideTable
 * Centre distance and width of a slide at 0…4 steps from the active one.
 */

export class ShoppableVideo extends BaseComponent {
  static requiredRefs = ['stage'];

  /** Every slide on the stage, copies included. @type {HTMLElement[]} */
  #slides = [];

  /** How many slides the merchant made. */
  #count = 0;

  #index = 0;

  #loop = false;

  #inView = false;

  /** Set by a drag, so the click that ends it does not also pick a slide. */
  #suppressClick = false;

  /** @type {{ id: number, x: number, y: number, decided: boolean, progress: number, last: number, time: number, velocity: number, table: SlideTable|null }|null} */
  #pointer = null;

  /** @type {IntersectionObserver|null} */
  #observer = null;

  /** @type {number|null} */
  #timer = null;

  /** Autoplay stops for good at the first touch, drag or press. */
  #autoplayStopped = false;

  /** Hover or focus inside pauses autoplay without stopping it. */
  #held = false;

  setup() {
    const stage = this.refs.stage;
    const originals = Array.from(stage.querySelectorAll(':scope > [data-slide]'));
    this.#count = originals.length;
    if (!this.#count) return;

    this.#loop = this.dataset.loop !== 'false' && this.#count > 1;
    this.#slides = this.#loop ? this.#withCopies(originals) : originals;

    this.#label();
    this.#measureRatios();
    this.#bindVideos();
    this.#bindInput(stage);
    this.#bindControls();

    // Shopify fires block selection on the block itself, inside this element.
    this.on(document, 'shopify:block:select', (event) => {
      const real = originals.findIndex((slide) => slide.contains(/** @type {Node} */ (event.target)));
      if (real >= 0) {
        this.#stopAutoplay();
        this.goToReal(real);
      }
    });

    if ('IntersectionObserver' in window) {
      this.#observer = new IntersectionObserver(
        ([entry]) => {
          this.#inView = Boolean(entry?.isIntersecting);
          this.#syncPlayback();
          this.#scheduleAutoplay();
        },
        { threshold: 0.35 }
      );
      this.#observer.observe(this);
    } else {
      this.#inView = true;
    }

    this.#render(null);
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#clearTimer();
    super.disconnectedCallback();
  }

  /* ---------------------------------------------------------- public API -- ---- */

  /** @returns {number} The active slide, counted among the merchant's own. */
  get realIndex() {
    return this.#index % this.#count;
  }

  /**
   * Make a slide the active one.
   *
   * @param {number} index Position among every slide on the stage.
   */
  go(index) {
    const total = this.#slides.length;
    const next = this.#loop ? ((index % total) + total) % total : Math.max(0, Math.min(total - 1, index));

    const previous = this.#index;
    this.#index = next;
    if (next !== previous) this.#slides[next]?.removeAttribute('data-held');
    this.#render(previous);
    this.#scheduleAutoplay();
  }

  /**
   * Go to one of the merchant's slides by the shortest way round.
   *
   * @param {number} real
   */
  goToReal(real) {
    if (!this.#loop) {
      this.go(real);
      return;
    }

    let best = this.#index;
    let bestDistance = Infinity;
    this.#slides.forEach((_, index) => {
      if (index % this.#count !== real) return;
      const distance = Math.abs(this.#distance(index, this.#index));
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    this.go(best);
  }

  next() {
    this.go(this.#index + 1);
  }

  previous() {
    this.go(this.#index - 1);
  }

  /* ------------------------------------------------------------ layout -- ---- */

  /**
   * Copy the slides until the stage holds enough for a seamless loop. The
   * copies are the slides themselves, already rendered by Liquid.
   *
   * @param {HTMLElement[]} originals
   * @returns {HTMLElement[]}
   */
  #withCopies(originals) {
    const slides = [...originals];
    const stage = this.refs.stage;

    while (slides.length < LOOP_MINIMUM) {
      for (const original of originals) {
        const copy = /** @type {HTMLElement} */ (original.cloneNode(true));
        copy.setAttribute('data-copy', '');
        for (const attribute of Array.from(copy.attributes)) {
          if (attribute.name.startsWith('data-shopify')) copy.removeAttribute(attribute.name);
        }
        for (const focusable of copy.querySelectorAll('a, button, [tabindex]')) {
          focusable.setAttribute('tabindex', '-1');
        }
        stage.appendChild(copy);
        slides.push(copy);
      }
    }

    return slides;
  }

  /**
   * Shortest signed distance from `active` to `index`: round the loop when
   * looping, straight along the row when not.
   *
   * @param {number} index
   * @param {number} active
   * @returns {number}
   */
  #distance(index, active) {
    let distance = index - active;
    if (!this.#loop) return distance;

    const total = this.#slides.length;
    if (distance > total / 2) distance -= total;
    if (distance < -total / 2) distance += total;
    return distance;
  }

  /** @param {number|null} previous The index that was active, or null on first paint. */
  #render(previous) {
    const limit = VISIBLE + 1;

    this.#slides.forEach((slide, index) => {
      const distance = this.#distance(index, this.#index);

      // The first placement is instant. After that, a slide that wraps from one
      // end to the other does so out of sight, without a transition.
      if (previous === null) {
        slide.setAttribute('data-jump', '');
      } else {
        const before = this.#distance(index, previous);
        const wraps = Math.sign(before) !== Math.sign(distance) && Math.abs(before) + Math.abs(distance) > 2;
        slide.toggleAttribute('data-jump', wraps);
      }

      this.#clearDragStyle(slide);
      slide.dataset.offset = String(Math.max(-limit, Math.min(limit, distance)));
      slide.toggleAttribute('data-active', distance === 0);
      if (slide.hasAttribute('data-copy')) {
        // A copy in the centre is the slide being shown, so it is announced.
        slide.toggleAttribute('aria-hidden', distance !== 0);
      } else {
        slide.inert = Math.abs(distance) > VISIBLE;
      }
      if (distance === 0) this.style.setProperty('--sv-active-ratio', this.#ratioOf(slide));
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const slide of this.#slides) slide.removeAttribute('data-jump');
      });
    });

    this.#updateControls();
    this.#syncPlayback();
  }

  /**
   * @param {HTMLElement} slide
   * @returns {string} The slide's width-to-height ratio, as Liquid wrote it.
   */
  #ratioOf(slide) {
    return slide.style.getPropertyValue('--sv-ratio').trim() || '0.6';
  }

  /** The stage is as tall as the tallest shape any slide can take in the centre. */
  #measureRatios() {
    const ratios = this.#slides.map((slide) => Number.parseFloat(this.#ratioOf(slide))).filter((n) => n > 0);
    if (ratios.length) this.style.setProperty('--sv-stage-ratio', String(Math.min(...ratios)));
  }

  /** Number each slide from the localised pattern; a copy repeats its original's label. */
  #label() {
    const pattern = this.dataset.slideLabel || '';
    if (!pattern) return;

    const count = String(this.#count);
    this.#slides.forEach((slide, index) => {
      const real = (index % this.#count) + 1;
      slide.setAttribute('aria-label', pattern.replace('__index__', String(real)).replace('__count__', count));
    });
  }

  /**
   * The slide sizes and centres, read from the same custom properties the
   * stylesheet uses, so a drag can draw the states between two of them.
   *
   * @returns {SlideTable}
   */
  #measure() {
    const style = getComputedStyle(this);
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

    /** @param {string} name */
    const px = (name) => {
      const value = style.getPropertyValue(name).trim();
      const number = Number.parseFloat(value);
      if (!Number.isFinite(number)) return 0;
      return value.endsWith('rem') ? number * root : number;
    };

    const w = [px('--sv-w0'), px('--sv-w1'), px('--sv-w2'), px('--sv-w3')];
    const frame = px('--sv-frame');
    const gapFirst = px('--sv-gap-first');
    const gap = px('--sv-gap');

    const x1 = w[0] / 2 + frame + gapFirst + w[1] / 2;
    const x2 = x1 + w[1] / 2 + gap + w[2] / 2;
    const x3 = x2 + w[2] / 2 + gap + w[3] / 2;
    const x4 = x3 + w[3] + gap;

    return { x: [0, x1, x2, x3, x4], w: [w[0], w[1], w[2], w[3], w[3]] };
  }

  /**
   * Draw a slide at a fractional distance from the centre.
   *
   * @param {HTMLElement} slide
   * @param {number} position Signed distance, in slides.
   * @param {SlideTable} table
   */
  #place(slide, position, table) {
    const along = Math.abs(position);
    const step = Math.min(Math.floor(along), 4);
    const t = along - step;

    let x;
    let w;
    if (step >= 4) {
      x = table.x[4] + (along - 4) * (table.x[4] - table.x[3]);
      w = table.w[4];
    } else {
      x = table.x[step] + (table.x[step + 1] - table.x[step]) * t;
      w = table.w[step] + (table.w[step + 1] - table.w[step]) * t;
    }

    const opacity = along <= VISIBLE ? 1 : Math.max(0, VISIBLE + 1 - along);

    slide.style.setProperty('--sv-x', `${Math.sign(position) * x}px`);
    slide.style.setProperty('--sv-w', `${w}px`);
    slide.style.opacity = String(opacity);
    slide.style.visibility = opacity > 0 ? 'visible' : 'hidden';
    slide.style.zIndex = String(10 - Math.round(along));
  }

  /** @param {HTMLElement} slide */
  #clearDragStyle(slide) {
    slide.style.removeProperty('--sv-x');
    slide.style.removeProperty('--sv-w');
    slide.style.removeProperty('opacity');
    slide.style.removeProperty('visibility');
    slide.style.removeProperty('z-index');
  }

  /* ------------------------------------------------------------- input -- ---- */

  /** @param {HTMLElement} stage */
  #bindInput(stage) {
    this.on(stage, 'click', (event) => this.#onClick(/** @type {MouseEvent} */ (event)), { capture: true });
    this.on(stage, 'keydown', (event) => this.#onKey(/** @type {KeyboardEvent} */ (event)));
    this.on(stage, 'dragstart', (event) => event.preventDefault());

    if (this.#count > 1) {
      this.on(stage, 'pointerdown', (event) => this.#onPointerDown(/** @type {PointerEvent} */ (event)));
      this.on(stage, 'pointermove', (event) => this.#onPointerMove(/** @type {PointerEvent} */ (event)));
      this.on(stage, 'pointerup', (event) => this.#onPointerEnd(/** @type {PointerEvent} */ (event)));
      this.on(stage, 'pointercancel', (event) => this.#onPointerEnd(/** @type {PointerEvent} */ (event)));
    }

    this.on(this, 'pointerenter', () => this.#hold(true));
    this.on(this, 'pointerleave', () => this.#hold(false));
    this.on(this, 'focusin', () => this.#hold(true));
    this.on(this, 'focusout', () => this.#hold(false));
  }

  /** @param {MouseEvent} event */
  #onClick(event) {
    if (this.#suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = /** @type {Element} */ (event.target);
    const slide = target.closest('[data-slide]');
    if (!(slide instanceof HTMLElement)) return;

    const index = this.#slides.indexOf(slide);

    // On the centre slide the whole video is the play control; the product card keeps its own.
    const onCentreVideo = index === this.#index && !target.closest('.shoppable-video__product, a, button');
    const toggle = target.closest('[data-video-toggle]') || (onCentreVideo && slide.querySelector('[data-video-toggle]'));

    if (toggle) {
      this.#stopAutoplay();
      if (this.#isPlaying(slide)) {
        // Paused by hand: autoplay leaves it alone until it is picked again.
        slide.setAttribute('data-held', '');
        this.#pause(slide);
      } else {
        slide.removeAttribute('data-held');
        this.#play(slide, { sound: true });
      }
      if (index !== this.#index) this.go(index);
      return;
    }

    // A slide beside the centre is picked rather than followed into.
    if (index !== this.#index) {
      event.preventDefault();
      event.stopPropagation();
      this.#stopAutoplay();
      this.go(index);
    }
  }

  /** @param {KeyboardEvent} event */
  #onKey(event) {
    if (event.target !== this.refs.stage) return;

    const forward = isRTL() ? 'ArrowLeft' : 'ArrowRight';
    const back = isRTL() ? 'ArrowRight' : 'ArrowLeft';

    if (event.key === forward) {
      event.preventDefault();
      this.#stopAutoplay();
      this.next();
    } else if (event.key === back) {
      event.preventDefault();
      this.#stopAutoplay();
      this.previous();
    }
  }

  /** @param {PointerEvent} event */
  #onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (/** @type {Element} */ (event.target).closest('[data-video-toggle]')) return;

    this.#pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      decided: false,
      progress: 0,
      last: event.clientX,
      time: event.timeStamp,
      velocity: 0,
      table: null
    };
  }

  /** @param {PointerEvent} event */
  #onPointerMove(event) {
    const pointer = this.#pointer;
    if (!pointer || pointer.id !== event.pointerId) return;

    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;

    if (!pointer.decided) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

      // Mostly vertical: the page is being scrolled, not the carousel.
      if (Math.abs(dy) > Math.abs(dx)) {
        this.#pointer = null;
        return;
      }

      pointer.decided = true;
      pointer.table = this.#measure();
      this.#stopAutoplay();
      this.refs.stage.setPointerCapture?.(event.pointerId);
      this.setAttribute('data-dragging', '');
    }

    const table = /** @type {SlideTable} */ (pointer.table);
    const step = table.x[1] || 1;
    const towards = isRTL() ? 1 : -1;
    let progress = (dx * towards) / step;

    // Without a loop, pull against the ends instead of running past them.
    if (!this.#loop) {
      const min = -this.#index;
      const max = this.#slides.length - 1 - this.#index;
      if (progress < min) progress = min + (progress - min) * RESISTANCE;
      if (progress > max) progress = max + (progress - max) * RESISTANCE;
    }

    pointer.progress = progress;

    this.#slides.forEach((slide, index) => {
      this.#place(slide, this.#distance(index, this.#index) - progress, table);
    });

    const elapsed = event.timeStamp - pointer.time;
    if (elapsed > 0) {
      pointer.velocity = ((event.clientX - pointer.last) * towards) / elapsed;
      pointer.last = event.clientX;
      pointer.time = event.timeStamp;
    }
  }

  /** @param {PointerEvent} event */
  #onPointerEnd(event) {
    const pointer = this.#pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    this.#pointer = null;
    if (!pointer.decided) return;

    const stage = this.refs.stage;
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);

    this.#suppressClick = true;
    setTimeout(() => {
      this.#suppressClick = false;
    }, 0);

    let steps = Math.round(pointer.progress);
    if (steps === 0) {
      const decisive = Math.abs(pointer.progress) > SWIPE_RATIO || Math.abs(pointer.velocity) > FLICK_SPEED;
      if (decisive) steps = Math.sign(pointer.progress || pointer.velocity);
    }

    // Settle from where the finger left the slides: transitions come back on
    // in the same frame the drag styles are cleared.
    this.removeAttribute('data-dragging');
    this.go(this.#index + steps);
  }

  /* ---------------------------------------------------------- controls -- ---- */

  #bindControls() {
    const previous = this.refs.previous;
    const next = this.refs.next;

    if (previous instanceof HTMLElement) {
      this.on(previous, 'click', () => {
        this.#stopAutoplay();
        this.previous();
      });
    }
    if (next instanceof HTMLElement) {
      this.on(next, 'click', () => {
        this.#stopAutoplay();
        this.next();
      });
    }

    for (const dot of this.querySelectorAll('[data-dot]')) {
      this.on(dot, 'click', () => {
        this.#stopAutoplay();
        this.goToReal(Number(/** @type {HTMLElement} */ (dot).dataset.dot) || 0);
      });
    }

    this.querySelector('[data-carousel-nav]')?.setAttribute('data-carousel-active', '');
  }

  #updateControls() {
    const real = this.realIndex;

    for (const dot of this.querySelectorAll('[data-dot]')) {
      const active = Number(/** @type {HTMLElement} */ (dot).dataset.dot) === real;
      dot.classList.toggle('carousel-shell__dot--active', active);
      dot.setAttribute('aria-current', active ? 'true' : 'false');
    }

    const current = this.refs.current;
    if (current instanceof HTMLElement) current.textContent = String(real + 1).padStart(2, '0');

    const fill = this.refs.fill;
    if (fill instanceof HTMLElement) fill.style.transform = `scaleX(${(real + 1) / this.#count})`;

    if (!this.#loop) {
      this.refs.previous?.classList.toggle('carousel-button--disabled', this.#index === 0);
      this.refs.next?.classList.toggle('carousel-button--disabled', this.#index === this.#slides.length - 1);
    }
  }

  /* ---------------------------------------------------------- autoplay -- ---- */

  /** @returns {number} Milliseconds between slides, or 0 for no autoplay. */
  get #delay() {
    const delay = Number(this.dataset.autoplayDelay);
    return Number.isFinite(delay) && delay > 0 && !prefersReducedMotion() ? delay : 0;
  }

  /** @param {boolean} held */
  #hold(held) {
    this.#held = held;
    this.#scheduleAutoplay();
  }

  #scheduleAutoplay() {
    this.#clearTimer();
    if (!this.#delay || this.#autoplayStopped || this.#held || !this.#inView || this.#count < 2) return;

    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      if (!this.#loop && this.#index >= this.#slides.length - 1) {
        this.go(0);
      } else {
        this.next();
      }
    }, this.#delay);
  }

  #stopAutoplay() {
    this.#autoplayStopped = true;
    this.#clearTimer();
  }

  #clearTimer() {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /* ---------------------------------------------------------- playback -- ---- */

  /** Keep every toggle in step with its own video, however it was started. */
  #bindVideos() {
    for (const slide of this.#slides) {
      const video = slide.querySelector('video');
      if (!video) continue;

      this.on(video, 'playing', () => this.#setPlaying(slide, true));
      this.on(video, 'pause', () => this.#setPlaying(slide, false));
      this.on(video, 'ended', () => this.#setPlaying(slide, false));
    }
  }

  /**
   * @param {HTMLElement} slide
   * @param {boolean} playing
   */
  #setPlaying(slide, playing) {
    slide.toggleAttribute('data-playing', playing);

    const toggle = slide.querySelector('[data-video-toggle]');
    if (!(toggle instanceof HTMLElement)) return;

    toggle.setAttribute('aria-pressed', String(playing));
    const label = playing ? toggle.dataset.labelPause : toggle.dataset.labelPlay;
    if (label) toggle.setAttribute('aria-label', label);
  }

  /**
   * @param {HTMLElement} slide
   * @returns {boolean} Whether this slide's video starts on its own once centred.
   */
  #autoplays(slide) {
    return slide.hasAttribute('data-autoplay') && !prefersReducedMotion();
  }

  /**
   * @param {HTMLElement} slide
   * @returns {boolean}
   */
  #isPlaying(slide) {
    const video = slide.querySelector('video');
    if (video) return !video.paused;
    return slide.hasAttribute('data-playing');
  }

  /**
   * Start or resume a slide's video. A press plays it with sound; autoplay
   * stays muted, because browsers block sound nobody asked for.
   *
   * @param {HTMLElement} slide
   * @param {{ sound?: boolean }} [options]
   */
  #play(slide, { sound = false } = {}) {
    const video = slide.querySelector('video');
    if (video) {
      if (sound) video.muted = false;
      else if (!slide.hasAttribute('data-started')) video.muted = true;

      slide.setAttribute('data-started', '');
      video.play().catch(() => {
        // Sound refused after all: play muted rather than not at all.
        if (!video.muted) {
          video.muted = true;
          video.play().catch(() => this.#setPlaying(slide, false));
        } else {
          this.#setPlaying(slide, false);
        }
      });
      return;
    }

    // An embed: inserted on first play, then driven through its player API.
    let frame = slide.querySelector('iframe');
    if (!frame) {
      const template = slide.querySelector('template[data-video-template]');
      const media = slide.querySelector('.shoppable-video__media');
      if (!(template instanceof HTMLTemplateElement) || !media) return;

      const content = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
      frame = content.querySelector('iframe');
      if (!frame) return;

      frame.setAttribute('src', this.#embedUrl(frame.getAttribute('src') || '', { muted: !sound }));
      frame.setAttribute('tabindex', '-1');
      media.appendChild(content);
    } else {
      this.#command(frame, 'play');
      if (sound) this.#command(frame, 'unmute');
    }

    slide.setAttribute('data-started', '');
    this.#setPlaying(slide, true);
  }

  /**
   * Pause where it is: the frame stays on screen and resumes from there.
   *
   * @param {HTMLElement} slide
   */
  #pause(slide) {
    const video = slide.querySelector('video');
    if (video) {
      if (!video.paused) video.pause();
      return;
    }

    const frame = slide.querySelector('iframe');
    if (frame) this.#command(frame, 'pause');
    this.#setPlaying(slide, false);
  }

  /**
   * @param {string} src The embed address Liquid wrote.
   * @param {{ muted: boolean }} options
   * @returns {string} The address with the player API on and sound set.
   */
  #embedUrl(src, { muted }) {
    let url;
    try {
      url = new URL(src, window.location.href);
    } catch {
      return src;
    }

    if (url.hostname.includes('youtube')) {
      url.searchParams.set('enablejsapi', '1');
      url.searchParams.set('origin', window.location.origin);
      url.searchParams.set('mute', muted ? '1' : '0');
    } else if (url.hostname.includes('vimeo')) {
      url.searchParams.set('muted', muted ? '1' : '0');
    }

    return url.toString();
  }

  /**
   * Send play, pause or unmute to a YouTube or Vimeo player.
   *
   * @param {HTMLIFrameElement} frame
   * @param {'play'|'pause'|'unmute'} action
   */
  #command(frame, action) {
    const target = frame.contentWindow;
    if (!target) return;

    let host = '';
    try {
      host = new URL(frame.src).hostname;
    } catch {
      return;
    }

    if (host.includes('youtube')) {
      const func = { play: 'playVideo', pause: 'pauseVideo', unmute: 'unMute' }[action];
      target.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
      return;
    }

    if (host.includes('vimeo')) {
      const messages =
        action === 'unmute'
          ? [{ method: 'setMuted', value: false }, { method: 'setVolume', value: 1 }]
          : [{ method: action }];
      for (const message of messages) target.postMessage(JSON.stringify(message), 'https://player.vimeo.com');
    }
  }

  /**
   * Put a slide back as it was before anything played: video at the start,
   * cover image showing.
   *
   * @param {HTMLElement} slide
   */
  #reset(slide) {
    const video = slide.querySelector('video');
    if (video) {
      if (!video.paused) video.pause();
      video.currentTime = 0;
    }

    // An embed is dropped; the next play inserts it fresh from the template.
    slide.querySelector('.shoppable-video__media > iframe')?.remove();

    slide.removeAttribute('data-started');
    slide.removeAttribute('data-held');
    this.#setPlaying(slide, false);
  }

  /** Reset what left the centre, pause the centre while off screen, start it when it may play itself. */
  #syncPlayback() {
    this.#slides.forEach((slide, index) => {
      if (!slide.querySelector('[data-video-toggle]')) return;

      if (index !== this.#index) {
        if (slide.hasAttribute('data-started')) this.#reset(slide);
        return;
      }

      if (!this.#inView) {
        if (this.#isPlaying(slide)) this.#pause(slide);
        return;
      }

      if (this.#autoplays(slide) && !this.#isPlaying(slide) && !slide.hasAttribute('data-held')) this.#play(slide);
    });
  }
}

defineComponent('shoppable-video', ShoppableVideo);
