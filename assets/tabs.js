/**
 * tabs.js — Boost10
 *
 * `<tab-group>`: a tablist, its panels, and a marker that slides between them.
 *
 * Deliberately generic. It reads `role="tab"` and `role="tabpanel"` and nothing
 * else, so the same element drives the mega menu, a size guide and a spec table
 * without any of them appearing in this file.
 *
 * @module @theme/tabs
 */
import { BaseComponent, defineComponent } from '@theme/component';
import { rafThrottle, prefersReducedMotion, isDesignMode } from '@theme/utilities';


/**
 * A tab strip with animated selection.
 *
 * ## The marker is measured, not guessed
 *
 * The active state slides because a single element is moved to the active tab's
 * box, rather than a background colour being switched on. That means the tab
 * itself can keep whatever padding and font the design calls for, and the
 * marker follows — including when a web font finishes loading and every tab
 * changes width, which is what the `ResizeObserver` is for.
 *
 * ## Hover selects, but only where the caller asked
 *
 * `data-hover` exists for the mega menu, where the customer is already moving a
 * pointer across a list of categories and a required click is an extra step for
 * nothing. It is off everywhere else, because hover-to-select on a form is a
 * way to lose what you were reading.
 *
 * ## The strip scrolls, and something else owns the wheel
 *
 * A horizontal strip is a scroll container, and this theme runs Lenis for page
 * scrolling (`assets/scrollbar.js`). Lenis cancels wheel gestures and animates
 * the page itself, so a strip that overflowed could not be scrolled with a
 * wheel or a trackpad at all — it looked like a strip with no way to reach the
 * tabs past the edge, which is what it was.
 *
 * `data-lenis-prevent-wheel` is the theme's own opt-out — the dialog, the
 * filters drawer and the media zoom all use it — and it goes on and comes off
 * with the overflow. Left on permanently, a strip that fits would swallow the
 * smooth page scroll of anyone whose pointer happened to be over it.
 *
 * With Lenis out of the way the browser scrolls the strip natively for a
 * horizontal gesture. A plain mouse has no horizontal gesture, so a vertical
 * wheel over the strip is mapped across here, and handed back at either end so
 * the page keeps scrolling once the strip has run out.
 *
 * Attributes:
 *   data-orientation  horizontal | vertical
 *   data-activation   auto (arrow keys select) | manual (arrow keys only move focus)
 *   data-hover        "true" to select on pointerenter
 */
export class TabGroup extends BaseComponent {
  static requiredRefs = ['list'];

  /** @type {ResizeObserver|null} */
  #observer = null;

  /** @type {number} */
  #index = 0;

  /** @type {boolean} Whether the strip currently has more tabs than it can show. */
  #overflowing = false;

