/**
 * modules.js — Boost10
 *
 * The small interactive primitives that appear throughout the theme:
 *
 *   <accordion-element>  Disclosure group, optionally single-open
 *   <tabs-element>       Tab list following the ARIA authoring practices
 *   <show-more>          Collapsed content with an expand control
 *   <deferred-media>     Click-to-load video, model and embed
 *
 * All four are progressive enhancements over markup that already works. The
 * accordion is native `<details>`, so it opens and closes with JavaScript
 * disabled. Tabs are anchor links to real headings. `<show-more>` renders all
 * of its content, and only collapses it once the script confirms it can expand
 * it again. `<deferred-media>` holds a real `<template>` whose contents are a
 * plain iframe or video element.
 *
 * That ordering matters more than it looks. A collection page that hides half
 * its content behind a script and then fails to load that script has hidden the
 * content from search engines as well as from customers.
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
 *
 * Markup:
 *
 *   <accordion-element data-single>
 *     <details data-ref="item[]">
 *       <summary>Question</summary>
 *       <div data-ref="panel[]">Answer</div>
 *     </details>
 *   </accordion-element>
 *
 * Height is animated by measuring the panel and running a WAAPI animation on
 * the `<details>` element, rather than by animating `max-height` to an arbitrary
 * large value. The arbitrary value is what makes accordions feel slow when the
 * content is short and clipped when it is long.
 *
 * `morph()` preserves the `open` attribute on `<details>`, so an accordion stays
 * open across a section re-render.
 *
 * ## Collapsing only on small screens
 *
 * `data-collapse-below="750"` makes the group an accordion below that width and
 * a plain list of open sections above it. Footer columns are the usual case:
 * four headed lists side by side on a desktop, four tappable rows on a phone.
 *
 * This is managed here rather than in CSS because a closed `<details>` hides its
 * content in the user agent stylesheet, and no CSS rule reliably reopens it
 * across browsers. The `open` attribute has to actually change, so `matchMedia`
 * drives it — and above the breakpoint the summaries are marked `data-static`,
 * which the stylesheet uses to remove the pointer cursor and the marker.
 */
export class AccordionElement extends BaseComponent {
  /** @type {WeakMap<HTMLDetailsElement, Animation>} */
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

  /* --------------------------------------------------------- public API -- */

  /**
   * @param {HTMLDetailsElement} item
   */
  open(item) {
    if (item.open) return;

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
    if (!item.open) return;
    this.#animateClose(item);
  }

  /**
   * Open every item. Used by print stylesheets and by in-page search.
   */
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

  /* ---------------------------------------------------------- internals -- */

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
          // The summary is no longer a control, so it must not be a tab stop or
          // announce itself as expandable.
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
   * It used to be `:scope > details, :scope > * > details` — one level, or two.
   * That was enough while a footer column was a block in a flat list, and
   * stopped being enough the moment the footer grew a hierarchy: a Menu inside a
   * Group inside a Column is three levels down, so the accordion found nothing,
   * marked nothing static, and every column on a phone stayed a wall of links.
   *
   * Depth is now unbounded and ownership is what limits the search instead. A
   * `<details>` inside a nested accordion belongs to that group, not to this
   * one, and a block that opted out with `data-no-collapse` is not a disclosure
   * at all — it is markup that happens to be a `<details>` so it can share one
   * stylesheet with the ones that are.
   *
   * Ownership is decided by walking up to the nearest element that *is* an
   * accordion, not by matching the tag name `accordion-element`. A subclass
   * registered under its own name — `<footer-columns>` — is still an accordion,
   * and a `closest('accordion-element')` test silently returns nothing for
   * every disclosure inside one.
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
    // Above the breakpoint the summary is decoration, not a control.
    if (this.hasAttribute('data-static')) {
      event.preventDefault();
      return;
    }

