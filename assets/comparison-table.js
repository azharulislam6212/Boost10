/**
 * comparison-table.js — Boost10
 *
 * `<comparison-table>` — the chooser on the Comparison table section, and the
 * three things about that table Liquid cannot know.
 *
 * ## It does not build the table, and that is the point
 *
 * The grid, the columns, the rows, the dividers and the marks are all rendered
 * by `blocks/_comparison-table.liquid` and laid out by `assets/base.css`. With
 * this module absent every alternative column is on screen, named, complete and
 * readable — the same shape `assets/collection-tabs.js` settled into, and for
 * the same reason: a table that hides half its content behind a script and then
 * fails to load that script has hidden it from search engines as well as from
 * customers.
 *
 * What is left here is what Liquid genuinely cannot do, because `block.blocks`
 * does not exist and `forloop` does not reach inside `{% content_for 'blocks' %}`
 * — a block cannot read its siblings, its children or its own position:
 *
 *   1. **Build each chooser's list.** The list *is* the set of alternative
 *      columns, so every column publishes its own name on
 *      `data-comparison-name` and this reads them all. The alternative is the
 *      merchant typing four names into four columns and keeping them in step by
 *      hand. Same mechanism as `<tab-group>` building its buttons from its
 *      panels.
 *
 *   2. **Correct the two counts.** `--ct-rows` and the column count are
 *      settings because the grid needs both before any child renders. Here they
 *      are re-read from the DOM, so a merchant who adds a seventh claim and
 *      forgets the slider still gets a table with seven rows in it.
 *
 *   3. **Name every mark.** A tick announces as nothing. The markup ships
 *      *Yes* / *No*; this upgrades it to *Third-party lab tested: Yes*, because
 *      it can count a cell's position and Liquid cannot.
 *
 * ## Choosing swaps rather than duplicates
 *
 * Picking *Recovery capsules* in a slot that is not currently showing it moves
 * that column into the slot. If it was already in another slot the two trade
 * places, rather than the same column appearing twice with the customer left to
 * work out why one of their comparisons vanished.
 *
 * ## Markup
 *
 *   <comparison-table data-rows="6" data-slots="2" data-slots-tablet="1" data-slots-mobile="1">
 *     <div data-comparison-column data-comparison-role="features"> … </div>
 *     <div data-comparison-column data-comparison-role="brand"> … </div>
 *     <div data-comparison-column data-comparison-role="product" data-comparison-name="Hydration powder">
 *       <div class="comparison-column__head">
 *         <button data-comparison-trigger aria-expanded="false">
 *           <span data-comparison-trigger-label>Hydration powder</span>
 *         </button>
 *         <div data-comparison-panel role="listbox" hidden></div>
 *       </div>
 *       <div data-comparison-cell data-comparison-kind="cross">
 *         <span data-comparison-mark><svg …><span data-comparison-answer>No</span></span>
 *       </div>
 *       …
 *     </div>
 *   </comparison-table>
 *
 * @element comparison-table
 * @module @theme/comparison-table
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { isDesignMode, uniqueId } from '@theme/utilities';

/** Where the tablet and phone layouts begin. Mirrors `assets/base.css`. */
const TABLET = '(max-width: 989px)';
const MOBILE = '(max-width: 749px)';

export class ComparisonTable extends BaseComponent {
  /** @type {HTMLElement[]} */
  #columns = [];

  /** @type {HTMLElement[]} */
  #alternatives = [];

  /** @type {HTMLElement|null} */
  #features = null;

  /**
   * Which alternative column is in which slot, left to right. Indices into
   * `#alternatives`; its length is how many slots this breakpoint has.
   * @type {number[]}
   */
  #slots = [];

  /** @type {HTMLElement|null} */
  #open = null;

  #id = '';

