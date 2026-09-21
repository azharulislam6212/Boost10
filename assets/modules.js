/**
 * The small interactive primitives that appear throughout the theme:
 *
 * @module @theme/modules
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { prefersReducedMotion, rafThrottle, isRTL, debounce, themeString, announce } from '@theme/utilities';

/* ==========================================================================
   <accordion-element>
   ========================================================================== */

/**
 * The accordion group a disclosure belongs to.
 *
 * @param {Element} element
 * @returns {AccordionElement|null}
 */
function nearestAccordion(element) {
  let node = element.parentElement;

  while (node) {
    if (node instanceof AccordionElement) return node;
    node = node.parentElement;
  }

  return null;
}

/**
 * A group of `<details>` disclosures with animated height and optional
 * single-open behaviour.
 */
export class AccordionElement extends BaseComponent {
  /**
   * What is running on an item, and which way it is going.
   *
   * @type {WeakMap<HTMLDetailsElement, {animation: Animation, fade: Animation|null, direction: 'open'|'close'}>}
   */
  #animations = new WeakMap();

  /** @type {MediaQueryList|null} */
  #query = null;

  setup() {
    for (const item of this.#items()) {
      const summary = item.querySelector('summary');
      if (!summary) continue;

      this.on(summary, 'click', (event) => this.#onSummaryClick(event, item));
    }

    this.#watchBreakpoint();
  }

  teardown() {
    this.#query = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @param {HTMLDetailsElement} item
   */
  open(item) {
    const running = this.#animations.get(item);

    if (running?.direction === 'open') return;
    if (item.open && running?.direction !== 'close') return;

    if (this.dataset.single !== undefined && this.dataset.single !== 'false') {
      for (const other of this.#items()) {
        if (other !== item && other.open) this.close(other);
      }
    }

    item.open = true;
    this.#animateOpen(item);
  }

  /**
   * @param {HTMLDetailsElement} item
   */
  close(item) {
    if (this.#animations.get(item)?.direction === 'close') return;
    if (!item.open) return;
    this.#animateClose(item);
  }

  /** Open every item. Used by print stylesheets and by in-page search. */
  openAll() {
    for (const item of this.#items()) {
      item.open = true;
    }
  }

  /**
   * @returns {number|null} The width below which this group collapses.
   */
  get collapseBelow() {
    const value = Number(this.dataset.collapseBelow);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Open everything above the breakpoint, restore the authored state below it.
   *
   * @private
   */
  #watchBreakpoint() {
    const width = this.collapseBelow;
    if (width === null) return;

    this.#query = window.matchMedia(`(min-width: ${width}px)`);

    const apply = () => {
      const expanded = this.#query.matches;
      this.toggleAttribute('data-static', expanded);

      for (const item of this.#items()) {
        const summary = item.querySelector('summary');

        if (expanded) {
          item.open = true;
          summary?.setAttribute('data-static', '');
          summary?.setAttribute('tabindex', '-1');
        } else {
          item.open = item.hasAttribute('data-default-open');
          summary?.removeAttribute('data-static');
          summary?.removeAttribute('tabindex');
        }
      }
    };

    this.on(this.#query, 'change', apply);
    apply();
  }

  /**
   * Every disclosure this group owns, at any depth.
   *
   * @returns {HTMLDetailsElement[]}
   * @private
   */
  #items() {
    const found = this.querySelectorAll('details:not([data-no-collapse])');

    return Array.from(found).filter((item) => nearestAccordion(item) === this);
  }

  /**
   * @param {HTMLDetailsElement} item
   * @returns {HTMLElement|null}
   * @private
   */
  #panelOf(item) {
    return item.querySelector(':scope > *:not(summary)');
  }

  /**
   * @param {MouseEvent} event
   * @param {HTMLDetailsElement} item
   * @private
   */
  #onSummaryClick(event, item) {
    if (this.hasAttribute('data-static')) {
      event.preventDefault();
      return;
    }

    if (prefersReducedMotion()) {
      if (item.open) return;
      if (this.dataset.single !== undefined && this.dataset.single !== 'false') {
        for (const other of this.#items()) {
          if (other !== item) other.open = false;
        }
      }
      return;
    }

    event.preventDefault();

    if (item.open) {
      this.close(item);
    } else {
      this.open(item);
    }
  }

  /**
   * @param {HTMLDetailsElement} item
   * @private
   */
  #animateOpen(item) {
    const panel = this.#panelOf(item);
    if (!panel || prefersReducedMotion()) return;

    const running = this.#animations.get(item);
    const from = running ? item.getBoundingClientRect().height : null;
    running?.animation.cancel();
    running?.fade?.cancel();

    const start = from ?? this.#closedHeight(item);
    const end = item.offsetHeight;

    this.#clip(item, true);

    this.#run(item, 'open', start, end, panel, 300, 'cubic-bezier(0.16, 1, 0.3, 1)');
  }

