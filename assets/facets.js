/**
 * Collection and search filtering.
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

export class FacetFilters extends BaseComponent {
  static requiredRefs = ['form'];

  /** @type {AbortController|null} */
  #request = null;

  /** The URL currently rendered, so a duplicate request is skipped. */
  #currentUrl = window.location.href;

  setup() {
    this.#currentUrl = window.location.href;

    this.on(this.refs.form, 'submit', (event) => {
      event.preventDefault();
      this.apply();
    });

    this.on(this.refs.form, 'change', this.#onChange);

    this.on(this, 'click', this.#onClick);

    this.on(window, 'popstate', () => this.apply({ url: window.location.href, push: false }));

    this.#syncActiveCount();
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

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

      for (const range of this.querySelectorAll('price-range')) range.sync?.();

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

  /* ---------------------------------------------------------- internals -- ---- */

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
   * @param {string} html
   * @private
   */
  #updateFilterMarkup(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const nextForm = parsed.querySelector('facet-filters [data-ref="form"]');

    if (nextForm) morph(this.refs.form, nextForm);

    const nextActive = parsed.querySelector('facet-filters [data-ref="active"]');
    if (nextActive && this.refs.active instanceof HTMLElement) morph(this.refs.active, nextActive);

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

/** The mobile filter drawer. */
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

/** A min/max price filter. */
export class PriceRange extends BaseComponent {
  static requiredRefs = ['min', 'max'];

  /** How long typing has to pause before the results refresh. */
  static COMMIT_DELAY = 800;

  setup() {
    const commit = debounce((edited) => {
      this.#clampAgainstEachOther(edited);
      this.#paint();
      this.commit();
    }, PriceRange.COMMIT_DELAY);

    for (const input of [this.refs.min, this.refs.max]) {
      this.on(input, 'input', () => {
        this.#paint();
        if (this.#isSettled(input)) commit(input);
      });

      this.on(input, 'change', () => {
        commit.cancel();
        this.#clampAgainstEachOther(input);
        this.#paint();
        this.commit();
      });
    }

    this.#paint();
  }

  /* --------------------------------------------------------- public API -- ---- */

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

  /** Repaint the track after the markup has been re-rendered. */
  sync() {
    this.#paint();
  }

  /** Clear both ends. */
  reset() {
    this.refs.min.value = '';
    this.refs.max.value = '';
    this.#paint();
  }

  /** Report the settled range to `<facet-filters>`. */
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

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * A half-typed value ("12.", "-") is not worth a request.
   *
   * @param {HTMLInputElement} input
   * @returns {boolean}
   * @private
   */
  #isSettled(input) {
    return input.validity.valid && !/[.,]$/.test(input.value);
  }

  /**
   * Stop the two ends crossing.
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

/** The sort order control. */
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

/** Switch a product grid between grid and list. */
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
    } catch {}

    if (shouldAnnounce) announce(themeString(next === 'list' ? 'viewList' : 'viewGrid', ''));
  }
}

defineComponent('layout-toggle', LayoutToggle);

export default { FacetFilters, FacetDrawer, PriceRange, SortBy, LayoutToggle };
