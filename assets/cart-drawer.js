/**
 * cart-drawer.js — Boost10
 *
 * The cart. Every mutation in the theme goes through this module, and nothing
 * else is allowed to POST to a cart endpoint.
 *
 * Two pieces live here:
 *
 *   `cart`          A module singleton holding the network layer and the last
 *                   known cart object. It is the owner of cart state.
 *   <cart-drawer>   The drawer UI. Delegates every mutation to `cart` and
 *                   renders whatever comes back.
 *
 * Why the state owner is a module rather than the element: `settings.cart_type`
 * can be set to "page" or "notification", in which case no drawer is rendered
 * at all — but `<cart-items>` on the cart page, `<free-shipping-bar>` in the
 * footer and the header count all still need a cart. Hanging the state on an
 * element that may not exist makes every consumer defensive. The ownership rule
 * is unchanged: exactly one owner, everyone else calls its methods.
 *
 * Server rendering, not client rendering. Every mutation asks Shopify to render
 * the affected sections in the same request, and `morph()` applies them. Prices,
 * discounts, translations and money formatting are therefore computed by Liquid
 * exactly once, and the cart drawer cannot drift out of step with the cart page.
 *
 * @module @theme/cart-drawer
 */

import { DrawerComponent } from '@theme/dialog';
import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, cartUpdatedDetail, cartErrorDetail } from '@theme/events';
import { CartError, announce, announceUrgent, fetchConfig, formatMoney, getRoute, parseResponse, themeString } from '@theme/utilities';
import { applySections, clearSectionCache } from '@theme/section-renderer';

/* ==========================================================================
   Cart state owner
   ========================================================================== */

/**
 * The single source of truth for cart state and the only code in the theme that
 * writes to a cart endpoint.
 */
