/**
 * button-element.js — Boost10
 *
 * `<button-swap>` — the hover animation where a button's label pill and its
 * solid icon badge trade places on one continuous slide.
 *
 * ## What the effect actually is
 *
 * Not two elements animating past each other. The contents are duplicated into
 * a track twice the button's width, the button clips it, and the track slides:
 *
 *   rest    [ label │ icon ][ label │ icon ]
 *           └── visible ───┘
 *
 *   hover   [ label │ icon ][ label │ icon ]
 *                   └── visible ───┘
 *
 * The window lands on `icon │ label` — the same two shapes in the opposite
 * order — and because the second group is a copy, the label enters from the
 * right at the same rate the first one leaves. Nothing is ever empty, and both
 * label and icon are fully visible at the end of the slide, which is the part a
 * crossfade or a pair of independent transforms cannot give you.
 *
 * ## Why nothing is measured here
 *
 * An earlier version measured both track positions off the DOM, and before that
 * computed a slide distance in pixels. Neither survives contact with a font
 * loading late, a container resizing, or the Theme Editor swapping the markup
 * out — each needed its own observer, and every observer was another chance to
 * be looking at a stale number.
 *
 * The copy is absolutely positioned exactly one track-width plus one gap away,
 * and `translateX` percentages resolve against the element's own width, so both
 * positions are expressible in the track's own units:
 *
 *   a whole group     100% + the gap
 *   a badge trade     100% - the badge
 *
 * Both are in `assets/base.css`. This module injects the copy and nothing else,
 * which is why it has no observers, no measurements and no teardown.
 *
 * ## Why the clone is injected rather than rendered
 *
 * A duplicate label in the markup is a duplicate label in the accessibility
 * tree, in the DOM a merchant's app scans, and in the text a crawler reads. The
 * copy exists only to be looked at, so it is created here, marked
 * `aria-hidden`, and has its interactive descendants neutralised.
 *
 * Everything degrades: the markup is a working button before this runs, and
 * stays one if it never does.
 *
 * @module @theme/button-element
 */

import { BaseComponent, defineComponent } from '@theme/component';

/* ==========================================================================
   <button-swap>
   ========================================================================== */

/**
 * Wraps a single `.button` whose `.button-text` should swap with its icon.
 *
 * Markup in (from `snippets/button.liquid`):
 *
 *   <button-swap data-icon-position="end">
 *     <a class="button button--icon-solid button--icon-end">
 *       <span class="button-text">
 *         <span class="button__label">Shop now</span>
 *         <span class="button__icon">…</span>
 *       </span>
 *     </a>
 *   </button-swap>
 *
 * Markup out:
 *
 *   <a class="button … is-swap-ready">
 *     <span class="button__track">
 *       <span class="button-text">…</span>
 *       <span class="button-text-hover" aria-hidden="true">…</span>
 *     </span>
 *   </a>
 *
 * @extends BaseComponent
 */
export class ButtonSwap extends BaseComponent {
  /** @type {HTMLElement|null} */
  #button = null;

  /** @type {HTMLElement|null} */
  #track = null;

  /** @type {HTMLElement|null} */
  #group = null;

  /** @type {HTMLElement|null} */
  #clone = null;

  setup() {
    this.#button = this.querySelector('.button');
    if (!this.#button) return;

    // Idempotent: moving this element in the DOM disconnects and reconnects it,
    // and the Theme Editor morphs sections on every settings change. Building
    // the track twice would nest a track inside a track and double the label
    // again on each edit.
    this.#track = this.#button.querySelector(':scope > .button__track');

    if (!this.#track) {
      if (!this.#build()) return;
    } else {
      this.#group = this.#track.querySelector('.button-text');
      this.#clone = this.#track.querySelector('.button-text-hover');
    }
  }

  /**
   * Wraps the existing `.button-text` in a track and adds the hidden copy.
   *
   * @returns {boolean} False when the expected markup is not there, in which
   *   case the button is left exactly as the server sent it.
   */
  #build() {
    const button = this.#button;
    const group = button?.querySelector(':scope > .button-text');
    if (!button || !group) return false;

    const track = document.createElement('span');
    track.className = 'button__track';

    const clone = /** @type {HTMLElement} */ (group.cloneNode(true));

    // The copy carries its own class rather than a second `.button-text`. Two
    // identical classes in one track means every selector has to disambiguate
    // by `[aria-hidden]` or by position, and anyone reading the DOM has to work
    // out which one is real. `.button-text-hover` says what it is: the copy that
    // is only ever seen mid-hover.
    clone.classList.remove('button-text');
    clone.classList.add('button-text-hover');

    // It is scenery. Hiding it from assistive technology is not enough on its
    // own — a cloned `id` is a duplicate id, and a cloned link or input is still
    // a tab stop even inside an `aria-hidden` subtree in some engines.
    clone.setAttribute('aria-hidden', 'true');
    clone.removeAttribute('id');
    for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id');
    for (const node of clone.querySelectorAll('a, button, input, select, textarea, [tabindex]')) {
      node.setAttribute('tabindex', '-1');
    }

    // Always appended. The copy is absolutely positioned, so which side it
    // appears on is `inset-inline-start`/`-end` in the stylesheet rather than
    // DOM order — and the real group stays first, which is the order a screen
    // reader and a text crawler see.
    group.replaceWith(track);
    track.append(group, clone);

    this.#track = track;
    this.#group = group;
    this.#clone = clone;

    // Only now does the stylesheet switch the button into swap layout. Adding
    // the class before the track exists would clip a button that has nothing to
    // slide, which on a slow connection is a visible flash of a broken control.
    button.classList.add('is-swap-ready');

    return true;
  }
}

defineComponent('button-swap', ButtonSwap);