    if (prefersReducedMotion()) {
      // Let the browser do it. There is nothing to animate.
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

    this.#animations.get(item)?.cancel();

    const summary = item.querySelector('summary');
    const start = summary ? summary.offsetHeight : 0;
    const end = item.offsetHeight;

    // The height is animated on the `<details>` itself, so for the whole of the
    // animation the element is shorter than the content inside it. Without this
    // the content simply overflows and is painted at full height from the first
    // frame — the panel appears instantly and only the box around it grows,
    // which is what "the accordion doesn't animate" looks like on a phone.
    //
    // `overflow` is not an animatable property, so it cannot ride along in the
    // keyframes; it is set here and cleared when the animation settles.
    this.#clip(item, true);

    const animation = item.animate(
      [
        { height: `${start}px`, opacity: 0.6 },
        { height: `${end}px`, opacity: 1 },
      ],
      { duration: 280, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );

    this.#animations.set(item, animation);
    animation.finished
      .then(() => {
        item.style.removeProperty('height');
        this.#clip(item, false);
      })
      .catch(() => {
        // Cancelled: the next animation is already clipping the element and
        // owns the cleanup.
      });
  }

  /**
   * Clip the item to its animating height, and put back whatever `overflow` it
   * had before.
   *
   * A `<details>` in this theme can legitimately carry `overflow: visible` for
   * a focus ring or a dropdown, so the previous value is preserved rather than
   * assumed — and only ever restored by the animation that set it.
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
    const summary = item.querySelector('summary');

    if (!panel || prefersReducedMotion()) {
      item.open = false;
      return;
    }

    this.#animations.get(item)?.cancel();

    const start = item.offsetHeight;
    const end = summary ? summary.offsetHeight : 0;

    this.#clip(item, true);

    const animation = item.animate(
      [
        { height: `${start}px`, opacity: 1 },
        { height: `${end}px`, opacity: 0.6 },
      ],
      { duration: 220, easing: 'cubic-bezier(0.76, 0, 0.24, 1)' }
    );

    this.#animations.set(item, animation);

    animation.finished
      .then(() => {
        item.open = false;
        item.style.removeProperty('height');
        this.#clip(item, false);
      })
      .catch(() => {
        // Cancelled because the customer clicked again mid-animation. The next
        // animation owns the element now, so leave its state alone.
      });
  }
}

defineComponent('accordion-element', AccordionElement);

/* ==========================================================================
   <footer-columns>
   --------------------------------------------------------------------------
   The footer panel's grid, measured from its own children.

   Every block a merchant adds to the footer arrives through one
   `{% content_for 'blocks' %}`, and — as `sections/header.liquid` already
   notes — a section cannot iterate those blocks: `section.blocks` returns
   nothing for them. So the three numbers the panel's layout depends on cannot
   be worked out in Liquid, however the section is written:

     --panel-tracks         one `fr` track per column, in the width share each
                            column carries, so three at 100% and one at 150%
                            become `1fr 1fr 1fr 1.5fr`
     --panel-card-rows      the rows the card covers — however many rows the
                            columns actually took, plus the policy links' row
                            when there is one. Declaring them as the *explicit*
                            grid is what lets the card say `1 / -1` and have that
                            mean "not the utility rows", which are implicit and
                            land underneath
     --aside-column         the track the column carrying the divider sits in
     --policy-span          how many tracks the policy links run across: up to
                            the aside, so they stop at the rule instead of
                            passing under the newsletter

   Each column already publishes its own width as `--column-width`, so this
   reads them off the children rather than being told. It extends
   `AccordionElement` rather than sitting beside it because the same element is
   both the grid and the thing that collapses on a phone.

   The stylesheet has a working fallback for all three, so a page where this
   never runs still gets a sensible footer — equal columns and a card around the
   first two rows — rather than a broken one.
   ========================================================================== */

/**
 * How many columns share a row before the next one wraps.
 *
 * Not a limit on how many columns a footer may have — a seventh is fine, it
 * simply starts a second row.
 */
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

    // The theme editor adds, removes and reorders blocks in place, and a column
    // resized with the width slider rewrites its own `style` attribute. Both
    // change the answer, and neither re-runs `setup()`.
    this.#watcher = new MutationObserver(() => this.#schedule(true));
    this.#watcher.observe(this, {
      childList: true,
      subtree: false,
      attributes: true,
      attributeFilter: ['style', 'data-divider'],
    });

    // The number of rows the columns occupy changes with the width, so the
    // measurement has to follow it. One observer on the grid itself catches the
    // breakpoint, an orientation change and a resized editor preview alike.
    if (typeof ResizeObserver === 'function') {
      this.#resizer = new ResizeObserver(() => this.#schedule(true));
      this.#resizer.observe(this);
    }
  }

  /**
   * Coalesce measurements to one per frame.
   *
   * Setting the track list changes the layout, which is what the row count is
   * read from — and writing a property from inside a ResizeObserver callback
   * can schedule another one. A frame between them keeps that from becoming a
   * loop, and keeps a burst of editor mutations to a single pass.
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

    // Six tracks at most.
    //
    // One track per column reads well up to about six and then stops being a
    // footer: a seventh column makes seven columns of roughly two hundred pixels
    // each, and every menu inside them wraps. Capping the track list is what
    // makes the seventh column wrap to a second row instead — grid puts anything
    // that does not fit the declared tracks on the next row by itself, which is
    // exactly the behaviour wanted, and the row count below measures the result
    // rather than assuming one row.
    const tracks = columns
      .slice(0, FOOTER_MAX_COLUMNS)
      .map((el) => {
        // `--column-width` is a percentage share, not a size: 150% next to three
        // 100%s means "half again as wide as one of those", which is what an
        // `fr` already means.
        const share = parseFloat(getComputedStyle(el).getPropertyValue('--column-width'));
        return `${Number.isFinite(share) && share > 0 ? (share / 100).toFixed(4) : 1}fr`;
      })
      .join(' ');

    // Where the aside sits, as a track number.
    //
    // It used to be pinned to the last track with `-2 / -1`, on the assumption
    // that the column carrying the divider is the last one. Add a sixth column
    // after it and that assumption is simply false: the aside was yanked to the
    // end of the row, the columns behind it shuffled up, and — because the aside
    // also spans down beside the policy links — the policy row could no longer
    // fit on its own row and dropped through to an implicit one *below the card*,
    // taking a column with it. That is the block that went missing.
    //
    // Measured, it lands wherever the merchant actually put it.
    const asideIndex = columns.findIndex((el) => el.hasAttribute('data-divider'));
    const hasAside = asideIndex >= 0;

    // The policy links run up to the aside, and across everything when there is
    // no aside to stop at. Never fewer than one track, and never more than the
    // grid actually has — which is the capped count, not the column count.
    const trackCount = Math.min(columns.length, FOOTER_MAX_COLUMNS);
    const span = Math.min(Math.max(hasAside ? asideIndex : trackCount, 1), trackCount);

    this.style.setProperty('--panel-tracks', tracks);
    this.style.setProperty('--policy-span', String(span));

    // Only pin the aside when it is on the first row of tracks. Past that it is
    // an ordinary column on a later row, and pinning it to a track it does not
    // sit in would drag it back up.
    const pinAside = hasAside && asideIndex < trackCount;

    if (pinAside) {
      this.style.setProperty('--aside-column', String(asideIndex + 1));
    } else {
      this.style.removeProperty('--aside-column');
    }

    // The attribute is what the stylesheet keys the placement off. Without it,
    // the rule's definite row would still apply once the aside had wrapped past
    // the last track: an item with a definite row and an automatic column is
    // placed before the fully automatic ones, so the aside would jump back up to
    // the first row and push an ordinary column down in its place.
    this.toggleAttribute('data-aside-pinned', pinAside);

    // How far the aside reaches down.
    //
    // In the design it spans its own row and the policy links' row, so its rule
    // runs the full height of the card. That only holds while those two rows are
    // adjacent — which they are in the ordinary footer, and are not the moment
    // a full-width block joins them inside the card. Then the aside is asking to
    // span across a row that needs every track, the grid resolves the conflict
    // by pushing that block further down, and the rows the aside reserved are
    // left empty: a gap in the middle of the card with nothing in it.
    //
    // So it only spans when the shape it was drawn for is actually there.
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

    // The row count has to be read back from the laid-out grid rather than
    // assumed, because how many rows these blocks occupy is not a fact about the
    // markup: side by side the columns are one row, stacked on a phone they are
    // one row each, and a narrow window can wrap them into any number in
    // between. Setting the tracks above is what decides it, so this reads the
    // answer after that has taken effect.
    //
    // And it counts every block that belongs *inside* the card, not just the
    // columns. A full-width block among them — the brand block, say — takes a
    // row of its own, and counting only columns left the card one or two rows
    // short: it closed above the policy links, which then sat outside a card
    // they are supposed to be in.
    const rows = this.#rowCount();
    const value = 'auto '.repeat(rows).trim();

    if (this.style.getPropertyValue('--panel-card-rows') === value) return;

    this.style.setProperty('--panel-card-rows', value);

    // Changing the explicit rows can change the layout that was just measured —
    // a first pass with too few rows pushes a block into an implicit one, and
    // the corrected grid pulls it back. One more pass settles it. The guard is
    // there because "measure, write, re-measure" is exactly the shape a layout
    // loop takes, and this one must always stop.
    if (this.#passes < 4) {
      this.#passes += 1;
      this.#schedule();
    }
  }

  /**
   * How many grid rows the card covers.
   *
   * Everything except the rows the design puts *below* the card: the utility
   * rows and the legal band. Those are the blocks that land in implicit rows,
   * which is what puts them outside it.
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

/**
 * A tab list implementing the ARIA authoring practices roving tabindex pattern.
 *
 * Markup:
 *
 *   <tabs-element>
 *     <div role="tablist" data-ref="tablist">
 *       <button role="tab" id="tab-1" aria-controls="panel-1" data-ref="tab[]">One</button>
 *     </div>
 *     <div role="tabpanel" id="panel-1" aria-labelledby="tab-1" data-ref="panel[]">…</div>
 *   </tabs-element>
 *
 * Keyboard support: arrow keys move between tabs and activate them, Home and End
 * jump to the ends. Only the selected tab is in the tab order, so Tab moves past
 * the whole group in one press rather than through every tab in it.
 */
