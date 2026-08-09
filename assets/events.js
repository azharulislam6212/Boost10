/**
 * events.js — Boost10
 *
 * The single source of truth for every custom event name the theme dispatches,
 * plus small constructors that build the `detail` payload for each one.
 *
 * This file is NOT an event bus. It holds no listeners, no subscriber list and
 * no routing logic. It exists so that no module ever types an event name as a
 * string literal, which is how event-name drift starts. Dispatching is done by
 * the owning element through `BaseComponent#dispatch()`, which calls native
 * `dispatchEvent()` directly.
 *
 * Ownership rule: only the element that owns a piece of state dispatches events
 * about that state. `<cart-drawer>` dispatches `cart:*`. `<variant-picker>`
 * dispatches `variant:*`. Nothing else may.
 *
 * @module @theme/events
 */

/**
 * Canonical event names, grouped by domain.
 *
 * Naming: `domain:verb`, lowercase, colon-separated. Past tense reports a fact
 * that already happened; present tense reports an intent that a listener may
 * still cancel.
 *
 * Deliberately a plain, mutable object — never frozen — so that a section can
 * register a namespaced event of its own without patching this file.
 *
 * @type {Record<string, string>}
 */
export const EVENTS = {
  /* ------------------------------------------------------------------ cart */
  CART_UPDATED: 'cart:updated',
  CART_ERROR: 'cart:error',
  CART_ITEM_ADDED: 'cart:item-added',
  CART_ITEM_REMOVED: 'cart:item-removed',
  CART_ITEM_CHANGED: 'cart:item-changed',
  CART_DISCOUNT: 'cart:discount-applied',
  CART_NOTE_UPDATED: 'cart:note-updated',
  CART_LOADING: 'cart:loading',

  /* --------------------------------------------------------------- product */
  VARIANT_CHANGE: 'variant:change',
  VARIANT_UNAVAILABLE: 'variant:unavailable',
  SELLING_PLAN_CHANGE: 'selling-plan:change',
  QUANTITY_CHANGE: 'quantity:change',
  PRODUCT_FORM_SUBMIT: 'product-form:submit',
  PRODUCT_FORM_ERROR: 'product-form:error',

  /* ----------------------------------------------------------------- media */
  CAROUSEL_CHANGE: 'carousel:change',
  MEDIA_SELECT: 'media:select',
  MEDIA_LOADED: 'media:loaded',
  ZOOM_OPEN: 'zoom:open',
  ZOOM_CLOSE: 'zoom:close',

  /* ------------------------------------------------- collection and search */
  FILTER_UPDATE: 'filter:update',
  FILTER_LOADED: 'filter:loaded',
  SEARCH_RESULTS: 'search:results',

  /* -------------------------------------------------------------- overlays */
  OVERLAY_OPEN: 'overlay:open',
  OVERLAY_CLOSE: 'overlay:close',

  /* --------------------------------------------------------------- staging */
  SECTION_RENDERED: 'section:rendered',

  /* -------------------------------------------------------- client memory */
  BUNDLE_ITEM_TOGGLE: 'bundle:item-toggle',
  BUNDLE_CHANGE: 'bundle:change',
  COMPARE_CHANGE: 'compare:change',
  RECENTLY_VIEWED_CHANGE: 'recently-viewed:change'
};

/**
 * Shopify Theme Editor events. Handled only through `BaseComponent` lifecycle
 * hooks — no module should attach to these directly.
 *
 * @type {Record<string, string>}
 */
export const EDITOR_EVENTS = {
  SECTION_LOAD: 'shopify:section:load',
  SECTION_UNLOAD: 'shopify:section:unload',
  SECTION_SELECT: 'shopify:section:select',
  SECTION_DESELECT: 'shopify:section:deselect',
  SECTION_REORDER: 'shopify:section:reorder',
  BLOCK_SELECT: 'shopify:block:select',
  BLOCK_DESELECT: 'shopify:block:deselect'
};

