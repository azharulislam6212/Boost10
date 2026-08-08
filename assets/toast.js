/**
 * toast.js — Boost10
 *
 * `<toast-notification>` and the `toast` helper.
 *
 * A transient confirmation: item added, link copied, code applied. One element
 * per page, rendered in the overlay group, driven entirely through `toast.show()`.
 *
 * ## Three rules, and why each one exists
 *
 * **A toast never takes focus.** Stealing focus for a confirmation interrupts
 * whatever the customer was doing — mid-word in a search field, mid-scroll
 * through a grid. The message reaches assistive technology through the shared
 * live region instead, and any action it offers is always reachable from the
 * page itself. A toast is the fastest route to that action, never the only one.
 *
 * **The timer pauses on hover and focus.** A toast carrying a link that
 * disappears while someone is reaching for it is worse than no link at all. It
 * also pauses when the tab is hidden, so a customer who switches away and comes
 * back does not find an empty space where the confirmation was.
 *
 * **Errors do not auto-dismiss.** A confirmation can vanish because the customer
 * has already seen the result. A failure has to be read, and a customer who
 * looked away for two seconds should not have to guess what went wrong.
 *
 * ## Shadow DOM, deliberately
 *
 * This is the one component in the theme that uses a shadow root. A toast sits
 * above everything and appears while a customer is mid-task, so a merchant's
 * Custom CSS accidentally matching `.toast` — or a `z-index` from an app —
 * should not be able to break it. `part` attributes expose the pieces that are
 * genuinely meant to be themed. Everywhere else in this theme, merchant CSS
 * reaching a component is a feature; here it is a hazard.
 *
 * @module @theme/toast
 */

import { defineComponent } from '@theme/component';
import { ShadowComponent } from '@theme/shadow-component';
import { announce, announceUrgent, themeString, prefersReducedMotion } from '@theme/utilities';

/** How long a normal toast stays, in milliseconds. */
const DEFAULT_DURATION = 4000;

/** Errors stay until dismissed; this is the ceiling for everything else. */
const MAX_DURATION = 10_000;

export class ToastNotification extends ShadowComponent {
  static template = `
    <div part="container" class="toast" role="presentation" data-state="hidden">
      <span part="icon" class="toast__icon" aria-hidden="true"></span>

      <div part="body" class="toast__body">
        <span part="message" class="toast__message"></span>
        <a part="action" class="toast__action" hidden></a>
      </div>

      <button part="close" class="toast__close" type="button">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `;

  static styles = `
    :host {
      position: fixed;
      inset-block-end: var(--toast-offset, 2rem);
      inset-inline-start: 50%;
      z-index: 60;
      display: block;
      inline-size: max-content;
      max-inline-size: min(42rem, calc(100vw - 3.2rem));
      transform: translateX(-50%);
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 1.2rem;
      padding: 1.2rem 1.6rem;
      border-radius: var(--toast-radius, 0.8rem);
      background: var(--toast-background, #1a1a1a);
      color: var(--toast-text, #fff);
      box-shadow: 0 8px 30px rgb(0 0 0 / 0.24);
      font-size: 1.4rem;
      line-height: 1.5;
      opacity: 0;
      transform: translateY(1.2rem);
      transition: opacity 220ms ease, transform 220ms ease;
      pointer-events: auto;
    }

    .toast[data-state="visible"] { opacity: 1; transform: none; }
    .toast[data-state="hidden"] { visibility: hidden; }

    .toast[data-type="error"] { background: var(--toast-error-background, #8a1b1b); }
    .toast[data-type="success"] .toast__icon::before { content: "\\2713"; }
    .toast[data-type="error"] .toast__icon::before { content: "\\26A0"; }

    .toast__icon { flex: 0 0 auto; font-size: 1.4rem; line-height: 1.5; }
    .toast__icon:empty { display: none; }
    .toast__body { flex: 1 1 auto; min-inline-size: 0; }
    .toast__message { display: block; }

    .toast__action {
      display: inline-block;
      margin-block-start: 0.4rem;
      color: inherit;
      font-weight: 500;
      text-decoration: underline;
    }

    .toast__close {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      inline-size: 2.4rem;
      block-size: 2.4rem;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: inherit;
      cursor: pointer;
      opacity: 0.7;
    }

    .toast__close:hover { opacity: 1; }
    .toast__close:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

    @media (prefers-reduced-motion: reduce) {
      .toast { transition: opacity 120ms linear; transform: none; }
      .toast[data-state="visible"] { transform: none; }
    }
  `;

