/**
 * `<button-swap>` — the hover animation where a button's label pill and its
 * solid icon badge trade places on one continuous slide.
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

    clone.classList.remove('button-text');
    clone.classList.add('button-text-hover');

    clone.setAttribute('aria-hidden', 'true');
    clone.removeAttribute('id');
    for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id');
    for (const node of clone.querySelectorAll('a, button, input, select, textarea, [tabindex]')) {
      node.setAttribute('tabindex', '-1');
    }

    group.replaceWith(track);
    track.append(group, clone);

    this.#track = track;
    this.#group = group;
    this.#clone = clone;

    button.classList.add('is-swap-ready');

    return true;
  }
}

defineComponent('button-swap', ButtonSwap);
