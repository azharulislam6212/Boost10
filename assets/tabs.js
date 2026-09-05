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
 * How far the pointer travels before a press on the strip becomes a drag.
 *
 * Zero would mean every click on a tab that moved a pixel scrolled the strip
 * instead of selecting the tab, which is most clicks made with a hand rather
 * than a mouse mat. Below the threshold nothing moves and nothing is swallowed.
 */
const DRAG_THRESHOLD = 5;


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
 * ## And it can be dragged
 *
 * A touchscreen drags the strip because the browser does it — `overflow-x` and
 * a finger is all that takes. A mouse has never had that: `overflow-x: auto`
 * with the scrollbar hidden gives a desktop customer a strip with tabs past the
 * edge, no bar to pull and no gesture that reaches them. Grabbing it is the
 * obvious thing to try and it did nothing.
 *
 * So a press and a pull moves `scrollLeft` here. Three things make it a drag
 * rather than a broken click:
 *
 *   - Nothing happens until the pointer has travelled `DRAG_THRESHOLD`, so a
 *     click on a tab is still a click on a tab.
 *   - The click the browser sends after the release is swallowed once. It
 *     reports where the pointer went down and came up, and after a drag the tab
 *     under it is not the one the customer asked for.
 *   - `data-dragging` turns off `scroll-behavior: smooth` and the snap points
 *     for the length of the gesture. Both exist for the programmatic scrolls
 *     and both fight a hand that is already holding the strip.
 *
 * Touch pointers are left alone deliberately: the browser's own scrolling has
 * momentum and rubber-banding, and a script that took the gesture over would be
 * replacing that with a worse version of it.
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

  /** @type {boolean} Whether a pointer drag is currently moving the strip. */
  #dragging = false;

  /** @type {boolean} Whether the next `click` is the tail of a drag. */
  #swallowClick = false;

  setup() {
    this.#buildTabs();

    const initial = this.tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    this.#index = initial === -1 ? 0 : initial;

    this.delegate('click', '[role="tab"]', (event, tab) => {
      event.preventDefault();

      // The click at the end of a drag. Swallowed once — see `#onPointerDown`.
      //
      // `detail` is the click count, and it is 0 for the click a browser
      // synthesises from Enter or Space on a focused button. A keyboard
      // activation has no drag behind it whatever the flag says, so it is
      // never the one to throw away.
      if (this.#swallowClick) {
        this.#swallowClick = false;
        if (/** @type {MouseEvent} */ (event).detail > 0) return;
      }

      this.select(this.tabs.indexOf(tab));
    });

    this.on(this.refs.list, 'keydown', (event) => this.#onKeydown(event));

    if (this.dataset.hover === 'true') {
      this.delegate('pointerenter', '[role="tab"]', (_event, tab) => {
        // Dragging the strip moves tabs under a stationary pointer, and every
        // one of them would open a panel on the way past.
        if (this.#dragging) return;
        this.select(this.tabs.indexOf(tab));
      }, { capture: true });
    }

    // The marker is positioned from measured boxes, so anything that changes a
    // tab's size has to move it: a container resize, a panel opening, a strip
    // that was not painted when it was first placed. Observing the list covers
    // those without a resize listener. Font loading is the exception, and is
    // handled separately below.
    this.#observer = new ResizeObserver(
      rafThrottle(() => {
        this.#placeMarker(false);
        this.#syncOverflow();
      })
    );
    this.#observer.observe(this.refs.list);

    // Not passive: the point of the handler is to take the gesture off the page.
    this.on(this.refs.list, 'wheel', (event) => this.#onWheel(event), { passive: false });

    this.on(this.refs.list, 'pointerdown', (event) => this.#onPointerDown(event));

    // An icon or an image inside a tab is something the browser will happily
    // start a native drag with, and that drag ends the scroll gesture halfway
    // through it — the ghost image follows the pointer and the strip stops.
    // Tested against the overflow rather than against `#dragging`, because the
    // native drag begins before the five pixels that make this one.
    this.on(this.refs.list, 'dragstart', (event) => {
      if (this.#overflowing) event.preventDefault();
    });

    this.#syncOverflow();

    // Web fonts are the one case the observer above cannot see. The list's own
    // width comes from the grid column it sits in, so a swapped font changes
    // every tab inside it and leaves the observed box exactly where it was —
    // and that is the difference between a strip that fits and one that does
    // not, which decides both where the marker goes and whether the strip can
    // be dragged or take the wheel off the page.
    document.fonts?.ready.then(() => {
      if (!this.isConnected) return;
      this.#placeMarker(false);
      this.#syncOverflow();
    });

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

    // Moving an element in the DOM disconnects and reconnects it, and morphing
    // does exactly that — so a drag can be interrupted mid-gesture. The
    // listeners go with the AbortController; the state they were writing has to
    // be put back by hand, or the strip comes back holding a `data-dragging`
    // that nothing will ever remove.
    this.#dragging = false;
    this.#swallowClick = false;
    this.refs.list?.removeAttribute('data-dragging');
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
   * `data-lenis-prevent-wheel` is Lenis's: it hands the wheel back to the
   * browser for any gesture over this element. `data-draggable` is this
   * theme's, and is what puts the grab cursor on the strip — the only thing
   * that tells a desktop customer the row can be pulled, since the scrollbar is
   * hidden.
   *
   * Both are toggled rather than written once. A strip that fits has nothing to
   * scroll: it would be taking the page's smooth scrolling away from whoever
   * moved a pointer across it, and offering a grab handle for a gesture that
   * cannot move anything.
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
    list.toggleAttribute('data-draggable', overflowing);
  }

  /**
   * Drag the strip with a pointer.
   *
   * Listeners go on `document` rather than on the strip, and no pointer is
   * captured. Both are deliberate:
   *
   *   - `document` is what keeps the gesture alive once the pointer leaves the
   *     strip, which it does constantly — the strip is one row of buttons tall
   *     and a hand pulling sideways drifts out of it in a few frames.
   *   - `setPointerCapture` would have done the same, but a captured pointer
   *     retargets the `click` that follows to the capturing element. The click
   *     on a tab is how a tab is selected, so capturing here would trade one
   *     bug for a worse one.
   *
   * The position is recomputed from where the gesture started rather than added
   * to frame by frame, so a frame the browser skipped cannot accumulate into
   * drift between the pointer and the strip under it.
   *
   * @param {PointerEvent} event
   * @private
   */
  #onPointerDown(event) {
    // First, and before any of the guards below. A press is the start of a
    // fresh gesture, so suppression left over from a drag that ended somewhere
    // other than on a tab dies here rather than eating the click that is about
    // to happen — including when the reason this handler returns early is that
    // the strip has since stopped overflowing.
    this.#swallowClick = false;

    const list = this.refs.list;
    if (!list || !this.#overflowing) return;

    // The browser already does this for a finger, with momentum and
    // rubber-banding that nothing here would improve on.
    if (event.pointerType === 'touch') return;

    // Primary button only: the middle one is autoscroll and the right one is a
    // context menu, and neither belongs to this.
    if (event.button !== 0) return;

    const startX = event.clientX;
    const startScroll = list.scrollLeft;

    /** @param {PointerEvent} move */
    const onMove = (move) => {
      const delta = move.clientX - startX;

      if (!this.#dragging) {
        if (Math.abs(delta) < DRAG_THRESHOLD) return;

        this.#dragging = true;
        list.toggleAttribute('data-dragging', true);
      }

      list.scrollLeft = startScroll - delta;
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);

      if (!this.#dragging) return;

      this.#dragging = false;
      list.removeAttribute('data-dragging');

      // The click the release is about to produce is the browser reporting
      // where the pointer went down and came up. After a drag that is whichever
      // tab happens to be under the hand, not the one the customer asked for.
      this.#swallowClick = true;
    };

    document.addEventListener('pointermove', onMove, { signal: this.signal });
    document.addEventListener('pointerup', onUp, { signal: this.signal });
    document.addEventListener('pointercancel', onUp, { signal: this.signal });
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
