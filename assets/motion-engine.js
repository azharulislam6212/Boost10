/**
 * The theme's animation runtime, built entirely on the Web Animations API and
 * IntersectionObserver. No timeline library, no scroll library, no keyframe CSS
 * duplicated across section files.
 *
 * @module @theme/motion-engine
 */

import { clamp, prefersReducedMotion, isTouchDevice, isRTL } from '@theme/utilities';

/* ==========================================================================
   Timings
   ========================================================================== */

/** Easing curves, matched to the CSS custom properties in base.css. */
export const EASING = {
  outExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  outQuart: 'cubic-bezier(0.25, 1, 0.5, 1)',
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  outBack: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  inOutQuart: 'cubic-bezier(0.76, 0, 0.24, 1)',
  linear: 'linear'
};

const DEFAULTS = {
  duration: 600,
  delay: 0,
  stagger: 55,
  distance: 28,
  threshold: 0.08,
  rootMargin: '0px 0px -5% 0px',
  /** Cascade applied to elements already on screen when the page loads. */
  loadStagger: 60,
  /** How long after navigation an intersection still counts as "on load". */
  loadWindow: 1200
};

/**
 * Applied to preset durations and staggers, never to a value a merchant set.
 * Presets were tuned long; content that takes most of a second to arrive is
 * what makes a page feel slow to scroll through.
 */
const PRESET_PACE = 0.8;

/**
 * Longest a split preset may take to cascade across its pieces, in
 * milliseconds. A heading lands well inside it; a long paragraph split into
 * letters compresses its stagger instead of trickling in for seconds.
 */
const MAX_SPLIT_SPREAD = 1200;

/**
 * Longest a cascade of whole items (cards, columns, slides) may take to start
 * its last one, in milliseconds. A long list tightens instead of trickling.
 */
const MAX_ITEM_SPREAD = 1800;

/* ==========================================================================
   Preset registry
   ========================================================================== */

/**
 * @typedef {Object} MotionPreset
 * @property {(options: Object) => Keyframe[]} keyframes Two or more keyframes, first is the resting state.
 * @property {'words'|'chars'} [split] Split the text and animate the parts instead of the element.
 * @property {boolean} [random] Shuffle the stagger order. Only meaningful with `split`.
 * @property {number} [duration] Preset-specific default, in milliseconds.
 * @property {number} [stagger] Preset-specific default, in milliseconds.
 * @property {string} [easing]
 * @property {number} [maxSpread] Cap on the whole split cascade, in milliseconds. Defaults to MAX_SPLIT_SPREAD.
 * @property {string} [group] `text`, `image`, `element` or `both`. Used by the editor to sort options.
 */

/**
 * Every named animation in the theme.
 *
 * @type {Record<string, MotionPreset>}
 */
