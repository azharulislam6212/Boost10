/**
 * recently-viewed.js — Boost10
 *
 * `<recently-viewed>` — the products this browser has looked at.
 *
 * Records handles in `localStorage` and renders them through the Section
 * Rendering API, so the cards are the theme's real product cards rather than a
 * second implementation in JavaScript.
 *
 * ## Three rules that keep this from being creepy or useless
 *
 * **The current product is never in its own list.** A "recently viewed" row on a
 * product page whose first card is the product you are looking at is the tell of
 * a theme that did not check.
 *
 * **Nothing renders below the minimum.** One card in a row built for four looks
 * broken, and a customer on their second ever page view has no useful history.
 * The section removes itself rather than showing a lonely card.
 *
 * **The list is capped and recency-ordered.** Re-visiting a product moves it to
 * the front rather than adding a duplicate.
 *
 * Everything is client side. No request records anything anywhere, which is both
 * the Theme Store requirement and the right default for a feature that is,
 * literally, a record of what someone looked at.
 *
 * @module @theme/recently-viewed
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { storage, getRoute } from '@theme/utilities';
import { fetchSection } from '@theme/section-renderer';
import { morph } from '@theme/morph';

/** Storage key, namespaced per shop by `storage`. */
const KEY = 'recently-viewed';

/** How many handles are kept. The section shows fewer; this is the memory. */
const MAX_STORED = 20;

/**
 * Record a product handle. Called by the product template on every product page.
 *
 * Exported separately from the element because the recording has to happen on
 * pages that do not render the section at all — the whole point is that the
 * history exists before there is anything to show.
 *
 * @param {string} handle
 * @returns {string[]} The list after recording.
 */
export function recordProduct(handle) {
  if (!handle) return read();

  const items = read().filter((item) => item !== handle);

  // Most recent first. Re-visiting moves a product rather than duplicating it.
  items.unshift(handle);
  if (items.length > MAX_STORED) items.length = MAX_STORED;

  write(items);
  return items;
}

/**
 * @returns {string[]}
 */
export function read() {
  try {
    const raw = storage.get(KEY, null);
    const parsed = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    // Storage disabled or the value corrupted. An empty history is a fine
    // outcome for a decorative feature.
    return [];
  }
}

/**
 * @param {string[]} items
 */
function write(items) {
  try {
    storage.set(KEY, JSON.stringify(items));
  } catch {
    // Nothing to do and nothing worth telling the customer: unlike a cart,
    // nobody chose to save this, so a warning about it would be noise.
  }
}

/**
 * Forget everything. Rendered as a control on the section when enabled.
 */
export function clearHistory() {
  write([]);
}

/* ==========================================================================
   <recently-viewed>
   ========================================================================== */

/**
 * Markup:
 *
 *   <recently-viewed
 *     data-section-id="recently-viewed"
 *     data-limit="4"
 *     data-minimum="2"
 *     data-exclude="current-product-handle">
 *     <div data-ref="content" data-recently-viewed-content></div>
 *   </recently-viewed>
 */
export class RecentlyViewed extends BaseComponent {
  setup() {
    // Record before rendering, so the current product is in the history for the
    // *next* page even though it is excluded from this one.
    if (this.dataset.exclude) recordProduct(this.dataset.exclude);

    this.on(this, 'click', (event) => {
      const clear = event.target instanceof Element ? event.target.closest('[data-history-clear]') : null;
      if (!clear) return;

      event.preventDefault();
      clearHistory();
      this.remove();
    });

    this.load();
  }

  /**
   * @returns {number}
   */
  get limit() {
    return Number(this.dataset.limit) || 4;
  }

  /**
   * @returns {number} Below this the section does not render at all.
   */
  get minimum() {
    return Number(this.dataset.minimum) || 2;
  }

  /**
   * @returns {string[]} Handles to show, excluding the current product.
   */
  get handles() {
    const exclude = this.dataset.exclude;
    return read()
      .filter((handle) => handle !== exclude)
      .slice(0, this.limit);
  }

  /**
   * Fetch the cards and put them in place.
   *
   * @returns {Promise<boolean>}
   */
  async load() {
    const handles = this.handles;

    // One card in a row built for four looks broken. Removing beats rendering a
    // heading over a single lonely product.
    if (handles.length < this.minimum) {
      this.remove();
      return false;
    }

    try {
      const sectionId = this.dataset.sectionId || 'recently-viewed';
      const params = new URLSearchParams({ handles: handles.join(',') });
      const url = `${getRoute('rootUrl')}?section_id=${sectionId}&${params}`;

      const html = await fetchSection(url);
      const next = new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('[data-recently-viewed-content]');

      if (!next || next.children.length === 0) {
        this.remove();
        return false;
      }

      const target = this.refs.content instanceof HTMLElement ? this.refs.content : this;
      morph(target, next, { childrenOnly: true });

      this.removeAttribute('hidden');
      return true;
    } catch (error) {
      // A decorative row. Failing quietly is the correct behaviour; an error
      // message where a product row should be is worse than an absent row.
      console.warn('[Boost10] Recently viewed products could not be loaded.', error);
      this.remove();
      return false;
    }
  }
}

defineComponent('recently-viewed', RecentlyViewed);

export default { RecentlyViewed, recordProduct, read, clearHistory };
