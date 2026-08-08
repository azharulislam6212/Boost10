/**
 * product-recommendations.js — Boost10
 *
 * `<product-recommendations>` and `<complementary-products>`.
 *
 * Both fetch server-rendered markup from Shopify's recommendations endpoint,
 * which returns product cards built by the same snippet the collection grid
 * uses. Nothing about a product is reconstructed here, so prices, badges,
 * swatches and translations are correct by construction.
 *
 * Three decisions worth keeping:
 *
 *   **Nothing is fetched until the section is near the viewport.**
 *   Recommendations sit below the fold on every product page, and a request
 *   fired at page load competes with the images the customer is actually
 *   looking at.
 *
 *   **An empty response removes the section.** Shopify returns no
 *   recommendations until it has enough order data, which is the state every new
 *   store is in. "You may also like" above an empty row looks broken.
 *
 *   **A failure removes it too, silently.** A missing recommendations row is not
 *   worth an error message; the customer came for the product above it.
 *
 * Markup:
 *
 *   <product-recommendations
 *     data-product-id="123"
 *     data-section-id="product-recommendations"
 *     data-limit="4">
 *     <div data-ref="content" data-recommendations-content></div>
 *   </product-recommendations>
 *
 * @module @theme/product-recommendations
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { getRoute, whenIdle, themeString } from '@theme/utilities';
import { morph } from '@theme/morph';

/**
 * Shared behaviour. Not registered: it has no tag of its own.
 */
class RecommendationsBase extends BaseComponent {
  /** @type {AbortController|null} */
  #request = null;

  /** @type {IntersectionObserver|null} */
  #observer = null;

  /** The product already rendered, so a re-connect does not refetch. */
  #loadedFor = null;

  setup() {
    if (!this.dataset.productId) {
      this.remove();
      return;
    }

    if (this.#loadedFor === this.dataset.productId) return;

    if (!('IntersectionObserver' in window)) {
      whenIdle(() => this.load());
      return;
    }

    this.#observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        this.#observer?.disconnect();
        this.#observer = null;
        this.load();
      },
      { rootMargin: '400px' }
    );

    this.#observer.observe(this);
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {'related'|'complementary'}
   */
  get intent() {
    return 'related';
  }

  /**
   * @returns {number}
   */
  get limit() {
    const value = Number(this.dataset.limit);
    // Shopify caps the endpoint at ten, and asking for more returns an error
    // rather than a truncated list.
    return Number.isFinite(value) && value > 0 ? Math.min(value, 10) : 4;
  }

  /**
   * Load recommendations for a different product.
   *
   * Used by the quick view drawer, which reuses one instance across products.
   *
   * @param {string|number} productId
   * @returns {Promise<boolean>}
   */
  update(productId) {
    this.dataset.productId = String(productId);
    this.#loadedFor = null;
    this.removeAttribute('data-loaded');
    return this.load();
  }

  /**
   * Fetch and render.
   *
   * @returns {Promise<boolean>} True when products were rendered.
   */
  async load() {
    const productId = this.dataset.productId;
    if (!productId) return false;

    this.#request?.abort();
    this.#request = new AbortController();

    const params = new URLSearchParams({
      product_id: productId,
      limit: String(this.limit),
      intent: this.intent
    });

    // An empty `section_id` makes Shopify return the whole page rather than the
    // section, which then morphs a full document into the row.
    if (this.dataset.sectionId) params.set('section_id', this.dataset.sectionId);

    this.setLoading(true);

    try {
      const response = await fetch(`${getRoute('productRecommendations')}?${params}`, {
        signal: this.#request.signal,
        headers: { Accept: 'text/html' }
      });

      if (!response.ok) throw new Error(`Request failed with ${response.status}`);

      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const next =
        parsed.querySelector('[data-recommendations-content]') ||
        parsed.querySelector(`${this.tagName.toLowerCase()} [data-ref="content"]`);

      // No products, or a section that rendered nothing: remove rather than
      // leave a heading above an empty row.
      if (!next || next.querySelectorAll('[data-product-id]').length === 0) {
        this.remove();
        return false;
      }

      const target = this.refs.content instanceof HTMLElement ? this.refs.content : this;
      morph(target, next, { childrenOnly: true });

      this.#loadedFor = productId;
      this.setAttribute('data-loaded', '');
      this.removeAttribute('hidden');

      // The heading is rendered by Liquid and hidden until there is something
      // to head, so it never flashes above an empty row.
      this.querySelector('[data-recommendations-heading]')?.removeAttribute('hidden');

      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      console.warn('[Boost10] Recommendations could not be loaded.', error);
      this.remove();
      return false;
    } finally {
      this.setLoading(false);
      this.#request = null;
    }
  }
}

/**
 * Products related to the one being viewed.
 */
export class ProductRecommendations extends RecommendationsBase {}

defineComponent('product-recommendations', ProductRecommendations);

/**
 * Complementary products, curated in Shopify's Search & Discovery app.
 *
 * Identical mechanics, separate element only because the intent differs — which
 * changes what Shopify returns and what the heading should say. Merchants curate
 * these by hand, so an empty result here is a deliberate "nothing pairs with
 * this" rather than missing data, and removing the section is still right.
 */
export class ComplementaryProducts extends RecommendationsBase {
  get intent() {
    return 'complementary';
  }

  /**
   * @returns {number}
   */
  get limit() {
    const value = Number(this.dataset.limit);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 10) : 3;
  }
}

defineComponent('complementary-products', ComplementaryProducts);

export default { ProductRecommendations, ComplementaryProducts };
