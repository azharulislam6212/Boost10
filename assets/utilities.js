/**
 * utilities.js — Boost10
 *
 * Pure, dependency-free helpers. This module imports nothing and touches no
 * component: it is the bottom of the dependency graph, and everything else may
 * import it safely.
 *
 * Contents:
 *   - Network        fetchConfig, RequestError, CartError, parseResponse, getRoute
 *   - Timing         debounce, throttle, rafThrottle, wait, nextFrame
 *   - Money          formatMoney
 *   - Announcements  announce, announceUrgent
 *   - Storage        storage.get / set / remove / has (guarded)
 *   - Environment    prefersReducedMotion, isTouchDevice, matchesQuery
 *   - Visibility     isVisible, isInViewport, onVisible
 *   - Focus          getFocusableElements, trapFocus, releaseFocus
 *   - Gestures       createSwipeDetector, createPinchDetector
 *   - Misc           clamp, uniqueId, escapeHtml, parseJSONScript, setCssVar
 *
 * @module @theme/utilities
 */

/* ========================================================================== */
/*  Network                                                                   */
/* ========================================================================== */

/**
 * Error thrown by any theme request that completes with a non-OK status or an
 * error body. Carries the HTTP status so callers can branch on it.
 */
export class RequestError extends Error {
  /**
   * @param {string} message Customer-facing, already-translated message.
   * @param {Object} [options]
   * @param {number|null} [options.status]
   * @param {*} [options.body] Parsed response body, when there was one.
   */
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Cart-specific request failure. Adds the line index when the failure is scoped
 * to a single cart line.
 */
export class CartError extends RequestError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {number|null} [options.status]
   * @param {*} [options.body]
   * @param {number|null} [options.line]
   */
  constructor(message, { status = null, body = null, line = null } = {}) {
    super(message, { status, body });
    this.name = 'CartError';
    this.line = line;
  }
}

/**
 * Builds the request init for every mutating call in the theme.
 *
 * All POST/PUT/DELETE traffic must go through this so that headers, content
 * type and body serialisation stay identical everywhere. Never hand-roll a
 * fetch init object.
 *
 * @param {'json'|'javascript'|'html'} [type='json'] Value used for `Accept`.
 * @param {Object} [options]
 * @param {string} [options.method='POST']
 * @param {Object|string|FormData|null} [options.body]
 * @param {AbortSignal} [options.signal]
 * @param {Record<string, string>} [options.headers] Extra headers, merged last.
 * @returns {RequestInit}
 *
 * @example
 * const response = await fetch(
 *   `${Theme.routes.cartAdd}.js`,
 *   fetchConfig('json', { body: { items }, signal: this.signal })
 * );
 */
export function fetchConfig(type = 'json', { method = 'POST', body = null, signal, headers = {} } = {}) {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  /** @type {Record<string, string>} */
  const baseHeaders = {
    Accept: type === 'html' ? 'text/html' : `application/${type}`,
    'X-Requested-With': 'XMLHttpRequest'
  };

  // FormData sets its own multipart boundary; setting Content-Type breaks it.
  if (!isFormData) {
    baseHeaders['Content-Type'] = type === 'javascript' ? 'application/javascript' : 'application/json';
  }

  /** @type {RequestInit} */
  const config = { method, headers: { ...baseHeaders, ...headers } };

  if (signal) config.signal = signal;

  if (body !== null && body !== undefined) {
    if (isFormData || typeof body === 'string') {
      config.body = body;
    } else {
      config.body = JSON.stringify(body);
    }
  }

  return config;
}

/**
 * Parses a response and throws a typed error when the request failed.
 *
 * The Shopify Cart API answers some failures with HTTP 200 and a `status` field
 * in the body, so checking `response.ok` alone is not enough.
 *
 * @param {Response} response
 * @param {Object} [options]
 * @param {typeof RequestError} [options.ErrorClass=RequestError]
 * @param {string} [options.fallbackMessage]
 * @returns {Promise<any>}
 * @throws {RequestError}
 */
export async function parseResponse(response, { ErrorClass = RequestError, fallbackMessage } = {}) {
  const contentType = response.headers.get('content-type') || '';
  const isJSON = contentType.includes('application/json');
  const body = isJSON ? await response.json().catch(() => null) : await response.text();

  const failed = !response.ok || (isJSON && body && (body.status || body.errors));

  if (failed) {
    const message =
      (isJSON && (body?.description || body?.message)) ||
      fallbackMessage ||
      themeString('networkError', 'Something went wrong. Please try again.');

    throw new ErrorClass(message, { status: response.status, body });
  }

  return body;
}

