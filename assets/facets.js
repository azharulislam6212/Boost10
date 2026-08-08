/**
 * facets.js — Boost10
 *
 * Collection and search filtering.
 *
 *   <facet-filters>  Owns the active filter state and the URL
 *   <facet-drawer>   The mobile filter drawer
 *   <price-range>    Dual-handle min/max, backed by two real number inputs
 *   <sort-by>        Sort order
 *
 * The division of labour matters. `<facet-filters>` decides *what* the results
 * should be and produces a URL; `<results-list>` decides *how* the new results
 * appear and where focus lands. Neither reaches into the other beyond one public
 * method call.
 *
 * Everything is built on a real `<form method="get">` containing real inputs
 * whose names are Shopify's filter parameters. With JavaScript disabled the form
 * submits and the server filters, which is not a fallback so much as the source
 * of truth: this module reads the same form the server would have received.
 *
 * History is written with `pushState`, so Back returns to the previous filter
 * state rather than leaving the store, and a filtered view can be shared or
 * bookmarked.
 *
 * @module @theme/facets
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { DrawerComponent } from '@theme/dialog';
import { EVENTS, filterUpdateDetail } from '@theme/events';
import { fetchSection } from '@theme/section-renderer';
import { morph } from '@theme/morph';
import { announce, announceUrgent, clamp, debounce, formatMoney, storage, themeString } from '@theme/utilities';

/* ==========================================================================
   <facet-filters>
   ========================================================================== */

/**
 * Markup:
 *
 *   <facet-filters data-section-id="main-collection" data-results="ProductGrid">
 *     <form data-ref="form">
 *       <input type="checkbox" name="filter.v.option.color" value="Blue">
 *       <price-range>…</price-range>
 *       <button type="submit" class="no-js-only">Apply</button>
 *     </form>
 *     <div data-ref="active">…removable pills…</div>
 *     <button data-ref="clear">Clear all</button>
 *   </facet-filters>
 */
export class FacetFilters extends BaseComponent {
  static requiredRefs = ['form'];

  /** @type {AbortController|null} */
  #request = null;

  /** The URL currently rendered, so a duplicate request is skipped. */
  #currentUrl = window.location.href;

