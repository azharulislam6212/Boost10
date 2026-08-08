/**
 * compare.js — Boost10
 *
 * `<product-compare>` and `<compare-trigger>` — side-by-side product comparison.
 *
 * Off by default. It is genuinely useful for a store selling twelve variants of
 * one technical product, and clutter for a store selling t-shirts, so it is a
 * merchant setting rather than an assumption.
 *
 * Everything is stored in the browser, namespaced per shop, and nothing is sent
 * anywhere. A theme that stored comparison data server-side would be doing an
 * app's job, which the Theme Store rejects — and it would also mean a customer's
 * comparison list following them across devices, which nobody expects from a
 * feature they used once.
 *
 * The comparison table itself is rendered by Liquid through the Section
 * Rendering API, so prices, badges, swatches and translated attribute names are
 * correct without being rebuilt in JavaScript.
 *
 * Markup:
 *
 *   <compare-trigger data-product-handle="mango-protein">
 *     <button type="button" data-ref="button" aria-pressed="false">…</button>
 *   </compare-trigger>
 *
 *   <product-compare data-section-id="compare" data-limit="4">
 *     <button data-ref="open" hidden>…</button>
 *     <span data-ref="count"></span>
 *     <drawer-component id="CompareDrawer">
 *       <dialog data-ref="dialog">
 *         <div data-ref="panel">
 *           <div data-ref="content" data-compare-content></div>
 *           <button data-ref="clear">…</button>
 *         </div>
 *       </dialog>
 *     </drawer-component>
 *   </product-compare>
 *
 * @module @theme/compare
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { fetchSection } from '@theme/section-renderer';
import { morph } from '@theme/morph';
import { storage, themeString, announce, announceUrgent } from '@theme/utilities';

/** Storage key, namespaced per shop by `storage`. */
const STORAGE_KEY = 'compare';

/* ==========================================================================
   Shared list
   ========================================================================== */

/**
 * The comparison list. A module singleton for the same reason the cart is one:
 * the triggers on product cards, the drawer, and the count in the header all
 * need the same list, and the drawer may not be on the page at all.
 */
export const compareList = {
  /**
   * @returns {string[]} Product handles, in the order they were added.
   */
  get handles() {
    const stored = storage.get(STORAGE_KEY, []);
    return Array.isArray(stored) ? stored : [];
  },

  /**
   * @returns {number}
   */
  get limit() {
    return Number(window.Theme?.settings?.compareLimit) || 4;
  },

  /**
   * @param {string} handle
   * @returns {boolean}
   */
  has(handle) {
    return this.handles.includes(handle);
  },

  /**
   * Add a product.
   *
   * @param {string} handle
   * @returns {boolean} False when the list is already full.
   */
  add(handle) {
    const current = this.handles;
    if (current.includes(handle)) return true;

    if (current.length >= this.limit) {
      announceUrgent(themeString('compareLimit', '', { count: this.limit }));
      return false;
    }

    this._write([...current, handle]);
    announce(themeString('compareAdded', ''));
    return true;
  },

  /**
   * @param {string} handle
   */
  remove(handle) {
    this._write(this.handles.filter((item) => item !== handle));
    announce(themeString('compareRemoved', ''));
  },

  /**
   * @param {string} handle
   * @returns {boolean} The state after toggling.
   */
  toggle(handle) {
    if (this.has(handle)) {
      this.remove(handle);
      return false;
    }

    return this.add(handle);
  },

  /**
   * Empty the list.
   */
  clear() {
    this._write([]);
  },

  /**
   * Private by convention, not by syntax: `#` fields are a class feature and
   * this is an object literal, chosen so the list can be imported and called
   * without instantiating anything.
   *
   * @param {string[]} handles
   * @private
   */
  _write(handles) {
    // `storage` swallows quota and private-mode failures and returns false. The
    // feature then degrades to not persisting rather than throwing on click.
    storage.set(STORAGE_KEY, handles);

    document.dispatchEvent(
      new CustomEvent(EVENTS.COMPARE_CHANGE, {
        detail: { handles, count: handles.length },
        bubbles: true
      })
    );
  }
};

/* ==========================================================================
   <compare-trigger>
   ========================================================================== */

/**
 * The add-to-compare control on a product card.
 *
 * Rendered hidden by Liquid and revealed here, so a store with the feature
 * turned off never ships a button that does nothing. `aria-pressed` carries the
 * state, because this is a toggle, not a link.
 */
export class CompareTrigger extends BaseComponent {
  static requiredRefs = ['button'];

