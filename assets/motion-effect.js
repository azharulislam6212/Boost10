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

/**
 * What each motion element last ran in the editor, keyed by where it sits. A
 * re-render whose animation settings differ from last time is the merchant
 * trying a new effect, so that one plays; any other edit still just appears.
 *
 * @type {Map<string, string>}
 */
const editorSignatures = new Map();

/** The data attributes that describe an animation. */
const SIGNATURE_KEYS = ['effect', 'duration', 'delay', 'stagger', 'distance', 'easing', 'target', 'children', 'speed', 'direction'];

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

  /** @type {{ destroy: () => void, play?: () => void, pause?: () => void }|null} */
  #instance = null;

  /** True inside `replay()`, which always animates. @type {boolean} */
  #replaying = false;

  /** Waiting for the parser to finish this element's content. @type {boolean} */
  #waitingForParse = false;

  /* ------------------------------------------------------------ lifecycle ---- */

  /**
   * This module loads `async`, so it runs while the document is still
   * streaming in. A host the parser has already closed starts now. One it is
   * still filling, or has not reached, starts on the first frame after the
   * parser closes it — not at DOMContentLoaded, which on a long page is
   * seconds later and left a restored reload showing blank sections. Its
   * targets and text are all there by then, so it plays the same entrance.
   */
  connectedCallback() {
    if (document.readyState === 'loading' && !(upgrading && isParsed(this))) {
      if (this.#waitingForParse) return;
      this.#waitingForParse = true;
      waitForParse(this, () => {
        this.#waitingForParse = false;
        if (this.isConnected) super.connectedCallback();
      });
      return;
    }
    super.connectedCallback();
  }

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

    // A reload or back/forward that reopened the page on this spot
    // (snippets/scroll-restore.liquid) showed it from the first frame, as it
    // was left. Hiding it again to animate it would be a blank flash.
    const restored = this.hasAttribute('data-motion-restored');
    const changed = this.#recordSignature();
    if (
      (editorReady && !this.#replaying && !changed) ||
      (!this.#replaying && (restored || this.#shownByFailsafe()))
    ) {
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
    this.removeAttribute('data-motion-played');
    for (const target of this.#targets()) target.removeAttribute('data-motion-revealed');
    this.#replaying = true;
    this.setup();
    this.#replaying = false;
  }

  /* ------------------------------------------------------------ effects -- ---- */

  /** @param {string} effect */
  #setupReveal(effect) {
    const preset = getPreset(effect);

    if (!preset) {
      console.warn(`[theme] <motion-effect> has no preset named "${effect}".`);
      this.setAttribute('data-motion-revealed', '');
      return;
    }

    const targets = this.#targets();

    const splitOne =
      Boolean(preset.split) &&
      targets.length === 1 &&
      !targets[0].querySelector('motion-effect:not([data-motion-inline])');

    this.setAttribute('data-motion-pending', '');

    this.#cancelReveal = reveal(splitOne ? targets[0] : this, {
      effect,
      onReveal: () => {
        this.removeAttribute('data-motion-pending');
        this.setAttribute('data-motion-revealed', '');
        this.setAttribute('data-motion-played', '');
      },
      targets: splitOne ? undefined : targets,
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

  /** @param {string} effect */
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
   * Remember this element's animation settings in the editor.
   *
   * @returns {boolean} True when they differ from what this spot ran last time.
   */
  #recordSignature() {
    if (!isDesignMode()) return false;

    const section = this.closest('.shopify-section')?.id || '';
    const owner = this.closest('[data-shopify-editor-block]');
    let blockId = '';
    if (owner) {
      try {
        blockId = JSON.parse(owner.getAttribute('data-shopify-editor-block') || '{}').id || '';
      } catch {
        blockId = owner.getAttribute('data-shopify-editor-block') || '';
      }
    }

    const scope = owner || this.closest('.shopify-section') || document;
    const position = Array.from(scope.querySelectorAll('motion-effect')).indexOf(this);

    const key = `${section}|${blockId}|${position}`;
    const signature = SIGNATURE_KEYS.map((name) => this.dataset[name] ?? '').join('|');
    const previous = editorSignatures.get(key);
    editorSignatures.set(key, signature);

    return previous !== undefined && previous !== signature;
  }

  /**
   * The critical stylesheet holds a host at opacity 0 until this module claims
   * it, and lets go after 12s in case a script never settles. A host it has
   * already let go of that sits on screen has been seen; hiding it again to
   * animate it is a flash, not an entrance.
   *
   * @returns {boolean}
   */
  #shownByFailsafe() {
    if (performance.now() < 12000 || this.hasAttribute('data-motion-pending')) return false;
    if (getComputedStyle(this).opacity === '0') return false;
    const box = this.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight;
  }

  /**
   * Resolve which elements the effect applies to.
   *
   * @returns {HTMLElement[]}
   */
  #targets() {
    if (this.dataset.target) {
      const found = Array.from(this.querySelectorAll(this.dataset.target));
      if (found.length > 0) return found;
    }

    if (this.dataset.children !== undefined && this.dataset.children !== 'false') {
      return itemsOf(Array.from(this.children));
    }

    return [this];
  }

  /**
   * @param {string} name
   * @returns {number|undefined}
   */
  #number(name) {
    const raw = this.dataset[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

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

/**
 * The children to cascade, one after another. A box that only holds the real
 * items — a carousel, its track, a group's content, anything marked
 * `data-motion-items` — gives way to the items inside it, so a row of cards
 * comes in card by card instead of as one block.
 *
 * @param {Element[]} nodes
 * @returns {HTMLElement[]}
 */
function itemsOf(nodes) {
  /** @type {HTMLElement[]} */
  const items = [];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.matches("carousel-slider, [data-ref~='track'], [data-motion-items]") && node.children.length > 0) {
      items.push(...itemsOf(Array.from(node.children)));
    } else {
      items.push(node);
    }
  }
  return items;
}

