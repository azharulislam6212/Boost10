/**
 * `<tab-group>`: a tablist, its panels, and a marker that slides between them.
 *
 * @module @theme/tabs
 */
import { BaseComponent, defineComponent } from '@theme/component';
import { rafThrottle, prefersReducedMotion, isDesignMode } from '@theme/utilities';

/** How far the pointer travels before a press on the strip becomes a drag. */
const DRAG_THRESHOLD = 5;

/** A tab strip with animated selection. */
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

      if (this.#swallowClick) {
        this.#swallowClick = false;
        if (/** @type {MouseEvent} */ (event).detail > 0) return;
      }

      this.select(this.tabs.indexOf(tab));
    });

    this.on(this.refs.list, 'keydown', (event) => this.#onKeydown(event));

    if (this.dataset.hover === 'true') {
      this.delegate('pointerenter', '[role="tab"]', (_event, tab) => {
        if (this.#dragging) return;
        this.select(this.tabs.indexOf(tab));
      }, { capture: true });
    }

    this.#observer = new ResizeObserver(
      rafThrottle(() => {
        this.#placeMarker(false);
        this.#syncOverflow();
      })
    );
    this.#observer.observe(this.refs.list);

    this.on(this.refs.list, 'wheel', (event) => this.#onWheel(event), { passive: false });

    this.on(this.refs.list, 'pointerdown', (event) => this.#onPointerDown(event));

    this.on(this.refs.list, 'dragstart', (event) => {
      if (this.#overflowing) event.preventDefault();
    });

    this.#syncOverflow();

    document.fonts?.ready.then(() => {
      if (!this.isConnected) return;
      this.#placeMarker(false);
      this.#syncOverflow();
    });

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

    this.#dragging = false;
    this.#swallowClick = false;
    this.refs.list?.removeAttribute('data-dragging');
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** @returns {HTMLElement[]} */
  get tabs() {
    return /** @type {HTMLElement[]} */ ([...this.refs.list.querySelectorAll('[role="tab"]')]);
  }

  /**
   * This group's panels, and not the panels of a group nested inside one of
   * them.
   *
   * @returns {HTMLElement[]}
   */
  get panels() {
    return /** @type {HTMLElement[]} */ ([...this.querySelectorAll('[role="tabpanel"]')]).filter(
      (panel) => panel.closest('tab-group') === this
    );
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
      tab.tabIndex = isSelected ? 0 : -1;
    });

    this.panels.forEach((panel, position) => {
      panel.toggleAttribute('hidden', position !== index);
    });

    this.#placeMarker(options.animate !== false);

    if (!options.silent) this.#revealTab(tabs[index], options.animate !== false);

    if (!options.silent) {
      this.dispatchEvent(
        new CustomEvent('tab-group:select', { bubbles: true, detail: { index } })
      );
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Mark the strip while it has more tabs than it can show.
   *
   * @private
   */
  #syncOverflow() {
    const list = this.refs.list;
    if (!list) return;

    const overflowing = list.scrollWidth - list.clientWidth > 1;
    if (overflowing === this.#overflowing) return;

    this.#overflowing = overflowing;
    list.toggleAttribute('data-lenis-prevent-wheel', overflowing);
    list.toggleAttribute('data-draggable', overflowing);
  }

  /**
   * Drag the strip with a pointer.
   *
   * @param {PointerEvent} event
   * @private
   */
  #onPointerDown(event) {
    this.#swallowClick = false;

    const list = this.refs.list;
    if (!list || !this.#overflowing) return;

    if (event.pointerType === 'touch') return;

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

    list.scrollBy({ left: event.deltaY, behavior: 'instant' });
  }

  /**
   * Bring the selected tab into view.
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
   * @private
   */
  #buildTabs() {
    if (this.refs.list.querySelector('[role="tab"]')) return;

    const panels = this.panels.filter((panel) => panel.dataset.tabLabel);
    if (panels.length === 0) return;

    const preferred = panels.findIndex((panel) => panel.dataset.tabSelected != null);
    const selected = preferred === -1 ? 0 : preferred;

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
      tab.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      tab.tabIndex = index === selected ? 0 : -1;

      const template = panel.querySelector(':scope > template[data-tab-button]');

      if (template instanceof HTMLTemplateElement) {
        tab.append(template.content.cloneNode(true));
      } else {
        tab.textContent = panel.dataset.tabLabel || '';
      }

      panel.setAttribute('aria-labelledby', tab.id);
      panel.toggleAttribute('hidden', index !== selected);

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

    if (tabBox.width === 0 && tabBox.height === 0) return;

    marker.toggleAttribute('data-instant', !animate || prefersReducedMotion());

    marker.style.setProperty('--marker-width', `${tabBox.width}px`);
    marker.style.setProperty('--marker-height', `${tabBox.height}px`);
    marker.style.setProperty('--marker-x', `${tabBox.left - listBox.left + this.refs.list.scrollLeft}px`);
    marker.style.setProperty('--marker-y', `${tabBox.top - listBox.top + this.refs.list.scrollTop}px`);

    if (!animate) {
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
