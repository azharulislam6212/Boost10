/**
 * `<toast-notification>` and the `toast` helper.
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

    const container = this.$('.toast');
    container?.addEventListener('pointerenter', () => this.pause(), { signal: this.signal });
    container?.addEventListener('pointerleave', () => this.resume(), { signal: this.signal });
    container?.addEventListener('focusin', () => this.pause(), { signal: this.signal });
    container?.addEventListener('focusout', () => this.resume(), { signal: this.signal });

    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.resume();
    });
  }

  teardown() {
    this.#clear();
    super.teardown?.();
  }

  /* --------------------------------------------------------- public API -- ---- */

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

    if (type === 'error') announceUrgent(message);
    else announce(message);

    if (type !== 'error') {
      this.#remaining = Math.min(duration ?? DEFAULT_DURATION, MAX_DURATION);
      this.#run();
    }

    return true;
  }

  /** Hide the toast. */
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

    window.setTimeout(finish, 400);
  }

  /** Stop the dismiss timer, keeping what is left of it. */
  pause() {
    if (this.#timer === null) return;

    window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#remaining -= Date.now() - this.#startedAt;
  }

  /** Start the dismiss timer again from where it stopped. */
  resume() {
    if (this.#timer !== null || this.#remaining <= 0) return;
    if (!this.hasAttribute('data-visible')) return;

    this.#run();
  }

  /* ---------------------------------------------------------- internals -- ---- */

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