export const cart = {
  /** @type {Object|null} Last known cart object. */
  state: null,

  /** @type {AbortController|null} */
  _request: null,

  /**
   * Section ids that should be re-rendered with every mutation.
   * Registered by the elements that own them, so a page that has no free
   * shipping bar never asks the server to render one.
   *
   * @type {Set<string>}
   */
  _sections: new Set(),

  /**
   * @param {string} sectionId
   */
  registerSection(sectionId) {
    if (sectionId) this._sections.add(sectionId);
  },

  /**
   * @param {string} sectionId
   */
  unregisterSection(sectionId) {
    this._sections.delete(sectionId);
  },

  /**
   * @returns {string[]}
   */
  get sections() {
    return Array.from(this._sections);
  },

  /**
   * @returns {Element} Where cart events are dispatched from: the drawer when
   *   one exists, otherwise the document body, so listeners work either way.
   */
  get host() {
    return document.querySelector('cart-drawer') || document.body;
  },

  /* ------------------------------------------------------------ mutations */

  /**
   * Add one or more items.
   *
   * @param {Object|Object[]} items A line item, or several.
   * @param {Object} [options]
   * @param {boolean} [options.open=true] Open the drawer afterwards.
   * @returns {Promise<Object>} The Shopify add response.
   * @throws {CartError}
   */
  async addItem(items, { open = true } = {}) {
    const lines = Array.isArray(items) ? items : [items];

    const data = await this._post(getRoute('cartAdd', { json: true }), {
      items: lines,
      sections: this.sections,
      sections_url: window.location.pathname
    });

    await this.refresh({ sections: data.sections });

    const added = data.items?.[0] || data;
    this._dispatch(EVENTS.CART_ITEM_ADDED, cartUpdatedDetail(this.state, 'add', added));
    announce(themeString('itemAdded', ''));

    if (open) this._reveal(added);

    return data;
  },

  /**
   * Change a line's quantity.
   *
   * `line` is one-based and shifts whenever an item is removed, so `key` is
   * preferred wherever the caller has one. Shopify accepts either.
   *
   * @param {Object} options
   * @param {string} [options.key] Line item key.
   * @param {number} [options.line] One-based line index.
   * @param {number} options.quantity
   * @returns {Promise<Object>} The updated cart.
   */
  async changeItem({ key, line, quantity }) {
    const payload = { quantity, sections: this.sections, sections_url: window.location.pathname };

    if (key) {
      payload.id = key;
    } else {
      payload.line = line;
    }

    const previousCount = this.state?.item_count ?? 0;
    const data = await this._post(getRoute('cartChange', { json: true }), payload);

    this.state = data;
    this._applySections(data.sections);

    const removed = quantity === 0;
    this._dispatch(
      removed ? EVENTS.CART_ITEM_REMOVED : EVENTS.CART_ITEM_CHANGED,
      cartUpdatedDetail(data, removed ? 'remove' : 'change')
    );
    this._dispatch(EVENTS.CART_UPDATED, cartUpdatedDetail(data, 'change'));

    announce(themeString(removed ? 'itemRemoved' : 'cartUpdated', ''));

    // A cart that just emptied has to re-render even if the server returned no
    // sections, because the empty state lives in a different part of the markup.
    if (previousCount > 0 && data.item_count === 0) await this.refresh();

    return data;
  },

  /**
   * Swap a line for a different variant, keeping its quantity and properties.
   *
   * Shopify has no "change variant" endpoint: the old line is removed and a new
   * one added. Doing it in that order avoids a moment where the customer has
   * neither, which matters when the add fails because the new variant sold out
   * between the page load and the click.
   *
   * @param {Object} options
   * @param {string} options.key Existing line key.
   * @param {number} options.id New variant id.
   * @param {number} [options.quantity]
   * @param {Object} [options.properties]
   * @param {number|null} [options.selling_plan]
   * @returns {Promise<Object>}
   */
  async changeVariant({ key, id, quantity = 1, properties = {}, selling_plan = null }) {
    const line = { id, quantity, properties };
    if (selling_plan) line.selling_plan = selling_plan;

    await this._post(getRoute('cartAdd', { json: true }), { items: [line] });
    return this.changeItem({ key, quantity: 0 });
  },

  /**
   * Remove a line.
   *
   * @param {Object} options
   * @param {string} [options.key]
   * @param {number} [options.line]
   * @returns {Promise<Object>}
   */
  removeItem({ key, line }) {
    return this.changeItem({ key, line, quantity: 0 });
  },

  /**
   * Update the order note.
   *
   * @param {string} note
   * @returns {Promise<Object>}
   */
  async updateNote(note) {
    const data = await this._post(getRoute('cartUpdate', { json: true }), { note });

    this.state = data;
    this._dispatch(EVENTS.CART_NOTE_UPDATED, cartUpdatedDetail(data, 'note'));

    return data;
  },

  /**
   * Update cart attributes.
   *
   * @param {Object} attributes
   * @returns {Promise<Object>}
   */
  async updateAttributes(attributes) {
    const data = await this._post(getRoute('cartUpdate', { json: true }), {
      attributes,
      sections: this.sections,
      sections_url: window.location.pathname
    });

    this.state = data;
    this._applySections(data.sections);
    this._dispatch(EVENTS.CART_UPDATED, cartUpdatedDetail(data, 'attributes'));

    return data;
  },

  /**
   * Record a discount code for checkout.
   *
   * Shopify has no storefront endpoint that validates a code against a cart.
   * `/discount/CODE` is a redirect that sets a cookie, not a JSON API, and
   * fetching it neither validates the code nor reliably attaches it. So the code
   * is stored as a cart attribute and appended to the checkout URL, and the UI
   * says "applied at checkout" rather than claiming a saving the theme cannot
   * verify. Announcing a discount that then fails at checkout is worse than
   * saying nothing.
   *
   * @param {string} code
   * @returns {Promise<Object>}
   */
  async applyDiscount(code) {
    const trimmed = String(code || '').trim();
    if (!trimmed) return this.state;

    const data = await this.updateAttributes({ discount_code: trimmed });

    this._dispatch(EVENTS.CART_DISCOUNT, { code: trimmed, cart: data });
    announce(themeString('discountApplied', ''));

    return data;
  },

  /**
   * Clear the stored discount code.
   *
   * @returns {Promise<Object>}
   */
  async removeDiscount() {
    const data = await this.updateAttributes({ discount_code: '' });
    this._dispatch(EVENTS.CART_DISCOUNT, { code: null, cart: data });
    return data;
  },

  /**
   * @returns {string} Checkout URL, carrying the stored discount code.
   */
  get checkoutUrl() {
    const base = getRoute('cart') + '/checkout';
    const code = this.state?.attributes?.discount_code;
    return code ? `${base}?discount=${encodeURIComponent(code)}` : base;
  },

  /* --------------------------------------------------------------- reads */

  /**
   * Re-fetch the cart and re-render the registered sections.
   *
   * @param {Object} [options]
   * @param {Object} [options.sections] Already-rendered sections to apply instead of fetching.
   * @returns {Promise<Object>}
   */
  async refresh({ sections } = {}) {
    if (sections) {
      this._applySections(sections);
    } else if (this.sections.length > 0) {
      const { fetchSections } = await import('@theme/section-renderer');
      const rendered = await fetchSections(this.sections, { cache: false });
      this._applySections(rendered);
    }

    const response = await fetch(getRoute('cart', { json: true }), {
      headers: { Accept: 'application/json' }
    });

    this.state = await parseResponse(response, { ErrorClass: CartError });
    this._dispatch(EVENTS.CART_UPDATED, cartUpdatedDetail(this.state, 'refresh'));

    return this.state;
  },

  /**
   * @returns {number}
   */
  get itemCount() {
    return this.state?.item_count ?? 0;
  },

  /* ----------------------------------------------------------- internals */

  /**
   * @param {string} url
   * @param {Object} body
   * @returns {Promise<Object>}
   * @private
   */
  async _post(url, body) {
    // A second request while one is in flight would race, and the loser would
    // overwrite the winner's cart state with a stale object.
    this._request?.abort();
    this._request = new AbortController();

    this._dispatch(EVENTS.CART_LOADING, { loading: true });
    document.documentElement.setAttribute('data-cart-loading', '');

    try {
      const response = await fetch(
        url,
        fetchConfig('json', { body, signal: this._request.signal })
      );

      const data = await parseResponse(response, { ErrorClass: CartError });

      // Cached section HTML is stale the moment the cart changes.
      clearSectionCache();

      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;

      const message = error?.message || themeString('cartError', '');
      this._dispatch(EVENTS.CART_ERROR, cartErrorDetail(message, { status: error?.status }));
      announceUrgent(message);

      throw error;
    } finally {
      this._request = null;
      document.documentElement.removeAttribute('data-cart-loading');
      this._dispatch(EVENTS.CART_LOADING, { loading: false });
    }
  },

  /**
   * @param {Object} sections
   * @private
   */
  _applySections(sections) {
    if (!sections) return;
    applySections(sections);
  },

  /**
   * @param {string} type
   * @param {Object} detail
   * @private
   */
  _dispatch(type, detail) {
    this.host.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  },

  /**
   * Show the customer what just happened, in whichever way the merchant chose.
   *
   * @param {Object} added
   * @private
   */
  async _reveal(added) {
    const behaviour = window.Theme?.settings?.cartType || 'drawer';

    if (behaviour === 'page') {
      window.location.href = getRoute('cart');
      return;
    }

    if (behaviour === 'notification') {
      const { toast } = await import('@theme/dialog');
      toast(themeString('itemAdded', ''), 'success');
      return;
    }

    document.querySelector('cart-drawer')?.open?.();
    void added;
  }
};

