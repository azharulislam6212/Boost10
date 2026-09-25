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

  /** Columns whose head carries a chooser, in DOM order. @type {HTMLElement[]} */
  #choosers = [];

  /** @type {HTMLElement|null} */
  #features = null;

  /** The section's shared list, used by every chooser without its own. @type {string[]} */
  #alternatives = [];

  /** Each chooser's options, one list per entry in `#choosers`. @type {string[][]} */
  #lists = [];

  /**
   * Which list each chooser draws from. Choosers on the shared list never show
   * the same option; one with its own list stands alone.
   *
   * @type {string[]}
   */
  #groups = [];

  /**
   * Which option each chooser column shows. One 1-based index per entry in
   * `#choosers`, never repeated within a group.
   *
   * @type {number[]}
   */
  #choice = [];

  /** @type {HTMLElement|null} */
  #open = null;

  #id = '';

  setup() {
    this.#id = this.id || uniqueId('comparison');

    this.#read();
    if (this.#columns.length === 0) return;

    this.#applyCounts();
    this.#resize();
    this.#labelMarks();

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

        const position = this.#choosers.indexOf(column);
        if (position === -1) return;

        this.#choice[position] = this.#published(position);
        this.#settle(position);
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
    this.#choosers = this.#columns.filter((column) => column.dataset.comparisonRole === 'product');

    this.#alternatives = this.#parseList(this.dataset.comparisonAlternatives);

    this.#lists = this.#choosers.map((column) => {
      const own = this.#parseList(column.dataset.comparisonOptions);
      return own.length > 0 ? own : this.#alternatives;
    });
    this.#groups = this.#choosers.map((column, position) =>
      this.#lists[position] === this.#alternatives ? 'shared' : `own-${position}`
    );

    this.#choice = this.#choosers.map((_, position) => this.#published(position));
    for (let position = 0; position < this.#choice.length; position += 1) this.#settle(position);
  }

  /**
   * @param {string|undefined} raw A JSON array of names.
   * @returns {string[]}
   */
  #parseList(raw) {
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((name) => String(name).trim()).filter(Boolean);
    } catch {
      // A malformed list leaves the names to the columns themselves.
    }
    return [];
  }

  /**
   * The option a chooser was rendered on, clamped to its list.
   *
   * @param {number} position Index into `#choosers`.
   * @returns {number}
   */
  #published(position) {
    const index = Number(this.#choosers[position]?.dataset.comparisonAlternative ?? 1);
    if (!Number.isFinite(index)) return 1;
    return Math.min(Math.max(Math.round(index), 1), Math.max(this.#count(position), 1));
  }

  /**
   * How many options a chooser offers. Without a list, the most values any
   * cell in its group holds.
   *
   * @param {number} position Index into `#choosers`.
   * @returns {number}
   */
  #count(position) {
    const list = this.#lists[position] ?? [];
    if (list.length > 0) return list.length;

    let most = 1;
    this.#choosers.forEach((column, index) => {
      if (this.#groups[index] !== this.#groups[position]) return;
      for (const cell of column.querySelectorAll(':scope > [data-comparison-cell]')) {
        most = Math.max(most, cell.querySelectorAll(':scope > [data-comparison-value]').length);
      }
    });
    return most;
  }

  /**
   * Moves the chooser at `position` off any option another chooser in its
   * group already shows, so the columns beside each other never repeat one.
   *
   * @param {number} position
   */
  #settle(position) {
    const total = Math.max(this.#count(position), 1);

    for (let step = 0; step < total; step += 1) {
      const taken = this.#choice.some(
        (value, index) =>
          index !== position && this.#groups[index] === this.#groups[position] && value === this.#choice[position]
      );
      if (!taken) return;
      this.#choice[position] = (this.#choice[position] % total) + 1;
    }
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

  /** Hides the chooser columns this width has no room for. */
  #resize() {
    const available = Math.min(Math.max(1, Number(this.#slotCount()) || 1), this.#choosers.length);

    this.#choosers.forEach((column, position) => {
      column.hidden = position >= available;
    });

    this.#apply();
  }

  /** @returns {number} */
  #slotCount() {
    if (window.matchMedia(MOBILE).matches) return Number(this.dataset.slotsMobile ?? 1);
    if (window.matchMedia(TABLET).matches) return Number(this.dataset.slotsTablet ?? 1);
    return Number(this.dataset.slots ?? 2);
  }

  /** Writes every chooser's current alternative to the DOM. */
  #apply() {
    this.classList.add('is-arranged');

    this.#choosers.forEach((column, position) => {
      const chosen = this.#choice[position];
      column.dataset.comparisonAlternative = String(chosen);

      const name = this.#nameOf(position, chosen);
      if (name) column.dataset.comparisonName = name;

      const label = column.querySelector('[data-comparison-trigger-label]');
      if (label && name) label.textContent = name;

      this.#buildPanel(column, position);
    });

    const visible = this.#columns.filter(
      (column) => column !== this.#features && !column.hidden
    ).length;
    this.style.setProperty('--ct-cols-active', String(visible));
  }

  /* ------------------------------------------------------------ chooser -- ---- */

  /**
   * Fills one column's listbox with every alternative there is.
   *
   * @param {HTMLElement} column
   * @param {number} position Index into `#choosers`.
   */
  #buildPanel(column, position) {
    const panel = column.querySelector('[data-comparison-panel]');
    const trigger = column.querySelector('[data-comparison-trigger]');
    if (!(panel instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return;

    const panelId = `${this.#id}-panel-${position}`;
    panel.id = panelId;
    trigger.setAttribute('aria-controls', panelId);
    trigger.removeAttribute('aria-disabled');

    const total = this.#count(position);
    const options = [];

    for (let index = 1; index <= total; index += 1) {
      const name = this.#nameOf(position, index);
      if (!name) continue;

      const option = document.createElement('div');
      option.className = 'comparison-choose__option';
      option.id = `${panelId}-option-${index}`;
      option.setAttribute('role', 'option');
      option.dataset.comparisonOption = String(index);
      option.setAttribute('aria-selected', String(index === this.#choice[position]));
      option.textContent = name;
      options.push(option);
    }

    panel.replaceChildren(...options);
  }

  /**
   * @param {number} position Index into `#choosers`.
   * @param {number} index 1-based.
   * @returns {string}
   */
  #nameOf(position, index) {
    return this.#lists[position]?.[index - 1] ?? '';
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const option = target.closest('[data-comparison-option]');
    if (option instanceof HTMLElement) {
      const column = option.closest('[data-comparison-column]');
      if (column instanceof HTMLElement) {
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
   * Puts the chosen option in this column. A chooser in the same group already
   * showing it takes this one's place, so the two never read the same.
   *
   * @param {HTMLElement} column The column whose chooser was used.
   * @param {number} index 1-based index into this chooser's list.
   */
  #choose(column, index) {
    const here = this.#choosers.indexOf(column);
    if (here === -1 || !Number.isFinite(index)) return;

    const there = this.#choice.findIndex(
      (value, position) => position !== here && this.#groups[position] === this.#groups[here] && value === index
    );
    if (there !== -1) this.#choice[there] = this.#choice[here];
    this.#choice[here] = index;

    this.#close();
    this.#apply();
    this.#labelMarks();

    const trigger = column.querySelector('[data-comparison-trigger]');
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
        const claim = claims[index];
        if (!claim) return;

        for (const answer of cell.querySelectorAll('[data-comparison-answer]')) {
          const base = answer.getAttribute('data-comparison-base') ?? (answer.textContent ?? '').trim();
          answer.setAttribute('data-comparison-base', base);

          answer.textContent = name ? `${name}, ${claim}: ${base}` : `${claim}: ${base}`;
        }
      });
    }
  }
}

defineComponent('comparison-table', ComparisonTable);

export default { ComparisonTable };
