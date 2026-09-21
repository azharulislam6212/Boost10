/**
 * `<results-list>` — any paginated grid of server-rendered results: a collection,
 * a search results page, or the bundle builder's product picker.
 *
 * @module @theme/results-list
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, filterUpdateDetail } from '@theme/events';
import { fetchSection } from '@theme/section-renderer';
import { morph } from '@theme/morph';
import { themeString, announce, announceUrgent, getFocusableElements } from '@theme/utilities';

/** Automatic loads allowed before infinite scroll hands over to the button. */
const AUTO_LOAD_LIMIT = 3;

export class ResultsList extends BaseComponent {
  static requiredRefs = ['grid'];

  /** @type {AbortController|null} */
  #request = null;

  /** @type {IntersectionObserver|null} */
  #sentinelObserver = null;

  /** @type {IntersectionObserver|null} */
  #pageObserver = null;

  /** How many pages infinite scroll has appended without being asked again. */
  #autoLoads = 0;

  /**
   * First rendered node of each loaded page, used to report which page is in
   * view without measuring scroll offsets.
   *
   * @type {Array<{ page: number, node: Element }>}
   */
  #pageAnchors = [];

  setup() {
    this.#autoLoads = 0;
    this.#pageAnchors = [];

    this.#bindControls();
    this.#markCurrentPage();
    this.#applyMode();

    if (!document.querySelector('facet-filters')) {
      this.on(window, 'popstate', () => this.#onPopState());
    }

    this.on(window, 'pageshow', (event) => {
      if (event.persisted) {
      this.refreshRefs();
      this.#applyMode();
    }
    });
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
    this.#sentinelObserver?.disconnect();
    this.#pageObserver?.disconnect();
    this.#sentinelObserver = null;
    this.#pageObserver = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {'paginate'|'load-more'|'infinite'}
   */
  get pagination() {
    return this.dataset.pagination || window.Theme?.settings?.paginationType || 'paginate';
  }

  /**
   * @returns {string}
   */
  get sectionId() {
    return this.dataset.sectionId || '';
  }

  /**
   * @returns {string} Selector identifying one item. Products by default, so the
   *   bundle builder and any other grid can override it.
   */
  get itemSelector() {
    return this.dataset.itemSelector || '[data-product-id]';
  }

  /**
   * @returns {number} Items currently rendered.
   */
  get count() {
    return this.refs.grid.querySelectorAll(this.itemSelector).length;
  }

  /**
   * @returns {number} Items matching the current filters, across all pages.
   */
  get total() {
    return Number(this.dataset.total) || this.count;
  }

  /**
   * @returns {number} The page the server rendered into this element.
   */
  get page() {
    return Number(this.dataset.page) || 1;
  }

  /**
   * @returns {string|null}
   */
  get nextUrl() {
    return this.refs.loadMore?.dataset.nextUrl || null;
  }

  /**
   * @returns {string|null}
   */
  get previousUrl() {
    return this.refs.loadPrevious?.dataset.prevUrl || null;
  }

  /**
   * Replace the results with freshly rendered HTML.
   *
   * @param {string} html Section HTML containing a `<results-list>`.
   * @param {Object} [options]
   * @param {boolean} [options.focus=true] Move focus to the results.
   * @param {boolean} [options.scroll=false] Scroll the results into view.
   * @returns {boolean}
   */
update(html, { focus = true, scroll = false } = {}) {
  const next = new DOMParser().parseFromString(html, 'text/html').querySelector('results-list');

  if (!next) {
    console.warn('[Boost10] <results-list> found no results in the response.');
    return false;
  }

  morph(this, next);

  this.refreshRefs();

  this.#autoLoads = 0;
  this.#pageAnchors = [];

  this.#markCurrentPage();
  this.#applyMode();

  this.#announceCount();

  if (scroll) this.#scrollIntoView();

  if (focus) this.focusResults();

  return true;
}

  /**
   * Append the next page.
   *
   * @returns {Promise<boolean>}
   */
  loadMore() {
    const url = this.nextUrl;
    if (!url || this.hasAttribute('data-loading')) return Promise.resolve(false);

    return this.#loadPage(url, 'append');
  }

  /**
   * Prepend the previous page.
   *
   * @returns {Promise<boolean>}
   */
  loadPrevious() {
    const url = this.previousUrl;
    if (!url || this.hasAttribute('data-loading')) return Promise.resolve(false);

    return this.#loadPage(url, 'prepend');
  }

  /**
   * Go to a numbered page, replacing the current results.
   *
   * @param {string} url
   * @param {Object} [options]
   * @param {boolean} [options.push=true]
   * @returns {Promise<boolean>}
   */
  async goToPage(url, { push = true } = {}) {
    if (!url || this.hasAttribute('data-loading')) return false;

    this.#request?.abort();
    this.#request = new AbortController();
    this.#setLoading(true);

    try {
      const html = await this.#fetch(url);
      if (push) window.history.pushState({ results: true }, '', url);

      return this.update(html, { focus: true, scroll: true });
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      console.error('[Boost10] Could not load that page.', error);
      announceUrgent(themeString('networkError', ''));
      return false;
    } finally {
      this.#setLoading(false);
      this.#request = null;
    }
  }

  /** Move focus to the results container. */
  focusResults() {
    const target = this.refs.grid;
    if (!(target instanceof HTMLElement)) return;

    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ loading -- ---- */

  /**
   * @param {string} url
   * @param {'append'|'prepend'} direction
   * @returns {Promise<boolean>}
   * @private
   */
  async #loadPage(url, direction) {
    this.#request?.abort();
    this.#request = new AbortController();
    this.#setLoading(true);

    const heightBefore = document.documentElement.scrollHeight;
    const scrollBefore = window.scrollY;

    try {
      const html = await this.#fetch(url);
      const next = new DOMParser().parseFromString(html, 'text/html').querySelector('results-list');
      if (!next) return false;

      const incoming = Array.from(next.querySelector('[data-ref="grid"]')?.children || []);
      if (incoming.length === 0) return false;

      const pageNumber = Number(next.dataset.page) || null;
      const firstIncoming = incoming[0];

      if (direction === 'append') {
        for (const node of incoming) this.refs.grid.appendChild(node);
      } else {
        for (const node of [...incoming].reverse()) {
          this.refs.grid.insertBefore(node, this.refs.grid.firstChild);
        }
      }

      this.#recordPageAnchor(pageNumber, firstIncoming);
      this.#syncControlsFrom(next, direction);
      this.dataset.count = String(this.count);

      if (direction === 'prepend') {
        const grown = document.documentElement.scrollHeight - heightBefore;
        window.scrollTo({ top: scrollBefore + grown, behavior: 'instant' });
      }

      this.#announceLoaded();
      this.#focusNewContent(firstIncoming, direction);
      this.#observePages();

      this.dispatch(
        EVENTS.FILTER_LOADED,
        filterUpdateDetail(url, { resultsCount: this.count, appended: true })
      );

      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      console.error('[Boost10] Could not load more results.', error);
      announceUrgent(themeString('networkError', ''));
      return false;
    } finally {
      this.#setLoading(false);
      this.#request = null;
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<string>}
   * @private
   */
  async #fetch(url) {
    if (this.sectionId) {
      return fetchSection(this.sectionId, { url, signal: this.#request.signal, cache: false });
    }

    const response = await fetch(url, {
      signal: this.#request.signal,
      headers: { Accept: 'text/html' }
    });

    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    return response.text();
  }

  /* ------------------------------------------------------------- wiring -- ---- */

  /** @private */
#bindControls() {
  this.on(this, 'click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;

    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const loadMore = event.target.closest('[data-ref~="loadMore"]');
    if (loadMore && this.contains(loadMore)) {
      event.preventDefault();
      this.loadMore();
      return;
    }

    const loadPrevious = event.target.closest('[data-ref~="loadPrevious"]');
    if (loadPrevious && this.contains(loadPrevious)) {
      event.preventDefault();
      this.loadPrevious();
      return;
    }

    if (this.pagination !== 'paginate') return;

    const link = event.target.closest('[data-ref~="pagination"] a[href]');
    if (!(link instanceof HTMLAnchorElement) || !this.contains(link)) return;

    event.preventDefault();
    this.goToPage(link.href);
  });
}

  /**
   * Apply whatever the current mode requires, and make deep links recoverable.
   *
   * @private
   */
  #applyMode() {
    this.#sentinelObserver?.disconnect();
    this.#sentinelObserver = null;

    const deepLinked = this.page > 1 && this.pagination !== 'paginate';
    if (this.refs.loadPrevious instanceof HTMLElement) {
      this.refs.loadPrevious.toggleAttribute('hidden', !deepLinked || !this.previousUrl);
    }

    if (this.pagination === 'infinite') this.#observeSentinel();

    this.#observePages();
  }

  /** @private */
  #markCurrentPage() {
    const first = this.refs.grid.querySelector(this.itemSelector);
    if (first) this.#recordPageAnchor(this.page, first);
  }