/* ==========================================================================
   <cart-drawer>
   ========================================================================== */

/**
 * The cart drawer.
 *
 * Extends `<drawer-component>`, so focus trapping, scroll locking, Escape
 * handling and the `data-lenis-prevent` fix all come from one place rather than
 * being reimplemented for the cart.
 *
 * Attributes:
 *   data-sections  Comma separated section ids to re-render on every mutation
 */
export class CartDrawer extends DrawerComponent {
  get overlayType() {
    return 'cart';
  }

  setup() {
    super.setup();

    for (const id of (this.dataset.sections || '').split(',')) {
      cart.registerSection(id.trim());
    }

    cart.state = window.Theme?.cart ?? cart.state;

    // Quick add forms in product cards submit straight to the cart. Intercepting
    // here rather than in the card keeps the network layer in one module, and
    // the form still works as a plain POST if this script never loads.
    this.on(document, 'submit', this.#onQuickAdd);

    this.on(document, EVENTS.CART_ERROR, this.#onCartError);
  }

  teardown() {
    for (const id of (this.dataset.sections || '').split(',')) {
      cart.unregisterSection(id.trim());
    }
    super.teardown();
  }

  /* --------------------------------------------------------- public API -- */

  /** @returns {Object|null} The current cart. Read-only by convention. */
  get state() {
    return cart.state;
  }

  /**
   * @param {Object|Object[]} items
   * @returns {Promise<Object>}
   */
  addItem(items) {
    return cart.addItem(items);
  }

  /**
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  changeItem(options) {
    return cart.changeItem(options);
  }

  /**
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  changeVariant(options) {
    return cart.changeVariant(options);
  }

  /**
   * @param {string} code
   * @returns {Promise<Object>}
   */
  applyDiscount(code) {
    return cart.applyDiscount(code);
  }

  /**
   * @param {string} note
   * @returns {Promise<Object>}
   */
  updateNote(note) {
    return cart.updateNote(note);
  }

  /**
   * @returns {Promise<Object>}
   */
  refresh() {
    return cart.refresh();
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onQuickAdd = async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-quick-add-form]')) return;

    event.preventDefault();

    const button = form.querySelector('[type="submit"]');
    button?.setAttribute('aria-busy', 'true');
    button?.setAttribute('disabled', '');

    try {
      const data = new FormData(form);
      await cart.addItem({
        id: Number(data.get('id')),
        quantity: Number(data.get('quantity') || 1)
      });
    } catch {
      // The error has already been announced and dispatched by `cart._post`.
    } finally {
      button?.removeAttribute('aria-busy');
      button?.removeAttribute('disabled');
    }
  };

  /**
   * @param {CustomEvent} event
   * @private
   */
  #onCartError = async (event) => {
    const { toast } = await import('@theme/dialog');
    toast(event.detail?.message || themeString('cartError', ''), 'error');
  };
}

