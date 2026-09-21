/**
 * The theme's only interface to the Shopify Section Rendering API.
 *
 * @module @theme/section-renderer
 */

import { EVENTS, sectionRenderedDetail } from '@theme/events';
import { RequestError, isDesignMode } from '@theme/utilities';
import { morph } from '@theme/morph';

/* ==========================================================================
   Cache
   ========================================================================== */

/** How long a cached section stays fresh, in milliseconds. */
const CACHE_TTL = 30_000;

/** Hard cap on cached entries, so long browsing sessions cannot grow unbounded. */
const CACHE_LIMIT = 40;

/** @type {Map<string, { html: string, expires: number }>} */
const cache = new Map();

/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

/**
 * Remove cached sections.
 *
 * @param {string} [prefix] Clear only entries whose cache key starts with this.
 */
export function clearSectionCache(prefix) {
  if (!prefix) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * @returns {number} Number of entries currently cached.
 */
export function sectionCacheSize() {
  return cache.size;
}

/**
 * @param {string} key
 * @returns {string|null}
 * @private
 */
function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expires < Date.now()) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);

  return entry.html;
}

/**
 * @param {string} key
 * @param {string} html
 * @private
 */
function writeCache(key, html) {
  if (isDesignMode()) return; // The Theme Editor must always see fresh output.

  cache.set(key, { html, expires: Date.now() + CACHE_TTL });

  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/* ==========================================================================
   URL construction
   ========================================================================== */

/**
 * Build a Section Rendering API URL.
 *
 * @param {Object} options
 * @param {string} [options.url] Base URL. Defaults to the current path.
 * @param {string} [options.sectionId] Single section id.
 * @param {string[]} [options.sections] Several section ids.
 * @param {Object|URLSearchParams|string} [options.params] Extra query parameters.
 * @returns {string}
 */
export function buildSectionUrl({ url, sectionId, sections, params } = {}) {
  const base = new URL(url || window.location.pathname + window.location.search, window.location.origin);

  base.searchParams.delete('section_id');
  base.searchParams.delete('sections');

  if (params) {
    const extra = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    for (const [key, value] of extra.entries()) base.searchParams.set(key, value);
  }

  if (sectionId) base.searchParams.set('section_id', sectionId);
  if (sections?.length) base.searchParams.set('sections', sections.join(','));

  return `${base.pathname}${base.search}`;
}

/* ==========================================================================
   Fetching
   ========================================================================== */

/**
 * Fetch a single section as HTML.
 *
 * @param {string} sectionId The Shopify section id, without the `shopify-section-` prefix.
 * @param {Object} [options]
 * @param {string} [options.url] Base URL. Defaults to the current page.
 * @param {Object} [options.params] Extra query parameters, e.g. active filters.
 * @param {AbortSignal} [options.signal] Cancels the request.
 * @param {boolean} [options.cache=true] Set false to bypass the cache.
 * @returns {Promise<string>} The section's HTML.
 * @throws {RequestError} When the network fails or the server responds with an error.
 */
export async function fetchSection(sectionId, { url, params, signal, cache: useCache = true } = {}) {
  if (!sectionId) throw new RequestError('A section id is required.', { status: 0 });

  const requestUrl = buildSectionUrl({ url, sectionId, params });

  if (useCache) {
    const cached = readCache(requestUrl);
    if (cached !== null) return cached;
  }

  const pending = inFlight.get(requestUrl);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(requestUrl, {
      signal,
      headers: { Accept: 'text/html' }
    });

    if (!response.ok) {
      throw new RequestError(`Section "${sectionId}" could not be rendered.`, {
        status: response.status
      });
    }

    const html = await response.text();
    if (useCache) writeCache(requestUrl, html);

    return html;
  })();

  inFlight.set(requestUrl, request);

  try {
    return await request;
  } finally {
    inFlight.delete(requestUrl);
  }
}

/**
 * Fetch several sections in one round trip.
 *
 * @param {string[]} sectionIds
 * @param {Object} [options] Same shape as {@link fetchSection}.
 * @returns {Promise<Record<string, string>>} A map of section id to HTML.
 * @throws {RequestError}
 */
export async function fetchSections(sectionIds, { url, params, signal, cache: useCache = true } = {}) {
  const ids = Array.from(new Set((sectionIds || []).filter(Boolean)));

  if (ids.length === 0) return {};
  if (ids.length === 1) {
    const html = await fetchSection(ids[0], { url, params, signal, cache: useCache });
    return { [ids[0]]: html };
  }

  const requestUrl = buildSectionUrl({ url, sections: ids, params });

  if (useCache) {
    const cached = readCache(requestUrl);
    if (cached !== null) return JSON.parse(cached);
  }

  const pending = inFlight.get(requestUrl);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(requestUrl, {
      signal,
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new RequestError('Sections could not be rendered.', { status: response.status });
    }

    const data = await response.json();
    if (useCache) writeCache(requestUrl, JSON.stringify(data));

    return data;
  })();

  inFlight.set(requestUrl, request);

  try {
    return await request;
  } finally {
    inFlight.delete(requestUrl);
  }
}