  setup() {
    this.#currentUrl = window.location.href;

    // Submit is the no-JS path and stays functional; here it is intercepted so
    // the page does not reload.
    this.on(this.refs.form, 'submit', (event) => {
      event.preventDefault();
      this.apply();
    });

    // Checkbox and radio changes apply immediately. Price ranges debounce
    // themselves inside <price-range> and dispatch a change when settled.
    this.on(this.refs.form, 'change', this.#onChange);

    this.on(this, 'click', this.#onClick);

    // Back and forward must restore the results, not just the URL.
    this.on(window, 'popstate', () => this.apply({ url: window.location.href, push: false }));

    this.#syncActiveCount();
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {string} The section id to re-render.
   */
  get sectionId() {
    return this.dataset.sectionId || '';
  }

  /**
   * @returns {ResultsList|null} The results container this instance drives.
   */
  get results() {
    const id = this.dataset.results;
    const element = id ? document.getElementById(id) : null;
    return element?.closest('results-list') || document.querySelector('results-list');
  }

  /**
   * @returns {number} How many filter values are currently selected.
   */
  get activeCount() {
    return this.#selectedInputs().length;
  }

  /**
   * Build the URL the current form state represents.
   *
   * Empty values are dropped, and `page` is always dropped: changing a filter
   * while on page four should show page one of the new results, not an empty
   * page four.
   *
   * @returns {string}
   */
  buildUrl() {
    const data = new FormData(this.refs.form);
    const params = new URLSearchParams();

    for (const [key, value] of data.entries()) {
      if (value === '' || value === null) continue;
      params.append(key, String(value));
    }

    params.delete('page');

    const query = params.toString();
    return `${window.location.pathname}${query ? `?${query}` : ''}`;
  }

  /**
   * Fetch and render results for the current form state.
   *
   * @param {Object} [options]
   * @param {string} [options.url] Use this URL instead of building one.
   * @param {boolean} [options.push=true] Write a history entry.
   * @param {boolean} [options.focus=true] Move focus to the results.
   * @returns {Promise<boolean>}
   */
  async apply({ url, push = true, focus = true } = {}) {
    const target = url || this.buildUrl();

    if (target === this.#currentUrl && !url) return false;

    // Clicking three filters quickly must not race: only the last request may
    // paint, or the grid ends up showing a filter combination nobody chose.
    this.#request?.abort();
    this.#request = new AbortController();

    this.#setLoading(true);

    try {
      const html = await fetchSection(this.sectionId, {
        url: target,
        signal: this.#request.signal,
        cache: false
      });

      this.#currentUrl = target;
      if (push) window.history.pushState({ filters: true }, '', target);

      this.results?.update(html, { focus });
      this.#updateFilterMarkup(html);
      this.#syncActiveCount();

      this.dispatch(
        EVENTS.FILTER_UPDATE,
        filterUpdateDetail(target, { activeCount: this.activeCount })
      );

      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      console.error('[Boost10] Filtering failed.', error);
      announceUrgent(themeString('networkError', ''));
      return false;
    } finally {
      this.#setLoading(false);
      this.#request = null;
    }
  }

  /**
   * Remove a single filter value.
   *
   * @param {string} name
   * @param {string} value
   * @returns {Promise<void>}
   */
  async remove(name, value) {
    for (const input of this.#selectedInputs()) {
      if (input.name !== name) continue;
      if (value !== undefined && input.value !== value) continue;

      if (input.type === 'checkbox' || input.type === 'radio') {
        input.checked = false;
      } else {
        input.value = '';
      }
    }

    await this.apply();
  }

  /**
   * Clear every filter.
   *
   * @returns {Promise<void>}
   */
  async clearAll() {
    for (const input of this.#selectedInputs()) {
      if (input.type === 'checkbox' || input.type === 'radio') {
        input.checked = false;
      } else {
        input.value = '';
      }
    }

    for (const range of this.querySelectorAll('price-range')) range.reset?.();

    await this.apply();
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @returns {HTMLInputElement[]}
   * @private
   */
  #selectedInputs() {
    return Array.from(this.refs.form.elements).filter((element) => {
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement)) return false;
      if (!element.name || !element.name.startsWith('filter')) return false;

      if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
        return element.checked;
      }

      return element.value !== '';
    });
  }

  /**
   * Re-render the filter controls themselves.
   *
   * Counts next to each value change as other filters are applied — "Blue (12)"
   * becomes "Blue (3)" — and values with no matches are disabled by the server.
   * Morphing rather than replacing keeps open filter groups open and keeps focus
   * on the checkbox the customer just used.
   *
   * @param {string} html
   * @private
   */
  #updateFilterMarkup(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const nextForm = parsed.querySelector('facet-filters [data-ref="form"]');

    if (nextForm) morph(this.refs.form, nextForm);

    const nextActive = parsed.querySelector('facet-filters [data-ref="active"]');
    if (nextActive && this.refs.active instanceof HTMLElement) morph(this.refs.active, nextActive);

    // The drawer shows the same filters; keep it in step so opening it after
    // filtering does not show stale counts.
    const drawer = document.querySelector('facet-drawer [data-ref="form"]');
    if (drawer && nextForm && drawer !== this.refs.form) morph(drawer, nextForm.cloneNode(true));
  }

  /** @private */
  #syncActiveCount() {
    const count = this.activeCount;

    this.dataset.activeCount = String(count);

    for (const badge of document.querySelectorAll('[data-facet-count]')) {
      badge.textContent = count > 0 ? String(count) : '';
      badge.toggleAttribute('hidden', count === 0);
    }

    if (this.refs.clear instanceof HTMLElement) {
      this.refs.clear.toggleAttribute('hidden', count === 0);
    }
  }

  /**
   * @param {Event} event
   * @private
   */
  #onChange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    // <price-range> and <sort-by> announce their own settled values.
    if (target.closest('price-range')) return;

    this.apply();
  };

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const remove = target.closest('[data-remove-filter]');
    if (remove instanceof HTMLElement) {
      event.preventDefault();
      this.remove(remove.dataset.filterName, remove.dataset.filterValue);
      return;
    }

    if (target.closest('[data-ref="clear"], [data-clear-filters]')) {
      event.preventDefault();
      this.clearAll();
    }
  };

  /**
   * @param {boolean} loading
   * @private
   */
  #setLoading(loading) {
    this.toggleAttribute('data-loading', loading);
    this.refs.form.setAttribute('aria-busy', loading ? 'true' : 'false');
    document.documentElement.toggleAttribute('data-filtering', loading);
  }
}

defineComponent('facet-filters', FacetFilters);

/* ==========================================================================
   <facet-drawer>
   ========================================================================== */