/**
 * True only while `customElements.define` upgrades the hosts already in the
 * document. A host the parser creates after that connects on its opening tag,
 * before any of its content exists.
 */
let upgrading = false;

/**
 * Whether the parser has closed `element`: the node it is appending to is the
 * deepest last element of the document, so an element that contains it is
 * still open.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function isParsed(element) {
  return !outermostHost(element).contains(deepestLast());
}

/**
 * A host inside a wrapper waits with it: the wrapper's cascade must be set up
 * first, exactly as it was when everything started together.
 *
 * @param {Element} element
 * @returns {Element}
 */
function outermostHost(element) {
  let outermost = element;
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.localName === 'motion-effect') outermost = node;
  }
  return outermost;
}

/** The node the parser is appending to. @returns {Element} */
function deepestLast() {
  let last = document.documentElement;
  while (last.lastElementChild) last = last.lastElementChild;
  return last;
}

/**
 * Hosts the parser has not closed yet, in document order, each with the
 * function that starts it.
 *
 * @type {{ host: Element, start: () => void }[]}
 */
const parseQueue = [];

/** @type {number} */
let parseFrame = 0;

/**
 * Start every queued host the parser has closed, in document order. The queue
 * is in document order and the parser closes elements in that order, so the
 * first host still open ends the run.
 *
 * @param {boolean} [all] Start everything (the document is complete).
 */
function flushParsed(all = false) {
  const last = all ? null : deepestLast();
  while (parseQueue.length > 0) {
    const { host, start } = parseQueue[0];
    if (last && host.isConnected && outermostHost(host).contains(last)) break;
    parseQueue.shift();
    start();
  }
}

/**
 * Checked once a frame while the document loads, so a section starts on the
 * frame its markup is complete; whatever is left starts at DOMContentLoaded.
 */
function pollParsed() {
  parseFrame = 0;
  flushParsed();
  if (parseQueue.length > 0 && document.readyState === 'loading') {
    parseFrame = requestAnimationFrame(pollParsed);
  }
}

/**
 * @param {Element} host
 * @param {() => void} start
 */
function waitForParse(host, start) {
  parseQueue.push({ host, start });
  if (!parseFrame) parseFrame = requestAnimationFrame(pollParsed);
}

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      if (parseFrame) cancelAnimationFrame(parseFrame);
      parseFrame = 0;
      flushParsed(true);
    },
    { once: true }
  );
}

upgrading = true;
try {
  defineComponent('motion-effect', MotionEffect);
} finally {
  upgrading = false;
}

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

  #stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #invalidate = () => {
    this.#geometry = null;
  };

  #measure() {
    const rect = this.getBoundingClientRect();
    this.#geometry = {
      centre: rect.top + rect.height / 2 + window.scrollY - this.#offset,
      height: rect.height
    };
  }

  #tick = (scrollY = window.scrollY) => {
    if (!this.#geometry) this.#measure();
    const { centre, height } = /** @type {{ centre: number, height: number }} */ (this.#geometry);

    const viewport = window.innerHeight;
    const strength = this.speed * height;

    const distance = centre - scrollY - viewport / 2;
    const offset = (-distance * strength) / (viewport + strength);

    this.#offset = offset;
    this.style.setProperty('--parallax-offset', `${offset.toFixed(2)}px`);
  };
}

defineComponent('parallax-media', ParallaxMedia);

export default { MotionEffect, ParallaxMedia };