/**
 * Resolves a Shopify route from the global `Theme.routes` map.
 *
 * Routes must never be hardcoded: markets prefix URLs with a locale segment, so
 * a literal `/cart/add.js` silently breaks on every non-primary market.
 *
 * @param {string} name Key from `Theme.routes`, e.g. `'cartAdd'`.
 * @param {Object} [options]
 * @param {boolean} [options.json=false] Append `.js` for the AJAX endpoints.
 * @returns {string}
 */
export function getRoute(name, { json = false } = {}) {
  const route = globalThis.Theme?.routes?.[name];

  if (!route) {
    console.warn(`[Boost10] Unknown route "${name}". Check the routes map in theme.liquid.`);
    return json ? '/' : '/';
  }

  return json ? `${route}.js` : route;
}

/**
 * Reads a translated string from the global `Theme.strings` map.
 *
 * @param {string} key
 * @param {string} [fallback='']
 * @param {Record<string, string|number>} [replacements] Replaces `[token]` placeholders.
 * @returns {string}
 */
export function themeString(key, fallback = '', replacements = {}) {
  let value = globalThis.Theme?.strings?.[key] ?? fallback;

  for (const [token, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`[${token}]`, String(replacement));
  }

  return value;
}

/* ========================================================================== */
/*  Timing                                                                    */
/* ========================================================================== */

/**
 * Delays invocation until `wait` ms have passed without another call.
 *
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @param {number} [wait=300]
 * @param {Object} [options]
 * @param {boolean} [options.leading=false] Fire on the first call instead of the last.
 * @returns {T & { cancel: () => void }}
 */
export function debounce(fn, wait = 300, { leading = false } = {}) {
  let timer = null;

  const debounced = function (...args) {
    const callNow = leading && timer === null;

    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!leading) fn.apply(this, args);
    }, wait);

    if (callNow) fn.apply(this, args);
  };

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  return /** @type {any} */ (debounced);
}

/**
 * Caps invocation to at most once per `limit` ms, trailing edge included.
 *
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @param {number} [limit=200]
 * @returns {T & { cancel: () => void }}
 */
export function throttle(fn, limit = 200) {
  let lastRun = 0;
  let timer = null;

  const throttled = function (...args) {
    const now = Date.now();
    const remaining = limit - (now - lastRun);

    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      lastRun = now;
      fn.apply(this, args);
    } else if (timer === null) {
      timer = setTimeout(() => {
        lastRun = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };

  throttled.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  return /** @type {any} */ (throttled);
}

/**
 * Coalesces calls into one per animation frame. Use for scroll and resize work
 * that writes to the DOM — `throttle` still fires between frames and thrashes.
 *
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @returns {T & { cancel: () => void }}
 */
export function rafThrottle(fn) {
  let frame = null;
  let lastArgs = null;

  const throttled = function (...args) {
    lastArgs = args;
    if (frame !== null) return;

    frame = requestAnimationFrame(() => {
      frame = null;
      fn.apply(this, lastArgs);
    });
  };

  throttled.cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  return /** @type {any} */ (throttled);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves after the next paint. Useful between a DOM write and a measurement.
 *
 * @returns {Promise<void>}
 */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Runs a callback when the browser is idle, with a timeout fallback for Safari.
 *
 * @param {() => void} fn
 * @param {number} [timeout=2000]
 * @returns {number}
 */
export function whenIdle(fn, timeout = 2000) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, { timeout });
  }
  return setTimeout(fn, 1);
}

/* ========================================================================== */
/*  Money                                                                     */
/* ========================================================================== */

const MONEY_PATTERN = /\{\{\s*(\w+)\s*\}\}/;

/**
 * Formats an integer number of cents using a Shopify money format string.
 *
 * Never build price strings by hand: merchants configure separators and decimal
 * behaviour per store, and several markets use a comma decimal separator.
 *
 * @param {number|string} cents Amount in the store's minor unit.
 * @param {string} [format] Defaults to `Theme.shop.moneyFormat`.
 * @returns {string}
 *
 * @example
 * formatMoney(2599, '${{amount}}'); // "$25.99"
 */