defineComponent('cart-drawer', CartDrawer);


/* ==========================================================================
   <cart-upsell>
   ========================================================================== */

/**
 * Cross-sells inside the cart drawer.
 *
 * Fetches Shopify's recommendations endpoint as JSON rather than as a rendered
 * section, for one reason: the drawer offers a variant selector, and the
 * section-rendered version would mean a second request to get the variant data.
 *
 * Two products, not six. A cart drawer is a checkout funnel, and the honest
 * measure of an upsell there is whether it adds an item without costing a
 * conversion. A grid of six turns the drawer into a browse.
 *
 * Nothing is fetched until the drawer opens. Recommendations for a cart nobody
 * has looked at are a request nobody asked for.
 *
 * Markup:
 *
 *   <cart-upsell data-product-id="123" data-limit="2" data-intent="complementary">
 *     <h3 data-ref="heading" hidden>…</h3>
 *     <div data-ref="list"></div>
 *     <template data-ref="template">…</template>
 *   </cart-upsell>
 */
export class CartUpsell extends BaseComponent {
  static requiredRefs = ['list'];

  /** @type {AbortController|null} */
  #request = null;

  /** The product the current list was fetched for. */
  #loadedFor = null;

  setup() {
    this.on(this, 'click', this.#onClick);

    // The drawer announces itself rather than this element polling for it.
    this.on(document.body, EVENTS.OVERLAY_OPEN, (event) => {
      if (event.detail?.type !== 'cart') return;
      this.load();
    });

    // Adding an item changes what should be recommended alongside it.
    this.on(document.body, EVENTS.CART_UPDATED, () => {
      this.#loadedFor = null;
    });
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
  }

  /**
   * @returns {string|null}
   */
  get productId() {
    return this.dataset.productId || null;
  }

  /**
   * @returns {number} Shopify caps this endpoint at ten, and asking for more
   *   errors rather than truncating.
   */
  get limit() {
    return Math.min(Number(this.dataset.limit) || 2, 10);
  }

  /**
   * Fetch and render.
   *
   * @returns {Promise<boolean>}
   */
  async load() {
    const id = this.productId;
    if (!id || this.#loadedFor === id) return false;

    this.#request?.abort();
    this.#request = new AbortController();

    const params = new URLSearchParams({
      product_id: id,
      limit: String(this.limit),
      intent: this.dataset.intent || 'complementary'
    });

    try {
      const response = await fetch(`${getRoute('productRecommendations')}.json?${params}`, {
        signal: this.#request.signal,
        headers: { Accept: 'application/json' }
      });

      if (!response.ok) throw new Error(`Request failed with ${response.status}`);

      const data = await response.json();
      const products = (data.products || []).filter((product) => product.available);

      if (products.length === 0) {
        // Nothing to suggest is not an error. Remove rather than leave a heading
        // over an empty row in a drawer already short on space.
        this.remove();
        return false;
      }

      this.#render(products);
      this.#loadedFor = id;
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      // An upsell is supplementary. A failure removes it rather than putting an
      // error message inside a checkout funnel.
      console.warn('[Boost10] Cart recommendations could not be loaded.', error);
      this.remove();
      return false;
    } finally {
      this.#request = null;
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {Object[]} products
   * @private
   */
  #render(products) {
    const template = this.refs.template;
    const list = this.refs.list;

    if (!(template instanceof HTMLTemplateElement)) return;

    list.replaceChildren();

    for (const product of products) {
      const node = template.content.cloneNode(true);
      const root = node.querySelector('[data-upsell-item]');
      if (!root) continue;

      root.dataset.productId = String(product.id);

      const image = node.querySelector('[data-upsell-image]');
      if (image instanceof HTMLImageElement && product.featured_image) {
        image.src = product.featured_image;
        image.alt = '';
      }

      const title = node.querySelector('[data-upsell-title]');
      if (title instanceof HTMLElement) {
        title.textContent = product.title;
        if (title instanceof HTMLAnchorElement) title.href = product.url;
      }

      const price = node.querySelector('[data-upsell-price]');
      if (price instanceof HTMLElement) price.textContent = formatMoney(product.price);

      // A variant selector, because adding the wrong size from a cart drawer is
      // a return rather than a sale.
      const select = node.querySelector('[data-upsell-variant]');
      const available = product.variants.filter((variant) => variant.available);

      if (select instanceof HTMLSelectElement) {
        if (product.variants.length > 1) {
          select.replaceChildren(
            ...available.map((variant) => {
              const option = document.createElement('option');
              option.value = String(variant.id);
              option.textContent = variant.title;
              return option;
            })
          );

          select.id = `UpsellVariant-${product.id}`;
          select.hidden = false;

          const label = node.querySelector('[data-upsell-variant-label]');
          if (label instanceof HTMLLabelElement) label.htmlFor = select.id;
        } else {
          select.hidden = true;
          select.replaceChildren();
        }
      }

      const button = node.querySelector('[data-upsell-add]');
      if (button instanceof HTMLElement) {
        button.dataset.variantId = String(available[0]?.id ?? product.variants[0]?.id ?? '');
      }

      list.appendChild(node);
    }

    this.refs.heading?.removeAttribute('hidden');
    this.removeAttribute('hidden');
  }

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-upsell-add]') : null;
    if (!(button instanceof HTMLElement)) return;

    event.preventDefault();

    const item = button.closest('[data-upsell-item]');
    const select = item?.querySelector('[data-upsell-variant]');
    const id = select instanceof HTMLSelectElement && !select.hidden ? select.value : button.dataset.variantId;

    if (!id) return;

    button.setAttribute('disabled', '');
    button.setAttribute('aria-busy', 'true');

    try {
      await cart.addItem({ id: Number(id), quantity: 1 });
    } catch (error) {
      announceUrgent(error?.message || themeString('cartError', ''));
    } finally {
      button.removeAttribute('disabled');
      button.removeAttribute('aria-busy');
    }
  };
}

defineComponent('cart-upsell', CartUpsell);

/* ==========================================================================
   <cart-free-gift>
   ========================================================================== */

/**
 * The claim button for a gift the cart has earned.
 *
 * ## What this promises, and what it does not
 *
 * It adds a product to the cart. It does **not** make that product free — the
 * discount is a Shopify automatic discount the merchant configures, and a theme
 * cannot create one. The gift line shows its real price until checkout applies
 * the discount, and the schema tells the merchant to set that discount up.
 *
 * Claiming is a button, never automatic. A product appearing in a cart without
 * the customer asking reads as a bug or a trick, and it is the kind of thing
 * that produces chargebacks.
 *
 * The threshold is compared against `items_subtotal_price`, not `total_price`.
 * `total_price` already has discounts taken off, so a customer who applied a
 * code would watch the gift they had earned disappear.
 *
 * Markup:
 *
 *   <cart-free-gift data-threshold="5000" data-variant-id="123" data-claimed="false">
 *     <p data-ref="message"></p>
 *     <button data-ref="claim" hidden>…</button>
 *   </cart-free-gift>
 */
export class CartFreeGift extends BaseComponent {
  setup() {
    if (this.refs.claim) {
      this.on(this.refs.claim, 'click', (event) => {
        event.preventDefault();
        this.claim();
      });
    }

    this.on(document.body, EVENTS.CART_UPDATED, (event) => {
      this.render(event.detail?.cart);
    });

    this.render(window.Theme?.cart);
  }