/**
 * The mobile filter drawer.
 *
 * On small screens filters are applied on close rather than on each tap. Every
 * tap triggering a network request and a grid re-render behind a drawer the
 * customer cannot see is both wasteful and disorienting — the result count is
 * announced for results they are not looking at.
 *
 * The footer therefore shows a live count and an apply button, and the drawer
 * defers to `<facet-filters>` for the actual work.
 */
export class FacetDrawer extends DrawerComponent {
  get overlayType() {
    return 'facets';
  }

  setup() {
    super.setup();

    this.on(this, 'click', (event) => {
      const apply = event.target instanceof Element ? event.target.closest('[data-apply-filters]') : null;
      if (!apply) return;

      event.preventDefault();
      this.applyAndClose();
    });
  }

  /**
   * Apply the drawer's filters and close it.
   *
   * @returns {Promise<void>}
   */
  async applyAndClose() {
    const filters = document.querySelector('facet-filters');
    await this.close();
    await filters?.apply?.();
  }
}

defineComponent('facet-drawer', FacetDrawer);

/* ==========================================================================
   <price-range>
   ========================================================================== */

/**
 * A min/max price filter.
 *
 * Two real `<input type="number">` controls carry the value and the names
 * Shopify expects, so the filter works without JavaScript and is announced
 * correctly. The dual-handle slider on top of them is decorative and
 * `aria-hidden`: a custom two-thumb slider that is genuinely accessible is
 * considerably harder than it looks, and the number inputs already are.
 *
 * The two values are kept from crossing, and a change is only reported once the
 * customer stops adjusting — a filter request per pixel of drag is unusable.
 *
 * Markup:
 *
 *   <price-range data-min="0" data-max="25000">
 *     <input data-ref="min" type="number" name="filter.v.price.gte" min="0" max="250">
 *     <input data-ref="max" type="number" name="filter.v.price.lte" min="0" max="250">
 *     <div data-ref="track" aria-hidden="true">
 *       <span data-ref="fill"></span>
 *     </div>
 *     <output data-ref="output"></output>
 *   </price-range>
 */
export class PriceRange extends BaseComponent {
  static requiredRefs = ['min', 'max'];

  setup() {
    const commit = debounce(() => this.commit(), 500);

    for (const input of [this.refs.min, this.refs.max]) {
      this.on(input, 'input', () => {
        this.#clampAgainstEachOther(input);
        this.#paint();
        commit();
      });

      this.on(input, 'change', () => {
        this.#clampAgainstEachOther(input);
        this.#paint();
        commit();
      });
    }

    this.#paint();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {number} Lowest selectable price, in cents.
   */
  get floor() {
    return Number(this.dataset.min) || 0;
  }

  /**
   * @returns {number} Highest selectable price, in cents.
   */
  get ceiling() {
    return Number(this.dataset.max) || 0;
  }

  /**
   * @returns {{ min: number|null, max: number|null }} Values in cents.
   */
  get value() {
    const min = this.refs.min.value === '' ? null : Number(this.refs.min.value) * 100;
    const max = this.refs.max.value === '' ? null : Number(this.refs.max.value) * 100;
    return { min, max };
  }

  /**
   * Clear both ends.
   */
  reset() {
    this.refs.min.value = '';
    this.refs.max.value = '';
    this.#paint();
  }

  /**
   * Report the settled range to `<facet-filters>`.
   */
  commit() {
    const { min, max } = this.value;

    announce(
      themeString('facetsPriceRange', '', {
        min: formatMoney(min ?? this.floor),
        max: formatMoney(max ?? this.ceiling)
      })
    );

    this.closest('facet-filters')?.apply?.({ focus: false });
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Stop the two ends crossing.
   *
   * The input being edited wins, and the other one moves out of its way, which
   * is less surprising than snapping the value the customer just typed.
   *
   * @param {HTMLInputElement} edited
   * @private
   */
  #clampAgainstEachOther(edited) {
    const min = this.refs.min;
    const max = this.refs.max;

    if (min.value === '' || max.value === '') return;

    const minValue = Number(min.value);
    const maxValue = Number(max.value);

    if (minValue <= maxValue) return;

    if (edited === min) {
      max.value = String(minValue);
    } else {
      min.value = String(maxValue);
    }
  }

  /** @private */
  #paint() {
    const span = this.ceiling - this.floor;
    if (span <= 0) return;

    const { min, max } = this.value;
    const start = clamp((((min ?? this.floor) - this.floor) / span) * 100, 0, 100);
    const end = clamp((((max ?? this.ceiling) - this.floor) / span) * 100, 0, 100);

    this.style.setProperty('--range-start', `${start}%`);
    this.style.setProperty('--range-end', `${end}%`);

    if (this.refs.output instanceof HTMLElement) {
      this.refs.output.textContent = themeString('facetsPriceRange', '', {
        min: formatMoney(min ?? this.floor),
        max: formatMoney(max ?? this.ceiling)
      });
    }
  }
}