export function formatMoney(cents, format) {
  const moneyFormat = format || globalThis.Theme?.shop?.moneyFormat || '${{amount}}';
  const value = typeof cents === 'string' ? Number(cents.replace(/[^0-9.-]/g, '')) : Number(cents);

  if (!Number.isFinite(value)) return '';

  const match = moneyFormat.match(MONEY_PATTERN);
  const placeholder = match ? match[1] : 'amount';

  /**
   * @param {number} number
   * @param {number} precision
   * @param {string} thousands
   * @param {string} decimal
   * @returns {string}
   */
  const withDelimiters = (number, precision, thousands, decimal) => {
    const fixed = (number / 100).toFixed(precision);
    const [whole, fraction] = fixed.split('.');
    const grouped = whole.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, `$1${thousands}`);
    return fraction ? `${grouped}${decimal}${fraction}` : grouped;
  };

  let formatted;

  switch (placeholder) {
    case 'amount_no_decimals':
      formatted = withDelimiters(value, 0, ',', '.');
      break;
    case 'amount_with_comma_separator':
      formatted = withDelimiters(value, 2, '.', ',');
      break;
    case 'amount_no_decimals_with_comma_separator':
      formatted = withDelimiters(value, 0, '.', ',');
      break;
    case 'amount_with_apostrophe_separator':
      formatted = withDelimiters(value, 2, "'", '.');
      break;
    case 'amount_with_space_separator':
      formatted = withDelimiters(value, 2, ' ', ',');
      break;
    case 'amount_no_decimals_with_space_separator':
      formatted = withDelimiters(value, 0, ' ', ',');
      break;
    case 'amount_with_period_and_space_separator':
      formatted = withDelimiters(value, 2, ' ', '.');
      break;
    case 'amount':
    default:
      formatted = withDelimiters(value, 2, ',', '.');
      break;
  }

  return moneyFormat.replace(MONEY_PATTERN, formatted);
}

/* ========================================================================== */
/*  Screen reader announcements                                               */
/* ========================================================================== */

/**
 * Writes into one of the two shared live regions rendered by
 * `snippets/live-region.liquid`.
 *
 * Components must never create their own `aria-live` container: duplicates make
 * screen readers announce the same message more than once.
 *
 * @param {string} message Already-translated text.
 * @param {'polite'|'assertive'} [priority='polite']
 */