export class TabsElement extends BaseComponent {
  static requiredRefs = ['tab'];

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

  /* --------------------------------------------------------- public API -- */

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

  /* ---------------------------------------------------------- internals -- */

  /**
   * @returns {HTMLElement[]}
   * @private
   */
  #tabs() {
    const refs = this.refs.tab;
    return Array.isArray(refs) ? refs : refs ? [refs] : [];
  }

  /**
   * @returns {HTMLElement[]}
   * @private
   */
  #panels() {
    const refs = this.refs.panel;
    return Array.isArray(refs) ? refs : refs ? [refs] : [];
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

/**
 * Collapses long content behind an expand control.
 *
 * Markup:
 *
 *   <show-more data-height="180">
 *     <div data-ref="content">…long description…</div>
 *     <button data-ref="button" aria-expanded="false"
 *             data-label-more="{{ 'general.actions.show_more' | t }}"
 *             data-label-less="{{ 'general.actions.show_less' | t }}">
 *       {{ 'general.actions.show_more' | t }}
 *     </button>
 *   </show-more>
 *
 * The content is only collapsed if it is actually taller than the threshold,
 * and the control removes itself when it is not needed. A "show more" button
 * that expands nothing is worse than no button.
 */
export class ShowMore extends BaseComponent {
  static requiredRefs = ['content', 'button'];