  /**
   * @param {number|null} page
   * @param {Element|undefined} node
   * @private
   */
  #recordPageAnchor(page, node) {
    if (!page || !node) return;
    if (this.#pageAnchors.some((entry) => entry.page === page)) return;

    node.setAttribute('data-page-anchor', String(page));
    this.#pageAnchors.push({ page, node });
    this.#pageAnchors.sort((a, b) => a.page - b.page);
  }

  /**
   * Keep the address bar pointing at the page currently in view.
   *
   * @private
   */
  #observePages() {
    this.#pageObserver?.disconnect();
    this.#pageObserver = null;

    if (this.pagination === 'paginate' || this.#pageAnchors.length < 2) return;
    if (!('IntersectionObserver' in window)) return;

    this.#pageObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => Number(entry.target.getAttribute('data-page-anchor')))
          .filter(Boolean);

        if (visible.length === 0) return;

        this.#syncUrlToPage(Math.min(...visible));
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );

    for (const { node } of this.#pageAnchors) this.#pageObserver.observe(node);
  }

  /**
   * @param {number} page
   * @private
   */
  #syncUrlToPage(page) {
    const url = new URL(window.location.href);
    const current = Number(url.searchParams.get('page')) || 1;

    if (current === page) return;

    if (page === 1) {
      url.searchParams.delete('page');
    } else {
      url.searchParams.set('page', String(page));
    }