export const PRESETS = {
  /* ---------------------------------------------------------- universal -- ---- */

  fade: {
    group: 'both',
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
  },

  'fade-in': {
    group: 'both',
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
  },

  /**
   * The theme default. Each element rises 30% of its own height while it fades
   * in — 500ms, a long soft ease-out, 75ms between neighbours — so a heading,
   * its subheading and its text arrive one after another in a single smooth
   * wave. Durations here are scaled by PRESET_PACE (0.8), hence 625 and 94.
   */
  rise: {
    group: 'both',
    duration: 625,
    stagger: 94,
    easing: 'cubic-bezier(0, 0, 0.3, 1)',
    keyframes: () => [
      { opacity: 0, transform: 'translate3d(0, 30%, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  /**
   * What a letter or word preset becomes on gradient text, which cannot be
   * split: the heading rises whole while a soft edge uncovers it left to right.
   */
  'gradient-rise': {
    group: 'text',
    duration: 1100,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    keyframes: ({ distance = 24, rtl = false }) => [
      {
        opacity: 0,
        transform: `translate3d(0, ${distance}px, 0)`,
        clipPath: rtl ? 'inset(-20% -10% -20% 100%)' : 'inset(-20% 100% -20% -10%)'
      },
      { opacity: 1, transform: 'translate3d(0, 0, 0)', clipPath: 'inset(-20% -10% -20% -10%)' }
    ]
  },

  /**
   * Content blocks — card rows, product lists, panels — lifting into place on
   * one long, soft ease. A fixed distance rather than a percentage, so a tall
   * grid travels as far as a single card.
   */
  'smooth-rise': {
    group: 'element',
    duration: 1100,
    stagger: 250,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    keyframes: ({ distance = 56 }) => [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'fade-up': {
    group: 'both',
    keyframes: ({ distance = DEFAULTS.distance }) => [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'slide-up': {
    group: 'both',
    keyframes: ({ distance = DEFAULTS.distance }) => [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'slide-down': {
    group: 'both',
    keyframes: ({ distance = DEFAULTS.distance }) => [
      { opacity: 0, transform: `translate3d(0, -${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'slide-left': {
    group: 'image',
    keyframes: ({ distance = 48, rtl = false }) => [
      { opacity: 0, transform: `translate3d(${rtl ? -distance : distance}px, 0, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'slide-right': {
    group: 'image',
    keyframes: ({ distance = 48, rtl = false }) => [
      { opacity: 0, transform: `translate3d(${rtl ? distance : -distance}px, 0, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  /**
   * Grows from a tenth of its size — for small pictures set into a line of
   * text, which a fade or a short rise would barely show.
   */
  'grow-in': {
    group: 'image',
    duration: 900,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    keyframes: () => [
      { opacity: 0, transform: 'scale(0.1)' },
      { opacity: 1, transform: 'scale(1)' }
    ]
  },

  scale: {
    group: 'both',
    keyframes: ({ from = 0.92 }) => [
      { opacity: 0, transform: `scale(${from})` },
      { opacity: 1, transform: 'scale(1)' }
    ]
  },

  blur: {
    group: 'both',
    duration: 800,
    keyframes: () => [
      { opacity: 0, filter: 'blur(14px)' },
      { opacity: 1, filter: 'blur(0px)' }
    ]
  },

  /* ------------------------------------------------------------ element -- ---- */
  /* Whole-element entrances for subheadings and buttons, each a distinct move. */

  'pop-in': {
    group: 'element',
    duration: 600,
    easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    keyframes: () => [
      { opacity: 0, transform: 'scale(0.6)' },
      { opacity: 1, transform: 'scale(1)' }
    ]
  },

  'bounce-in': {
    group: 'element',
    duration: 900,
    easing: 'ease-out',
    keyframes: () => [
      { opacity: 0, transform: 'translate3d(0, 40px, 0)' },
      { opacity: 1, transform: 'translate3d(0, -8px, 0)', offset: 0.55 },
      { opacity: 1, transform: 'translate3d(0, 3px, 0)', offset: 0.8 },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'flip-up': {
    group: 'element',
    duration: 800,
    easing: EASING.outQuint,
    keyframes: () => [
      { opacity: 0, transform: 'perspective(600px) rotateX(-75deg)', transformOrigin: '50% 100%' },
      { opacity: 1, transform: 'perspective(600px) rotateX(0deg)', transformOrigin: '50% 100%' }
    ]
  },

  'swing-in': {
    group: 'element',
    duration: 850,
    easing: EASING.outBack,
    keyframes: ({ rtl = false }) => [
      {
        opacity: 0,
        transform: `perspective(600px) rotateY(${rtl ? 70 : -70}deg)`,
        transformOrigin: rtl ? '100% 50%' : '0% 50%'
      },
      { opacity: 1, transform: 'perspective(600px) rotateY(0deg)', transformOrigin: rtl ? '100% 50%' : '0% 50%' }
    ]
  },

  'rotate-in': {
    group: 'element',
    duration: 750,
    easing: EASING.outQuint,
    keyframes: ({ rtl = false }) => [
      { opacity: 0, transform: `translate3d(0, 24px, 0) rotate(${rtl ? 8 : -8}deg)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0) rotate(0deg)' }
    ]
  },

  'skew-up': {
    group: 'element',
    duration: 750,
    easing: EASING.outQuint,
    keyframes: () => [
      { opacity: 0, transform: 'translate3d(0, 32px, 0) skewY(7deg)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0) skewY(0deg)' }
    ]
  },

  /* -------------------------------------------------------------- image -- ---- */

  'zoom-in': {
    group: 'image',
    duration: 900,
    keyframes: ({ from = 1.12 }) => [
      { opacity: 0, transform: `scale(${from})` },
      { opacity: 1, transform: 'scale(1)' }
    ]
  },

  'zoom-out': {
    group: 'image',
    duration: 900,
    keyframes: ({ from = 0.88 }) => [
      { opacity: 0, transform: `scale(${from})` },
      { opacity: 1, transform: 'scale(1)' }
    ]
  },

  'reveal-right': {
    group: 'image',
    duration: 900,
    easing: EASING.inOutQuart,
    keyframes: ({ distance = 16 }) => [
      { clipPath: 'inset(0 100% 0 0)', transform: `translate3d(-${distance}px, 0, 0)`, opacity: 1 },
      { clipPath: 'inset(0 0 0 0)', transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ]
  },

  'reveal-left': {
    group: 'image',
    duration: 900,
    easing: EASING.inOutQuart,
    keyframes: ({ distance = 16 }) => [
      { clipPath: 'inset(0 0 0 100%)', transform: `translate3d(${distance}px, 0, 0)`, opacity: 1 },
      { clipPath: 'inset(0 0 0 0)', transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ]
  },

  'reveal-up': {
    group: 'image',
    duration: 900,
    easing: EASING.inOutQuart,
    keyframes: ({ distance = 16 }) => [
      { clipPath: 'inset(100% 0 0 0)', transform: `translate3d(0, ${distance}px, 0)`, opacity: 1 },
      { clipPath: 'inset(0 0 0 0)', transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ]
  },

  'reveal-down': {
    group: 'image',
    duration: 900,
    easing: EASING.inOutQuart,
    keyframes: ({ distance = 16 }) => [
      { clipPath: 'inset(0 0 100% 0)', transform: `translate3d(0, -${distance}px, 0)`, opacity: 1 },
      { clipPath: 'inset(0 0 0 0)', transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ]
  },

  /* --------------------------------------------------------------- text -- ---- */

  'split-text': {
    group: 'text',
    split: 'chars',
    duration: 620,
    stagger: 22,
    keyframes: ({ distance = 22 }) => [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'words-slide-up': {
    group: 'text',
    split: 'words',
    duration: 680,
    stagger: 60,
    keyframes: ({ distance = 26 }) => [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'words-rotate-in': {
    group: 'text',
    split: 'words',
    duration: 800,
    stagger: 70,
    easing: EASING.outBack,
    keyframes: () => [
      { opacity: 0, transform: 'perspective(600px) rotateX(-82deg)', transformOrigin: '50% 100%' },
      { opacity: 1, transform: 'perspective(600px) rotateX(0deg)', transformOrigin: '50% 100%' }
    ]
  },

  'words-slide-from-right': {
    group: 'text',
    split: 'words',
    duration: 700,
    stagger: 55,
    keyframes: ({ distance = 40, rtl = false }) => [
      { opacity: 0, transform: `translate3d(${rtl ? -distance : distance}px, 0, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'letters-slide-up': {
    group: 'text',
    split: 'chars',
    duration: 620,
    stagger: 22,
    keyframes: ({ distance = 24 }) => [
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'letters-slide-down': {
    group: 'text',
    split: 'chars',
    duration: 620,
    stagger: 22,
    keyframes: ({ distance = 24 }) => [
      { opacity: 0, transform: `translate3d(0, -${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ]
  },

  'letters-fade-in': {
    group: 'text',
    split: 'chars',
    duration: 560,
    stagger: 26,
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
  },

  'letters-fade-in-random': {
    group: 'text',
    split: 'chars',
    random: true,
    duration: 560,
    stagger: 26,
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
  },

  typewriter: {
    group: 'text',
    split: 'chars',
    duration: 1,
    stagger: 45,
    maxSpread: 3000,
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
  }
};

/** Older names kept working so existing section settings do not break. */
const ALIASES = {
  zoom: 'zoom-in',
  'slide-in': 'slide-right',
  text: 'fade-up',
  'fede-up': 'fade-up',
  'fede-in': 'fade-in'
};

/**
 * Resolve a preset by name, following aliases.
 *
 * @param {string} name
 * @returns {MotionPreset|null}
 */
export function getPreset(name) {
  if (!name) return null;
  const resolved = ALIASES[name] || name;
  return PRESETS[resolved] || null;
}

/**
 * @param {'text'|'image'|'both'} [group]
 * @returns {string[]} Preset names in the requested group.
 */
export function presetNames(group) {
  return Object.entries(PRESETS)
    .filter(([, preset]) => !group || preset.group === group || preset.group === 'both')
    .map(([name]) => name);
}

/* ==========================================================================
   Capability
   ========================================================================== */

/**
 * @returns {boolean} True when animations should actually run.
 */
export function motionEnabled() {
  return !prefersReducedMotion() && typeof Element.prototype.animate === 'function';
}

/** Navigation timestamp, used to decide whether an intersection is "on load". */
const bootedAt = performance.now();

/** How many elements have already animated inside the load window. */
let loadIndex = 0;

/**
 * @returns {boolean} True while the page is still in its initial paint window.
 * @private
 */
function withinLoadWindow() {
  return performance.now() - bootedAt < DEFAULTS.loadWindow;
}

/* ==========================================================================
   Observer pool
   ========================================================================== */

/**
 * One IntersectionObserver per unique configuration, shared by every caller.
 * A page can hold a hundred revealed elements; a hundred observers cost far
 * more than routing them all through a handful.
 *
 * @type {Map<string, { observer: IntersectionObserver, callbacks: WeakMap<Element, Function> }>}
 */
const observerPool = new Map();

/**
 * Observe an element until it enters the viewport.
 *
 * @param {Element} element
 * @param {(entry: IntersectionObserverEntry) => void} callback
 * @param {Object} [options]
 * @param {number} [options.threshold]
 * @param {string} [options.rootMargin]
 * @param {boolean} [options.once=true]
 * @returns {() => void} Stop observing.
 */
export function observe(element, callback, options = {}) {
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const rootMargin = options.rootMargin ?? DEFAULTS.rootMargin;
  const once = options.once !== false;

  if (!('IntersectionObserver' in window)) {
    callback({ target: element, isIntersecting: true, intersectionRatio: 1 });
    return () => {};
  }

  const key = `${rootMargin}|${threshold}|${once}`;
  let entry = observerPool.get(key);

  if (!entry) {
    /** @type {WeakMap<Element, Set<Function>>} */
    const callbacks = new WeakMap();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const item of entries) {
          if (!item.isIntersecting) continue;
          const handlers = callbacks.get(item.target);
          if (!handlers) continue;
          if (once) {
            observer.unobserve(item.target);
            callbacks.delete(item.target);
          }
          for (const handler of [...handlers]) handler(item);
        }
      },
      { threshold, rootMargin }
    );

    entry = { observer, callbacks };
    observerPool.set(key, entry);
  }

  let done = false;
  const fire = (item) => {
    if (done) return;
    done = true;
    releaseFloor();
    callback(item);
  };

  // Several reveals can watch one element — a wrapper's item that also runs
  // its own entrance — so each keeps its own handler.
  const { observer, callbacks } = entry;
  let handlers = callbacks.get(element);
  if (!handlers) callbacks.set(element, (handlers = new Set()));
  handlers.add(fire);
  // Observing afresh is what delivers an initial entry for the new handler;
  // every handler ignores a second one.
  observer.unobserve(element);
  observer.observe(element);

  const releaseFloor = watchScrollFloor(element, () =>
    fire({ target: element, isIntersecting: true, intersectionRatio: 1 })
  );

  return () => {
    done = true;
    releaseFloor();
    const current = callbacks.get(element);
    if (!current) return;
    current.delete(fire);
    if (current.size === 0) {
      callbacks.delete(element);
      observer.unobserve(element);
    }
  };
}

/* ==========================================================================
   The scroll floor
   --------------------------------------------------------------------------
   `rootMargin: '0px 0px -8% 0px'` is what stops content animating the instant
   a single pixel of it clears the fold: an element has to be properly on screen
   before it plays. It also carves 8% off the bottom of the viewport, and for
   anything inside the last 8% of the *document* that region is unreachable —
   the page runs out of scroll before the element ever enters the shrunken root.
   Those elements stay in their resting state, which for a reveal preset means
   `opacity: 0`, for the life of the page.
   ========================================================================== */

/** @type {Set<{ element: Element, fire: () => void }>} */
const waitingOnFloor = new Set();

/** @type {(() => void)|null} */
let floorListener = null;

/**
 * Document height, kept current by a ResizeObserver so the scroll check never
 * reads `scrollHeight` — a forced layout — mid-frame.
 *
 * @type {number}
 */
let documentHeight = 0;

/** @type {ResizeObserver|null} */
let documentHeightObserver = null;

function checkScrollFloor() {
  const atEnd = window.innerHeight + window.scrollY >= documentHeight - 2;
  if (!atEnd) return;

  for (const item of [...waitingOnFloor]) {
    const rect = item.element.getBoundingClientRect();
    const onScreen = rect.top < window.innerHeight && rect.bottom > 0 && rect.height > 0;
    if (!onScreen) continue;

    waitingOnFloor.delete(item);
    item.fire();
  }

  if (waitingOnFloor.size === 0) stopFloorListener();
}

function startFloorListener() {
  if (floorListener) return;

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      checkScrollFloor();
    });
  };

  documentHeight = document.documentElement.scrollHeight;
  documentHeightObserver = new ResizeObserver(() => {
    documentHeight = document.documentElement.scrollHeight;
    onScroll();
  });
  documentHeightObserver.observe(document.body ?? document.documentElement);

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  floorListener = () => {
    documentHeightObserver?.disconnect();
    documentHeightObserver = null;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };

  onScroll();
}

function stopFloorListener() {
  floorListener?.();
  floorListener = null;
}

/**
 * Wait for the document to run out of scroll, as a backstop for an element the
 * inset root can never reach.
 *
 * @param {Element} element
 * @param {() => void} fire
 * @returns {() => void} Stop waiting.
 */
function watchScrollFloor(element, fire) {
  const item = { element, fire };
  waitingOnFloor.add(item);
  startFloorListener();

  return () => {
    waitingOnFloor.delete(item);
    if (waitingOnFloor.size === 0) stopFloorListener();
  };
}

/* ==========================================================================
   Core animation
   ========================================================================== */

/**
 * Run a WAAPI animation, or apply the end state immediately under reduced motion.
 *
 * @param {Element} element
 * @param {Keyframe[]} keyframes
 * @param {KeyframeAnimationOptions} [options]
 * @returns {Animation|null}
 */
export function animate(element, keyframes, options = {}) {
  if (!motionEnabled()) {
    applyState(element, keyframes[keyframes.length - 1]);
    return null;
  }

  return element.animate(keyframes, {
    duration: DEFAULTS.duration,
    easing: EASING.outExpo,
    fill: 'both',
    ...options
  });
}

/**
 * Write a keyframe onto an element as inline style.
 *
 * @param {Element} element
 * @param {Keyframe} frame
 */
export function applyState(element, frame) {
  if (!frame) return;

  for (const [property, value] of Object.entries(frame)) {
    if (property === 'offset' || property === 'easing' || property === 'composite') continue;
    element.style.setProperty(camelToKebab(property), property === 'transform' ? flatten(String(value)) : String(value));
  }
}

/**
 * `translate3d(x, y, 0)` as the 2D `translate(x, y)` it draws the same as. A
 * resting state sits on every split letter on the page, and each 3D transform
 * is its own compositing layer: thousands of idle layers made every frame of
 * the load slow enough that the entrances on screen jumped. The animation
 * still runs on the compositor; only the waiting is flat.
 *
 * @param {string} transform
 * @returns {string}
 * @private
 */
function flatten(transform) {
  return transform.replace(/translate3d\(\s*([^,]+),\s*([^,]+),\s*0(?:px)?\s*\)/g, 'translate($1, $2)');
}

/**
 * Remove the inline properties a keyframe set, letting the stylesheet take over
 * again once the animation has finished.
 *
 * @param {Element} element
 * @param {Keyframe} frame
 */
export function clearState(element, frame) {
  if (!frame) return;

  for (const property of Object.keys(frame)) {
    if (property === 'offset' || property === 'easing' || property === 'composite') continue;
    element.style.removeProperty(camelToKebab(property));
  }
}

/**
 * @param {string} value
 * @returns {string}
 * @private
 */
function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/* ==========================================================================
   Reveal
   ========================================================================== */

/**
 * Play a preset when an element is on screen — immediately if it already is,
 * on scroll if it is not.
 *
 * @param {HTMLElement} element The element that triggers the reveal.
 * @param {Object} [options]
 * @param {string} [options.effect='fade-up'] A key of {@link PRESETS}, or an alias.
 * @param {HTMLElement[]} [options.targets] Animate these instead of the element itself.
 * @param {number} [options.duration]
 * @param {number} [options.delay]
 * @param {number} [options.stagger]
 * @param {number} [options.distance]
 * @param {string} [options.easing]
 * @param {number} [options.threshold]
 * @param {string} [options.rootMargin]
 * @param {boolean} [options.once=true]
 * @param {boolean} [options.loadCascade=true] Stagger elements already visible at load.
 * @param {() => void} [options.onReveal]
 * @returns {() => void} Cancel a pending reveal and restore the element.
 */
export function reveal(element, options = {}) {
  const requested = options.effect || 'fade-up';
  // Gradient text cannot be split: each moving letter is its own GPU layer,
  // and `background-clip: text` on such a layer paints the gradient — or the
  // letters themselves — in the wrong place until the cascade ends. It moves
  // whole instead, revealed left to right so it still reads as a cascade.
  const effect =
    getPreset(requested)?.split && !options.targets?.length && hasClippedText(element) ? 'gradient-rise' : requested;
  const preset = getPreset(effect);

  if (!preset) {
    console.warn(`[Boost10] No motion preset named "${effect}".`);
    markRevealed(element, options.targets || []);
    return () => {};
  }

  let targets = options.targets?.length ? options.targets : [];

  if (preset.split && targets.length === 0) {
    targets = splitText(element, { by: preset.split });
  }

  if (targets.length === 0) targets = [element];

  if (!motionEnabled()) {
    markRevealed(element, targets);
    return () => {};
  }

  const keyframes = preset.keyframes({
    distance: options.distance,
    rtl: isRTL()
  });

  const restingState = keyframes[0];

  /** This reveal, as the owner of the waits it registers. */
  const owner = {};

  const isSectionHeader = element.matches(HEADER_SELECTOR);
  if (isSectionHeader) headersPending.add(element);
  /** The section header this reveal queues behind, once it has been looked up. @type {Element|null|undefined} */
  let gate;

  // An item that brings its own entrance — a subheading's fade-up, a heading's
  // letters — plays exactly that, at its turn in this cascade. Moving it here
  // as well stacked two animations on one element and buried its own.
  const own = new Set(targets.filter((target) => target !== element && ownsEntrance(target)));

  for (const target of targets) if (!own.has(target)) applyState(target, restingState);
  element.setAttribute('data-motion-pending', '');

  const order = preset.random ? shuffledIndices(targets.length) : null;
  const duration = options.duration ?? (preset.duration ? preset.duration * PRESET_PACE : DEFAULTS.duration);
  const easing = options.easing ?? preset.easing ?? EASING.outExpo;
  const baseStagger =
    options.stagger ?? (preset.stagger ? preset.stagger * PRESET_PACE : targets.length > 1 ? DEFAULTS.stagger : 0);
  const spread = preset.split ? preset.maxSpread ?? MAX_SPLIT_SPREAD : MAX_ITEM_SPREAD;

  // What is watched, and what each sighting plays. A list of whole items —
  // cards, columns, a header and its content — is watched item by item, so a
  // tall section's lower rows wait for the visitor instead of playing unseen
  // the moment its top edge appears. Split text and a single element play as
  // one piece when the element itself comes into view.
  // A clip-path resting state is watched through its parent, as it always was.
  const clips = typeof restingState.clipPath === 'string';
  /** @type {{ observed: Element, members: HTMLElement[], done: boolean }[]} */
  const units =
    !preset.split && targets.length > 1
      ? targets.map((target) => ({
          observed: clips ? target.parentElement ?? target : target,
          members: [target],
          done: false
        }))
      : [
          {
            observed: clips && targets.includes(element) ? element.parentElement ?? element : element,
            members: targets,
            done: false
          }
        ];

  /** @type {Set<HTMLElement>} */
  const queued = new Set();
  let queuedFromLoad = false;
  let wrapperReady = false;
  let waitingOnWrapper = false;
  let flushScheduled = false;
  let started = false;
  /** Earliest time, on the performance clock, the next whole item may start. */
  let nextSlot = 0;
  let cancelWait = () => {};
  /** @type {Map<object, () => void>} */
  const stopObserving = new Map();

  const play = (list, fromLoad) => {
    const stagger = list.length > 1 ? Math.min(baseStagger, spread / (list.length - 1)) : baseStagger;
    // Inside a wrapper that is itself animating, follow it instead of the
    // page-load cascade, which the wrapper has already taken its place in.
    const lead = ancestorLead(element);
    const now = performance.now();
    // Content after its section's header waits for the header's own items to
    // start first — subheading, heading, text — whichever reveal reaches it.
    const ready = gate ? headerReady.get(gate) : undefined;
    const gateWait = ready === undefined ? 0 : Math.max(0, ready - now);
    const cascade = fromLoad && lead === null && ready === undefined ? loadCascadeDelay(options) : 0;
    const baseDelay = Math.max(lead ?? 0, gateWait) + (options.delay ?? DEFAULTS.delay) + cascade;
    let firstStart = now + baseDelay;

    list.forEach((target, position) => {
      let delay;
      if (preset.split) {
        delay = baseDelay + (order ? order[targets.indexOf(target)] : position) * stagger;
      } else {
        // Whole items queue up across sightings: one that scrolls into view a
        // moment after the heading still takes its turn behind it, instead of
        // opening a cascade of its own and landing first.
        const start = Math.max(now + baseDelay, nextSlot);
        delay = start - now;
        if (position === 0) firstStart = start;
        nextSlot = start + stagger + headerHold(target);
      }

      // A zero duration hands an item that animates itself its slot exactly,
      // with no lead into an entrance this cascade does not play.
      const owned = own.has(target);
      targetTiming.set(target, { start: now + delay, duration: owned ? 0 : duration });

      const animation = owned ? null : animate(target, keyframes, { duration, delay, easing });

      animation?.finished
        .then(() => {
          // The end frame is the element's own style, so there is nothing to
          // commit: `commitStyles()` recalculated style once per split letter,
          // a third of a second of main thread that held back the next entrance.
          animation.cancel();
          clearState(target, restingState);
        })
        .catch(() => {});

      target.style.setProperty('--motion-delay', `${Math.round(delay)}ms`);
      target.setAttribute('data-motion-played', '');
      if (!target.hasAttribute('data-motion-armed')) target.setAttribute('data-motion-revealed', '');
      clearWaiting(target, owner);
      target.dispatchEvent(new Event(PLAY_EVENT));
    });

    if (!started) {
      started = true;
      options.onReveal?.();
      if (!targets.includes(element)) element.dispatchEvent(new Event(PLAY_EVENT));
      if (isSectionHeader) {
        headerReady.set(element, firstStart + headerHold(element));
        element.dispatchEvent(new Event(HEADER_EVENT));
      }
    }

    if (units.every((unit) => unit.done)) markRevealed(element, targets);
  };

  const flush = () => {
    flushScheduled = false;
    if (queued.size === 0) return;
    const list = targets.filter((target) => queued.has(target));
    const fromLoad = queuedFromLoad;
    queued.clear();
    queuedFromLoad = false;
    play(list, fromLoad);
  };

  // Next frame rather than a microtask: observers with different settings
  // report in separate callbacks, and an item one of them starts early (a
  // nested reveal forcing its wrapper) must still join the same cascade, or
  // the content plays ahead of its heading.
  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flush);
  };

  /** @param {{ observed: Element, members: HTMLElement[], done: boolean }} unit */
  const trigger = (unit) => {
    if (unit.done) return;
    unit.done = true;
    stopObserving.get(unit)?.();
    stopObserving.delete(unit);
    for (const member of unit.members) queued.add(member);
    queuedFromLoad ||= withinLoadWindow();

    if (wrapperReady) {
      scheduleFlush();
    } else if (!waitingOnWrapper) {
      waitingOnWrapper = true;
      cancelWait = afterWrapperPlays(element, owner, () => {
        gate = sectionGate(element);
        cancelWait = afterHeaderPlays(gate, () => {
          wrapperReady = true;
          scheduleFlush();
        });
      });
    }
  };

  /** @param {{ observed: Element, members: HTMLElement[], done: boolean }} unit */
  const sighted = (unit) => {
    trigger(unit);
    if (units.length === 1) return;
    // Everything level with or above what just appeared goes with it: slides a
    // carousel clips sideways, items the scroll jumped past, anything without
    // a box of its own. Only the rows still below the fold keep waiting.
    for (const other of units) {
      if (!other.done && other.observed.getBoundingClientRect().top < window.innerHeight) trigger(other);
    }
  };

  for (const unit of units) {
    for (const member of unit.members) markWaiting(member, owner, () => trigger(unit));
    stopObserving.set(
      unit,
      observe(unit.observed, () => sighted(unit), {
        threshold: options.threshold,
        rootMargin: options.rootMargin,
        once: options.once
      })
    );
  }

  return () => {
    for (const stop of stopObserving.values()) stop();
    stopObserving.clear();
    cancelWait();
    if (isSectionHeader) headersPending.delete(element);
    for (const target of targets) {
      if (!own.has(target)) clearState(target, restingState);
      clearWaiting(target, owner);
    }
    markRevealed(element, targets);
  };
}

/**
 * Animated items whose entrance is not scheduled yet, by the reveal holding
 * them. Each entry starts that entrance now — for an animation nested inside
 * the item that is already on screen and must not play while it is invisible.
 * One element can wait on two reveals: its own, and a wrapper's cascade.
 *
 * @type {WeakMap<Element, Map<object, () => void>>}
 */
const waiting = new WeakMap();

/**
 * @param {Element} target
 * @param {object} owner
 * @param {() => void} start
 * @private
 */
function markWaiting(target, owner, start) {
  let owners = waiting.get(target);
  if (!owners) waiting.set(target, (owners = new Map()));
  owners.set(owner, start);
}

/**
 * @param {Element} target
 * @param {object} owner
 * @private
 */
function clearWaiting(target, owner) {
  const owners = waiting.get(target);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size === 0) waiting.delete(target);
}

/**
 * @param {Element} node
 * @param {object} owner
 * @returns {boolean} True while a reveal other than `owner` still holds `node`.
 * @private
 */
function heldByOthers(node, owner) {
  const owners = waiting.get(node);
  if (!owners) return false;
  for (const key of owners.keys()) if (key !== owner) return true;
  return false;
}

/**
 * Whether `target` is a `<motion-effect>` that plays its own entrance on its
 * own box or text, rather than cascading things inside it (a wrapper, which a
 * cascade around it still moves as one piece).
 *
 * @param {Element} target
 * @returns {boolean}
 * @private
 */
function ownsEntrance(target) {
  if (target.localName !== 'motion-effect' || !(target instanceof HTMLElement)) return false;
  const { effect = 'fade-up', target: selector, children } = target.dataset;
  if (effect === '' || effect === 'none' || effect === 'parallax' || effect === 'marquee') return false;
  if (selector || (children !== undefined && children !== 'false')) return false;
  return Boolean(getPreset(effect));
}

/** A section's heading cluster. */
const HEADER_SELECTOR = '.block-section-header';

/** Settle time, in milliseconds, after a heading cluster's last item starts. */
const HEADER_HOLD = 150;

/** Longest a heading cluster's own cascade may hold back what follows it. */
const HEADER_HOLD_MAX = 400;

/**
 * Extra wait for whatever follows `target` in a cascade when it holds a
 * heading cluster: long enough for the cluster's own items — subheading,
 * heading, text — to start one by one first, so tabs or cards land after the
 * heading instead of beside it.
 *
 * @param {Element} target
 * @returns {number}
 * @private
 */
function headerHold(target) {
  const header = target.matches(HEADER_SELECTOR) ? target : target.querySelector(HEADER_SELECTOR);
  if (!(header instanceof HTMLElement)) return 0;
  const stagger = Number(header.dataset.stagger) || 0;
  const count = header.querySelector('[data-motion-items]')?.childElementCount ?? 1;
  return Math.min(Math.max(0, count - 1) * stagger, HEADER_HOLD_MAX) + HEADER_HOLD;
}

/** Fired on a section header the moment its own items are scheduled. */
const HEADER_EVENT = 'motion:header';

/** Section headers whose own entrance is set up but has not played. */
const headersPending = new WeakSet();

/**
 * When each section header's items have all started, on the performance
 * clock: whatever follows the header in its section starts no earlier.
 *
 * @type {WeakMap<Element, number>}
 */
const headerReady = new WeakMap();

/**
 * The section header `element` has to follow: the first one in its section,
 * when it comes before `element` and is still on screen or below. A reveal
 * that is, holds or sits inside a header is ordered by its own cascade.
 *
 * @param {Element} element
 * @returns {Element|null}
 * @private
 */
function sectionGate(element) {
  if (element.closest(HEADER_SELECTOR) || element.querySelector(HEADER_SELECTOR)) return null;
  const header = element.closest('.shopify-section')?.querySelector(HEADER_SELECTOR);
  if (!header || !(header.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
  if (headerReady.has(header)) return header;
  if (!headersPending.has(header)) return null;
  // A header the visitor has already scrolled past has nothing left to lead.
  return header.getBoundingClientRect().bottom > 0 ? header : null;
}

/**
 * Run `callback` once `header` has scheduled its own items, starting it now
 * if it is still waiting for its turn. Immediately when there is no header
 * or it has already played.
 *
 * @param {Element|null} header
 * @param {() => void} callback
 * @returns {() => void} Stop waiting.
 * @private
 */
function afterHeaderPlays(header, callback) {
  if (!header || headerReady.has(header) || !headersPending.has(header)) {
    callback();
    return () => {};
  }

  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    header.removeEventListener(HEADER_EVENT, run);
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(run, NESTED_WAIT);
  header.addEventListener(HEADER_EVENT, run);

  // Content in view means its header is in view or just above it: start the
  // header's items, which starts whatever wraps the header in turn.
  const items = header.querySelector('[data-motion-items]')?.children ?? header.children;
  for (const node of [header, ...items]) {
    for (const start of [...(waiting.get(node)?.values() ?? [])]) start();
  }

  return () => {
    done = true;
    header.removeEventListener(HEADER_EVENT, run);
    clearTimeout(timer);
  };
}

/** Fired on a reveal's element the moment its animation is scheduled. */
export const PLAY_EVENT = 'motion:play';

/**
 * When each animated target starts moving and for how long, so an animation
 * nested inside it can follow on.
 *
 * @type {WeakMap<Element, { start: number, duration: number }>}
 */
const targetTiming = new WeakMap();

/**
 * How far into its wrapper's entrance a nested animation begins: just after
 * the wrapper starts to show, so the two read as one motion rather than the
 * inner one queueing behind the outer.
 */
const NESTED_LEAD = 0.1;

/** Longest a nested animation waits for a wrapper that never plays. */
const NESTED_WAIT = 2500;

/**
 * Milliseconds until a nested animation should start: partway into the
 * entrance of the closest animated element around it. Starting together meant
 * a button or heading played its whole entrance while its section was still
 * invisible and waiting its turn, so it never seemed to animate at all.
 *
 * @param {Element} element
 * @returns {number|null} Null when nothing around it animates.
 * @private
 */
function ancestorLead(element) {
  // The element itself first: a text block that is one item in its wrapper's
  // cascade follows its own turn, not the wrapper's first item.
  for (let node = element; node; node = node.parentElement) {
    const timing = targetTiming.get(node);
    if (timing) return Math.max(0, timing.start + timing.duration * NESTED_LEAD - performance.now());
  }
  return null;
}

/**
 * Run `callback` once the animated item around `element` has scheduled its
 * own entrance, so {@link ancestorLead} can see it. Immediately when there is
 * no such item waiting. An item still waiting for its own turn on screen is
 * started now: `element` being visible means it is too.
 *
 * @param {Element} element
 * @param {object} owner The reveal asking, whose own hold on `element` does not count.
 * @param {() => void} callback
 * @returns {() => void} Stop waiting.
 * @private
 */
function afterWrapperPlays(element, owner, callback) {
  /** @type {Element|null} */
  let wrapper = null;
  for (let node = element; node; node = node.parentElement) {
    if (heldByOthers(node, owner)) {
      wrapper = node;
      break;
    }
  }

  if (!wrapper) {
    callback();
    return () => {};
  }

  const held = wrapper;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    held.removeEventListener(PLAY_EVENT, onPlay);
    clearTimeout(timer);
    callback();
  };
  const onPlay = () => {
    if (!heldByOthers(held, owner)) run();
  };
  const timer = setTimeout(run, NESTED_WAIT);
  held.addEventListener(PLAY_EVENT, onPlay);

  for (const [key, start] of [...(waiting.get(held) ?? [])]) {
    if (key !== owner) start();
  }

  return () => {
    done = true;
    wrapper.removeEventListener(PLAY_EVENT, run);
    clearTimeout(timer);
  };
}

/**
 * Every class the stylesheets give `background-clip: text`. Keep in step with
 * base.css, header.css and footer.css.
 */
const CLIPPED_TEXT_SELECTOR = [
  '.block-text--gradient',
  '.text-gradient',
  '.custom-element--gradient',
  ".custom-element[style*='--font-custom-gradient']",
  '.tabs__rail--gradient',
  '.footer-legal__wordmark-text'
].join(', ');

/**
 * Whether `root` or anything in it paints its text through its background.
 * Matched by selector: reading computed styles here, between reveals that
 * have just written inline styles, recalculated the page's style once per
 * descendant and froze a reload for over a second.
 *
 * @param {Element} root
 * @returns {boolean}
 * @private
 */
function hasClippedText(root) {
  return root.matches(CLIPPED_TEXT_SELECTOR) || root.querySelector(CLIPPED_TEXT_SELECTOR) !== null;
}

/**
 * Cascade delay for elements already on screen when the page loads.
 *
 * @param {Object} options
 * @returns {number}
 * @private
 */
function loadCascadeDelay(options) {
  if (options.loadCascade === false) return 0;
  const step = options.loadStagger ?? DEFAULTS.loadStagger;
  const delay = loadIndex * step;
  loadIndex += 1;
  // A short cap: a reload that lands mid-page has a dozen hosts on screen,
  // and the last of them waiting half a second read as a blank section.
  return Math.min(delay, step * 3);
}

/**
 * @param {HTMLElement} element
 * @param {HTMLElement[]} targets
 * @private
 */
function markRevealed(element, targets) {
  element.removeAttribute('data-motion-pending');
  element.setAttribute('data-motion-revealed', '');
  // A carousel's slides carry their own reveal flag; leave it to the carousel.
  for (const target of targets) {
    if (!target.hasAttribute('data-motion-armed')) target.setAttribute('data-motion-revealed', '');
  }
}

/**
 * @param {number} length
 * @returns {number[]} 0…length-1 in random order.
 * @private
 */
function shuffledIndices(length) {
  const indices = Array.from({ length }, (_, index) => index);

  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  return indices;
}

/* ==========================================================================
   Split text
   ========================================================================== */

/**
 * Elements a split moves whole, in their place in the cascade: icons, stars and
 * images have no text to split, and a button's label must never come apart
 * (its hover copy is cloned from it). A `<motion-effect data-motion-inline>`
 * set into the text takes its turn the same way and plays its own entrance
 * when the letters reach it.
 */
const SPLIT_UNIT = '.button, button-swap, .block-icon-text, .icon-mark, svg, img, picture, video, [data-motion-inline]';

/** Subtrees whose text is never on screen. */
const SPLIT_SKIP = 'script, style, template, noscript';

/**
 * Text nodes and whole units under `root`, in document order.
 *
 * @param {Element} root
 * @param {(Text|HTMLElement)[]} [found]
 * @returns {(Text|HTMLElement)[]}
 * @private
 */
function splitItems(root, found = []) {
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue && node.nodeValue.trim()) found.push(/** @type {Text} */ (node));
    } else if (node instanceof Element) {
      if (node.matches(SPLIT_SKIP)) continue;
      if (node.matches(SPLIT_UNIT)) found.push(/** @type {HTMLElement} */ (node));
      else splitItems(node, found);
    }
  }
  return found;
}

/**
 * Split an element's text into animatable spans without destroying its markup.
 * Icons, images and buttons inside it join the cascade whole.
 *
 * @param {HTMLElement} element
 * @param {Object} [options]
 * @param {'chars'|'words'} [options.by='chars']
 * @returns {HTMLElement[]} The generated spans and whole units, in document order.
 */
export function splitText(element, { by = 'chars' } = {}) {
  if (element.hasAttribute('data-motion-split')) {
    return Array.from(element.querySelectorAll('[data-motion-part]'));
  }

  const items = splitItems(element);

  if (items.length === 0) return [];

  element.setAttribute('data-motion-split', by);

  const parts = [];

  for (const node of items) {
    if (node instanceof HTMLElement || node instanceof SVGElement) {
      node.setAttribute('data-motion-part', '');
      node.setAttribute('data-motion-unit', '');
      parts.push(/** @type {HTMLElement} */ (node));
      continue;
    }

    const original = node.nodeValue ?? '';
    const collapsed = original.replace(/\s+/g, ' ');

    const site = document.createElement('span');
    site.className = 'motion-split';
    site.setAttribute('data-motion-split-site', '');
    site.dataset.motionText = original;

    if (by !== 'words') {
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = collapsed;
      site.append(label);
    }

    if (/^\s/.test(collapsed)) site.append(document.createTextNode(' '));

    const words = collapsed.trim().split(' ');

    words.forEach((word, index) => {
      const wordSpan = document.createElement('span');
      wordSpan.className = 'motion-word';
      if (by !== 'words') wordSpan.setAttribute('aria-hidden', 'true');
      wordSpan.style.display = 'inline-block';
      wordSpan.style.whiteSpace = 'pre';

      if (by === 'words') {
        wordSpan.textContent = word;
        wordSpan.setAttribute('data-motion-part', '');
        parts.push(wordSpan);
      } else {
        for (const character of Array.from(word)) {
          const charSpan = document.createElement('span');
          charSpan.className = 'motion-char';
          charSpan.setAttribute('data-motion-part', '');
          charSpan.style.display = 'inline-block';
          charSpan.style.whiteSpace = 'pre';
          charSpan.textContent = character;
          wordSpan.appendChild(charSpan);
          parts.push(charSpan);
        }
      }

      site.append(wordSpan);

      if (index < words.length - 1) site.append(document.createTextNode(' '));
    });

    if (/\s$/.test(collapsed)) site.append(document.createTextNode(' '));

    node.replaceWith(site);
  }

  return parts;
}

/**
 * Undo {@link splitText}, restoring the original text node.
 *
 * @param {HTMLElement} element
 */
export function unsplitText(element) {
  if (!element.hasAttribute('data-motion-split')) return;

  element.removeAttribute('data-motion-split');

  for (const unit of element.querySelectorAll('[data-motion-unit]')) {
    unit.removeAttribute('data-motion-part');
    unit.removeAttribute('data-motion-unit');
  }

  for (const site of element.querySelectorAll('[data-motion-split-site]')) {
    site.replaceWith(document.createTextNode(site.dataset.motionText ?? ''));
  }

  element.normalize();
}

/* ==========================================================================
   Scroll ticker
   ========================================================================== */

/** @type {Set<(scrollY: number) => void>} */
const tickerSubscribers = new Set();

/** @type {number|null} */
let tickerFrame = null;

/** @type {number} */
let lastTickY = -1;

/** @type {(() => void)|null} */
let tickerListener = null;

/**
 * Subscribe to a shared frame callback driven by scroll position. Frames run
 * only while the page is scrolling or resizing, never while it sits still.
 *
 * @param {(scrollY: number) => void} callback
 * @returns {() => void} Unsubscribe.
 */
export function subscribeToTicker(callback) {
  tickerSubscribers.add(callback);
  startTicker();
  requestTick(true);

  return () => {
    tickerSubscribers.delete(callback);
    if (tickerSubscribers.size === 0) stopTicker();
  };
}

/**
 * @param {boolean} [force] Run even when the scroll position has not moved.
 * @private
 */
function requestTick(force = false) {
  if (force) lastTickY = -1;
  if (tickerFrame !== null) return;
  tickerFrame = requestAnimationFrame(tick);
}

/** @private */
function tick() {
  tickerFrame = null;
  const scrollY = window.scrollY;
  if (scrollY === lastTickY) return;
  lastTickY = scrollY;

  for (const callback of tickerSubscribers) {
    try {
      callback(scrollY);
    } catch (error) {
      console.error('[Boost10] motion ticker subscriber failed.', error);
    }
  }

  // Momentum and smooth scrolling keep moving between events.
  requestTick();
}

/** @private */
function startTicker() {
  if (tickerListener) return;

  const onScroll = () => requestTick();
  const onResize = () => requestTick(true);

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  tickerListener = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
  };
}

/** @private */
function stopTicker() {
  tickerListener?.();
  tickerListener = null;
  if (tickerFrame !== null) cancelAnimationFrame(tickerFrame);
  tickerFrame = null;
  lastTickY = -1;
}

/* ==========================================================================
   Parallax
   ========================================================================== */

/**
 * Move an element at a different rate to the page as it scrolls.
 *
 * @param {HTMLElement} element
 * @param {Object} [options]
 * @param {number} [options.speed=0.2] Fraction of scroll distance. Negative inverts.
 * @param {'y'|'x'} [options.axis='y']
 * @param {number} [options.max=120] Maximum offset in pixels.
 * @returns {{ destroy: () => void }}
 */
export function parallax(element, { speed = 0.2, axis = 'y', max = 120 } = {}) {
  if (!motionEnabled() || isTouchDevice()) return { destroy() {} };

  let bounds = null;
  let frameRequested = false;

  const measure = () => {
    const rect = element.getBoundingClientRect();
    bounds = { top: rect.top + window.scrollY, height: rect.height };
  };

  const update = (scrollY) => {
    if (!bounds) return;

    const viewportHeight = window.innerHeight;
    const centre = bounds.top + bounds.height / 2;
    const distance = centre - (scrollY + viewportHeight / 2);
    const offset = clamp(distance * speed * -1, -max, max);

    element.style.setProperty(
      'transform',
      axis === 'x' ? `translate3d(${offset}px, 0, 0)` : `translate3d(0, ${offset}px, 0)`
    );
  };

  const remeasure = () => {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      measure();
    });
  };

  measure();
  element.style.setProperty('will-change', 'transform');

  // Follow the scroll only while the element is near the viewport; off screen
  // there is nothing to see and the frame budget belongs to what is.
  let unsubscribe = null;
  const visibility = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) {
        unsubscribe ??= subscribeToTicker(update);
      } else {
        unsubscribe?.();
        unsubscribe = null;
      }
    },
    { rootMargin: '200px 0px' }
  );
  visibility.observe(element.parentElement ?? element);

  const resizeObserver = new ResizeObserver(remeasure);
  resizeObserver.observe(element);
  window.addEventListener('resize', remeasure, { passive: true });

  return {
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      visibility.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener('resize', remeasure);
      element.style.removeProperty('transform');
      element.style.removeProperty('will-change');
    }
  };
}

/* ==========================================================================
   Marquee
   ========================================================================== */

/**
 * Turn a track into an infinite horizontal ticker.
 *
 * @param {HTMLElement} track
 * @param {Object} [options]
 * @param {number} [options.speed=60] Pixels per second.
 * @param {'left'|'right'} [options.direction='left']
 * @param {boolean} [options.pauseOnHover=true]
 * @returns {{ play: () => void, pause: () => void, destroy: () => void }}
 */
export function marquee(track, { speed = 60, direction = 'left', pauseOnHover = true } = {}) {
  const container = track.parentElement;
  if (!container) return { play() {}, pause() {}, destroy() {} };

  const originals = Array.from(track.children).filter(
    (node) => !node.hasAttribute('data-marquee-clone')
  );
  if (originals.length === 0) return { play() {}, pause() {}, destroy() {} };

  /** @type {Element[]} */
  let clones = [];
  /** @type {Animation|null} */
  let animation = null;
  /** @type {ResizeObserver|null} */
  let observer = null;
  let paused = false;

  const clearClones = () => {
    for (const clone of clones) clone.remove();
    clones = [];
  };

  /**
   * One "cycle" is the distance from the first original item to the first item
   * of the next copy. Measuring it from real offsets rather than dividing
   * `scrollWidth` in half is what makes the loop seamless: `scrollWidth` does
   * not tell you where the seam is once flex `gap` and a variable number of
   * copies are involved, which is why the old maths drifted a gap-width per
   * lap and eventually showed a blank stretch.
   */
  const build = () => {
    clearClones();

    const viewport = container.offsetWidth || track.offsetWidth;
    const baseWidth = track.scrollWidth;
    if (baseWidth === 0) return 0;

    const copies = Math.max(2, Math.ceil((viewport * 2) / baseWidth) + 1);

    for (let copy = 1; copy < copies; copy += 1) {
      for (const node of originals) {
        const clone = /** @type {Element} */ (node.cloneNode(true));
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('data-marquee-clone', '');
        for (const focusable of clone.querySelectorAll('a, button, input, select, textarea')) {
          focusable.setAttribute('tabindex', '-1');
        }
        if (clone.matches('a, button, input, select, textarea')) {
          clone.setAttribute('tabindex', '-1');
        }
        track.appendChild(clone);
        clones.push(clone);
      }
    }

    const first = /** @type {HTMLElement} */ (track.children[0]);
    const second = /** @type {HTMLElement} */ (track.children[originals.length]);

    return second && first ? second.offsetLeft - first.offsetLeft : baseWidth;
  };

  const start = () => {
    animation?.cancel();
    animation = null;

    const distance = build();
    if (!distance || !motionEnabled()) return;

    const duration = (distance / Math.max(speed, 1)) * 1000;

    const from = direction === 'right' ? -distance : 0;
    const to = direction === 'right' ? 0 : -distance;

    animation = track.animate(
      [
        { transform: `translate3d(${from}px, 0, 0)` },
        { transform: `translate3d(${to}px, 0, 0)` }
      ],
      { duration, easing: EASING.linear, iterations: Infinity }
    );

    if (paused) animation.pause();
  };

  start();

  const onEnter = () => {
    paused = true;
    animation?.pause();
  };

  const onLeave = () => {
    paused = false;
    animation?.play();
  };

  if (pauseOnHover) {
    container.addEventListener('pointerenter', onEnter);
    container.addEventListener('pointerleave', onLeave);
    container.addEventListener('focusin', onEnter);
    container.addEventListener('focusout', onLeave);
  }

  let lastWidth = container.offsetWidth;
  observer = new ResizeObserver(() => {
    const width = container.offsetWidth;
    if (width === lastWidth) return;
    lastWidth = width;
    start();
  });
  observer.observe(container);

  // The first measure can run on the fallback font; re-measure once web fonts land.
  let destroyed = false;
  document.fonts?.ready.then(() => {
    if (!destroyed && document.fonts.status === 'loaded') start();
  });

  return {
    play: () => {
      paused = false;
      animation?.play();
    },
    pause: () => {
      paused = true;
      animation?.pause();
    },
    destroy() {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      animation?.cancel();
      animation = null;
      container.removeEventListener('pointerenter', onEnter);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('focusin', onEnter);
      container.removeEventListener('focusout', onLeave);
      clearClones();
    }
  };
}

export default {
  PRESETS,
  EASING,
  getPreset,
  presetNames,
  animate,
  reveal,
  observe,
  splitText,
  unsplitText,
  parallax,
  marquee,
  motionEnabled
};
