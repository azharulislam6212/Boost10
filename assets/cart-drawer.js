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
 * Turn the name a piece of markup uses for a section into the id Shopify
 * actually renders it under.
 *
 * A section placed directly by a template is addressed by its own name —
 * `cart-drawer`. A section placed by a *section group* is not: Shopify renders
 * it as `sections--<group>__cart-drawer`, and that is the only id both the
 * Section Rendering API and `#shopify-section-…` will answer to. Boost10 puts
 * the drawer in `sections/overlay-group.json` and the header in
 * `sections/header-group.json`, so every `data-sections="cart-drawer,header"` in
 * the theme was naming two sections that do not exist under those names. The
 * request came back with nothing to apply, and the drawer kept whatever markup
 * the page had loaded with — which is a cart that shows the previous state, or
 * an empty one, after a successful add.
 *
 * Resolved from the DOM rather than from a Liquid variable so the markup keeps
 * saying which section it means, not where the theme currently happens to put
 * it. A section that moves in or out of a group needs no change here.
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
 * The registry is per page but the elements that fill it are not always: a
 * `<cart-items>` on the cart page registers `main-cart`, and the free shipping
 * bar's own section is only in the drawer. Asking the server to render a section
 * with no wrapper to morph it into is a round trip whose result is thrown away,
 * and `refresh()` re-fetches whatever did not apply — so without this, one
 * absent section would mean one wasted request on every cart mutation, forever.
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
 * Merchant-typed and customer-typed free text, so it is trimmed, de-duplicated
 * and emptied of blanks before it is ever put in a URL.
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
 * Built from `routes.root` rather than written as `/discount/…`, because a
 * market prefixes every path with its locale and a literal would silently stop
 * working on every market but the primary one.
 *
 * `redirect` keeps the response small: the route answers with a redirect and the
 * browser follows it, so without a target it would be the whole homepage
 * downloaded to be thrown away. `/cart.js` is the cheapest destination on the
 * store, and if a Shopify version ignores the parameter the only cost is the
 * bytes — the discount is set either way, and it is the cart read afterwards
 * that this module actually believes.
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
 * Shopify reports a discount in more than one shape and which one it uses
 * depends on what kind of discount it is: an order-level one lands in
 * `cart_level_discount_applications`, a product-level one only ever appears on
 * the lines it touched. Checking a single field is how a working discount gets
 * reported as a failure.
 *
 * Matched on title, which for a code-based discount is the code. Case-insensitive
 * because Shopify upper-cases them and customers do not.
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
   * Counted rather than a plain set, because two elements legitimately want the
   * same section: `<cart-drawer>` asks for `cart-drawer` because it *is* that
   * section, and the `<cart-items>` inside it asks for the same id because it is
   * what a quantity change has to re-render. With a set, the first of them to
   * leave took the id away from the other — so a cart emptied to zero discarded
   * its `<cart-items>`, that teardown deregistered `cart-drawer`, and from then
   * on no mutation re-rendered the drawer at all.
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

    // Past this line the items are in Shopify's cart. Nothing that follows is
    // allowed to make the caller believe otherwise: a drawer that could not be
    // re-rendered is a display failure, and a bundle that threw away the
    // customer's six choices because of one is a far worse outcome than a
    // drawer showing a stale total for a moment.
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
   * Hand a discount code to Shopify, so Shopify prices the cart.
   *
   * ## Why this is two requests and not one
   *
   * There is no cart endpoint that takes a discount code. `/discount/<code>` is
   * the only place a storefront can give Shopify one: it is a redirect that puts
   * the code on the session. Nothing is returned that is worth reading — the
   * point of the call is the side effect.
   *
   * The second request is what makes the drawer true. `/cart/update.js` comes
   * back with the cart *after* the discount, and with the cart sections rendered
   * by Liquid from that same cart — so the line prices, the
   * `cart_level_discount_applications` row and the total in the drawer are
   * Shopify's own numbers, not the theme's. This module still never prices
   * anything; it asks, and then it shows the answer.
   *
   * This replaces storing the code as a cart attribute and calling that
   * "applied at checkout". That was honest about not knowing, and it was also
   * the reason a bundle could show "You save $7.95" beside a cart drawer
   * charging full price: nothing had ever been handed to Shopify to price. The
   * attribute is still written, because `checkoutUrl` appends it and because a
   * code Shopify holds for checkout but does not show on the cart is still worth
   * carrying.
   *
   * ## Several codes
   *
   * Comma separated, in one request, because that is how the route takes them.
   * Whether Shopify keeps all of them is Shopify's decision — discounts combine
   * only when the merchant has marked them combinable, and an order-level code
   * replaces another order-level code. The cart read afterwards is what says
   * which survived, so `applied` is observed rather than assumed.
   *
   * @param {string} code One code, or several separated by commas.
   * @returns {Promise<Object>} The cart, after Shopify has priced it.
   */
  async applyDiscount(code) {
    const codes = parseCodes(code);
    if (codes.length === 0) return this.state;

    // Best effort, and deliberately not fatal. A failure here means the code was
    // not put on the session; the update below still records it for checkout,
    // which is exactly where this module stood before.
    try {
      await fetch(discountUrl(codes), { headers: { Accept: 'application/json' } });
    } catch (error) {
      console.warn(`[Boost10] Could not hand ${codes.join(', ')} to Shopify.`, error);
    }

    const data = await this.updateAttributes({ discount_code: codes.join(',') });
    const applied = codes.filter((entry) => cartHasDiscount(data, entry));

    this._dispatch(EVENTS.CART_DISCOUNT, { code: codes.join(','), codes, applied, cart: data });

    // Only when the cart actually shows it. Announcing an applied discount for a
    // code Shopify ignored is the claim this whole method exists to stop making.
    if (applied.length > 0) announce(themeString('discountApplied', ''));

    return data;
  },

  /**
   * Clear the stored discount code.
   *
   * The attribute goes, so `checkoutUrl` stops carrying the code. A code already
   * on the session does not: Shopify has no storefront route that takes one off,
   * and inventing one that appears to work would be worse than the gap. The cart
   * read below is therefore the honest answer — if Shopify is still applying the
   * discount, the drawer keeps showing it, and `<promo-code>` renders it as an
   * applied discount with no remove button rather than as a pending one.
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

  /* --------------------------------------------------------------- reads */

  /**
   * Re-fetch the cart and re-render the registered sections.
   *
   * @param {Object} [options]
   * @param {Object} [options.sections] Already-rendered sections to apply instead of fetching.
   * @returns {Promise<Object>}
   */
  async refresh({ sections } = {}) {
    const wanted = this.sections;

    // What the mutation already rendered for us, if anything. `_applySections`
    // reports what it could actually place, which is not the same as what was
    // asked for: a section the current template does not have is skipped, and so
    // — silently, until now — is one whose id the server did not recognise.
    const applied = sections ? this._applySections(sections) : [];

    // Anything still stale is fetched. This is what removes the race the drawer
    // used to lose: whatever the add response did or did not contain, every
    // section the cart owns is current by the time this resolves, and the drawer
    // is not revealed until then.
    const missing = wanted.filter((id) => !applied.includes(id) && isSectionOnPage(id));

    // Best effort, and it has to be. Re-rendering markup and re-reading the cart
    // are two different jobs, and letting the first stop the second is how the
    // drawer ends up showing the right lines beside a free shipping bar that
    // still thinks the cart is empty: `cart.state` is what every indicator in
    // the theme reads — the bar, the badges, the gift threshold — and it is not
    // allowed to go stale because one section failed to render.
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
