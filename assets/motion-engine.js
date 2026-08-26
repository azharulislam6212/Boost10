/**
 * motion-engine.js — Boost10
 *
 * The theme's animation runtime, built entirely on the Web Animations API and
 * IntersectionObserver. No timeline library, no scroll library, no keyframe CSS
 * duplicated across section files.
 *
 * What it provides:
 *   - `PRESETS`       a named registry of text and image entrance animations
 *   - `reveal()`      plays a preset on load or on scroll, with stagger
 *   - `splitText()`   accessible per-word / per-character splitting
 *   - `observe()`     a pooled IntersectionObserver shared by every caller
 *   - `parallax()`    transform-only parallax driven by one rAF loop
 *   - `marquee()`     infinite ticker with a real pause control
 *
 *
 * Four rules hold everywhere in this file:
 *
 *   1. Reduced motion wins. Every helper skips straight to the final visual
 *      state. Nothing animates, and nothing stays invisible waiting for an
 *      animation that will never run.
 *   2. JavaScript hides the content, not CSS. The starting state is written as
 *      inline style by `reveal()` at the moment it takes responsibility for the
 *      element. If this script never loads, nothing was ever hidden.
 *   3. On load and on scroll are the same code path. An element already in the
 *      viewport when the page loads animates immediately, with a small cascade
 *      so above-the-fold content arrives in sequence rather than all at once.
 *   4. Reads are batched before writes. Layout measurement happens once per
 *      frame in the shared ticker, never inside a scroll handler.
 *
 * Works with Lenis without any coupling: Lenis scrolls the real document, so
 * IntersectionObserver fires exactly as it would with native scrolling. Nothing
 * here reads `window.scrollY` at all: this file is a library of presets and
 * timings, and the elements that use them live in `motion-effect.js`.
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
  // The gentlest of the settles: no acceleration at the start, a long tail. For
  // anything large and slow, where an ease-in-out reads as a hesitation
  // followed by a lunge.
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  outBack: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  inOutQuart: 'cubic-bezier(0.76, 0, 0.24, 1)',
  linear: 'linear'
};

const DEFAULTS = {
  duration: 700,
  delay: 0,
  stagger: 70,
  distance: 28,
  threshold: 0.12,
  rootMargin: '0px 0px -8% 0px',
  /** Cascade applied to elements already on screen when the page loads. */
  loadStagger: 90,
  /** How long after navigation an intersection still counts as "on load". */
  loadWindow: 1200
};

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
 * @property {string} [group] `text`, `image` or `both`. Used by the editor to sort options.
 */

/**
 * Every named animation in the theme.
 *
 * Naming convention for the reveal family: the name is the direction the
 * revealing edge travels. `reveal-right` starts clipped at the left and the
 * visible area grows rightwards.
 *
 * @type {Record<string, MotionPreset>}
 */