  setup() {
    this.#buildTabs();

    const initial = this.tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    this.#index = initial === -1 ? 0 : initial;

    this.delegate('click', '[role="tab"]', (event, tab) => {
      event.preventDefault();
      this.select(this.tabs.indexOf(tab));
    });

    this.on(this.refs.list, 'keydown', (event) => this.#onKeydown(event));

    if (this.dataset.hover === 'true') {
      this.delegate('pointerenter', '[role="tab"]', (_event, tab) => {
        this.select(this.tabs.indexOf(tab));
      }, { capture: true });
    }

    // The marker is positioned from measured boxes, so anything that changes a
    // tab's size has to move it: font loading, a container resize, a panel
    // opening. Observing the list covers all three without a resize listener.
    this.#observer = new ResizeObserver(
      rafThrottle(() => {
        this.#placeMarker(false);
        this.#syncOverflow();
      })
    );
    this.#observer.observe(this.refs.list);

    // Not passive: the point of the handler is to take the gesture off the page.
    this.on(this.refs.list, 'wheel', (event) => this.#onWheel(event), { passive: false });

    this.#syncOverflow();

    // The Theme Editor selects blocks the customer cannot see. A panel that is
    // not the current tab is `hidden`, so clicking "Tab — Returns" in the
    // sidebar scrolled to nothing and looked like a broken block. Bring its tab
    // forward instead, and let the editor's own scroll land on a visible panel.
    if (isDesignMode()) {
      this.on(document, 'shopify:block:select', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (!(target instanceof HTMLElement)) return;

        const panels = this.panels;
        const index = panels.findIndex((panel) => panel === target || panel.contains(target));
        if (index !== -1) this.select(index);
      });
    }

    this.select(this.#index, { silent: true, animate: false });
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- */

  /** @returns {HTMLElement[]} */
  get tabs() {
    return /** @type {HTMLElement[]} */ ([...this.refs.list.querySelectorAll('[role="tab"]')]);
  }

  /** @returns {HTMLElement[]} */
  get panels() {
    return /** @type {HTMLElement[]} */ ([...this.querySelectorAll('[role="tabpanel"]')]);
  }

  /** @returns {number} */
  get selectedIndex() {
    return this.#index;
  }

  /**
   * Select a tab by index. Out-of-range indices are ignored rather than
   * clamped: a caller asking for tab 7 of 4 has a bug, and silently showing
   * tab 4 hides it.
   *
   * @param {number} index
   * @param {{ silent?: boolean, animate?: boolean }} [options]
   */
  select(index, options = {}) {
    const tabs = this.tabs;
    if (index < 0 || index >= tabs.length) return;

    this.#index = index;

    tabs.forEach((tab, position) => {
      const isSelected = position === index;
      tab.setAttribute('aria-selected', String(isSelected));
      // Roving tabindex: one stop for the whole strip, arrow keys inside it.
      tab.tabIndex = isSelected ? 0 : -1;
    });

    this.panels.forEach((panel, position) => {
      panel.toggleAttribute('hidden', position !== index);
    });

    this.#placeMarker(options.animate !== false);

    // Not on the first placement. `setup()` selects the initial tab silently,
    // and a `scrollIntoView` there would drag the page to the strip on load.
    if (!options.silent) this.#revealTab(tabs[index], options.animate !== false);


    if (!options.silent) {
      this.dispatchEvent(
        new CustomEvent('tab-group:select', { bubbles: true, detail: { index } })
      );
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Mark the strip while it has more tabs than it can show.
   *
   * The attribute is Lenis's: it hands the wheel back to the browser for any
   * gesture over this element. It is toggled rather than written once, because
   * a strip that fits has nothing to scroll and would only be taking the page's
   * smooth scrolling away from whoever moved a pointer across it.
   *
   * @private
   */
  #syncOverflow() {
    const list = this.refs.list;
    if (!list) return;

    // A sub-pixel difference is a rounding artefact, not a hidden tab.
    const overflowing = list.scrollWidth - list.clientWidth > 1;
    if (overflowing === this.#overflowing) return;

    this.#overflowing = overflowing;
    list.toggleAttribute('data-lenis-prevent-wheel', overflowing);
  }

  /**
   * Turn a vertical wheel into a horizontal one, while the strip has somewhere
   * to go.
   *
   * A trackpad swipe already arrives as `deltaX` and the browser handles it, so
   * this only takes over when the vertical delta is the larger of the two — a
   * mouse wheel, in other words. At either end the gesture is left alone, and
   * the page scrolls on as it would have.
   *
   * @param {WheelEvent} event
   * @private
   */
  #onWheel(event) {
    const list = this.refs.list;
    if (!list || !this.#overflowing) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    const max = list.scrollWidth - list.clientWidth;
    const next = list.scrollLeft + event.deltaY;
    if (next < 0 || next > max) return;

    event.preventDefault();

    // `instant`, not the element's own `scroll-behavior: smooth`: a wheel
    // already arrives in small steps, and animating each one lands the strip a
    // few frames behind the fingers pushing it.
    list.scrollBy({ left: event.deltaY, behavior: 'instant' });
  }

  /**
   * Bring the selected tab into view.
   *
   * A horizontal strip scrolls rather than wraps, so the tab that was just
   * selected with an arrow key can be off the edge — and a selected tab nobody
   * can see is the one thing a tab strip must never do. `nearest` so a tab
   * already on screen is left where it is: scrolling on every click would move
   * the strip under a pointer that is not asking for it.
   *
   * @param {HTMLElement|undefined} tab
   * @param {boolean} animate
   * @private
   */
  #revealTab(tab, animate) {
    if (!tab || !this.refs.list) return;

    const smooth = animate && !prefersReducedMotion();

    tab.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'nearest',
      inline: 'nearest',
    });
  }

  /**
   * Build the strip from the panels when the caller supplied none.
   *
   * A theme block that renders one panel per nested block cannot also render
   * the buttons: `{% content_for 'blocks' %}` produces a single stream, and the
   * buttons belong in a different container from the panels. So the panel
   * declares its own label with `data-tab-label` and the button is created
   * here, from markup Liquid could not have emitted in two places at once.
   *
   * A panel that wants more than a word in its button — an icon beside the
   * label — ships a `<template data-tab-button>` and that is cloned instead.
   * The alternative is an SVG escaped into a data attribute, which no formatter
   * indents and no checker validates. `data-tab-label` stays authoritative
   * either way: it is the fallback, and the accessible name if the template
   * turns out to hold nothing but decoration.
   *
   * Without JavaScript every panel simply stays visible, stacked, which is a
   * readable page rather than an empty one.
   *
   * @private
   */
  #buildTabs() {
    if (this.refs.list.querySelector('[role="tab"]')) return;

    const panels = this.panels.filter((panel) => panel.dataset.tabLabel);
    if (panels.length === 0) return;

    const fragment = document.createDocumentFragment();

    panels.forEach((panel, index) => {
      const id = panel.id || `${this.id || 'TabGroup'}-panel-${index}`;
      panel.id = id;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tabs__tab';
      tab.setAttribute('role', 'tab');
      tab.id = `${id}-tab`;
      tab.setAttribute('aria-controls', id);
      tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
      tab.tabIndex = index === 0 ? 0 : -1;

      // `:scope >` so a tab group nested inside a panel keeps its own buttons.
      const template = panel.querySelector(':scope > template[data-tab-button]');

      if (template instanceof HTMLTemplateElement) {
        tab.append(template.content.cloneNode(true));
      } else {
        tab.textContent = panel.dataset.tabLabel || '';
      }

      panel.setAttribute('aria-labelledby', tab.id);
      panel.toggleAttribute('hidden', index !== 0);

      fragment.append(tab);
    });

    this.refs.list.append(fragment);
  }