  /**
   * The closed height of a row, measured exactly rather than guessed at.
   *
   * @param {HTMLDetailsElement} item
   * @returns {number}
   * @private
   */
  #closedHeight(item) {
    const panel = this.#panelOf(item);
    if (!panel) return item.offsetHeight;

    const previous = panel.style.display;
    panel.style.display = 'none';
    const height = item.offsetHeight;

    if (previous) panel.style.display = previous;
    else panel.style.removeProperty('display');

    return height;
  }

  /**
   * Run one height animation and own the cleanup after it.
   *
   * @param {HTMLDetailsElement} item
   * @param {'open'|'close'} direction
   * @param {number} start
   * @param {number} end
   * @param {HTMLElement} panel
   * @param {number} duration
   * @param {string} easing
   * @private
   */
  #run(item, direction, start, end, panel, duration, easing) {
    const animation = item.animate([{ height: `${start}px` }, { height: `${end}px` }], {
      duration,
      easing,
      fill: 'both',
    });

    const fade = panel.animate(
      direction === 'open' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
      { duration: Math.round(duration * 0.7), easing: 'ease-out', fill: 'both' }
    );

    this.#animations.set(item, { animation, fade, direction });

    animation.finished
      .then(() => {
        if (this.#animations.get(item)?.animation !== animation) return;
        this.#animations.delete(item);

        if (direction === 'close') item.open = false;

        animation.cancel();
        fade.cancel();
        item.style.removeProperty('height');
        this.#clip(item, false);
      })
      .catch(() => {});
  }

  /**
   * Clip the item to its animating height, and put back whatever `overflow` it
   * had before.
   *
   * @param {HTMLDetailsElement} item
   * @param {boolean} on
   * @private
   */
  #clip(item, on) {
    if (on) {
      if (item.dataset.accordionClipped === undefined) {
        item.dataset.accordionClipped = item.style.overflow || '';
      }
      item.style.overflow = 'hidden';
      return;
    }

    const previous = item.dataset.accordionClipped;
    if (previous === undefined) return;

    if (previous === '') {
      item.style.removeProperty('overflow');
    } else {
      item.style.overflow = previous;
    }

    delete item.dataset.accordionClipped;
  }

  /**
   * @param {HTMLDetailsElement} item
   * @private
   */
  #animateClose(item) {
    const panel = this.#panelOf(item);

    if (!panel || prefersReducedMotion()) {
      item.open = false;
      return;
    }

    const running = this.#animations.get(item);
    const from = running ? item.getBoundingClientRect().height : null;
    running?.animation.cancel();
    running?.fade?.cancel();

    const start = from ?? item.offsetHeight;
    const end = this.#closedHeight(item);

    this.#clip(item, true);

    this.#run(item, 'close', start, end, panel, 260, 'cubic-bezier(0.33, 0, 0.2, 1)');
  }
}

defineComponent('accordion-element', AccordionElement);

/* ==========================================================================
   <footer-columns>
   --------------------------------------------------------------------------
   The footer panel's grid, measured from its own children.
   ========================================================================== */

/** How many columns share a row before the next one wraps. */
const FOOTER_MAX_COLUMNS = 6;

export class FooterColumns extends AccordionElement {
  /** @type {MutationObserver|null} */
  #watcher = null;

  /** @type {ResizeObserver|null} */
  #resizer = null;

  /** @type {number} */
  #pending = 0;