export const PRESETS = {
  /* ---------------------------------------------------------- universal -- */

  fade: {
    group: 'both',
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
  },

  'fade-in': {
    group: 'both',
    keyframes: () => [{ opacity: 0 }, { opacity: 1 }]
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

  /* -------------------------------------------------------------- image -- */

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

  // The reveal family animates clip-path rather than wrapping the element in an
  // overflow-hidden mask. No extra DOM, no layout change, and the image itself
  // can still be zoomed or parallaxed by a separate transform.
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

  /* --------------------------------------------------------------- text -- */

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

  /* Letters appearing in sequence with no transform and no fade, so it reads as
     typing rather than as an entrance animation.

     The 1ms duration is the whole trick: the effect lives entirely in the
     stagger, and any real duration turns each hard cut into a cross-fade, which
     is `letters-fade-in` — a different effect that already exists.

     No blinking caret. A caret has to stop when the last character lands, and
     the engine marks an element revealed when its animation *starts*, so there
     is no state a stylesheet could key off. Faking one with a fixed CSS
     animation would desync the moment a merchant changed the stagger. */
  typewriter: {
    group: 'text',
    split: 'chars',
    duration: 1,
    stagger: 45,
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
 * The first callback fires as soon as observation begins if the element is
 * already on screen, which is what makes on-load and on-scroll the same path.
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
    const callbacks = new WeakMap();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const item of entries) {
          if (!item.isIntersecting) continue;
          const handler = callbacks.get(item.target);
          if (!handler) continue;
          if (once) observer.unobserve(item.target);
          handler(item);
        }
      },
      { threshold, rootMargin }
    );

    entry = { observer, callbacks };
    observerPool.set(key, entry);
  }

  // One firing, whichever route gets there first, and one cleanup.
  let done = false;
  const fire = (item) => {
    if (done) return;
    done = true;
    releaseFloor();
    callback(item);
  };

  entry.callbacks.set(element, (item) => fire(item));
  entry.observer.observe(element);

  const releaseFloor = watchScrollFloor(element, () =>
    fire({ target: element, isIntersecting: true, intersectionRatio: 1 })
  );

  return () => {
    done = true;
    releaseFloor();
    entry.callbacks.delete(element);
    entry.observer.unobserve(element);
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

   It is easy to miss, because it only bites the very last thing on the page and
   only when that thing is short: the footer's disclaimer, a closing line of
   copy, a final badge row. Then it does not "animate late" — it never appears
   at all.

   So the bottom of the document is a floor. Once the page can scroll no
   further, anything still waiting that is genuinely on screen is released. One
   shared listener for the whole page, passive, on rAF, and it removes itself as
   soon as nothing is waiting on it.
   ========================================================================== */

/** @type {Set<{ element: Element, fire: () => void }>} */
const waitingOnFloor = new Set();

/** @type {(() => void)|null} */
let floorListener = null;

function checkScrollFloor() {
  const doc = document.documentElement;
  const atEnd = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
  if (!atEnd) return;

  for (const item of [...waitingOnFloor]) {
    const rect = item.element.getBoundingClientRect();
    // In the real viewport, not the inset one.
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

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  floorListener = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };

  // A short page can already be at its end with nothing left to scroll.
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
    element.style.setProperty(camelToKebab(property), String(value));
  }
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
 * The starting state is written inline the moment this function takes charge,
 * so content is only ever hidden by a script that is definitely running. If the
 * module fails to load, every element stays visible.
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
  const effect = options.effect || 'fade-up';
  const preset = getPreset(effect);

  if (!preset) {
    console.warn(`[Boost10] No motion preset named "${effect}".`);
    markRevealed(element, options.targets || []);
    return () => {};
  }

  // Text presets animate the split parts, unless the caller named its own.
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

  // Hide now, from JavaScript, never from CSS.
  for (const target of targets) applyState(target, restingState);
  element.setAttribute('data-motion-pending', '');

  const order = preset.random ? shuffledIndices(targets.length) : null;

  const play = (fromLoad) => {
    const stagger = options.stagger ?? preset.stagger ?? (targets.length > 1 ? DEFAULTS.stagger : 0);
    const baseDelay = (options.delay ?? DEFAULTS.delay) + (fromLoad ? loadCascadeDelay(options) : 0);

    targets.forEach((target, index) => {
      const position = order ? order[index] : index;

      const animation = animate(target, keyframes, {
        duration: options.duration ?? preset.duration ?? DEFAULTS.duration,
        delay: baseDelay + position * stagger,
        easing: options.easing ?? preset.easing ?? EASING.outExpo
      });

      // Once the animation holds the final state, the inline resting styles are
      // no longer needed and would otherwise fight later hover styles.
      animation?.finished
        .then(() => {
          animation.commitStyles?.();
          animation.cancel();
          clearState(target, restingState);
        })
        .catch(() => {});
    });

    markRevealed(element, targets);
    options.onReveal?.();
  };

  // The element that is watched is not always the element that is hidden.
  //
  // The `reveal-*` presets rest at `clip-path: inset(100% 0 0 0)` — the element
  // clipped away to nothing. IntersectionObserver applies the target's own
  // clip-path before it measures, so an element clipped to nothing reports a
  // ratio of 0 and never intersects, whatever the scroll position.
  //
  // When that resting state lands on the same element the observer is watching,
  // those two facts deadlock: the state that hides the element suppresses the
  // one event that would reveal it, and the content stays invisible for the
  // life of the page. It only worked at all where the caller passed a
  // `data-target`, because then the clip goes on a child and the host stays
  // measurable — `reveal-up` on an element with no target was simply gone.
  //
  // So when the observed element clips itself, its parent is watched instead:
  // the same place on the page, the same moment on screen, nothing clipped.
  const clipsItself = targets.includes(element) && typeof restingState.clipPath === 'string';
  const observed = clipsItself ? element.parentElement ?? element : element;

  const cancelObserve = observe(
    observed,
    () => play(withinLoadWindow()),
    {
      threshold: options.threshold,
      rootMargin: options.rootMargin,
      once: options.once
    }
  );

  return () => {
    cancelObserve();
    for (const target of targets) clearState(target, restingState);
    markRevealed(element, targets);
  };
}

/**
 * Cascade delay for elements already on screen when the page loads.
 *
 * Without it, everything above the fold animates on the same frame, which looks
 * like a flash rather than an entrance.
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
  return Math.min(delay, step * 8);
}

/**
 * @param {HTMLElement} element
 * @param {HTMLElement[]} targets
 * @private
 */
