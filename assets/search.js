/**
 * `<predictive-search>` and `<search-drawer>`.
 *
 * @module @theme/search
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { DrawerComponent } from '@theme/dialog';
import { EVENTS } from '@theme/events';
import { fetchSection } from '@theme/section-renderer';
import { morph } from '@theme/morph';
import {
  debounce,
  getRoute,
  themeString,
  announce,
  announceUrgent,
  prefersReducedMotion
} from '@theme/utilities';

/** Suggestions start at the first character. */
const MIN_QUERY_LENGTH = 1;

/** Where recent searches live. Per browser, never sent anywhere. */
const RECENT_KEY = 'boost10:recent-searches';

/** How long each rotating prompt holds before the next one. */
const PROMPT_INTERVAL = 3200;

/** Fade-out half of the prompt swap. Must match `--search-prompt-duration`. */
const PROMPT_FADE = 260;

/* ==========================================================================
   Recent searches
   ========================================================================== */

/** Recent search terms, stored in `localStorage`. */
export const recentSearches = {
  /**
   * @param {number} [limit]
   * @returns {string[]}
   */
  read(limit = 6) {
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((term) => typeof term === 'string').slice(0, limit) : [];
    } catch {
      return [];
    }
  },

  /**
   * @param {string[]} list
   */
  write(list) {
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {}
  },

  /**
   * Move a term to the front, de-duplicated case-insensitively.
   *
   * @param {string} term
   * @param {number} [limit]
   * @returns {string[]}
   */
  add(term, limit = 6) {
    const value = term.trim();
    if (value.length < MIN_QUERY_LENGTH) return this.read(limit);

    const lower = value.toLowerCase();
    const next = [value, ...this.read(limit).filter((entry) => entry.toLowerCase() !== lower)].slice(0, limit);

    this.write(next);
    return next;
  },

  /**
   * @param {string} term
   * @param {number} [limit]
   * @returns {string[]}
   */
  remove(term, limit = 6) {
    const lower = term.trim().toLowerCase();
    const next = this.read(limit).filter((entry) => entry.toLowerCase() !== lower);

    this.write(next);
    return next;
  },

  clear() {
    try {
      window.localStorage.removeItem(RECENT_KEY);
    } catch {}
  }
};

/* ==========================================================================
   <search-list>
   ========================================================================== */

/** The suggestion listbox for predictive search. */
export class SearchList extends BaseComponent {
  /** Index of the highlighted option, or -1 for none. */
  #index = -1;