  /** @type {number} Re-measure passes since the last settled layout. */
  #passes = 0;

  setup() {
    super.setup();
    this.#measure();

    this.#watcher = new MutationObserver(() => this.#schedule(true));
    this.#watcher.observe(this, {
      childList: true,
      subtree: false,
      attributes: true,
      attributeFilter: ['style', 'data-divider'],
    });

    if (typeof ResizeObserver === 'function') {
      this.#resizer = new ResizeObserver(() => this.#schedule(true));
      this.#resizer.observe(this);
    }
  }

  /**
   * Coalesce measurements to one per frame.
   *
   * @private
   */
  #schedule(reset = false) {
    if (reset) this.#passes = 0;
    if (this.#pending) return;

    this.#pending = requestAnimationFrame(() => {
      this.#pending = 0;
      this.#measure();
    });
  }

  teardown() {
    super.teardown();
    this.#watcher?.disconnect();
    this.#watcher = null;
    this.#resizer?.disconnect();
    this.#resizer = null;
    if (this.#pending) cancelAnimationFrame(this.#pending);
    this.#pending = 0;
  }

  /** @private */
  #measure() {
    const children = Array.from(this.children);
    const columns = children.filter((el) => el.classList.contains('footer-column'));
    const policy = children.find((el) => el.classList.contains('footer__policies'));

    if (columns.length === 0) {
      this.removeAttribute('data-measured');
      return;
    }

    const tracks = columns
      .slice(0, FOOTER_MAX_COLUMNS)
      .map((el) => {
        const share = parseFloat(getComputedStyle(el).getPropertyValue('--column-width'));
        return `${Number.isFinite(share) && share > 0 ? (share / 100).toFixed(4) : 1}fr`;
      })
      .join(' ');

    const asideIndex = columns.findIndex((el) => el.hasAttribute('data-divider'));
    const hasAside = asideIndex >= 0;

    const trackCount = Math.min(columns.length, FOOTER_MAX_COLUMNS);
    const span = Math.min(Math.max(hasAside ? asideIndex : trackCount, 1), trackCount);

    this.style.setProperty('--panel-tracks', tracks);
    this.style.setProperty('--policy-span', String(span));

    const pinAside = hasAside && asideIndex < trackCount;

    if (pinAside) {
      this.style.setProperty('--aside-column', String(asideIndex + 1));
    } else {
      this.style.removeProperty('--aside-column');
    }

    this.toggleAttribute('data-aside-pinned', pinAside);

    const others = children.filter(
      (el) =>
        el !== policy &&
        !el.classList.contains('footer-column') &&
        !el.classList.contains('footer-utilities') &&
        !el.classList.contains('footer-legal')
    );
    const columnRows = new Set(columns.map((el) => Math.round(el.getBoundingClientRect().top))).size;
    const spansPolicy =
      Boolean(policy) && columnRows === 1 && others.length === 0 && columns.length <= trackCount;

    this.style.setProperty('--aside-span', spansPolicy ? '2' : '1');

    this.toggleAttribute('data-measured', true);

    const rows = this.#rowCount();
    const value = 'auto '.repeat(rows).trim();

    if (this.style.getPropertyValue('--panel-card-rows') === value) return;

    this.style.setProperty('--panel-card-rows', value);

    if (this.#passes < 4) {
      this.#passes += 1;
      this.#schedule();
    }
  }

  /**
   * How many grid rows the card covers.
   *
   * @returns {number}
   * @private
   */
  #rowCount() {
    const inside = Array.from(this.children).filter(
      (el) => !el.classList.contains('footer-utilities') && !el.classList.contains('footer-legal')
    );

    const offsets = new Set(inside.map((el) => Math.round(el.getBoundingClientRect().top)));

    return Math.max(offsets.size, 1);
  }
}

defineComponent('footer-columns', FooterColumns);

/* ==========================================================================
   <tabs-element>
   ========================================================================== */