  setup() {
    this.#id = this.id || uniqueId('comparison');

    this.#read();
    if (this.#columns.length === 0) return;

    this.#applyCounts();
    this.#labelMarks();
    this.#resize();

    // One listener per query rather than one resize handler: a breakpoint
    // change is the only width that matters here, and `change` fires once at
    // the crossing instead of on every pixel of a drag.
    for (const query of [TABLET, MOBILE]) {
      this.on(window.matchMedia(query), 'change', () => this.#resize());
    }

    this.on(this, 'click', this.#onClick);
    this.on(this, 'keydown', this.#onKeydown);

    // Closing needs a listener outside this element, which is why it is not
    // delegated. `pointerdown` rather than `click` so a press that starts
    // outside the panel closes it before the thing under it reacts.
    this.on(document, 'pointerdown', this.#onDocumentPointerDown);

    if (isDesignMode()) {
      // The editor selects blocks the customer cannot see. A column past the
      // slot count is `hidden`, so clicking it in the sidebar scrolled to
      // nothing and read as a broken block. Bring it into the first slot
      // instead and let the editor's own scroll land on something visible.
      this.on(document, 'shopify:block:select', (event) => {
        const target = /** @type {Event} */ (event).target;
        if (!(target instanceof HTMLElement) || !this.contains(target)) return;

        const column = target.closest('[data-comparison-column]');
        if (!(column instanceof HTMLElement)) return;

        const index = this.#alternatives.indexOf(column);
        if (index === -1 || this.#slots.includes(index)) return;

        this.#slots[0] = index;
        this.#apply();
      });
    }
  }

  teardown() {
    this.#close();
  }

  /* ------------------------------------------------------------- reading -- */

  #read() {
    this.#columns = /** @type {HTMLElement[]} */ (
      [...this.children].filter((node) => node instanceof HTMLElement && node.hasAttribute('data-comparison-column'))
    );

    this.#features = this.#columns.find((column) => column.dataset.comparisonRole === 'features') ?? null;
    this.#alternatives = this.#columns.filter((column) => column.dataset.comparisonRole === 'product');
  }

  /**
   * The two numbers the grid needs before any child has rendered, re-read from
   * the children that have now rendered.
   *
   * Rows is the longest column rather than the claims column, so a table whose
   * claims column is shorter than an answer column still has a track for every
   * answer instead of dropping the last one into an implicit row of its own.
   */
  #applyCounts() {
    let rows = 0;
    for (const column of this.#columns) {
      rows = Math.max(rows, column.querySelectorAll(':scope > [data-comparison-cell]').length);
    }
    if (rows > 0) this.style.setProperty('--ct-rows', String(rows));

    this.classList.toggle('comparison-grid--no-labels', this.#features === null);
  }

  /* ------------------------------------------------------------- layout -- */

  /**
   * How many alternatives this width shows, and which ones. The assignment is
   * kept across a breakpoint change wherever it still fits, so a customer who
   * picked *Energy drops* on a phone and then rotated the device is still
   * looking at Energy drops.
   */
  #resize() {
    const count = Math.max(1, Number(this.#slotCount()) || 1);
    const available = Math.min(count, this.#alternatives.length);

    const next = [];
    for (let position = 0; position < available; position += 1) {
      const kept = this.#slots[position];
      next.push(typeof kept === 'number' && kept < this.#alternatives.length ? kept : -1);
    }

    // Fill the gaps with whichever columns are not spoken for, in their own
    // order, so the default arrangement is the merchant's arrangement.
    let candidate = 0;
    for (let position = 0; position < next.length; position += 1) {
      if (next[position] !== -1) continue;
      while (candidate < this.#alternatives.length && next.includes(candidate)) candidate += 1;
      next[position] = candidate;
      candidate += 1;
    }

    this.#slots = next;
    this.#apply();
  }

  /** @returns {number} */
  #slotCount() {
    if (window.matchMedia(MOBILE).matches) return Number(this.dataset.slotsMobile ?? 1);
    if (window.matchMedia(TABLET).matches) return Number(this.dataset.slotsTablet ?? 1);
    return Number(this.dataset.slots ?? 2);
  }

  /**
   * Writes the arrangement to the DOM.
   *
   * Placement is `order` and `hidden`, never `grid-column`. Columns carry a
   * definite row span and no column position, so the grid places them into
   * successive tracks in order-modified document order — which means moving one
   * is one property, and a column that is `display: none` stops being a grid
   * item and leaves no empty track behind it.
   */
  #apply() {
    if (this.#features) this.#features.style.order = '0';

    for (const column of this.#columns) {
      if (column.dataset.comparisonRole === 'brand') column.style.order = '1';
    }

    this.#alternatives.forEach((column, index) => {
      const position = this.#slots.indexOf(index);

      if (position === -1) {
        column.hidden = true;
        column.style.removeProperty('order');
        return;
      }

      column.hidden = false;
      column.style.order = String(2 + position);
    });

    const brands = this.#columns.filter((column) => column.dataset.comparisonRole === 'brand').length;
    this.style.setProperty('--ct-cols-active', String(brands + this.#slots.length));

    for (const column of this.#alternatives) this.#buildPanel(column);
  }

  /* ------------------------------------------------------------ chooser -- */

  /**
   * Fills one column's listbox with every alternative there is.
   *
   * Rebuilt on every arrangement change rather than patched, because what marks
   * the chosen one — `aria-selected`, and the weight `assets/base.css` hangs off
   * it — is a property of the arrangement rather than of the option.
   *
   * @param {HTMLElement} column
   */
  #buildPanel(column) {
    const panel = column.querySelector('[data-comparison-panel]');
    const trigger = column.querySelector('[data-comparison-trigger]');
    if (!(panel instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return;

    const slot = this.#slots.indexOf(this.#alternatives.indexOf(column));
    if (slot === -1) return;

    const panelId = `${this.#id}-panel-${slot}`;
    panel.id = panelId;
    trigger.setAttribute('aria-controls', panelId);

    // The button does something now, so it stops saying it does not. See the
    // note in `blocks/_comparison-column.liquid` on why it ships this way.
    trigger.removeAttribute('aria-disabled');

    const label = column.querySelector('[data-comparison-trigger-label]');
    if (label) label.textContent = this.#nameOf(column);

    const options = this.#alternatives.map((alternative, index) => {
      const option = document.createElement('div');
      option.className = 'comparison-choose__option';
      option.id = `${panelId}-option-${index}`;
      option.setAttribute('role', 'option');
      option.dataset.comparisonOption = String(index);
      option.setAttribute('aria-selected', String(alternative === column));
      option.textContent = this.#nameOf(alternative);
      return option;
    });

    panel.replaceChildren(...options);
  }

  /**
   * A column's name, from the attribute it publishes and then from the label
   * Liquid already rendered into its trigger.
   *
   * The second fallback is what keeps the untranslated word out of this file:
   * the placeholder for an unnamed column is `sections.comparison_table.alternative`
   * in `locales/en.default.json`, rendered by the column, and read back from
   * there rather than repeated here in English.
   *
   * @param {HTMLElement} column
   * @returns {string}
   */
  #nameOf(column) {
    const published = column.dataset.comparisonName?.trim();
    if (published) return published;

    const label = column.querySelector('[data-comparison-trigger-label]');
    return (label?.textContent ?? '').trim();
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const option = target.closest('[data-comparison-option]');
    if (option instanceof HTMLElement) {
      const panel = option.closest('[data-comparison-panel]');
      const column = option.closest('[data-comparison-column]');
      if (panel instanceof HTMLElement && column instanceof HTMLElement) {
        this.#choose(column, Number(option.dataset.comparisonOption));
      }
      return;
    }

    const trigger = target.closest('[data-comparison-trigger]');
    if (trigger instanceof HTMLElement) {
      event.preventDefault();
      const panel = trigger.parentElement?.querySelector('[data-comparison-panel]');
      if (panel instanceof HTMLElement) {
        if (this.#open === panel) this.#close();
        else this.#openPanel(panel);
      }
    }
  };

  /**
   * Puts the chosen alternative in this column's slot.
   *
   * When it is already in another slot the two trade places. Showing the same
   * column twice would silently drop whichever comparison it replaced, and a
   * customer who cannot see what happened cannot undo it.
   *
   * @param {HTMLElement} column The column whose chooser was used.
   * @param {number} index Index into `#alternatives`.
   */
  #choose(column, index) {
    const here = this.#slots.indexOf(this.#alternatives.indexOf(column));
    if (here === -1 || Number.isNaN(index)) return;

    const there = this.#slots.indexOf(index);
    if (there !== -1) this.#slots[there] = this.#slots[here];
    this.#slots[here] = index;

    this.#close();
    this.#apply();
    this.#labelMarks();

    // Focus follows the arrangement: the slot the customer was using is still
    // in the same place on screen, so its trigger is where they left it.
    const moved = this.#alternatives[index];
    const trigger = moved?.querySelector('[data-comparison-trigger]');
    if (trigger instanceof HTMLElement) trigger.focus();
  }

  /* ---------------------------------------------------------- open/close -- */

  /** @param {HTMLElement} panel */
  #openPanel(panel) {
    this.#close();

    panel.hidden = false;
    this.#open = panel;

    const trigger = panel.parentElement?.querySelector('[data-comparison-trigger]');
    trigger?.setAttribute('aria-expanded', 'true');

    const selected = panel.querySelector('[aria-selected="true"]') ?? panel.firstElementChild;
    if (selected instanceof HTMLElement) this.#activate(panel, selected);

    panel.focus();
  }

  #close() {
    const panel = this.#open;
    if (!panel) return;

    panel.hidden = true;
    panel.removeAttribute('aria-activedescendant');
    panel.querySelector('.is-active')?.classList.remove('is-active');

    const trigger = panel.parentElement?.querySelector('[data-comparison-trigger]');
    trigger?.setAttribute('aria-expanded', 'false');

    this.#open = null;
  }

  /**
   * Moves the listbox's active option. The panel keeps the focus and
   * `aria-activedescendant` names the option, which is the pattern a collapsed
   * listbox wants — a roving `tabindex` over the options would put every one of
   * them in the tab order the moment the panel opened.
   *
   * @param {HTMLElement} panel
   * @param {HTMLElement} option
   */
  #activate(panel, option) {
    panel.querySelector('.is-active')?.classList.remove('is-active');
    option.classList.add('is-active');
    panel.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }

  /** @param {Event} event */
  #onKeydown = (event) => {
    const keyEvent = /** @type {KeyboardEvent} */ (event);
    const panel = this.#open;

    if (!panel) {
      const trigger = /** @type {Element|null} */ (keyEvent.target)?.closest?.('[data-comparison-trigger]');
      if (trigger instanceof HTMLElement && (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp')) {
        keyEvent.preventDefault();
        const next = trigger.parentElement?.querySelector('[data-comparison-panel]');
        if (next instanceof HTMLElement) this.#openPanel(next);
      }
      return;
    }

    const options = /** @type {HTMLElement[]} */ ([...panel.children].filter((n) => n instanceof HTMLElement));
    if (options.length === 0) return;

    const current = Math.max(0, options.findIndex((option) => option.classList.contains('is-active')));

    switch (keyEvent.key) {
      case 'ArrowDown':
        keyEvent.preventDefault();
        this.#activate(panel, options[Math.min(current + 1, options.length - 1)]);
        break;
      case 'ArrowUp':
        keyEvent.preventDefault();
        this.#activate(panel, options[Math.max(current - 1, 0)]);
        break;
      case 'Home':
        keyEvent.preventDefault();
        this.#activate(panel, options[0]);
        break;
      case 'End':
        keyEvent.preventDefault();
        this.#activate(panel, options[options.length - 1]);
        break;
      case 'Enter':
      case ' ': {
        keyEvent.preventDefault();
        const column = panel.closest('[data-comparison-column]');
        if (column instanceof HTMLElement) {
          this.#choose(column, Number(options[current].dataset.comparisonOption));
        }
        break;
      }
      case 'Escape': {
        keyEvent.preventDefault();
        const trigger = panel.parentElement?.querySelector('[data-comparison-trigger]');
        this.#close();
        if (trigger instanceof HTMLElement) trigger.focus();
        break;
      }
      case 'Tab':
        this.#close();
        break;
      default:
        break;
    }
  };

  /** @param {Event} event */
  #onDocumentPointerDown = (event) => {
    if (!this.#open) return;
    const target = event.target;
    if (target instanceof Node && this.#open.parentElement?.contains(target)) return;
    this.#close();
  };

  /* ------------------------------------------------------------- naming -- */

  /**
   * Gives every mark the claim it answers.
   *
   * The markup ships *Yes* or *No*, which is already better than a mark that
   * announces as nothing, but it is only half a sentence: the other half is the
   * row, and a row is a position rather than an ancestor. This is the one place
   * that position is knowable, so this is where the two halves are joined.
   *
   * Re-run after a swap, because the column in a slot changed and the marks in
   * it now answer the same claims with different answers.
   */
  #labelMarks() {
    if (!this.#features) return;

    const claims = [...this.#features.querySelectorAll(':scope > [data-comparison-cell]')].map((cell) =>
      (cell.textContent ?? '').trim()
    );
    if (claims.length === 0) return;

    for (const column of this.#columns) {
      if (column === this.#features) continue;

      const name = column.dataset.comparisonName?.trim() ?? '';
      const cells = column.querySelectorAll(':scope > [data-comparison-cell]');

      cells.forEach((cell, index) => {
        const answer = cell.querySelector('[data-comparison-answer]');
        const claim = claims[index];
        if (!answer || !claim) return;

        // Kept on the element so a second pass reads the answer rather than a
        // sentence it wrote itself. `getAttribute` rather than `dataset`,
        // because `querySelector` returns an `Element` and only `HTMLElement`
        // has a `dataset`.
        const base = answer.getAttribute('data-comparison-base') ?? (answer.textContent ?? '').trim();
        answer.setAttribute('data-comparison-base', base);

        answer.textContent = name ? `${name}, ${claim}: ${base}` : `${claim}: ${base}`;
      });
    }
  }
}

defineComponent('comparison-table', ComparisonTable);

export default { ComparisonTable };
