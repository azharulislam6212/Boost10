/**
 * `<recently-viewed>` — the products this browser has looked at.
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
 * @param {string} handle
 * @returns {string[]} The list after recording.
 */
export function recordProduct(handle) {
  if (!handle) return read();

  const items = read().filter((item) => item !== handle);

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
    return [];
  }
}

/**
 * @param {string[]} items
 */
function write(items) {
  try {
    storage.set(KEY, JSON.stringify(items));
  } catch {}
}

/** Forget everything. Rendered as a control on the section when enabled. */
export function clearHistory() {
  write([]);
}

/* ==========================================================================
   <recently-viewed>
   ========================================================================== */

export class RecentlyViewed extends BaseComponent {
  setup() {
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
      console.warn('[Boost10] Recently viewed products could not be loaded.', error);
      this.remove();
      return false;
    }
  }
}

defineComponent('recently-viewed', RecentlyViewed);

export default { RecentlyViewed, recordProduct, read, clearHistory };