  /**
   * @returns {number} Threshold in cents.
   */
  get threshold() {
    return Number(this.dataset.threshold) || 0;
  }

  /**
   * @returns {string|null}
   */
  get variantId() {
    return this.dataset.variantId || null;
  }

  /**
   * @returns {boolean}
   */
  get claimed() {
    return this.dataset.claimed === 'true';
  }

  /**
   * Add the gift.
   *
   * @returns {Promise<boolean>}
   */
  async claim() {
    if (!this.variantId || this.claimed) return false;

    this.setLoading(true);

    try {
      await cart.addItem({
        id: Number(this.variantId),
        quantity: 1,
        properties: { _free_gift: 'true' }
      });

      announce(themeString('freeGiftClaimed', ''));
      return true;
    } catch (error) {
      announceUrgent(error?.message || themeString('cartError', ''));
      return false;
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * @param {Object} [state] The cart, as returned by Shopify.
   */
  render(state) {
    const subtotal = Number(state?.items_subtotal_price ?? 0);
    const remaining = Math.max(0, this.threshold - subtotal);
    const earned = remaining === 0;

    this.toggleAttribute('data-earned', earned);

    if (this.refs.message instanceof HTMLElement) {
      this.refs.message.textContent = earned
        ? themeString('freeGiftEarned', '')
        : themeString('freeGiftRemaining', '', { amount: formatMoney(remaining) });
    }

    if (this.refs.claim instanceof HTMLElement) {
      this.refs.claim.hidden = !earned || this.claimed;
    }
  }
}

defineComponent('cart-free-gift', CartFreeGift);

export default cart;
