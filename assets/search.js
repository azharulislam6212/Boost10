/**
 * search.js — Boost10
 *
 * `<predictive-search>` and `<search-drawer>`.
 *
 * Suggestions are rendered by Liquid. The request goes to Shopify's predictive
 * search endpoint with `section_id`, so the response is HTML built by the same
 * snippets the search results page uses — product cards, prices, badges and all.
 * Nothing about a product is reconstructed in JavaScript, which is the only way
 * money formatting, translations and metafield logic stay correct in a dropdown.
 *
 * The whole thing degrades to a plain form. The input is a real `<input
 * type="search" name="q">` inside a `<form action="/search">`, so pressing Enter
 * with JavaScript disabled runs a normal search.
 *
 * Accessibility follows the combobox pattern: focus never leaves the input, and
 * the highlighted suggestion is tracked through `aria-activedescendant` by
 * `<search-list>`. Moving focus into a suggestion list closes the mobile
 * keyboard and breaks the input's editing keys, which is why it is not done.
 *
 * `<search-list>` lives here rather than in `results-list.js` because the two
 * solve different problems. A suggestion list is a combobox popup owned by an
 * input; a collection results list is the page's main content. Sharing one
 * element would mean one of them permanently carrying the other's compromises.
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

/** Below this many characters, a query returns noise rather than suggestions. */
const MIN_QUERY_LENGTH = 2;

/** Where recent searches live. Per browser, never sent anywhere. */
const RECENT_KEY = 'boost10:recent-searches';

/** How long each rotating placeholder holds before the next one. */
const PROMPT_INTERVAL = 3200;


/* ==========================================================================
   Recent searches
   ========================================================================== */

/**
 * Recent search terms, stored in `localStorage`.
 *
 * A customer's search history is theirs: it stays in their browser, it is never
 * sent to the shop, and clearing it clears it. Every access is wrapped, because
 * `localStorage` throws rather than returning null in Safari's private mode and
 * an unavailable storage API must not take the search field down with it.
 */
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
    } catch {
      // Storage full, disabled or blocked. Recent searches are a convenience,
      // never a dependency.
    }
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
    } catch {
      // See write().
    }
  }
};


/* ==========================================================================
   <search-list>
   ========================================================================== */

/**
 * The suggestion listbox for predictive search.
 *
 * Implements the combobox popup half of the ARIA pattern. It never takes focus:
 * the input keeps it, and this element reports which option is active through
 * `aria-activedescendant` on that input. Highlighting is expressed with
 * `data-selected` and `aria-selected`, both of which survive a morph because the
 * list is re-rendered wholesale and reset afterwards.
 *
 * Pointer and keyboard are kept in agreement: hovering an option makes it the
 * active one, so Enter always activates whatever the customer is looking at.
 *
 * Markup:
 *
 *   <search-list data-input="SearchInput">
 *     <ul role="listbox" id="SearchResults">
 *       <li role="option" id="result-1" data-result data-url="/products/x">
 *         <a href="/products/x">…</a>
 *       </li>
 *     </ul>
 *   </search-list>
 */
export class SearchList extends BaseComponent {
  /** Index of the highlighted option, or -1 for none. */
  #index = -1;

  setup() {
    this.#index = -1;

    this.on(this, 'pointermove', this.#onPointerMove);
    this.on(this, 'pointerleave', () => this.clear());
    this.on(this, 'click', this.#onClick);
  }

  /* --------------------------------------------------------- public API -- */

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
   * Called by `<predictive-search>` rather than bound here, because the keydown
   * happens on the input — focus never reaches this element. Returns true when
   * the key was consumed.
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

    // `nearest` scrolls the list and leaves the page alone, which matters when
    // the panel is a dropdown rather than a drawer.
    option.scrollIntoView({ block: 'nearest' });

    this.#input()?.setAttribute('aria-activedescendant', option.id || '');
  }

  /**
   * Remove the highlight.
   */
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

  /**
   * Reset after the list is replaced.
   *
   * A stale `aria-activedescendant` points at a node that no longer exists,
   * which silences the announcement of every subsequent option.
   */
  reset() {
    this.#index = -1;
    this.#input()?.removeAttribute('aria-activedescendant');
  }

  /* ---------------------------------------------------------- internals -- */

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

    // A real link inside the option handles its own navigation, including
    // middle-click and modifier-click, which this must not steal.
    if (event.target instanceof Element && event.target.closest('a[href]')) return;

    event.preventDefault();
    this.activate(option);
  };
}

