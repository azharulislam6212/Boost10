/**
 * The chooser on the Comparison table section.
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
   * Which alternative column is in which slot. Indices into #alternatives.
   *
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

    for (const query of [TABLET, MOBILE]) {
      this.on(window.matchMedia(query), 'change', () => this.#resize());
    }

    this.on(this, 'click', this.#onClick);
    this.on(this, 'keydown', this.#onKeydown);

    this.on(document, 'pointerdown', this.#onDocumentPointerDown);

    if (isDesignMode()) {
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

  /* ------------------------------------------------------------- reading -- ---- */

  #read() {
    this.#columns = /** @type {HTMLElement[]} */ (
      [...this.children].filter((node) => node instanceof HTMLElement && node.hasAttribute('data-comparison-column'))
    );

    this.#features = this.#columns.find((column) => column.dataset.comparisonRole === 'features') ?? null;
    this.#alternatives = this.#columns.filter((column) => column.dataset.comparisonRole === 'product');
  }

  /** Re-reads the row count from the cells that actually rendered. */
  #applyCounts() {
    let rows = 0;
    for (const column of this.#columns) {
      rows = Math.max(rows, column.querySelectorAll(':scope > [data-comparison-cell]').length);
    }
    if (rows > 0) this.style.setProperty('--ct-rows', String(rows));

    this.classList.toggle('comparison-grid--no-labels', this.#features === null);
  }

  /* ------------------------------------------------------------- layout -- ---- */

  /**
   * How many alternatives this width shows, and which ones. A choice is kept
   * across a breakpoint change wherever it still fits.
   */
  #resize() {
    const count = Math.max(1, Number(this.#slotCount()) || 1);
    const available = Math.min(count, this.#alternatives.length);

    const next = [];
    for (let position = 0; position < available; position += 1) {
      const kept = this.#slots[position];
      next.push(typeof kept === 'number' && kept < this.#alternatives.length ? kept : -1);
    }

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

  /** Writes the arrangement to the DOM. */
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

  /* ------------------------------------------------------------ chooser -- ---- */

  /**
   * Fills one column's listbox with every alternative there is.
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
   * A column's name: its published attribute, else its rendered trigger label.
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

    const moved = this.#alternatives[index];
    const trigger = moved?.querySelector('[data-comparison-trigger]');
    if (trigger instanceof HTMLElement) trigger.focus();
  }

  /* ---------------------------------------------------------- open/close -- ---- */

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
   * Moves the listbox's active option via aria-activedescendant.
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

  /* ------------------------------------------------------------- naming -- ---- */

  /** Gives every mark the claim it answers. */
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

        const base = answer.getAttribute('data-comparison-base') ?? (answer.textContent ?? '').trim();
        answer.setAttribute('data-comparison-base', base);

        answer.textContent = name ? `${name}, ${claim}: ${base}` : `${claim}: ${base}`;
      });
    }
  }
}

defineComponent('comparison-table', ComparisonTable);

export default { ComparisonTable };