    window.history.replaceState({ results: true, page }, '', `${url.pathname}${url.search}`);
    this.dataset.page = String(page);
  }

  /** @private */
  #onPopState() {
    this.goToPage(window.location.href, { push: false });
  }

  /**
   * @param {Element} next
   * @param {'append'|'prepend'} direction
   * @private
   */
  #syncControlsFrom(next, direction) {
    const ref = direction === 'append' ? 'loadMore' : 'loadPrevious';
    const attribute = direction === 'append' ? 'nextUrl' : 'prevUrl';

    const button = this.refs[ref];
    const nextButton = next.querySelector(`[data-ref="${ref}"]`);

    if (!(button instanceof HTMLElement)) return;

    if (nextButton instanceof HTMLElement && nextButton.dataset[attribute]) {
      button.dataset[attribute] = nextButton.dataset[attribute];
      button.hidden = false;
    } else {
      button.hidden = true;
      delete button.dataset[attribute];
      if (direction === 'append') this.#sentinelObserver?.disconnect();
    }
  }

  /** @private */
  #observeSentinel() {
    const sentinel = this.refs.sentinel;
    if (!(sentinel instanceof HTMLElement) || !('IntersectionObserver' in window)) return;

    this.#sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (!this.nextUrl) return;

        if (this.#autoLoads >= AUTO_LOAD_LIMIT) {
          this.#sentinelObserver?.disconnect();
          this.refs.loadMore?.removeAttribute('hidden');
          return;
        }

        this.#autoLoads += 1;
        this.loadMore();
      },
      { rootMargin: '600px' }
    );

    this.#sentinelObserver.observe(sentinel);
  }

  /* ----------------------------------------------------------- feedback -- ---- */

  /**
   * @param {boolean} loading
   * @private
   */
  #setLoading(loading) {
    this.toggleAttribute('data-loading', loading);
    this.refs.grid.setAttribute('aria-busy', loading ? 'true' : 'false');

    for (const ref of ['loadMore', 'loadPrevious']) {
      const button = this.refs[ref];
      if (button instanceof HTMLButtonElement) {
        button.disabled = loading;
        button.setAttribute('aria-busy', loading ? 'true' : 'false');
      }
    }
  }

  /** @private */
  #announceCount() {
    const message =
      this.total > 0
        ? themeString('searchResultsCount', '', { count: this.total })
        : themeString('facetsNoResults', '');

    this.#status(message);
    announce(message);
  }

  /** @private */
  #announceLoaded() {
    const message = themeString('paginationShowing', '', {
      shown: this.count,
      total: this.total
    });

    this.#status(message);
    announce(message);
  }

  /**
   * Put focus on the first item that just arrived, so a keyboard user continues
   * from where the content grew rather than from a button that is now a
   * screenful away.
   *
   * @param {Element} first
   * @param {'append'|'prepend'} direction
   * @private
   */
  #focusNewContent(first, direction) {
    if (direction === 'prepend') return;
    if (!(first instanceof HTMLElement)) return;

    const focusable = getFocusableElements(first)[0];
    (focusable || first).focus({ preventScroll: true });
  }

  /** @private */
  #scrollIntoView() {
    const scrollbar = document.querySelector('smooth-scrollbar');
    const header = document.querySelector('sticky-header');
    const offset = -(header?.height ?? 0) - 24;

    if (scrollbar?.scrollTo) {
      scrollbar.scrollTo(this, { offset });
      return;
    }

    const top = this.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /**
   * @param {string} message
   * @private
   */
  #status(message) {
    if (this.refs.status instanceof HTMLElement) this.refs.status.textContent = message;
  }
}

defineComponent('results-list', ResultsList);

export default ResultsList;