/* ==========================================================================
   Rendering
   ========================================================================== */

/**
 * Fetch a section and morph it into a live element.
 *
 * @param {string} sectionId
 * @param {Object} options
 * @param {Element} options.into The live element to update.
 * @param {string} [options.selector] What to pull out of the response.
 *   Defaults to the target's tag name.
 * @param {string} [options.url] Base URL.
 * @param {Object} [options.params] Extra query parameters.
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.cache=true]
 * @param {Object} [options.morphOptions] Forwarded to {@link morph}.
 * @returns {Promise<boolean>} True when a matching node was found and applied.
 */
export async function renderSection(
  sectionId,
  { into, selector, url, params, signal, cache: useCache = true, morphOptions } = {}
) {
  if (!(into instanceof Element)) {
    throw new RequestError('renderSection requires a target element.', { status: 0 });
  }

  const html = await fetchSection(sectionId, { url, params, signal, cache: useCache });
  return applyHTML(html, into, { selector, sectionId, morphOptions });
}

/**
 * Apply an HTML response to a live element.
 *
 * @param {string} html Document HTML containing the replacement.
 * @param {Element} into The live element to update.
 * @param {Object} [options]
 * @param {string} [options.selector] Defaults to the target's tag name.
 * @param {string} [options.sectionId] Included in the dispatched event detail.
 * @param {Object} [options.morphOptions] Forwarded to {@link morph}.
 * @returns {boolean} True when a matching node was found and applied.
 */
export function applyHTML(html, into, { selector, sectionId = null, morphOptions } = {}) {
  const target = selector || into.tagName.toLowerCase();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const next = parsed.querySelector(target);

  if (!next) {
    console.warn(`[Boost10] applyHTML found no "${target}" in the response.`);
    return false;
  }

  morph(into, next, morphOptions);
  notifyRendered(sectionId, into);

  return true;
}

/**
 * Apply a map of section id to HTML, as returned by `?sections=` or by the Cart
 * AJAX API's `sections` field.
 *
 * @param {Record<string, string>} sections
 * @param {Object} [options]
 * @param {Document|Element} [options.root=document]
 * @param {Object} [options.morphOptions] Forwarded to {@link morph}.
 * @returns {string[]} The ids that were actually applied.
 */
export function applySections(sections, { root = document, morphOptions } = {}) {
  const applied = [];

  for (const [sectionId, html] of Object.entries(sections || {})) {
    if (typeof html !== 'string' || html.length === 0) continue;

    const live =
      root.querySelector(`#shopify-section-${cssEscape(sectionId)}`) ||
      root.querySelector(`[data-section-id="${cssEscape(sectionId)}"]`);

    if (!live) continue;

    const parsed = new DOMParser().parseFromString(html, 'text/html');

    const body = parsed.body;
    const onlyRoot = body.children.length === 1 ? body.firstElementChild : null;

    const next =
      parsed.querySelector(`#shopify-section-${cssEscape(sectionId)}`) ||
      parsed.querySelector(`[data-section-id="${cssEscape(sectionId)}"]`) ||
      (onlyRoot?.tagName === live.tagName ? onlyRoot : null);

    if (!next) {
      console.warn(`[Boost10] applySections found no markup for "${sectionId}" in the response.`);
      continue;
    }

    morph(live, next, morphOptions);
    notifyRendered(sectionId, live);
    applied.push(sectionId);
  }

  return applied;
}

/**
 * Extract a single element from a section response without applying it.
 *
 * @param {string} html
 * @param {string} selector
 * @returns {Element|null}
 */
export function extractFromHTML(html, selector) {
  return new DOMParser().parseFromString(html, 'text/html').querySelector(selector);
}

/* ==========================================================================
   Notification
   ========================================================================== */

/**
 * Announce that a section finished rendering.
 *
 * @param {string|null} sectionId
 * @param {Element} element
 * @private
 */
function notifyRendered(sectionId, element) {
  element.dispatchEvent(
    new CustomEvent(EVENTS.SECTION_RENDERED, {
      detail: sectionRenderedDetail(sectionId, { source: element }),
      bubbles: true,
      composed: true
    })
  );
}

/**
 * Shopify section ids can contain characters that are not valid in a CSS
 * selector, and `CSS.escape` is missing on a few older mobile browsers.
 *
 * @param {string} value
 * @returns {string}
 * @private
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/([^\w-])/g, '\\$1');
}

export default { fetchSection, fetchSections, renderSection, applySections, applyHTML };