defineComponent('price-range', PriceRange);

/* ==========================================================================
   <sort-by>
   ========================================================================== */

/**
 * The sort order control.
 *
 * A plain `<select name="sort_by">` inside the filter form, so it submits with
 * everything else when JavaScript is unavailable. Changing it applies
 * immediately, without moving focus — the customer is still in the select, and
 * pulling focus to the grid mid-interaction would close the native picker on
 * mobile.
 *
 * Markup:
 *
 *   <sort-by>
 *     <select data-ref="select" name="sort_by">…</select>
 *   </sort-by>
 */
export class SortBy extends BaseComponent {
  static requiredRefs = ['select'];

  setup() {
    this.on(this.refs.select, 'change', () => this.apply());
  }

  /**
   * @returns {string}
   */
  get value() {
    return this.refs.select.value;
  }

  /**
   * Apply the selected sort order.
   *
   * @returns {Promise<void>}
   */
  async apply() {
    const filters = this.closest('facet-filters') || document.querySelector('facet-filters');

    const label = this.refs.select.selectedOptions[0]?.textContent?.trim();
    if (label) announce(themeString('facetsSortedBy', '', { sort: label }));

    if (filters) {
      await filters.apply({ focus: false });
      return;
    }

    // No filter form on this template: fall back to a plain navigation, which is
    // what the select would have done inside a form.
    const url = new URL(window.location.href);
    url.searchParams.set('sort_by', this.value);
    url.searchParams.delete('page');
    window.location.assign(url.toString());
  }
}

defineComponent('sort-by', SortBy);

/* ==========================================================================
   <layout-toggle>
   ========================================================================== */

/**
 * Switch a product grid between grid and list.
 *
 * The choice is a display preference, not a filter, so it lives in
 * `localStorage` rather than the URL. Putting it in the URL would mean two
 * addresses for the same products — bad for sharing, worse for indexing, and it
 * would survive being sent to someone who prefers the other view.
 *
 * It writes an attribute and nothing else. The layout itself is CSS: one grid
 * that becomes rows when `data-view="list"` is set. Rebuilding the markup would
 * mean re-rendering every card to change a column count.
 *
 * Hidden below 750px, where a list view of full-width rows and a two-column grid
 * are close enough that the control costs more than it gives.
 *
 * Markup:
 *
 *   <layout-toggle data-target="ProductGrid-abc">
 *     <button data-view-option="grid" aria-pressed="true">…</button>
 *     <button data-view-option="list" aria-pressed="false">…</button>
 *   </layout-toggle>
 */
export class LayoutToggle extends BaseComponent {
  setup() {
    this.on(this, 'click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-view-option]') : null;
      if (!(button instanceof HTMLElement)) return;

      event.preventDefault();
      this.select(button.dataset.viewOption);
    });

    this.select(this.stored, { announce: false });
  }

  /**
   * @returns {'grid'|'list'}
   */
  get stored() {
    const value = storage.get('collection-view', 'grid');
    return value === 'list' ? 'list' : 'grid';
  }

  /**
   * @returns {HTMLElement|null}
   */
  get target() {
    const id = this.dataset.target;
    return (id && document.getElementById(id)) || this.closest('results-list')?.querySelector('[data-product-grid]') || null;
  }

  /**
   * @param {string} view
   * @param {{ announce?: boolean }} [options]
   */
  select(view, { announce: shouldAnnounce = true } = {}) {
    const next = view === 'list' ? 'list' : 'grid';

    const target = this.target;
    if (target) target.dataset.view = next;

    for (const button of this.querySelectorAll('[data-view-option]')) {
      button.setAttribute('aria-pressed', String(button.dataset.viewOption === next));
    }

    try {
      storage.set('collection-view', next);
    } catch {
      // A display preference that cannot persist still works for this page, and
      // is not worth telling anyone about.
    }

    if (shouldAnnounce) announce(themeString(next === 'list' ? 'viewList' : 'viewGrid', ''));
  }
}

defineComponent('layout-toggle', LayoutToggle);

export default { FacetFilters, FacetDrawer, PriceRange, SortBy, LayoutToggle };