defineComponent('search-list', SearchList);

/* ==========================================================================
   <predictive-search>
   ========================================================================== */

/**
 * Markup:
 *
 *   <predictive-search data-section-id="predictive-search">
 *     <form action="{{ routes.search_url }}" method="get" role="search">
 *       <input
 *         data-ref="input"
 *         id="SearchInput"
 *         type="search"
 *         name="q"
 *         role="combobox"
 *         aria-expanded="false"
 *         aria-controls="SearchResults"
 *         aria-autocomplete="list"
 *         autocomplete="off">
 *       <button data-ref="reset" type="button">…</button>
 *     </form>
 *     <div data-ref="panel" id="SearchResults" hidden>
 *       <search-list data-input="SearchInput">…</search-list>
 *     </div>
 *     <p data-ref="status" class="visually-hidden" role="status"></p>
 *   </predictive-search>
 */
export class PredictiveSearch extends BaseComponent {
  static requiredRefs = ['input', 'panel'];

  /** @type {AbortController|null} */
  #request = null;

  /** @type {Map<string, string>} Rendered HTML per query, for this page view. */
  #cache = new Map();

  /** The query whose results are currently displayed. */
  #rendered = '';

  /** @type {number|null} Rotating placeholder interval. */
  #promptTimer = null;

  setup() {
    // The idle column, the recent searches and the rotating prompts are not
    // predictive search: they work with the suggestion request switched off, and
    // a merchant who turns suggestions off should still get the panel.
    this.#setupPrompts();
    this.#setupRecent();
    this.#setupTerms();

    if (window.Theme?.settings?.predictiveSearch === false) return;

    const search = debounce((value) => this.search(value), 300);

    this.on(this.refs.input, 'input', (event) => {
      const value = event.target.value.trim();
      this.#toggleReset(value.length > 0);

      if (value.length < MIN_QUERY_LENGTH) {
        search.cancel?.();
        this.close();
        return;
      }

      search(value);
    });

    this.on(this.refs.input, 'keydown', this.#onKeydown);
    this.on(this.refs.input, 'focus', () => {
      if (this.#rendered) this.open();
    });

    if (this.refs.reset) {
      this.on(this.refs.reset, 'click', () => this.reset());
    }

    // A click anywhere else dismisses the panel. Bound on the document because
    // the customer's next click is not going to be inside this element.
    this.on(document, 'click', (event) => {
      if (this.contains(event.target)) return;
      this.close();
    });

    this.#toggleReset(this.refs.input.value.trim().length > 0);
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;

    if (this.#promptTimer) {
      clearInterval(this.#promptTimer);
      this.#promptTimer = null;
    }
  }

  /* --------------------------------------------------------- public API -- */

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
      return;
    }

    // A customer typing quickly generates a request per keystroke. Only the last
    // one matters, and an out-of-order response would show results for a query
    // they have already moved past.
    this.#request?.abort();
    this.#request = new AbortController();

    this.#busy(true);

    try {
      const html = await fetchSection(this.sectionId, {
        url: getRoute('predictiveSearch'),
        params: this.#params(term),
        signal: this.#request.signal,
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
      this.#busy(false);
      this.#request = null;
    }
  }

  /**
   * Show the suggestion panel.
   */
  open() {
    if (this.isOpen) return;

    this.setAttribute('data-open', '');
    this.refs.panel.hidden = false;
    this.refs.input.setAttribute('aria-expanded', 'true');
  }

  /**
   * Hide the suggestion panel.
   */
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
    this.#toggleReset(false);
    this.refreshRecent();

    if (focus) this.refs.input.focus({ preventScroll: true });
  }

  /**
   * Repaint the recent searches block.
   *
   * Public because the drawer calls it on open: the customer may have searched
   * from another field, or in another tab, since this markup was rendered.
   */
  refreshRecent() {
    this.#renderRecent();
  }

  /**
   * @returns {string}
   */
  get sectionId() {
    return this.dataset.sectionId || 'predictive-search';
  }

  /* ---------------------------------------------------------- internals -- */

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

    // The section cannot know which field asked for these results — the theme
    // has more than one — so the link between the listbox and its input is
    // stamped here, where the answer is known. Without it
    // `aria-activedescendant` is never set and arrow keys announce nothing.
    if (list && this.refs.input.id) list.dataset.input = this.refs.input.id;

    list?.reset();

    const count = list?.count ?? 0;
    const message =
      count > 0
        ? themeString('searchResultsCount', '', { count })
        : themeString('searchNoResults', '');

    // Announced politely rather than assertively: the customer is still typing,
    // and interrupting them mid-word is worse than waiting for a pause.
    this.#status(message);
    announce(message);

    this.dispatch(EVENTS.SEARCH_RESULTS, { query: term, count });
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

    // Navigation keys belong to the list, but the event happens on the input,
    // because focus never leaves it.
    this.results?.handleKeydown(event);
  };

  /**
   * @param {boolean} busy
   * @private
   */
  #busy(busy) {
    this.toggleAttribute('data-loading', busy);
    this.refs.panel.setAttribute('aria-busy', busy ? 'true' : 'false');
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
    if (this.refs.reset instanceof HTMLElement) this.refs.reset.toggleAttribute('hidden', !visible);
  }

