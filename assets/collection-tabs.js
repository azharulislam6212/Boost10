/**
 * collection-tabs.js — Boost10
 *
 * The tab strip inside a mega menu panel.
 *
 * ## Why this exists when `<details>` did the job elsewhere
 *
 * Tabs and disclosure rows look similar and behave differently. A disclosure is
 * independent — any number can be open. Tabs are exclusive, and the ARIA
 * pattern for them requires arrow-key navigation with a single tab stop for the
 * whole strip, which no native element provides.
 *
 * Getting that wrong is the common failure: a tablist built from buttons with
 * no `keydown` handler leaves a keyboard user tabbing through every tab one at
 * a time, inside a menu they are only passing through.
 *
 * ## Roving tabindex
 *
 * Exactly one tab has `tabindex="0"` at any moment; the rest are `-1`. Tab
 * enters the strip once, arrow keys move within it, Tab leaves. Home and End
 * jump to the ends, which the pattern also specifies and which matters when a
 * merchant configures the maximum three tabs.
 *
 * Panels are shown and hidden with the `hidden` attribute rather than CSS, so
 * an inactive panel's products are out of the accessibility tree and out of the
 * tab order — not merely invisible.
 *
 * @element collection-tabs
 */

import { BaseComponent, defineComponent } from '@theme/component';

export class CollectionTabs extends BaseComponent {
  static requiredRefs = ['tablist'];

  setup() {
    this.on(this.refs.tablist, 'click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (!tab) return;
      this.select(this.tabs.indexOf(tab));
    });

    this.on(this.refs.tablist, 'keydown', (event) => this.#onKeydown(event));
  }

  /* --------------------------------------------------------- public API -- */

  /** @returns {HTMLElement[]} */
  get tabs() {
    return Array.from(this.refs.tablist?.querySelectorAll('[role="tab"]') ?? []);
  }

  /** @returns {HTMLElement[]} */
  get panels() {
    return Array.from(this.querySelectorAll('[role="tabpanel"]'));
  }

  /**
   * @param {number} index
   * @param {boolean} [focus] Move focus to the newly selected tab.
   */
  select(index, focus = false) {
    const tabs = this.tabs;
    if (index < 0 || index >= tabs.length) return;

    for (const [i, tab] of tabs.entries()) {
      const active = i === index;
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    }

    for (const [i, panel] of this.panels.entries()) {
      panel.toggleAttribute('hidden', i !== index);
    }

    if (focus) tabs[index].focus();
  }

  /* ---------------------------------------------------------- internals -- */

  /** @returns {number} @private */
  get #current() {
    return this.tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown(event) {
    const tabs = this.tabs;
    if (tabs.length === 0) return;

    const rtl = getComputedStyle(this).direction === 'rtl';
    const current = Math.max(0, this.#current);
    let next = null;

    switch (event.key) {
      case 'ArrowRight':
        next = rtl ? current - 1 : current + 1;
        break;
      case 'ArrowLeft':
        next = rtl ? current + 1 : current - 1;
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

    // Wrapping, because the pattern expects it and because a three-tab strip
    // that dead-ends feels broken long before it feels safe.
    if (next < 0) next = tabs.length - 1;
    if (next >= tabs.length) next = 0;

    event.preventDefault();
    this.select(next, true);
  }
}

defineComponent('collection-tabs', CollectionTabs);

export default { CollectionTabs };
