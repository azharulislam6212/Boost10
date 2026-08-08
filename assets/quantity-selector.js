/**
 * quantity-selector.js — Boost10
 *
 * `<quantity-selector>` is the stepper used on the product page, in the cart,
 * in the cart drawer and inside the quick option drawer. One component for all
 * four, because a quantity rule that is enforced in one place and not another
 * is a bug report waiting to happen.
 *
 * Markup:
 *
 * <button type="button" data-ref="decrease" aria-label="…">−</button>
 *
 * <input
 *   data-ref="input"
 *   type="number"
 *   name="quantity"
 *   value="1"
 *   min="1"
 *   inputmode="numeric">
 *
 * <button type="button" data-ref="increase" aria-label="…">+</button>
 *
 * <p data-ref="message" role="status"></p>
 *
 * Design decisions worth keeping:
 *
 * - The `<input>` is a real form control with `name`, `min`, `max` and `step`.
 *   Add to cart therefore works with JavaScript disabled, and Shopify's own
 *   validation still applies as a second line of defence.
 *
 * - Typing is not corrected on every keystroke. Clamping "1" to the minimum
 *   while someone is halfway through typing "10" is the single most common
 *   quantity-field bug. Correction happens on blur and on submit.
 *
 * - Shopify's quantity rules, minimum, increment, and maximum implied by
 *   available stock, are read from data attributes rendered by Liquid, not
 *   recalculated in JavaScript from a variant object that may be stale.
 *
 * - Changes are debounced before they reach the cart, so holding the plus
 *   button sends one request rather than fifteen.
 *
 * @module @theme/quantity-selector
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { clamp, debounce, themeString, announce } from '@theme/utilities';

export class QuantitySelector extends BaseComponent {
  static requiredRefs = ['input'];

  static observedAttributes = ['data-min', 'data-max', 'data-step'];

  /** @type {(value: number) => void} */
  #notify = () => {};

  /** Last value broadcast, so a no-op blur does not fire a cart request. */
  #lastNotified = null;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    const input = this.refs?.input;

    if (!(input instanceof HTMLInputElement)) return;

    this.#lastNotified = this.value;

    this.#notify = debounce(
      (value) => this.#dispatchChange(value),
      this.#debounceDelay()
    );

    if (this.refs.decrease instanceof HTMLButtonElement) {
      this.on(this.refs.decrease, 'click', () => this.stepBy(-1));
    }

    if (this.refs.increase instanceof HTMLButtonElement) {
      this.on(this.refs.increase, 'click', () => this.stepBy(1));
    }

    this.on(input, 'input', this.#onInput);
    this.on(input, 'change', this.#onCommit);
    this.on(input, 'blur', this.#onCommit);
    this.on(input, 'keydown', this.#onKeydown);

    this.#syncButtons();
  }

  teardown() {
    this.#notify.cancel?.();
  }

  attributeChanged() {
    /*
     * attributeChangedCallback() can run before setup() has initialized refs.
     * Do not touch the input until the component has been initialized.
     */
    if (!(this.refs?.input instanceof HTMLInputElement)) return;

    // Stock and quantity rules change when the variant changes.
    this.#clampToRules();
    this.#syncButtons();
  }

  /* --------------------------------------------------------- public API */

  /**
   * @returns {number} The current quantity.
   */
  get value() {
    const input = this.refs?.input;

    /*
     * Attribute callbacks can fire before setup() has initialized refs.
     * Returning the minimum keeps the getter safe during that phase.
     */
    if (!(input instanceof HTMLInputElement)) {
      return this.min;
    }

    const value = Number.parseInt(input.value, 10);

    return Number.isFinite(value) ? value : this.min;
  }

  /**
   * @param {number} next
   */
  set value(next) {
    this.setValue(next);
  }

  /** @returns {number} */
  get min() {
    const input = this.refs?.input;

    const raw = this.dataset.min ?? (
      input instanceof HTMLInputElement ? input.min : null
    );

    return Number(raw) || 1;
  }

  /** @returns {number} */
  get max() {
    const input = this.refs?.input;

    const raw = this.dataset.max ?? (
      input instanceof HTMLInputElement ? input.max : null
    );

    const value = Number(raw);

    return Number.isFinite(value) && value > 0 ? value : Infinity;
  }

  /** @returns {number} */
  get step() {
    const input = this.refs?.input;

    const raw = this.dataset.step ?? (
      input instanceof HTMLInputElement ? input.step : null
    );

    return Number(raw) || 1;
  }

  /**
   * Set the quantity, applying the minimum, maximum and increment rules.
   *
   * @param {number} next
   * @param {{ silent?: boolean }} [options] Pass `silent` to skip the change event.
   * @returns {number} The value actually applied.
   */
  setValue(next, { silent = false } = {}) {
    const input = this.refs?.input;

    if (!(input instanceof HTMLInputElement)) {
      return this.#applyRules(next);
    }

    const applied = this.#applyRules(next);

    input.value = String(applied);

    this.#syncButtons();

    if (!silent && applied !== this.#lastNotified) {
      this.#notify(applied);
    }

    return applied;
  }

  /**
   * Move by one increment.
   *
   * Named `stepBy` rather than `step` on purpose: `step` is already the getter
   * for the increment size, and a class cannot hold both.
   *
   * @param {number} direction 1 or -1.
   */
  stepBy(direction) {
    const before = this.value;
    const applied = this.setValue(before + this.step * direction);

    // Explain why nothing happened rather than leaving the button feeling dead.
    if (
      applied === before &&
      direction > 0 &&
      Number.isFinite(this.max)
    ) {
      this.#message(
        themeString('quantityMaximum', '', {
          quantity: this.max,
        }),
        true
      );
    }
  }

  /**
   * Show a validation message under the field.
   *
   * @param {string} text Already translated. Pass an empty string to clear.
   * @param {boolean} [announceIt=false] Also send it to the polite live region.
   */
  message(text, announceIt = false) {
    this.#message(text, announceIt);
  }

  /* ---------------------------------------------------------- internals */

  /**
   * @param {number} value
   * @returns {number}
   * @private
   */
  #applyRules(value) {
    const min = this.min;
    const max = this.max;
    const step = this.step;

    if (!Number.isFinite(value)) {
      return min;
    }

    /*
     * Snap to the nearest valid increment above the minimum, so a store
     * selling in packs of six cannot end up with seven in the cart.
     */
    const stepped =
      step > 1
        ? min + Math.round((value - min) / step) * step
        : Math.round(value);

    return clamp(
      stepped,
      min,
      Number.isFinite(max) ? max : stepped
    );
  }

  /** @private */
  #clampToRules() {
    const input = this.refs?.input;

    if (!(input instanceof HTMLInputElement)) return;

    const current = this.value;
    const applied = this.#applyRules(current);

    if (applied !== current) {
      input.value = String(applied);
    }
  }

  /** @private */
  #syncButtons() {
    const input = this.refs?.input;

    if (!(input instanceof HTMLInputElement)) return;

    const value = this.value;

    if (this.refs.decrease instanceof HTMLButtonElement) {
      this.refs.decrease.disabled = value <= this.min;
    }

    if (this.refs.increase instanceof HTMLButtonElement) {
      this.refs.increase.disabled =
        Number.isFinite(this.max) && value >= this.max;
    }

    input.setAttribute('aria-valuenow', String(value));
  }

  /**
   * While typing, only the buttons are updated. Correcting the value here is
   * what makes a field fight the customer as they type a two-digit number.
   *
   * @private
   */
  #onInput = () => {
    this.#message('');
    this.#syncButtons();
  };

  /** @private */
  #onCommit = () => {
    const input = this.refs?.input;

    if (!(input instanceof HTMLInputElement)) return;

    const typed = Number.parseInt(input.value, 10);
    const applied = this.setValue(typed);

    if (Number.isFinite(typed) && typed !== applied) {
      const key =
        typed > applied
          ? 'quantityMaximum'
          : 'quantityMinimum';

      this.#message(
        themeString(key, '', {
          quantity: applied,
        }),
        true
      );
    }
  };

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown = (event) => {
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        this.stepBy(1);
        break;

      case 'ArrowDown':
        event.preventDefault();
        this.stepBy(-1);
        break;

      case 'Enter':
        /*
         * Commit immediately: inside a cart form, Enter would otherwise
         * submit with the value still un-clamped.
         */
        this.#onCommit();
        break;

      default:
        break;
    }
  };

  /**
   * @param {string} text
   * @param {boolean} announceIt
   * @private
   */
  #message(text, announceIt = false) {
    const target = this.refs?.message;

    if (target instanceof HTMLElement) {
      target.textContent = text;
      target.toggleAttribute('hidden', !text);
    }

    this.toggleAttribute('data-invalid', Boolean(text));

    if (text && announceIt) {
      announce(text);
    }
  }

  /**
   * @param {number} value
   * @private
   */
  #dispatchChange(value) {
    const previous = this.#lastNotified;

    this.#lastNotified = value;

    this.dispatch(EVENTS.QUANTITY_CHANGE, {
      quantity: value,
      previous,
      line: this.dataset.line
        ? Number(this.dataset.line)
        : null,
      key: this.dataset.key || null,
      variantId: this.dataset.variantId || null,
    });
  }

  /**
   * Cart line updates hit the network, so they wait. A product form stepper
   * only updates local state, so it responds immediately.
   *
   * @returns {number}
   * @private
   */
  #debounceDelay() {
    const explicit = Number(this.dataset.debounce);

    if (Number.isFinite(explicit)) {
      return explicit;
    }

    return this.dataset.line || this.dataset.key ? 400 : 0;
  }
}

defineComponent('quantity-selector', QuantitySelector);

export default QuantitySelector;