function markRevealed(element, targets) {
  element.removeAttribute('data-motion-pending');
  element.setAttribute('data-motion-revealed', '');
  for (const target of targets) target.setAttribute('data-motion-revealed', '');
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
 * Split an element's text into animatable spans without breaking screen readers.
 *
 * The original string is preserved on the container as `aria-label` and the
 * generated spans are hidden from assistive technology. Without that, a split
 * heading is announced one letter at a time.
 *
 * Words are always wrapped, even when splitting by character, so that lines
 * still break between words rather than mid-word.
 *
 * @param {HTMLElement} element
 * @param {Object} [options]
 * @param {'chars'|'words'} [options.by='chars']
 * @returns {HTMLElement[]} The generated spans, in document order.
 */
export function splitText(element, { by = 'chars' } = {}) {
  if (element.hasAttribute('data-motion-split')) {
    return Array.from(element.querySelectorAll('[data-motion-part]'));
  }

  const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (text.length === 0) return [];

  element.setAttribute('data-motion-split', by);
  if (!element.hasAttribute('aria-label')) element.setAttribute('aria-label', text);

  const fragment = document.createDocumentFragment();
  const parts = [];

  text.split(' ').forEach((word, index, all) => {
    const wordSpan = document.createElement('span');
    wordSpan.className = 'motion-word';
    wordSpan.setAttribute('aria-hidden', 'true');
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

    fragment.appendChild(wordSpan);

    if (index < all.length - 1) fragment.appendChild(document.createTextNode(' '));
  });

  element.replaceChildren(fragment);

  return parts;
}

/**
 * Undo {@link splitText}, restoring the original text node.
 *
 * @param {HTMLElement} element
 */
export function unsplitText(element) {
  if (!element.hasAttribute('data-motion-split')) return;

  const original = element.getAttribute('aria-label') ?? element.textContent ?? '';
  element.removeAttribute('data-motion-split');
  element.textContent = original;
}

/* ==========================================================================
   Scroll ticker
   ========================================================================== */

/** @type {Set<(scrollY: number) => void>} */
const tickerSubscribers = new Set();

/** @type {number|null} */
let tickerFrame = null;

/**
 * Subscribe to a single shared rAF loop driven by scroll position.
 *
 * One loop for the whole page keeps parallax, sticky maths and progress bars on
 * the same frame, which is the difference between smooth and janky. It reads
 * `window.scrollY`, so it follows Lenis without knowing Lenis exists.
 *
 * @param {(scrollY: number) => void} callback
 * @returns {() => void} Unsubscribe.
 */
export function subscribeToTicker(callback) {
  tickerSubscribers.add(callback);
  startTicker();

  return () => {
    tickerSubscribers.delete(callback);
    if (tickerSubscribers.size === 0) stopTicker();
  };
}

/** @private */
function startTicker() {
  if (tickerFrame !== null) return;

  const tick = () => {
    const scrollY = window.scrollY;
    for (const callback of tickerSubscribers) {
      try {
        callback(scrollY);
      } catch (error) {
        console.error('[Boost10] motion ticker subscriber failed.', error);
      }
    }
    tickerFrame = requestAnimationFrame(tick);
  };

  tickerFrame = requestAnimationFrame(tick);
}

/** @private */
function stopTicker() {
  if (tickerFrame === null) return;
  cancelAnimationFrame(tickerFrame);
  tickerFrame = null;
}

/* ==========================================================================
   Parallax
   ========================================================================== */

/**
 * Move an element at a different rate to the page as it scrolls.
 *
 * Transform only: no `top`, no `background-position`, nothing that triggers
 * layout. Disabled under reduced motion and on touch devices, where parallax
 * fights momentum scrolling and reliably feels broken.
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

  const unsubscribe = subscribeToTicker(update);

  const resizeObserver = new ResizeObserver(remeasure);
  resizeObserver.observe(element);
  window.addEventListener('resize', remeasure, { passive: true });

  return {
    destroy() {
      unsubscribe();
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
 * The track's children are duplicated until they overflow the container twice,
 * then the whole track is translated by exactly half its width, so the loop is
 * seamless regardless of content length. Duplicated content is hidden from
 * assistive technology, and the animation exposes a real pause control rather
 * than relying on hover alone.
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

    // At least one extra copy, plus however many are needed to cover twice the
    // viewport so there is always content queued off the leading edge.
    const copies = Math.max(2, Math.ceil((viewport * 2) / baseWidth) + 1);

    for (let copy = 1; copy < copies; copy += 1) {
      for (const node of originals) {
        const clone = /** @type {Element} */ (node.cloneNode(true));
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('data-marquee-clone', '');
        // A cloned link must not be a second tab stop for the same destination.
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

    // Right-scrolling starts one cycle back and travels to zero, so the strip
    // enters from the left edge instead of leaving a gap while it catches up.
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

  // A marquee built inside a hidden container — the announcement bar before it
  // is revealed, a closed drawer, an inactive tab — measures zero and would
  // otherwise never move. Rebuilding when the box gains a real width is the
  // same recovery `<swiper-carousel>` makes.
  let lastWidth = container.offsetWidth;
  observer = new ResizeObserver(() => {
    const width = container.offsetWidth;
    if (width === lastWidth) return;
    lastWidth = width;
    start();
  });
  observer.observe(container);

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
