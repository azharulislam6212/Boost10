/**
 * The cart. Every mutation in the theme goes through this module, and nothing
 * else is allowed to POST to a cart endpoint.
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
 * Turn the name a piece of markup uses for a section into the id Shopify
 * actually renders it under.
 *
 * @param {string} name
 * @returns {string} The rendered id, or `name` unchanged when nothing matches.
 */
function resolveSectionId(name) {
  const id = String(name || '').trim();
  if (!id) return '';

  if (document.getElementById(`shopify-section-${id}`)) return id;

  const grouped = document.querySelector(`[id^="shopify-section-"][id$="__${id}"]`);
  return grouped ? grouped.id.slice('shopify-section-'.length) : id;
}

/**
 * Whether a section has somewhere to land on the page as it stands.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isSectionOnPage(id) {
  return Boolean(
    document.getElementById(`shopify-section-${id}`) || document.querySelector(`[data-section-id="${id}"]`)
  );
}

/**
 * Split a code field into individual codes.
 *
 * @param {string} value
 * @returns {string[]}
 */
function parseCodes(value) {
  return [
    ...new Set(
      String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ];
}

/**
 * Shopify's discount route for a set of codes.
 *
 * @param {string[]} codes
 * @returns {string}
 */
function discountUrl(codes) {
  const root = String(globalThis.Theme?.routes?.root || '/').replace(/\/+$/, '');
  const path = `${root}/discount/${codes.map(encodeURIComponent).join(',')}`;

  return `${path}?redirect=${encodeURIComponent(getRoute('cart', { json: true }))}`;
}

/**
 * Whether a cart is actually being discounted by a given code.
 *
 * @param {Object} state A cart, as returned by Shopify.
 * @param {string} code
 * @returns {boolean}
 */
export function cartHasDiscount(state, code) {
  const wanted = code.toUpperCase();

  const titles = [
    ...(state?.discount_codes || []).map((entry) => entry?.code),
    ...(state?.cart_level_discount_applications || []).map((entry) => entry?.title),
    ...(state?.discount_applications || []).map((entry) => entry?.title),
    ...(state?.items || []).flatMap((item) => [
      ...(item?.discounts || []).map((entry) => entry?.title),
      ...(item?.line_level_discount_allocations || []).map(
        (entry) => entry?.discount_application?.title
      )
    ])
  ];

  return titles.some((title) => String(title || '').toUpperCase() === wanted);
}

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
   * Section ids that should be re-rendered with every mutation, against the
   * number of elements currently asking for each. Registered by the elements
   * that own them, so a page that has no free shipping bar never asks the
   * server to render one.
   *
   * @type {Map<string, number>}
   */
  _sections: new Map(),

  /**
   * @param {string} sectionId
   */
  registerSection(sectionId) {
    const id = resolveSectionId(sectionId);
    if (!id) return;

    this._sections.set(id, (this._sections.get(id) ?? 0) + 1);
  },

  /**
   * @param {string} sectionId
   */
  unregisterSection(sectionId) {
    const id = resolveSectionId(sectionId);
    const count = this._sections.get(id);
    if (!count) return;

    if (count > 1) this._sections.set(id, count - 1);
    else this._sections.delete(id);
  },

  /**
   * @returns {string[]}
   */
  get sections() {
    return Array.from(this._sections.keys());
  },

  /**
   * @returns {Element} Where cart events are dispatched from: the drawer when
   *   one exists, otherwise the document body, so listeners work either way.
   */
  get host() {
    return document.querySelector('cart-drawer') || document.body;
  },

  /* ------------------------------------------------------------ mutations ---- */

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

    try {
      await this.refresh({ sections: data.sections });
    } catch (error) {
      console.error('[Boost10] The cart was updated but the drawer could not be refreshed.', error);
      this._dispatch(EVENTS.CART_ERROR, cartErrorDetail(themeString('cartError', ''), { code: 'refresh' }));
    }

    const added = data.items?.[0] || data;
    this._dispatch(EVENTS.CART_ITEM_ADDED, cartUpdatedDetail(this.state, 'add', added));
    announce(themeString('itemAdded', ''));

    if (open) this._reveal(added);

    return data;
  },

  /**
   * Change a line's quantity.
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

    if (previousCount > 0 && data.item_count === 0) await this.refresh();

    return data;
  },

  /**
   * Swap a line for a different variant, keeping its quantity and properties.
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
   * Hand a discount code to Shopify, so Shopify prices the cart.
   *
   * @param {string} code One code, or several separated by commas.
   * @returns {Promise<Object>} The cart, after Shopify has priced it.
   */
  async applyDiscount(code) {
    const codes = parseCodes(code);
    if (codes.length === 0) return this.state;

    try {
      await fetch(discountUrl(codes), { headers: { Accept: 'application/json' } });
    } catch (error) {
      console.warn(`[Boost10] Could not hand ${codes.join(', ')} to Shopify.`, error);
    }

    const data = await this.updateAttributes({ discount_code: codes.join(',') });
    const applied = codes.filter((entry) => cartHasDiscount(data, entry));

    this._dispatch(EVENTS.CART_DISCOUNT, { code: codes.join(','), codes, applied, cart: data });

    if (applied.length > 0) announce(themeString('discountApplied', ''));

    return data;
  },

  /**
   * Clear the stored discount code.
   *
   * @returns {Promise<Object>}
   */
  async removeDiscount() {
    const data = await this.updateAttributes({ discount_code: '' });
    this._dispatch(EVENTS.CART_DISCOUNT, { code: null, codes: [], applied: [], cart: data });
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

  /* --------------------------------------------------------------- reads ---- */

  /**
   * Re-fetch the cart and re-render the registered sections.
   *
   * @param {Object} [options]
   * @param {Object} [options.sections] Already-rendered sections to apply instead of fetching.
   * @returns {Promise<Object>}
   */
  async refresh({ sections } = {}) {
    const wanted = this.sections;

    const applied = sections ? this._applySections(sections) : [];

    const missing = wanted.filter((id) => !applied.includes(id) && isSectionOnPage(id));

    if (missing.length > 0) {
      try {
        const { fetchSections } = await import('@theme/section-renderer');
        this._applySections(await fetchSections(missing, { cache: false }));
      } catch (error) {
        console.warn(`[Boost10] Could not re-render ${missing.join(', ')}.`, error);
      }
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

  /* ----------------------------------------------------------- internals ---- */

  /**
   * @param {string} url
   * @param {Object} body
   * @returns {Promise<Object>}
   * @private
   */
  async _post(url, body) {
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
   * @returns {string[]} The ids that were placed on the page.
   * @private
   */
  _applySections(sections) {
    if (!sections) return [];
    return applySections(sections);
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

/** The cart drawer. */
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

    this.on(document, 'submit', this.#onQuickAdd);

    this.on(document, EVENTS.CART_ERROR, this.#onCartError);
  }

  teardown() {
    for (const id of (this.dataset.sections || '').split(',')) {
      cart.unregisterSection(id.trim());
    }
    super.teardown();
  }

  /* --------------------------------------------------------- public API -- ---- */

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

  /* ---------------------------------------------------------- internals -- ---- */

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
    } catch {} finally {
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

/** Cross-sells inside the cart drawer. */
export class CartUpsell extends BaseComponent {
  static requiredRefs = ['list'];

  /** @type {AbortController|null} */
  #request = null;

  /** The product the current list was fetched for. */
  #loadedFor = null;

  setup() {
    this.on(this, 'click', this.#onClick);

    this.on(document.body, EVENTS.OVERLAY_OPEN, (event) => {
      if (event.detail?.type !== 'cart') return;
      this.load();
    });

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
        this.remove();
        return false;
      }

      this.#render(products);
      this.#loadedFor = id;
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      console.warn('[Boost10] Cart recommendations could not be loaded.', error);
      this.remove();
      return false;
    } finally {
      this.#request = null;
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

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

/** The claim button for a gift the cart has earned. */
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