/** A tab list implementing the ARIA authoring practices roving tabindex pattern. */
export class TabsElement extends BaseComponent {
  setup() {
    const tabs = this.#tabs();
    if (tabs.length === 0) return;

    const initial = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    this.select(initial >= 0 ? initial : 0, { focus: false });

    for (const [index, tab] of tabs.entries()) {
      this.on(tab, 'click', (event) => {
        event.preventDefault();
        this.select(index);
      });
      this.on(tab, 'keydown', (event) => this.#onKeydown(event, index));
    }
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @param {number} index
   * @param {{ focus?: boolean }} [options]
   */
  select(index, { focus = true } = {}) {
    const tabs = this.#tabs();
    const panels = this.#panels();
    if (index < 0 || index >= tabs.length) return;

    for (const [i, tab] of tabs.entries()) {
      const selected = i === index;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
      panels[i]?.toggleAttribute('hidden', !selected);
    }

    if (focus) tabs[index].focus();
    this.dataset.selected = String(index);
  }

  /**
   * @returns {number}
   */
  get selectedIndex() {
    return Number(this.dataset.selected) || 0;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @returns {HTMLElement[]}
   * @private
   */
  #tabs() {
    const list = this.querySelector('[role="tablist"]') ?? this;
    return /** @type {HTMLElement[]} */ ([...list.querySelectorAll('[role="tab"]')]);
  }

  /**
   * The panels, in document order, which is the order their tabs are in — the
   * two are paired by index in `select()`.
   *
   * @returns {HTMLElement[]}
   * @private
   */
  #panels() {
    return /** @type {HTMLElement[]} */ ([...this.querySelectorAll('[role="tabpanel"]')]);
  }

  /**
   * @param {KeyboardEvent} event
   * @param {number} index
   * @private
   */
  #onKeydown(event, index) {
    const tabs = this.#tabs();
    const forward = isRTL() ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRTL() ? 'ArrowRight' : 'ArrowLeft';

    let next = null;

    switch (event.key) {
      case forward:
      case 'ArrowDown':
        next = (index + 1) % tabs.length;
        break;
      case backward:
      case 'ArrowUp':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.select(next);
  }
}

defineComponent('tabs-element', TabsElement);

/* ==========================================================================
   <show-more>
   ========================================================================== */

/** Collapses long content behind an expand control. */
export class ShowMore extends BaseComponent {
  static requiredRefs = ['content', 'button'];

  /** @type {ResizeObserver|null} */
  #observer = null;

  setup() {
    this.#measure();

    this.on(this.refs.button, 'click', () => this.toggle());

    this.#observer = new ResizeObserver(rafThrottle(() => this.#measure()));
    this.#observer.observe(this.refs.content);
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {boolean}
   */
  get expanded() {
    return this.refs.button.getAttribute('aria-expanded') === 'true';
  }

  toggle() {
    this.#setExpanded(!this.expanded);
  }

  expand() {
    this.#setExpanded(true);
  }

  collapse() {
    this.#setExpanded(false);
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {boolean} expanded
   * @private
   */
  #setExpanded(expanded) {
    const content = this.refs.content;
    const button = this.refs.button;

    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    this.toggleAttribute('data-expanded', expanded);

    content.style.maxHeight = expanded ? `${content.scrollHeight}px` : `${this.#threshold()}px`;

    const label = expanded ? button.dataset.labelLess : button.dataset.labelMore;
    if (label) {
      const text = button.querySelector('[data-ref="label"]') || button;
      text.textContent = label;
    }

    if (expanded) {
      content.addEventListener(
        'transitionend',
        () => {
          if (this.expanded) content.style.maxHeight = 'none';
        },
        { once: true }
      );
    }
  }

  /**
   * @returns {number}
   * @private
   */
  #threshold() {
    return Number(this.dataset.height) || 180;
  }

  /** @private */
  #measure() {
    const content = this.refs.content;
    const button = this.refs.button;
    const threshold = this.#threshold();

    const previous = content.style.maxHeight;
    content.style.maxHeight = 'none';
    const natural = content.scrollHeight;
    content.style.maxHeight = previous;

    const needed = natural > threshold + 16;

    button.toggleAttribute('hidden', !needed);
    this.toggleAttribute('data-collapsible', needed);

    if (!needed) {
      content.style.maxHeight = 'none';
      return;
    }

    if (!this.expanded) content.style.maxHeight = `${threshold}px`;
  }
}