  /** @type {ResizeObserver|null} */
  #observer = null;

  setup() {
    this.#measure();

    this.on(this.refs.button, 'click', () => this.toggle());

    // Fonts and images land after first paint and change the height, so the
    // decision has to be re-made rather than taken once on load.
    this.#observer = new ResizeObserver(rafThrottle(() => this.#measure()));
    this.#observer.observe(this.refs.content);
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- */

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

  /* ---------------------------------------------------------- internals -- */

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

    // Once fully open the cap is removed, so later content growth is not clipped.
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

/**
 * Loads heavy media only once the customer asks for it.
 *
 * Markup:
 *
 *   <deferred-media data-autoplay="false">
 *     <button data-ref="poster" aria-label="{{ 'accessibility.play_video' | t }}">
 *       {{ image }}
 *     </button>
 *     <template data-ref="template">
 *       <iframe src="…" title="…" allow="autoplay"></iframe>
 *     </template>
 *   </deferred-media>
 *
 * A YouTube embed costs upwards of half a megabyte and a dozen requests before
 * anyone presses play. Keeping it in a `<template>` means the markup is real,
 * server-rendered and translated, but nothing is fetched until it is wanted.
 *
 * `data-autoplay` loads on first scroll into view instead of on click, which is
 * appropriate for a background video and never for anything with sound.
 */
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

  /* --------------------------------------------------------- public API -- */

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
      media.play().catch(() => {
        // Autoplay was refused, which is the browser working as intended.
        // The controls are visible, so the customer can start it themselves.
      });
    }

    // Focus the media so a keyboard user is not left on a hidden poster button.
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