  setup() {
    if (window.Theme?.settings?.compare === false) {
      this.remove();
      return;
    }

    this.hidden = false;

    this.on(this.refs.button, 'click', (event) => {
      event.preventDefault();
      compareList.toggle(this.handle);
    });

    this.on(document, EVENTS.COMPARE_CHANGE, () => this.render());

    this.render();
  }

  /**
   * @returns {string}
   */
  get handle() {
    return this.dataset.productHandle || '';
  }

  /**
   * Reflect the shared list.
   */
  render() {
    const active = compareList.has(this.handle);

    this.refs.button.setAttribute('aria-pressed', String(active));
    this.toggleAttribute('data-active', active);

    const label = active ? themeString('compareRemoveLabel', '') : themeString('compareAddLabel', '');
    if (label) this.refs.button.setAttribute('aria-label', label);
  }
}

defineComponent('compare-trigger', CompareTrigger);

/* ==========================================================================
   <product-compare>
   ========================================================================== */

/**
 * The comparison bar and drawer.
 *
 * The bar appears once two products are selected — comparing one product with
 * nothing is not a comparison — and the table is fetched only when the drawer is
 * opened, not on every toggle.
 */
export class ProductCompare extends BaseComponent {
  /** @type {AbortController|null} */
  #request = null;

  /** The handle list already rendered, so reopening does not refetch. */
  #rendered = '';

  setup() {
    if (window.Theme?.settings?.compare === false) {
      this.remove();
      return;
    }

    this.on(document, EVENTS.COMPARE_CHANGE, () => this.render());

    if (this.refs.open) {
      this.on(this.refs.open, 'click', (event) => {
        event.preventDefault();
        this.openDrawer();
      });
    }

    if (this.refs.clear) {
      this.on(this.refs.clear, 'click', (event) => {
        event.preventDefault();
        compareList.clear();
        this.drawer?.close?.();
      });
    }

    // Removing a product from inside the table.
    this.on(this, 'click', (event) => {
      const remove = event.target instanceof Element ? event.target.closest('[data-compare-remove]') : null;
      if (!(remove instanceof HTMLElement)) return;

      event.preventDefault();
      compareList.remove(remove.dataset.compareRemove);
    });

    this.render();
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {HTMLElement|null}
   */
  get drawer() {
    return this.querySelector('drawer-component');
  }

  /**
   * Open the comparison drawer, loading the table first.
   *
   * @returns {Promise<void>}
   */
  async openDrawer() {
    await this.load();
    await this.drawer?.open?.(this.refs.open);
  }

  /**
   * Fetch and render the comparison table.
   *
   * @returns {Promise<boolean>}
   */
  async load() {
    const handles = compareList.handles;
    const key = handles.join(',');

    if (handles.length === 0) return false;
    if (key === this.#rendered) return true;

    const target = this.refs.content;
    if (!(target instanceof HTMLElement)) return false;

    this.#request?.abort();
    this.#request = new AbortController();

    this.setLoading(true);
    target.setAttribute('aria-busy', 'true');

    try {
      const html = await fetchSection(this.dataset.sectionId || 'compare', {
        params: { handles: key },
        signal: this.#request.signal,
        cache: false
      });

      const next = new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('[data-compare-content]');

      if (!next) return false;

      morph(target, next, { childrenOnly: true });
      this.#rendered = key;

      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      console.error('[Boost10] The comparison table could not be loaded.', error);
      announceUrgent(themeString('networkError', ''));
      return false;
    } finally {
      this.setLoading(false);
      target.removeAttribute('aria-busy');
      this.#request = null;
    }
  }

  /**
   * Reflect the shared list in the bar.
   */
  render() {
    const count = compareList.handles.length;

    if (this.refs.count instanceof HTMLElement) {
      this.refs.count.textContent = String(count);
    }

    if (this.refs.open instanceof HTMLElement) {
      // Two is the minimum that makes the word "compare" mean anything.
      this.refs.open.hidden = count < 2;
      this.refs.open.textContent = themeString('compareTriggerCount', '', { count });
    }

    this.toggleAttribute('data-visible', count > 0);
    this.dataset.count = String(count);

    // The rendered table is stale the moment the list changes, and the drawer
    // may be open while it happens.
    const key = compareList.handles.join(',');
    if (key !== this.#rendered && this.drawer?.isOpen) {
      this.#rendered = '';
      if (count >= 2) {
        this.load();
      } else {
        this.drawer?.close?.();
      }
    } else if (key !== this.#rendered) {
      this.#rendered = '';
    }
  }
}

defineComponent('product-compare', ProductCompare);

export default { compareList, CompareTrigger, ProductCompare };
