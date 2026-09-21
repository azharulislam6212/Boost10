/**
 * `<customer-order-history>` — the order list in the account area.
 *
 * @module @theme/customer-orders
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { cart } from '@theme/cart-drawer';
import { themeString, announce, announceUrgent } from '@theme/utilities';

export class CustomerOrderHistory extends BaseComponent {
  setup() {
    if (this.refs.filter) {
      this.on(this.refs.filter, 'change', (event) => this.filter(event.target.value));
    }

    this.on(this, 'click', this.#onClick);

    this.#applyFilterFromUrl();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement[]}
   */
  get orders() {
    return Array.from(this.querySelectorAll('[data-order]'));
  }

  /**
   * @returns {HTMLElement[]}
   */
  get visibleOrders() {
    return this.orders.filter((order) => !order.hasAttribute('hidden'));
  }

  /**
   * Show only orders with a given fulfilment status.
   *
   * @param {string} status `all`, or a Shopify fulfilment status.
   */
  filter(status) {
    const wanted = String(status || 'all').toLowerCase();

    for (const order of this.orders) {
      const matches = wanted === 'all' || (order.dataset.status || '').toLowerCase() === wanted;
      order.toggleAttribute('hidden', !matches);
    }

    const count = this.visibleOrders.length;

    if (this.refs.empty instanceof HTMLElement) {
      this.refs.empty.toggleAttribute('hidden', count > 0);
    }

    this.dataset.filter = wanted;
    this.#syncUrl(wanted);

    const message = themeString('ordersShowing', '', { shown: count, total: this.orders.length });
    this.#status(message);
    announce(message);
  }

  /**
   * Add an order's items back to the cart.
   *
   * @param {HTMLElement} trigger The reorder button, carrying `data-items`.
   * @returns {Promise<boolean>}
   */
  async reorder(trigger) {
    let items;

    try {
      items = JSON.parse(trigger.dataset.items || '[]');
    } catch {
      announceUrgent(themeString('reorderFailed', ''));
      return false;
    }

    if (!Array.isArray(items) || items.length === 0) return false;

    trigger.setAttribute('disabled', '');
    trigger.setAttribute('aria-busy', 'true');

    try {
      await cart.addItem(items);
      announce(themeString('reorderSuccess', ''));
      return true;
    } catch (error) {
      const rejected = error?.body?.description || '';
      const remaining = items.filter((item) => !rejected.includes(String(item.id)));

      if (remaining.length > 0 && remaining.length < items.length) {
        try {
          await cart.addItem(remaining);
          announce(themeString('reorderPartial', ''));
          return true;
        } catch {}
      }

      announceUrgent(error?.message || themeString('reorderFailed', ''));
      return false;
    } finally {
      trigger.removeAttribute('disabled');
      trigger.removeAttribute('aria-busy');
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-reorder]') : null;
    if (!(trigger instanceof HTMLElement)) return;

    event.preventDefault();
    this.reorder(trigger);
  };

  /**
   * Restore a filter from the URL, so a filtered view can be shared or returned
   * to with the Back button.
   *
   * @private
   */
  #applyFilterFromUrl() {
    const status = new URL(window.location.href).searchParams.get('status');
    if (!status) return;

    if (this.refs.filter instanceof HTMLSelectElement) this.refs.filter.value = status;
    this.filter(status);
  }

  /**
   * @param {string} status
   * @private
   */
  #syncUrl(status) {
    const url = new URL(window.location.href);

    if (status === 'all') {
      url.searchParams.delete('status');
    } else {
      url.searchParams.set('status', status);
    }

    window.history.replaceState({ orders: true }, '', `${url.pathname}${url.search}`);
  }

  /**
   * @param {string} message
   * @private
   */
  #status(message) {
    if (this.refs.status instanceof HTMLElement) this.refs.status.textContent = message;
  }
}

defineComponent('customer-order-history', CustomerOrderHistory);

export default CustomerOrderHistory;