  /* ---------------------------------------------------------- internals -- */

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
   <faq-search>
   ========================================================================== */

/**
 * Live filtering for a list of questions.
 *
 * Filters what is already on the page rather than querying anything. A store's
 * FAQ is twenty rows, not twenty thousand, and a request per keystroke to search
 * content the browser already has is a worse experience and a worse bill.
 *
 * Matching runs over the question *and* its answer, because customers search for
 * the word in the answer — "refund", "tracking number" — far more often than for
 * the phrasing the merchant chose for the heading.
 *
 * The result count is announced politely rather than assertively: a live region
 * that interrupts on every keystroke makes a screen reader unusable while typing.
 *
 * Markup:
 *
 *   <faq-search>
 *     <input type="search" data-ref="input">
 *     <p data-ref="status" class="visually-hidden" role="status"></p>
 *   </faq-search>
 */
export class FaqSearch extends BaseComponent {
  static requiredRefs = ['input'];

  setup() {
    this.on(this.refs.input, 'input', debounce(() => this.filter(this.refs.input.value), 200));

    this.on(this.refs.input, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.refs.input.value = '';
      this.filter('');
    });
  }

  /**
   * @returns {HTMLElement[]}
   */
  get rows() {
    const scope = this.closest('[data-faq-root]') || document;
    return Array.from(scope.querySelectorAll('[data-faq-row]'));
  }

  /**
   * @param {string} query
   */
  filter(query) {
    const term = query.trim().toLowerCase();
    let matches = 0;

    for (const row of this.rows) {
      const hit = term === '' || row.textContent.toLowerCase().includes(term);
      row.toggleAttribute('hidden', !hit);

      // A row matched on its answer is worth opening: the customer is looking at
      // a heading that does not obviously contain what they searched for.
      if (hit && term !== '' && row instanceof HTMLDetailsElement) {
        const heading = row.querySelector('summary')?.textContent?.toLowerCase() ?? '';
        row.open = !heading.includes(term);
      }

      if (hit) matches += 1;
    }

    // Groups that lost every row would otherwise leave a heading over nothing.
    const scope = this.closest('[data-faq-root]') || document;
    for (const group of scope.querySelectorAll('[data-faq-group]')) {
      const visible = group.querySelectorAll('[data-faq-row]:not([hidden])').length;
      group.toggleAttribute('hidden', visible === 0);
    }

    this.toggleAttribute('data-filtering', term !== '');
    this.#status(term, matches);
  }

  /**
   * @param {string} term
   * @param {number} matches
   * @private
   */
  #status(term, matches) {
    const target = this.refs.status;
    if (!(target instanceof HTMLElement)) return;

    target.textContent = term === ''
      ? ''
      : themeString('faqResults', '', { count: matches });

    const empty = this.closest('[data-faq-root]')?.querySelector('[data-faq-empty]');
    if (empty instanceof HTMLElement) empty.toggleAttribute('hidden', matches > 0 || term === '');
  }
}

defineComponent('faq-search', FaqSearch);


/* ==========================================================================
   <share-button>
   ========================================================================== */

/**
 * Share a link.
 *
 * Uses the device share sheet when the browser has one, and copies to the
 * clipboard when it does not. Both paths end the same way — the customer has the
 * link — so there is no third state to design for.
 *
 * ## Why no row of network buttons
 *
 * The classic Facebook/X/Pinterest row is four third-party requests, four
 * tracking opportunities, and four links that break whenever a network changes
 * its share URL format. The share sheet already lists every app the customer
 * actually uses, including the ones a theme would never think to add, and the
 * clipboard fallback works everywhere else.
 *
 * `navigator.share` must be called from a user gesture and rejects with
 * `AbortError` when the customer closes the sheet. That is a choice, not a
 * failure, so it is swallowed rather than reported — telling someone "sharing
 * failed" because they changed their mind is worse than saying nothing.
 *
 * Markup:
 *
 *   <share-button data-url="https://…" data-title="Product name">
 *     <button data-ref="button">Share</button>
 *     <span data-ref="feedback" hidden></span>
 *   </share-button>
 */
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
        // Closing the sheet is a decision, not an error. Anything else falls
        // through to the clipboard rather than leaving the customer with nothing.
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
      // Clipboard access is blocked in some contexts. Selecting the URL is the
      // last resort, and it is what people reach for anyway.
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

export default { AccordionElement, TabsElement, ShowMore, DeferredMedia, FaqSearch, ShareButton };