/* -------------------------------------------------------------------------- */
/*  Detail constructors                                                       */
/*                                                                            */
/*  Each returns a plain, serialisable object. No DOM nodes, no class          */
/*  instances, no functions — a `detail` that cannot be cloned is a `detail`   */
/*  that cannot be logged, replayed or tested.                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} CartUpdatedDetail
 * @property {Object} cart Full cart object returned by the Shopify Cart API.
 * @property {string} source What triggered the change, e.g. `'add'`, `'change'`.
 * @property {Object|null} [added] The add response, when the change was an add.
 */

/**
 * @param {Object} cart
 * @param {string} source
 * @param {Object|null} [added]
 * @returns {CartUpdatedDetail}
 */
export function cartUpdatedDetail(cart, source, added = null) {
  return {
    cart,
    source,
    added,
    itemCount: cart?.item_count ?? 0,
    totalPrice: cart?.total_price ?? 0
  };
}

/**
 * @param {string} message Already-translated, customer-facing message.
 * @param {Object} [options]
 * @param {number|null} [options.status] HTTP status, when the error came from a request.
 * @param {number|null} [options.line] Cart line index, when the error is line-scoped.
 * @param {string|null} [options.code] Machine-readable code for the failing operation.
 * @returns {Object}
 */
export function cartErrorDetail(message, { status = null, line = null, code = null } = {}) {
  return { message, status, line, code };
}

/**
 * @param {Object|null} variant Shopify variant object, or `null` when the
 *   selected combination does not exist.
 * @param {Object} context
 * @param {Array<{name: string, value: string, position: number}>} context.options
 * @param {number|string} context.productId
 * @param {string} context.sectionId
 * @returns {Object}
 */
export function variantChangeDetail(variant, { options, productId, sectionId }) {
  return {
    variant,
    variantId: variant?.id ?? null,
    available: Boolean(variant?.available),
    options,
    productId,
    sectionId
  };
}

/**
 * @param {number|string|null} sellingPlanId `null` means one-time purchase.
 * @param {Object} [context]
 * @param {string|null} [context.group] Selling plan group name.
 * @param {number|null} [context.price] Price in cents for the selected plan.
 * @param {number|string|null} [context.variantId]
 * @returns {Object}
 */
export function sellingPlanChangeDetail(sellingPlanId, { group = null, price = null, variantId = null } = {}) {
  return { sellingPlanId, group, price, variantId, isSubscription: sellingPlanId !== null };
}

/**
 * @param {number|string} mediaId
 * @param {number} index Zero-based position in the gallery.
 * @param {string} [mediaType] `'image'`, `'video'`, `'model'` or `'external_video'`.
 * @returns {Object}
 */
export function mediaSelectDetail(mediaId, index, mediaType = 'image') {
  return { mediaId, index, mediaType };
}

/**
 * @param {string} url The URL the filtered results were fetched from.
 * @param {Object} [context]
 * @param {number} [context.activeCount] Number of filters currently applied.
 * @param {number|null} [context.resultsCount]
 * @param {boolean} [context.appended] `true` for load-more and infinite scroll.
 * @returns {Object}
 */
export function filterUpdateDetail(url, { activeCount = 0, resultsCount = null, appended = false } = {}) {
  return { url, activeCount, resultsCount, appended };
}

/**
 * @param {string} id Stable identifier of the overlay, e.g. `'cart-drawer'`.
 * @param {Object} [context]
 * @param {string|null} [context.triggerId] `id` of the element that opened it.
 * @param {string} [context.type] `'drawer'`, `'modal'`, `'zoom'` or `'toast'`.
 * @returns {Object}
 */
export function overlayDetail(id, { triggerId = null, type = 'drawer' } = {}) {
  return { id, triggerId, type };
}

/**
 * @param {string} sectionId
 * @param {Object} [context]
 * @param {string|null} [context.source] Which module requested the render.
 * @returns {Object}
 */
export function sectionRenderedDetail(sectionId, { source = null } = {}) {
  return { sectionId, source };
}

/**
 * Shared shape for the three localStorage-backed engines.
 *
 * @param {string[]} handles Current contents, after the change.
 * @param {Object} [change]
 * @param {string|null} [change.added]
 * @param {string|null} [change.removed]
 * @returns {Object}
 */
export function collectionChangeDetail(handles, { added = null, removed = null } = {}) {
  return { handles, count: handles.length, added, removed };
}

export default EVENTS;