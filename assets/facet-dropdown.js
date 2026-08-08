/**
 * facet-dropdown.js — Boost10
 *
 * The popover behaviour for the horizontal filter layout.
 *
 * ## Why this is so small
 *
 * The markup is a `<details>` element, so the browser already provides the
 * open/closed state, the toggle on click and Enter, and the correct
 * `aria-expanded` semantics on `<summary>`. Reimplementing those with a button
 * and a state flag is how filter bars end up unreachable by keyboard.
 *
 * What the browser does not provide, and this class adds:
 *
 *   1. Only one panel open at a time. Two overlapping popovers is a bug, not
 *      a feature, and `<details name="...">` is not yet safe to rely on here.
 *   2. Escape closes, and returns focus to the summary that opened it.
 *   3. Outside clicks close.
 *   4. Flipping alignment when a panel would overflow the viewport.
 *
 * Filtering itself is untouched: the inputs inside are the same ones the
 * sidebar and drawer use, and `<facet-filters>` in `facets.js` still owns
 * submitting the form and morphing the results.
 *
 * @element facet-dropdown
 */

import { BaseComponent, defineComponent } from '@theme/component';

export class FacetDropdown extends BaseComponent {
  static requiredRefs = ['summary', 'panel'];

  /** @type {HTMLDetailsElement|null} */
  get #details() {
    return this instanceof HTMLElement ? this.querySelector('details') : null;
  }

  setup() {
    const details = this.#details;
    if (!details) return;

    this.on(details, 'toggle', () => {
      if (!details.open) return;

      this.#closeSiblings();
      this.#align();
    });

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !details.open) return;

      // Stop the event before it reaches any drawer this bar might sit inside.
      // Escape should close the popover the customer is looking at, not the
      // whole filter drawer around it.
      event.stopPropagation();
      details.open = false;
      this.refs.summary?.focus();
    });

    this.on(document, 'click', (event) => {
      if (!details.open) return;
      if (event.target instanceof Node && this.contains(event.target)) return;
      details.open = false;
    });

    this.on(window, 'resize', () => {
      if (details.open) this.#align();
    });
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #closeSiblings() {
    const bar = this.closest('.collection-filters__bar') ?? document;

    for (const other of bar.querySelectorAll('facet-dropdown')) {
      if (other === this) continue;
      const details = other.querySelector('details');
      if (details) details.open = false;
    }
  }

  /**
   * Flip the panel to the inline end when it would otherwise run past the
   * viewport. Measured rather than assumed, because how many filters fit before
   * the overflow starts depends on the merchant's filter names.
   * @private
   */
  #align() {
    const panel = this.refs.panel;
    if (!(panel instanceof HTMLElement)) return;

    this.removeAttribute('data-align');

    const rect = panel.getBoundingClientRect();
    const rtl = getComputedStyle(this).direction === 'rtl';
    const overflows = rtl ? rect.left < 0 : rect.right > window.innerWidth;

    if (overflows) this.setAttribute('data-align', 'end');
  }
}

defineComponent('facet-dropdown', FacetDropdown);

export default { FacetDropdown };