  /**
   * @param {boolean} animate
   * @private
   */
  #placeMarker(animate) {
    const marker = /** @type {HTMLElement|undefined} */ (this.refs.marker);
    const tab = this.tabs[this.#index];
    if (!marker || !tab) return;

    const listBox = this.refs.list.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();

    // A zero box means the group is inside something that has not been painted
    // yet — a closed mega menu panel, a hidden tabpanel. Writing the marker to
    // 0,0 in that state makes it visibly fly across the strip on open, so the
    // move is skipped and the next ResizeObserver callback places it.
    if (tabBox.width === 0 && tabBox.height === 0) return;

    marker.toggleAttribute('data-instant', !animate || prefersReducedMotion());

    marker.style.setProperty('--marker-width', `${tabBox.width}px`);
    marker.style.setProperty('--marker-height', `${tabBox.height}px`);
    marker.style.setProperty('--marker-x', `${tabBox.left - listBox.left + this.refs.list.scrollLeft}px`);
    marker.style.setProperty('--marker-y', `${tabBox.top - listBox.top + this.refs.list.scrollTop}px`);

    if (!animate) {
      // Force the instant placement to land before the attribute is removed,
      // or the browser coalesces both writes and animates anyway.
      void marker.offsetWidth;
      marker.removeAttribute('data-instant');
    }
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown(event) {
    const vertical = this.dataset.orientation === 'vertical';
    const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';

    let target = null;

    if (event.key === previous) target = this.#index - 1;
    else if (event.key === next) target = this.#index + 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = this.tabs.length - 1;
    else return;

    event.preventDefault();

    const count = this.tabs.length;
    const index = ((target % count) + count) % count;

    // Manual activation moves focus without changing the panel, which is what
    // a customer arrowing through a long strip to read the labels wants.
    if (this.dataset.activation === 'manual') {
      this.tabs[index]?.focus();
      return;
    }

    this.select(index);
    this.tabs[index]?.focus();
  }
}

defineComponent('tab-group', TabGroup);

export default { TabGroup };