  /* ------------------------------------------------- prompts and history -- */

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
   * Rotate the placeholder through the merchant's prompts.
   *
   * A static placeholder in a supplement store says "Search". Three prompts say
   * what the store actually sells. The first is already in the markup, so the
   * field is never empty before this runs, and a customer who has started
   * typing is left alone — swapping the placeholder under a half-typed query is
   * movement with no meaning.
   *
   * @private
   */
  #setupPrompts() {
    const prompts = (this.dataset.prompts || '')
      .split('|')
      .map((prompt) => prompt.trim())
      .filter(Boolean);

    if (prompts.length < 2 || prefersReducedMotion()) return;

    let index = 0;

    this.#promptTimer = window.setInterval(() => {
      if (this.refs.input.value.trim().length > 0) return;

      index = (index + 1) % prompts.length;
      this.refs.input.placeholder = prompts[index];
    }, PROMPT_INTERVAL);
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
   * The whole block is hidden when there is nothing in it: a "Recent searches"
   * heading over an empty row is worse than no heading.
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
      // The pill is the `<li>`, holding two real buttons: the term runs the
      // search, the cross forgets it. A cross nested inside the term button
      // would be invalid HTML and unreachable by keyboard.
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
   * A tag that jumped straight to the results page would throw away the panel
   * the customer is standing in, and with it the chance to refine. Setting the
   * value and searching keeps them where they are.
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

    // Submitting is the moment a query becomes worth remembering. Recorded on
    // the form rather than on the button so Enter counts too.
    const form = this.querySelector('form');
    if (form) {
      this.on(form, 'submit', () => {
        recentSearches.add(this.refs.input.value, this.#recentLimit);
      });
    }

    // Following a suggestion is also a completed search, and the one customers
    // repeat most often.
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
    this.#toggleReset(true);
    this.refs.input.focus({ preventScroll: true });

    // With suggestions switched off there is nothing to show in place, so the
    // chip does the next best thing and runs the real search. A tag that
    // silently did nothing would read as a broken button.
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

/**
 * The search drawer.
 *
 * Focus goes to the search field rather than the close button — the exception to
 * the drawer default, because opening search has exactly one purpose and a
 * customer who has to Tab to the field first will assume it is broken.
 *
 * The query is cleared on close. Reopening search and finding a previous query
 * with stale suggestions attached is more confusing than starting fresh.
 */
export class SearchDrawer extends DrawerComponent {
  get overlayType() {
    return 'search';
  }

  afterOpen() {
    // The customer may have searched from the 404 field, or in another tab,
    // since this markup was rendered.
    this.querySelector('predictive-search')?.refreshRecent?.();

    const input = this.querySelector('input[type="search"]');
    if (input instanceof HTMLInputElement) {
      input.focus({ preventScroll: true });
      input.select();
    }
  }

  afterClose() {
    // The drawer is already closed here. Never focus the search input during
    // cleanup; doing so focuses an element inside a closed native dialog and
    // can make the browser jump the page to that hidden field.
    this.querySelector('predictive-search')?.reset?.({ focus: false });
  }
}

defineComponent('search-drawer', SearchDrawer);

export default { PredictiveSearch, SearchDrawer, SearchList, recentSearches };