defineComponent('show-more', ShowMore);

/* ==========================================================================
   <deferred-media>
   ========================================================================== */

/** Loads heavy media only once the customer asks for it. */
export class DeferredMedia extends BaseComponent {
  static requiredRefs = ['template'];

  /** @type {boolean} */
  #loaded = false;

  /** @type {(() => void)|null} */
  #cancelObserve = null;

  setup() {
    this.#loaded = this.hasAttribute('data-loaded');

    if (this.refs.poster) {
      this.on(this.refs.poster, 'click', (event) => {
        event.preventDefault();
        this.load();
      });
    }

    if (this.dataset.autoplay === 'true') this.#loadWhenVisible();
  }

  teardown() {
    this.#cancelObserve?.();
    this.#cancelObserve = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * Insert the template's contents and start playback where applicable.
   *
   * @returns {HTMLElement|null} The inserted media element.
   */
  load() {
    if (this.#loaded) return this.querySelector('video, iframe, model-viewer');

    const template = this.refs.template;
    if (!(template instanceof HTMLTemplateElement)) return null;

    const content = template.content.cloneNode(true);
    const host = this.refs.container instanceof HTMLElement ? this.refs.container : this;

    host.appendChild(content);

    this.#loaded = true;
    this.setAttribute('data-loaded', '');
    this.refs.poster?.setAttribute('hidden', '');

    const media = this.querySelector('video, iframe, model-viewer');

    if (media instanceof HTMLVideoElement) {
      media.play().catch(() => {});
    }

    if (media instanceof HTMLElement && this.dataset.autoplay !== 'true') {
      media.setAttribute('tabindex', '-1');
      media.focus({ preventScroll: true });
    }

    return media instanceof HTMLElement ? media : null;
  }

  /**
   * @returns {boolean}
   */
  get loaded() {
    return this.#loaded;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #loadWhenVisible() {
    if (!('IntersectionObserver' in window)) {
      this.load();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        this.load();
      },
      { rootMargin: '200px' }
    );

    observer.observe(this);
    this.#cancelObserve = () => observer.disconnect();
  }
}

defineComponent('deferred-media', DeferredMedia);

/* ==========================================================================
   <share-button>
   ========================================================================== */

/** Share a link. */
export class ShareButton extends BaseComponent {
  static requiredRefs = ['button'];

  /** @type {number|null} */
  #timer = null;

  setup() {
    this.on(this.refs.button, 'click', this.#onClick);
  }

  teardown() {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * @returns {string}
   */
  get url() {
    return this.dataset.url || window.location.href;
  }

  /**
   * @returns {string}
   */
  get title() {
    return this.dataset.title || document.title;
  }

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = async (event) => {
    event.preventDefault();

    if (navigator.share) {
      try {
        await navigator.share({ title: this.title, url: this.url });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }

    await this.copy();
  };

  /**
   * Copy the link and confirm it.
   *
   * @returns {Promise<boolean>}
   */
  async copy() {
    try {
      await navigator.clipboard.writeText(this.url);
      this.#confirm(themeString('shareCopied', ''));
      return true;
    } catch {
      this.#selectFallback();
      return false;
    }
  }

  /**
   * @param {string} message
   * @private
   */
  #confirm(message) {
    announce(message);

    const feedback = this.refs.feedback;
    if (!(feedback instanceof HTMLElement)) return;

    feedback.textContent = message;
    feedback.hidden = false;

    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      feedback.hidden = true;
    }, 3000);
  }

  /**
   * Put the URL on screen and select it, so it can be copied by hand.
   *
   * @private
   */
  #selectFallback() {
    const feedback = this.refs.feedback;
    if (!(feedback instanceof HTMLElement)) {
      announce(this.url);
      return;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = this.url;
    input.className = 'share-button__url';
    input.setAttribute('aria-label', themeString('shareLink', ''));

    feedback.replaceChildren(input);
    feedback.hidden = false;

    input.select();
    announce(themeString('shareCopyManually', ''));
  }
}

defineComponent('share-button', ShareButton);

export default { AccordionElement, TabsElement, ShowMore, DeferredMedia, ShareButton };