  setup() {
    this.#index = -1;

    this.on(this, 'pointermove', this.#onPointerMove);
    this.on(this, 'pointerleave', () => this.clear());
    this.on(this, 'click', this.#onClick);
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement[]} Selectable options, in document order.
   */
  get options() {
    return Array.from(this.querySelectorAll('[data-result]'));
  }

  /**
   * @returns {HTMLElement|null}
   */
  get active() {
    return this.options[this.#index] || null;
  }

  /**
   * @returns {number}
   */
  get count() {
    return this.options.length;
  }

  /**
   * Handle a navigation key.
   *
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  handleKeydown(event) {
    const total = this.count;
    if (total === 0) return false;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.select(this.#index + 1 >= total ? 0 : this.#index + 1);
        return true;

      case 'ArrowUp':
        event.preventDefault();
        this.select(this.#index <= 0 ? total - 1 : this.#index - 1);
        return true;

      case 'Home':
        event.preventDefault();
        this.select(0);
        return true;

      case 'End':
        event.preventDefault();
        this.select(total - 1);
        return true;

      case 'Enter': {
        const option = this.active;
        if (!option) return false;
        event.preventDefault();
        this.activate(option);
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Highlight an option by index.
   *
   * @param {number} index
   */
  select(index) {
    const options = this.options;
    if (index < 0 || index >= options.length) return;

    for (const option of options) {
      option.removeAttribute('data-selected');
      option.setAttribute('aria-selected', 'false');
    }

    const option = options[index];
    this.#index = index;

    option.setAttribute('data-selected', '');
    option.setAttribute('aria-selected', 'true');

    option.scrollIntoView({ block: 'nearest' });

    this.#input()?.setAttribute('aria-activedescendant', option.id || '');
  }

  /** Remove the highlight. */
  clear() {
    for (const option of this.options) {
      option.removeAttribute('data-selected');
      option.setAttribute('aria-selected', 'false');
    }

    this.#index = -1;
    this.#input()?.removeAttribute('aria-activedescendant');
  }

  /**
   * Follow an option.
   *
   * @param {HTMLElement} option
   */
  activate(option) {
    const link = option.matches('a[href]') ? option : option.querySelector('a[href]');

    if (link instanceof HTMLAnchorElement) {
      link.click();
      return;
    }

    if (option.dataset.url) window.location.assign(option.dataset.url);
  }

  /** Reset after the list is replaced. */
  reset() {
    this.#index = -1;
    this.#input()?.removeAttribute('aria-activedescendant');
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @returns {HTMLElement|null}
   * @private
   */
  #input() {
    const id = this.dataset.input;
    return id ? document.getElementById(id) : null;
  }

  /**
   * @param {PointerEvent} event
   * @private
   */
  #onPointerMove = (event) => {
    const option = event.target instanceof Element ? event.target.closest('[data-result]') : null;
    if (!option) return;

    const index = this.options.indexOf(option);
    if (index !== -1 && index !== this.#index) this.select(index);
  };

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const option = event.target instanceof Element ? event.target.closest('[data-result]') : null;
    if (!option) return;

    if (event.target instanceof Element && event.target.closest('a[href]')) return;

    event.preventDefault();
    this.activate(option);
  };
}

defineComponent('search-list', SearchList);

/* ==========================================================================
   <predictive-search>
   ========================================================================== */

export class PredictiveSearch extends BaseComponent {
  static requiredRefs = ['input', 'panel'];

  /** @type {AbortController|null} */
  #request = null;

  /** @type {Map<string, string>} Rendered HTML per query, for this page view. */
  #cache = new Map();

  /** The query whose results are currently displayed. */
  #rendered = '';

  /** @type {number|null} Rotating prompt interval. */
  #promptTimer = null;

  /** @type {number|null} The in-flight half of a prompt cross-fade. */
  #promptSwap = null;

  setup() {
    this.#setupPrompts();
    this.#setupRecent();
    this.#setupTerms();

    this.on(this.refs.input, 'input', () => this.#syncField());
    this.#syncField();

    if (window.Theme?.settings?.predictiveSearch === false) return;

    const search = debounce((value) => this.search(value), 300);

    this.on(this.refs.input, 'input', (event) => {
      const value = event.target.value.trim();

      if (value.length < MIN_QUERY_LENGTH) {
        search.cancel?.();
        this.#busy(false);
        this.close();
        return;
      }

      this.#busy(true);
      search(value);
    });

    this.on(this.refs.input, 'keydown', this.#onKeydown);
    this.on(this.refs.input, 'focus', () => {
      if (this.#rendered) this.open();
    });

    if (this.refs.reset) {
      this.on(this.refs.reset, 'click', () => this.reset());
    }

    this.on(document, 'click', (event) => {
      if (this.contains(event.target)) return;
      this.close();
    });
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;

    if (this.#promptTimer) {
      clearInterval(this.#promptTimer);
      this.#promptTimer = null;
    }

    if (this.#promptSwap) {
      clearTimeout(this.#promptSwap);
      this.#promptSwap = null;
    }
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {boolean}
   */
  get isOpen() {
    return this.hasAttribute('data-open');
  }

  /**
   * @returns {SearchList|null}
   */
  get results() {
    return this.refs.panel.querySelector('search-list');
  }

  /**
   * Fetch and render suggestions for a query.
   *
   * @param {string} query
   * @returns {Promise<void>}
   */
  async search(query) {
    const term = query.trim();
    if (term.length < MIN_QUERY_LENGTH) return;

    const cached = this.#cache.get(term);
    if (cached) {
      this.#render(cached, term);

      this.#busy(false);
      return;
    }

    this.#request?.abort();

    const controller = new AbortController();
    this.#request = controller;

    this.#busy(true);

    try {
      const html = await fetchSection(this.sectionId, {
        url: getRoute('predictiveSearch'),
        params: this.#params(term),
        signal: controller.signal,
        cache: false
      });

      this.#cache.set(term, html);
      this.#render(html, term);
    } catch (error) {
      if (error?.name === 'AbortError') return;

      console.error('[Boost10] Predictive search failed.', error);
      const message = themeString('networkError', '');
      this.#status(message);
      announceUrgent(message);
      this.close();
    } finally {
      if (this.#request === controller) {
        this.#busy(false);
        this.#request = null;
      }
    }
  }

  /** Show the suggestion panel. */
  open() {
    if (this.isOpen) return;

    this.setAttribute('data-open', '');
    this.refs.panel.hidden = false;
    this.refs.input.setAttribute('aria-expanded', 'true');
  }

  /** Hide the suggestion panel. */
  close() {
    if (!this.isOpen) return;

    this.removeAttribute('data-open');
    this.refs.panel.hidden = true;
    this.refs.input.setAttribute('aria-expanded', 'false');
    this.results?.reset();
  }

  /**
   * Clear the query and the panel. Focus is restored only when the reset was
   * requested by the customer. A drawer reset after close must NOT focus an
   * input inside the now-closed native dialog, because the browser can scroll
   * that hidden control back into view and make the page visibly jump.
   *
   * @param {{focus?: boolean}} [options]
   */
  reset({ focus = true } = {}) {
    this.refs.input.value = '';
    this.#rendered = '';
    this.close();
    this.#syncField();
    this.refreshRecent();

    if (focus) this.refs.input.focus({ preventScroll: true });
  }

  /** Repaint the recent searches block. */
  refreshRecent() {
    this.#renderRecent();
  }

  /**
   * @returns {string}
   */
  get sectionId() {
    return this.dataset.sectionId || 'predictive-search';
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Build the resource parameters from theme settings, so a merchant who turned
   * off article suggestions does not pay for them in the request.
   *
   * @param {string} term
   * @returns {Object}
   * @private
   */
  #params(term) {
    const settings = window.Theme?.settings || {};
    const types = [];

    if (settings.predictiveSearchProducts !== false) types.push('product');
    if (settings.predictiveSearchCollections) types.push('collection');
    if (settings.predictiveSearchArticles) types.push('article');
    if (settings.predictiveSearchPages) types.push('page');
    if (types.length === 0) types.push('product');

    return {
      q: term,
      'resources[type]': types.join(','),
      'resources[limit]': String(settings.predictiveSearchLimit || 6),
      'resources[options][unavailable_products]': 'last',
      'resources[options][fields]': 'title,product_type,variants.title,vendor,tag'
    };
  }

  /**
   * @param {string} html
   * @param {string} term
   * @private
   */
  #render(html, term) {
    const next = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-results-panel]');

    if (!next) {
      this.close();
      return;
    }

    morph(this.refs.panel, next, { childrenOnly: true });
    this.#rendered = term;
    this.open();

    const list = this.results;

    if (list && this.refs.input.id) list.dataset.input = this.refs.input.id;

    this.#refreshMedia();
    list?.reset();

    const count = list?.count ?? 0;
    const message =
      count > 0
        ? themeString('searchResultsCount', '', { count })
        : themeString('searchNoResults', '');

    this.#status(message);
    announce(message);

    this.dispatch(EVENTS.SEARCH_RESULTS, { query: term, count });
  }

  /**
   * Put every image in the freshly morphed panel back into a visible state.
   *
   * @private
   */
  #refreshMedia() {
    const figures = this.refs.panel.querySelectorAll('responsive-image');

    for (const figure of figures) {
      const image = figure.querySelector('img');
      if (!(image instanceof HTMLImageElement)) continue;

      if (image.complete && image.naturalWidth > 0) {
        figure.setAttribute('data-loaded', '');
        continue;
      }

      figure.removeAttribute('data-loaded');
      image.addEventListener('load', () => figure.setAttribute('data-loaded', ''), { once: true });
      image.addEventListener(
        'error',
        () => {
          figure.setAttribute('data-error', '');
          figure.setAttribute('data-loaded', '');
        },
        { once: true }
      );
    }
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown = (event) => {
    if (event.key === 'Escape') {
      if (this.isOpen) {
        event.preventDefault();
        this.close();
      }
      return;
    }

    if (!this.isOpen) return;

    this.results?.handleKeydown(event);
  };

  /**
   * @param {boolean} busy
   * @private
   */
  #busy(busy) {
    this.toggleAttribute('data-loading', busy);
    this.refs.panel.setAttribute('aria-busy', busy ? 'true' : 'false');

    if (this.refs.busy instanceof HTMLElement) {
      this.refs.busy.textContent = busy ? themeString('loading', '') : '';
    }
  }

  /**
   * @param {string} message
   * @private
   */
  #status(message) {
    if (this.refs.status instanceof HTMLElement) this.refs.status.textContent = message;
  }

  /**
   * @param {boolean} visible
   * @private
   */
  #toggleReset(visible) {
    if (!(this.refs.reset instanceof HTMLElement)) return;

    this.refs.reset.toggleAttribute('data-visible', visible);

    this.refs.reset.tabIndex = visible ? 0 : -1;
  }

  /* ------------------------------------------------- prompts and history -- ---- */

  /**
   * How many recent searches this field keeps, and whether it keeps any.
   *
   * @returns {number} 0 when the merchant has turned recent searches off.
   * @private
   */
  get #recentLimit() {
    if (this.hasAttribute('data-recent-disabled')) return 0;
    return Number(this.dataset.recentLimit) || 6;
  }

  /**
   * The animated prompt.
   *
   * @private
   */
  #setupPrompts() {
    const prompt = this.refs.prompt;
    if (!(prompt instanceof HTMLElement)) return;

    const prompts = (this.dataset.prompts || '')
      .split('|')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (prompts.length === 0) return;

    prompt.textContent = prompts[0];
    this.refs.input.placeholder = '';
    this.setAttribute('data-prompt', '');
    this.#syncField();

    if (prompts.length < 2 || prefersReducedMotion()) return;

    let index = 0;

    this.#promptTimer = window.setInterval(() => {
      if (this.refs.input.value.trim().length > 0) return;

      index = (index + 1) % prompts.length;

      prompt.setAttribute('data-swap', '');
      this.#promptSwap = window.setTimeout(() => {
        prompt.textContent = prompts[index];
        prompt.removeAttribute('data-swap');
        this.#promptSwap = null;
      }, PROMPT_FADE);
    }, PROMPT_INTERVAL);
  }

  /**
   * Keep the field's chrome in step with its value.
   *
   * @private
   */
  #syncField() {
    const filled = this.refs.input.value.trim().length > 0;

    this.#toggleReset(filled);
    this.toggleAttribute('data-filled', filled);
  }

  /**
   * Wire the recent searches block.
   *
   * @private
   */
  #setupRecent() {
    const { recent, recentList, recentClear } = this.refs;
    if (!(recent instanceof HTMLElement) || !(recentList instanceof HTMLElement)) return;

    this.#renderRecent();

    if (recentClear instanceof HTMLElement) {
      this.on(recentClear, 'click', () => {
        recentSearches.clear();
        this.#renderRecent();
        this.refs.input.focus({ preventScroll: true });
      });
    }

    this.on(recentList, 'click', (event) => {
      const remove = event.target instanceof Element ? event.target.closest('[data-recent-remove]') : null;
      if (!remove) return;

      event.preventDefault();
      recentSearches.remove(remove.dataset.recentRemove || '', this.#recentLimit);
      this.#renderRecent();
    });
  }

  /**
   * Repaint the recent chips from storage.
   *
   * @private
   */
  #renderRecent() {
    const { recent, recentList } = this.refs;
    if (!(recent instanceof HTMLElement) || !(recentList instanceof HTMLElement)) return;

    const limit = this.#recentLimit;
    const terms = limit > 0 ? recentSearches.read(limit) : [];

    recentList.replaceChildren();

    for (const term of terms) {
      const item = document.createElement('li');
      item.className = 'search-chip search-chip--recent';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'search-chip__label';
      label.dataset.searchTerm = term;
      label.textContent = term;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'search-chip__remove';
      remove.dataset.recentRemove = term;
      remove.setAttribute('aria-label', themeString('searchRemoveRecent', 'Remove', { term }));
      remove.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6 18 18M18 6 6 18"/></svg>';

      item.append(label, remove);
      recentList.append(item);
    }

    recent.toggleAttribute('hidden', terms.length === 0);
  }

  /**
   * Chips and tags run their term through the field rather than navigating.
   *
   * @private
   */
  #setupTerms() {
    this.on(this, 'click', (event) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-search-term]') : null;
      if (!trigger || trigger.closest('[data-recent-remove]')) return;

      event.preventDefault();
      this.#useTerm(trigger.dataset.searchTerm || '');
    });

    const form = this.querySelector('form');
    if (form) {
      this.on(form, 'submit', () => {
        recentSearches.add(this.refs.input.value, this.#recentLimit);
      });
    }

    this.on(this, 'click', (event) => {
      const result = event.target instanceof Element ? event.target.closest('[data-result]') : null;
      if (!result) return;

      recentSearches.add(this.refs.input.value, this.#recentLimit);
    });
  }

  /**
   * @param {string} term
   * @private
   */
  #useTerm(term) {
    const value = term.trim();
    if (!value) return;

    this.refs.input.value = value;
    this.#syncField();
    this.refs.input.focus({ preventScroll: true });

    if (window.Theme?.settings?.predictiveSearch === false) {
      recentSearches.add(value, this.#recentLimit);
      this.querySelector('form')?.submit();
      return;
    }

    this.search(value);
  }
}

defineComponent('predictive-search', PredictiveSearch);

/* ==========================================================================
   <search-drawer>
   ========================================================================== */

/** The search drawer. */
export class SearchDrawer extends DrawerComponent {
  get overlayType() {
    return 'search';
  }

  afterOpen() {
    this.querySelector('predictive-search')?.refreshRecent?.();

    const input = this.querySelector('input[type="search"]');
    if (input instanceof HTMLInputElement) {
      input.focus({ preventScroll: true });
      input.select();
    }
  }

  afterClose() {
    this.querySelector('predictive-search')?.reset?.({ focus: false });
  }
}

defineComponent('search-drawer', SearchDrawer);

export default { PredictiveSearch, SearchDrawer, SearchList, recentSearches };