export function announce(message, priority = 'polite') {
  if (!message) return;

  const id = priority === 'assertive' ? 'LiveRegionAssertive' : 'LiveRegion';
  const region = document.getElementById(id);

  if (!region) return;

  // Clearing first guarantees a re-announcement when the text is unchanged.
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

/**
 * Announces through the assertive region. Reserve this for errors and blocking
 * states — it interrupts whatever the screen reader is currently saying.
 *
 * @param {string} message
 */
export function announceUrgent(message) {
  announce(message, 'assertive');
}

/* ========================================================================== */
/*  Storage                                                                   */
/* ========================================================================== */

const STORAGE_PREFIX = () => globalThis.Theme?.storageKey || 'boost10';

let storageAvailable = null;

/**
 * @returns {boolean}
 */
function canUseStorage() {
  if (storageAvailable !== null) return storageAvailable;

  try {
    const probe = '__boost10__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    storageAvailable = true;
  } catch {
    // Safari private mode, disabled cookies, or a full quota.
    storageAvailable = false;
  }

  return storageAvailable;
}

/**
 * Shop-scoped, failure-tolerant `localStorage` wrapper.
 *
 * Every key is namespaced with `Theme.storageKey`, so a merchant's development
 * and live stores never read each other's data. Every method degrades to a
 * no-op rather than throwing, because storage access throws outright in Safari
 * private browsing.
 */
export const storage = {
  /**
   * @param {string} key
   * @param {*} [fallback=null]
   * @returns {*}
   */
  get(key, fallback = null) {
    if (!canUseStorage()) return fallback;

    try {
      const raw = window.localStorage.getItem(`${STORAGE_PREFIX()}:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  /**
   * @param {string} key
   * @param {*} value Must be JSON-serialisable.
   * @returns {boolean} `false` when the write was rejected.
   */
  set(key, value) {
    if (!canUseStorage()) return false;

    try {
      window.localStorage.setItem(`${STORAGE_PREFIX()}:${key}`, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },

  /**
   * @param {string} key
   * @returns {boolean}
   */
  remove(key) {
    if (!canUseStorage()) return false;

    try {
      window.localStorage.removeItem(`${STORAGE_PREFIX()}:${key}`);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.get(key, undefined) !== undefined;
  },

  /**
   * @returns {boolean} Whether writes will succeed at all.
   */
  get available() {
    return canUseStorage();
  }
};

/* ========================================================================== */
/*  Environment                                                               */
/* ========================================================================== */

/**
 * @param {string} query
 * @returns {boolean}
 */
export function matchesQuery(query) {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * Read this before every animation. Motion must be a no-op when it is true.
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  return matchesQuery('(prefers-reduced-motion: reduce)');
}

/**
 * @returns {boolean} Whether the primary pointer is coarse (touch).
 */
export function isTouchDevice() {
  return matchesQuery('(hover: none) and (pointer: coarse)');
}

/**
 * @returns {boolean} Whether the storefront is being viewed in the Theme Editor.
 */
export function isDesignMode() {
  return Boolean(globalThis.Shopify?.designMode || globalThis.Theme?.template?.designMode);
}

/**
 * @returns {boolean}
 */
export function isRTL() {
  return document.documentElement.getAttribute('dir') === 'rtl';
}

/* ========================================================================== */
/*  Visibility                                                                */
/* ========================================================================== */

/**
 * Whether an element is rendered and takes up space. Cheaper and more reliable
 * than reading computed styles.
 *
 * @param {Element|null} element
 * @returns {boolean}
 */
export function isVisible(element) {
  if (!element) return false;
  return Boolean(element.getClientRects().length);
}

/**
 * @param {Element} element
 * @param {number} [threshold=0] Fraction of the element that must be inside.
 * @returns {boolean}
 */
export function isInViewport(element, threshold = 0) {
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const offsetY = rect.height * threshold;
  const offsetX = rect.width * threshold;

  return (
    rect.bottom - offsetY > 0 &&
    rect.right - offsetX > 0 &&
    rect.top + offsetY < viewportHeight &&
    rect.left + offsetX < viewportWidth
  );
}

/**
 * Calls `callback` the first time an element enters the viewport, then stops
 * observing. The returned function cancels early.
 *
 * @param {Element} element
 * @param {(entry: IntersectionObserverEntry) => void} callback
 * @param {IntersectionObserverInit} [options]
 * @returns {() => void} Disconnect function.
 */
export function onVisible(element, callback, options = { rootMargin: '200px 0px' }) {
  if (!element || typeof IntersectionObserver !== 'function') {
    callback(/** @type {any} */ (null));
    return () => {};
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.disconnect();
      callback(entry);
    }
  }, options);

  observer.observe(element);

  return () => observer.disconnect();
}

/* ========================================================================== */
/*  Focus management                                                          */
/* ========================================================================== */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex^="-"])'
].join(',');

/**
 * @param {ParentNode} container
 * @returns {HTMLElement[]} Focusable descendants, in document order.
 */
export function getFocusableElements(container) {
  if (!container) return [];

  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => isVisible(element) && !element.closest('[inert]') && !element.hasAttribute('aria-hidden')
  );
}

/**
 * Traps Tab navigation inside a container until the returned function runs.
 *
 * Prefer a native `<dialog>` with `showModal()`, which traps focus for free.
 * Use this only for overlays that cannot be a real dialog element.
 *
 * @param {HTMLElement} container
 * @param {Object} [options]
 * @param {HTMLElement|null} [options.initialFocus] Defaults to the first focusable child.
 * @param {AbortSignal} [options.signal] Releases the trap when aborted.
 * @returns {() => void} Release function that restores the previous focus.
 */
export function trapFocus(container, { initialFocus = null, signal } = {}) {
  const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);
  const controller = new AbortController();

  /** @param {KeyboardEvent} event */
  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements(container);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', onKeydown, { signal: controller.signal });

  const target = initialFocus || getFocusableElements(container)[0] || container;
  if (target === container && !container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: true });

  const release = () => {
    controller.abort();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus({ preventScroll: true });
    }
  };

  signal?.addEventListener('abort', release, { once: true });

  return release;
}

/* ========================================================================== */
/*  Touch gestures                                                            */
/* ========================================================================== */

/**
 * Horizontal and vertical swipe detection using Pointer Events.
 *
 * The detector never calls `preventDefault` on move, so vertical page scrolling
 * stays native. Constrain the axis in CSS with `touch-action` instead.
 *
 * @param {HTMLElement} element
 * @param {Object} handlers
 * @param {(detail: {distance: number, duration: number}) => void} [handlers.onSwipeLeft]
 * @param {(detail: {distance: number, duration: number}) => void} [handlers.onSwipeRight]
 * @param {(detail: {distance: number, duration: number}) => void} [handlers.onSwipeUp]
 * @param {(detail: {distance: number, duration: number}) => void} [handlers.onSwipeDown]
 * @param {Object} [options]
 * @param {number} [options.threshold=40] Minimum travel in px.
 * @param {number} [options.restraint=80] Maximum drift on the other axis.
 * @param {number} [options.maxDuration=600] Slower movements are drags, not swipes.
 * @param {AbortSignal} [options.signal]
 * @returns {() => void} Teardown function.
 */
export function createSwipeDetector(element, handlers = {}, { threshold = 40, restraint = 80, maxDuration = 600, signal } = {}) {
  const controller = new AbortController();
  const options = { signal: controller.signal, passive: true };

  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let tracking = false;

  /** @param {PointerEvent} event */
  const onPointerDown = (event) => {
    if (!event.isPrimary) return;
    tracking = true;
    startX = event.clientX;
    startY = event.clientY;
    startTime = performance.now();
  };

  /** @param {PointerEvent} event */
  const onPointerUp = (event) => {
    if (!tracking || !event.isPrimary) return;
    tracking = false;

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const duration = performance.now() - startTime;

    if (duration > maxDuration) return;

    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (absX >= threshold && absY <= restraint) {
      const handler = deltaX < 0 ? handlers.onSwipeLeft : handlers.onSwipeRight;
      handler?.({ distance: absX, duration });
    } else if (absY >= threshold && absX <= restraint) {
      const handler = deltaY < 0 ? handlers.onSwipeUp : handlers.onSwipeDown;
      handler?.({ distance: absY, duration });
    }
  };

  const onPointerCancel = () => {
    tracking = false;
  };

  element.addEventListener('pointerdown', onPointerDown, options);
  element.addEventListener('pointerup', onPointerUp, options);
  element.addEventListener('pointercancel', onPointerCancel, options);

  const destroy = () => controller.abort();
  signal?.addEventListener('abort', destroy, { once: true });

  return destroy;
}

/**
 * Two-finger pinch detection for the mobile zoom modal.
 *
 * @param {HTMLElement} element
 * @param {(detail: {scale: number, centerX: number, centerY: number}) => void} onPinch
 * @param {Object} [options]
 * @param {() => void} [options.onPinchStart]
 * @param {() => void} [options.onPinchEnd]
 * @param {AbortSignal} [options.signal]
 * @returns {() => void} Teardown function.
 */
export function createPinchDetector(element, onPinch, { onPinchStart, onPinchEnd, signal } = {}) {
  const controller = new AbortController();
  const listenerOptions = { signal: controller.signal };

  /** @type {Map<number, PointerEvent>} */
  const pointers = new Map();
  let startDistance = 0;

  const distanceBetween = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  };

  const centerBetween = () => {
    const [a, b] = [...pointers.values()];
    return { centerX: (a.clientX + b.clientX) / 2, centerY: (a.clientY + b.clientY) / 2 };
  };

  /** @param {PointerEvent} event */
  const onPointerDown = (event) => {
    pointers.set(event.pointerId, event);
    if (pointers.size === 2) {
      startDistance = distanceBetween();
      onPinchStart?.();
    }
  };

  /** @param {PointerEvent} event */
  const onPointerMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);

    if (pointers.size !== 2 || startDistance === 0) return;

    event.preventDefault();
    const scale = distanceBetween() / startDistance;
    onPinch({ scale, ...centerBetween() });
  };

  /** @param {PointerEvent} event */
  const onPointerEnd = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2 && startDistance !== 0) {
      startDistance = 0;
      onPinchEnd?.();
    }
  };

  element.addEventListener('pointerdown', onPointerDown, listenerOptions);
  element.addEventListener('pointermove', onPointerMove, { ...listenerOptions, passive: false });
  element.addEventListener('pointerup', onPointerEnd, listenerOptions);
  element.addEventListener('pointercancel', onPointerEnd, listenerOptions);
  element.addEventListener('pointerleave', onPointerEnd, listenerOptions);

  const destroy = () => controller.abort();
  signal?.addEventListener('abort', destroy, { once: true });

  return destroy;
}

/* ========================================================================== */
/*  Misc                                                                      */
/* ========================================================================== */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

let idCounter = 0;

/**
 * @param {string} [prefix='b10']
 * @returns {string}
 */
export function uniqueId(prefix = 'b10') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * Escapes a string for safe insertion into markup.
 *
 * Prefer `textContent` or `morph()`. Reach for this only when building an
 * attribute value that genuinely has to be a string.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Reads a `<script type="application/json">` payload rendered by Liquid.
 *
 * @param {ParentNode} container
 * @param {string} selector
 * @param {*} [fallback=null]
 * @returns {*}
 */
export function parseJSONScript(container, selector, fallback = null) {
  const script = container?.querySelector(selector);
  if (!script) return fallback;

  try {
    return JSON.parse(script.textContent || '');
  } catch (error) {
    console.warn(`[Boost10] Could not parse JSON from "${selector}".`, error);
    return fallback;
  }
}

/**
 * @param {string} name Custom property name, with or without the leading dashes.
 * @param {string|number} value
 * @param {HTMLElement} [target=document.documentElement]
 */
export function setCssVar(name, value, target = document.documentElement) {
  const property = name.startsWith('--') ? name : `--${name}`;
  target.style.setProperty(property, String(value));
}

/**
 * @param {string} name
 * @param {HTMLElement} [target=document.documentElement]
 * @returns {string}
 */
export function getCssVar(name, target = document.documentElement) {
  const property = name.startsWith('--') ? name : `--${name}`;
  return getComputedStyle(target).getPropertyValue(property).trim();
}

/* ========================================================================== */
/*  Scroll locking                                                            */
/* ========================================================================== */

/**
 * Reference count, so nested overlays (a quick view opening the cart drawer)
 * only release the page when the last one closes.
 * @type {number}
 */
let scrollLockCount = 0;


/**
 * Freezes page scrolling while an overlay is open.
 *
 * Three things happen, and all three are needed:
 *   1. `<smooth-scrollbar>.stop()` is called directly, so Lenis stops driving
 *      the document. No event, no registry: the overlay owns the decision and
 *      calls the method on the element that owns the behaviour.
 *   2. `--scrollbar-width` is published so fixed elements can compensate and
 *      the page does not shift sideways when the scrollbar disappears.
 *   3. The body is pinned with `position: fixed`, which is the only technique
 *      that reliably stops rubber-band scrolling on iOS Safari.
 *
 * Applied as inline styles rather than a class, so scroll locking works before
 * base.css exists and cannot be defeated by merchant CSS.
 */
export function lockScroll() {
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;

  // `overflow: hidden` on the root, and nothing else.
  //
  // This used to pin the body: `position: fixed` with `top: -scrollY`. That
  // stops the page scrolling, and it also takes the body out of flow - which
  // leaves `position: sticky` with no scrolling ancestor to stick to. The header
  // stopped being pinned and dropped back to where it sits in the document,
  // which is the top of the page. Opening a country picker or a drawer therefore
  // looked like the page had jumped to the top; closing it put the scroll back
  // and the header re-stuck, which looked like the header dropping down.
  //
  // The root overflow does the same job without moving anything. The scroll
  // position is untouched, so there is nothing to restore and nothing to jump.
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

  document.documentElement.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
  document.documentElement.classList.add('scroll-locked');

  // Stopped before the class lands, so the smooth scroller is not still
  // animating into a page that has just stopped scrolling.
  document.querySelector('smooth-scrollbar')?.stop?.();
}

/**
 * Releases one scroll lock. The page is restored only when the count reaches
 * zero, and the scroll position is put back exactly where it was.
 */
export function unlockScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;

  document.documentElement.classList.remove('scroll-locked');
  document.documentElement.style.removeProperty('--scrollbar-width');

  // No `scrollTo` here. The page never moved, so putting it back is what used to
  // move it: the stored offset was read before the lock and written after it,
  // and any drift between the two - a smooth scroller mid-animation, a resize,
  // an anchor - arrived as a jump the moment an overlay closed.
  document.querySelector('smooth-scrollbar')?.start?.();
}

/**
 * @returns {boolean} True while at least one overlay holds a scroll lock.
 */
export function isScrollLocked() {
  return scrollLockCount > 0;
}


/* ==========================================================================
   Disclosure mechanics
   --------------------------------------------------------------------------
   Opening and closing a `<details>` with a transition, and measuring a panel
   that has no height until it is open.

   These live here rather than in `header.js` because none of them know anything
   about navigation: they take a `<details>`, they read `data-` attributes, and
   they leave the styling to whatever stylesheet is in charge. The header uses
   them for its menus and its drawer; anything else that discloses can too.
   ========================================================================== */

/** Ceiling for waiting on `transitionend`, in case a panel never transitions. */
// Longer than `--panel-speed` (420ms), because this is the net under the
// transform's own `transitionend`, not a second way of ending the reveal.
const DISCLOSURE_FALLBACK = 600;

/** How long the reveal will wait for a panel's height to settle, in frames. */
const REVEAL_MAX_FRAMES = 6;

/**
 * The animated part of a `<details>`.
 *
 * @param {HTMLDetailsElement} details
 * @returns {HTMLElement|null}
 */
export function panelOf(details) {
  return details.querySelector(':scope > [data-nav-panel], :scope > [data-mobile-panel]');
}

/**
 * Give a measured panel a pixel height to animate to, and take it away again.
 *
 * A `<details>` panel has no height until it is open, and no *known* height once
 * it is — `auto` cannot be transitioned. So the height is written in pixels for
 * the duration of the transition and released afterwards, which is what lets a
 * submenu opening inside an already-open panel still grow it.
 *
 * Only panels marked `data-mobile-panel` are measured; the desktop ones animate
 * a transform inside a clip and need no height at all.
 *
 * @param {HTMLElement|null} panel
 * @param {'open'|'close'} direction
 */
export function measurePanel(panel, direction) {
  if (!panel || !panel.hasAttribute('data-mobile-panel')) return;

  if (direction === 'close') {
    // From its current height, not from `auto`, or there is nothing to animate
    // away from.
    panel.style.blockSize = `${panel.scrollHeight}px`;
    void panel.offsetHeight;
    panel.style.blockSize = '0px';
    return;
  }

  panel.style.blockSize = '0px';
  void panel.offsetHeight;
  panel.style.blockSize = `${panel.scrollHeight}px`;

  panel.addEventListener(
    'transitionend',
    (event) => {
      if (event.propertyName !== 'block-size' && event.propertyName !== 'height') return;
      panel.style.blockSize = 'auto';
    },
    { once: true }
  );
}

/**
 * Release the panel's clip once its reveal has finished.
 *
 * The clip exists so the inner element can slide out from behind the header.
 * Held past the reveal it also cuts off anything a child disclosure opens
 * sideways, so it comes off the moment the transition ends.
 *
 * Which transition, though — and that is where this was wrong.
 *
 * The inner animates two properties, and they are not the same length:
 *
 *   transform  var(--panel-speed)   420ms
 *   opacity    var(--panel-fade)    200ms
 *
 * `{ once: true }` took the first `transitionend` to arrive, which is opacity's,
 * at 200ms. The clip came off 220ms before the panel had finished sliding — with
 * the inner still translated up, roughly halfway through its travel. Released
 * from the clip it was suddenly painted outside the panel, over the header,
 * before dropping the rest of the way. That is the jump when a mega menu opens.
 *
 * It shows most once the header is stuck, because there the panel opens hard
 * against a solid bar and the overshoot is drawn across it. At the top of the
 * page the same overshoot lands on a transparent header over the banner, where
 * it reads as part of the frosted panel and is easy to miss.
 *
 * So: the transform, specifically. The listener is removed by hand rather than
 * with `once`, because `once` would have been spent on the opacity event.
 *
 * @param {HTMLDetailsElement} details
 */
export function settleDisclosure(details) {
  if (prefersReducedMotion()) {
    details.setAttribute('data-settled', '');
    return;
  }

  const panel = panelOf(details);
  const inner = panel?.querySelector(':scope > .nav__panel-inner, :scope > .drawer-nav__panel-inner');

  /** @param {TransitionEvent} [event] */
  const done = (event) => {
    // Anything bubbling up from inside the panel is not this panel arriving.
    if (event && event.target !== inner) return;
    if (event && event.propertyName !== 'transform') return;

    inner?.removeEventListener('transitionend', done);
    clearTimeout(Number(details.dataset.settleTimer));

    if (details.dataset.state !== 'open') return;
    details.setAttribute('data-settled', '');
  };

  inner?.addEventListener('transitionend', done);

  // The safety net, for the cases where `transitionend` will not fire at all —
  // a panel with no transition, a tab backgrounded mid-open. It has to outlast
  // the transform, or it would release the clip early on its own.
  details.dataset.settleTimer = String(window.setTimeout(done, DISCLOSURE_FALLBACK));
}

/**
 * Open a `<details>` with a transition.
 *
 * `open` has to be set first — the panel is `display: none` until it is, and a
 * transition on a display-none element never starts. `data-open` follows two
 * frames later, because the browser has not laid the panel out until the frame
 * after `open`, and a transition whose start and end are computed in one layout
 * pass jumps straight to the end.
 *
 * @param {HTMLDetailsElement} details
 */
export function openDisclosure(details) {
  if (details.dataset.state === 'open') return;

  clearTimeout(Number(details.dataset.closeTimer));
  details.dataset.state = 'open';
  details.open = true;

  const summary = details.querySelector('[data-nav-summary], summary');
  summary?.setAttribute('aria-expanded', 'true');

  // The reveal waits for the panel's height to stop changing.
  //
  // A dropdown is text: it has its final height the moment `open` is set, and
  // two frames was plenty. A mega menu is not. Its carousel only discovers its
  // track width when the panel gains a size, and Swiper then relays out — after
  // the reveal has already started. The inner element is translating by `-101%`
  // of a height that is no longer the height it began from, so the panel lurches
  // halfway through. That is why the dropdowns were smooth and the mega menus
  // were not.
  //
  // Two identical measurements and the reveal begins. The cap stops a panel with
  // something genuinely animating inside it from never opening at all.
  const panel = panelOf(details);
  let lastHeight = -1;
  let frames = 0;

  const reveal = () => {
    // A close may have been requested while we were waiting.
    if (details.dataset.state !== 'open') return;

    details.setAttribute('data-open', '');
    measurePanel(panel, 'open');
    settleDisclosure(details);
  };

  const settleHeight = () => {
    if (details.dataset.state !== 'open') return;

    const height = panel ? panel.scrollHeight : 0;

    if (height === lastHeight || frames >= REVEAL_MAX_FRAMES) {
      reveal();
      return;
    }

    lastHeight = height;
    frames += 1;
    requestAnimationFrame(settleHeight);
  };

  requestAnimationFrame(settleHeight);
}

/**
 * Close a `<details>`, waiting for the transition before removing `open`.
 *
 * Removing `open` immediately puts the panel back to `display: none` on the same
 * frame and the closing animation is never seen. The timeout is the safety net
 * for the cases where `transitionend` will not fire: reduced motion, a panel
 * with no transition, a tab backgrounded mid-close.
 *
 * @param {HTMLDetailsElement} details
 */
export function closeDisclosure(details) {
  if (!details.open || details.dataset.state === 'closed') return;

  details.dataset.state = 'closed';
  clearTimeout(Number(details.dataset.settleTimer));

  // The clip goes back on before the panel starts moving, so a submenu hanging
  // outside it is cut off rather than left floating over the page.
  details.removeAttribute('data-settled');
  details.removeAttribute('data-open');
  measurePanel(panelOf(details), 'close');

  const summary = details.querySelector('[data-nav-summary], summary');
  summary?.setAttribute('aria-expanded', 'false');

  const finish = () => {
    clearTimeout(Number(details.dataset.closeTimer));
    if (details.dataset.state !== 'closed') return;
    details.open = false;
    delete details.dataset.state;
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  // The same mistake in the other direction, and the same fix.
  //
  // This took whichever `transitionend` arrived first from anywhere inside the
  // panel — which is opacity's, at 200ms, while the inner is still sliding back
  // up. `open` was removed then, the panel went to `display: none`, and the
  // closing half of the animation was cut off partway.
  const panel = panelOf(details);
  const inner = panel?.querySelector(':scope > .nav__panel-inner, :scope > .drawer-nav__panel-inner');
  const watched = inner ?? panel;

  /** @param {TransitionEvent} event */
  const onEnd = (event) => {
    if (event.target !== watched) return;
    if (event.propertyName !== 'transform') return;

    watched?.removeEventListener('transitionend', onEnd);
    finish();
  };

  watched?.addEventListener('transitionend', onEnd);

  details.dataset.closeTimer = String(window.setTimeout(finish, DISCLOSURE_FALLBACK));
}