  /** @type {number|null} */
  #timer = null;

  /** Milliseconds left when the timer was paused. */
  #remaining = 0;

  /** When the current run of the timer started. */
  #startedAt = 0;

  setup() {
    super.setup();

    this.$('.toast__close')?.addEventListener('click', () => this.hide(), { signal: this.signal });

    // A toast carrying a link that vanishes while someone is reaching for it is
    // worse than no link at all.
    const container = this.$('.toast');
    container?.addEventListener('pointerenter', () => this.pause(), { signal: this.signal });
    container?.addEventListener('pointerleave', () => this.resume(), { signal: this.signal });
    container?.addEventListener('focusin', () => this.pause(), { signal: this.signal });
    container?.addEventListener('focusout', () => this.resume(), { signal: this.signal });

    // Switching tabs should not consume the toast's lifetime.
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.resume();
    });
  }

  teardown() {
    this.#clear();
    super.teardown?.();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Show a message.
   *
   * @param {string} message
   * @param {Object} [options]
   * @param {'info'|'success'|'error'} [options.type]
   * @param {number} [options.duration] Milliseconds. Ignored for errors.
   * @param {{ label: string, href: string }} [options.action]
   * @returns {boolean}
   */
  show(message, { type = 'info', duration, action } = {}) {
    if (!message) return false;

    const container = this.$('.toast');
    const text = this.$('.toast__message');
    if (!container || !text) return false;

    this.#clear();

    text.textContent = message;
    container.dataset.type = type;

    const link = this.$('.toast__action');
    if (link instanceof HTMLAnchorElement) {
      if (action?.href && action?.label) {
        link.href = action.href;
        link.textContent = action.label;
        link.hidden = false;
      } else {
        link.hidden = true;
        link.removeAttribute('href');
        link.textContent = '';
      }
    }

    const close = this.$('.toast__close');
    close?.setAttribute('aria-label', themeString('close', 'Close'));

    container.dataset.state = 'visible';
    this.setAttribute('data-visible', '');

    // Announced through the shared live region rather than by making this one,
    // so there is exactly one live region on the page and messages never
    // interleave. Errors interrupt; confirmations wait their turn.
    if (type === 'error') announceUrgent(message);
    else announce(message);

    // An error has to be read. A confirmation can vanish, because the customer
    // has already seen the result it is confirming.
    if (type !== 'error') {
      this.#remaining = Math.min(duration ?? DEFAULT_DURATION, MAX_DURATION);
      this.#run();
    }

    return true;
  }

  /**
   * Hide the toast.
   */
  hide() {
    this.#clear();

    const container = this.$('.toast');
    if (!container) return;

    container.dataset.state = 'hiding';
    this.removeAttribute('data-visible');

    const finish = () => {
      container.dataset.state = 'hidden';
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    container.addEventListener('transitionend', finish, { once: true });

    // A transition that never fires — because the element was hidden, or the
    // tab was backgrounded — would otherwise leave the toast on screen forever.
    window.setTimeout(finish, 400);
  }

  /**
   * Stop the dismiss timer, keeping what is left of it.
   */
  pause() {
    if (this.#timer === null) return;

    window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#remaining -= Date.now() - this.#startedAt;
  }

  /**
   * Start the dismiss timer again from where it stopped.
   */
  resume() {
    if (this.#timer !== null || this.#remaining <= 0) return;
    if (!this.hasAttribute('data-visible')) return;

    this.#run();
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #run() {
    this.#startedAt = Date.now();
    this.#timer = window.setTimeout(() => this.hide(), this.#remaining);
  }

  /** @private */
  #clear() {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#remaining = 0;
  }
}

defineComponent('toast-notification', ToastNotification);

/**
 * Show a toast from anywhere.
 *
 * A function rather than an element lookup at every call site, because the
 * caller should not have to know whether the merchant kept the toast in their
 * overlay group. When it is absent this returns false and the announcement still
 * happens through the live region — the message reaches a screen reader either
 * way, which is the part that must not be optional.
 *
 * @param {string} message
 * @param {Object} [options] See `ToastNotification.show`.
 * @returns {boolean} Whether a toast was actually shown.
 */
export function toast(message, options = {}) {
  const element = document.querySelector('toast-notification');

  if (element?.show) return element.show(message, options);

  if (options.type === 'error') announceUrgent(message);
  else announce(message);

  return false;
}

export default { ToastNotification, toast };
