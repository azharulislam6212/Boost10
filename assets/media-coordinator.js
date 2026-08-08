/**
 * media-coordinator.js — Boost10
 *
 * `<media-coordinator>` — keeps the product gallery in step with the selected
 * variant.
 *
 * It exists as a separate element rather than as logic inside either
 * `<variant-picker>` or `<media-gallery>` because neither should own the other.
 * The picker owns which variant is selected; the gallery owns which media is
 * showing. This is the wire between them, and it is the only thing that knows
 * both exist.
 *
 * Two paths, both needed:
 *
 *   Broadcast — listen for `variant:change` from the picker, which is how a
 *               selection made after load reaches here.
 *   Direct    — read `picker.currentVariant` on connect, which is how the
 *               correct media is shown when the page loads on a variant URL.
 *
 * The listener alone is not enough: an element connected after the event fired
 * never hears it, and a customer arriving on `?variant=123` would see the first
 * image rather than that variant's.
 *
 * Markup:
 *
 *   <div data-product-root>
 *     <variant-picker>…</variant-picker>
 *     <media-coordinator
 *       data-gallery="ProductGallery"
 *       data-filter-images="true"
 *       data-filter-strict="false"></media-coordinator>
 *     <media-gallery id="ProductGallery">…</media-gallery>
 *   </div>
 *
 * Image filtering is driven by alt text, in the format the merchant already
 * writes for SEO:
 *
 *     Great T-Shirt - Front|flavour:Mango
 *
 * Everything before the pipe is the alt text a screen reader hears. Everything
 * after it is one or more `option:value` pairs, comma separated, which this
 * element reads and nobody else sees. Alt text is used rather than a metafield
 * because merchants can edit it in the product admin without an app, and because
 * it survives an image being re-uploaded.
 *
 * @module @theme/media-coordinator
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';

export class MediaCoordinator extends BaseComponent {
  setup() {
    const picker = this.#picker();

    // Broadcast path: selections made after load.
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => {
      this.syncToVariant(event.detail?.variant);
    });

    // Direct path: the state that already existed when this connected.
    if (picker?.currentVariant) {
      this.syncToVariant(picker.currentVariant, { animate: false });
    }
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {HTMLElement} The nearest product container, or the document.
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @returns {MediaGallery|null}
   */
  get gallery() {
    const id = this.dataset.gallery;
    const byId = id ? document.getElementById(id) : null;
    if (byId) return byId.closest('media-gallery') || byId;

    return this.root.querySelector?.('media-gallery') || null;
  }

  /**
   * Show the media associated with a variant.
   *
   * @param {Object|null} variant
   * @param {Object} [options]
   * @param {boolean} [options.animate=true]
   * @returns {boolean} True when a media item was found and shown.
   */
  syncToVariant(variant, { animate = true } = {}) {
    if (!variant) return false;

    const gallery = this.gallery;
    if (!gallery?.goToMedia) return false;

    if (this.filterImages) this.filterToVariant(variant, gallery);

    const mediaId = variant.featured_media?.id;
    if (!mediaId) {
      // No image assigned to this variant. With filtering on, the first still
      // visible item is the right thing to show; without it, leave the customer
      // where they are rather than yanking the gallery back to the start.
      if (!this.filterImages) return false;

      const first = (gallery.media || []).find((item) => !item.hasAttribute('hidden'));
      return first ? gallery.goToMedia(first.dataset.mediaId, { animate }) : false;
    }

    return gallery.goToMedia(mediaId, { animate });
  }

  /**
   * @returns {boolean} Whether image filtering is enabled.
   */
  get filterImages() {
    return this.dataset.filterImages === 'true';
  }

  /**
   * @returns {boolean} Whether images with no option in their alt text are also
   *   hidden. Off by default, because that is the setting that empties a gallery
   *   on a store that has only labelled half its photography.
   */
  get filterStrict() {
    return this.dataset.filterStrict === 'true';
  }

  /**
   * Show only the media that belongs to the selected variant.
   *
   * Two sources, checked in order:
   *
   *   1. `data-options` on the media item, rendered by Liquid from the alt text
   *      as a JSON map of lowercase option name to lowercase value.
   *   2. `data-variant-ids`, for stores using Shopify's own media grouping.
   *
   * An item with neither is shared photography — a size chart, a lifestyle shot,
   * a packaging photo — and stays visible unless strict mode is on.
   *
   * @param {Object} variant
   * @param {HTMLElement} gallery
   */
  filterToVariant(variant, gallery) {
    const selected = this.#optionMap(variant);
    const id = String(variant.id);
    let visible = 0;

    for (const item of gallery.media || []) {
      const matches = this.#itemMatches(item, selected, id);
      item.toggleAttribute('hidden', !matches);
      if (matches) visible += 1;
    }

    // A filter that hides everything is worse than no filter. Incomplete or
    // mistyped alt text is common, and an empty gallery reads as a broken page.
    if (visible === 0) {
      for (const item of gallery.media || []) item.removeAttribute('hidden');
    }

    gallery.querySelector('media-thumbnails')?.setActive?.(variant.featured_media?.id ?? null);
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @returns {HTMLElement|null}
   * @private
   */
  #picker() {
    return this.root.querySelector?.('variant-picker') || null;
  }

  /**
   * Build a lowercase option name to value map for a variant.
   *
   * `options_with_values` is rendered into the variant JSON by Liquid, so the
   * option *names* are available here. Reading `option1`, `option2` and
   * `option3` positionally would break the moment a merchant reorders options.
   *
   * @param {Object} variant
   * @returns {Map<string, string>}
   * @private
   */
  #optionMap(variant) {
    const map = new Map();

    if (Array.isArray(variant.options_with_values)) {
      for (const option of variant.options_with_values) {
        if (!option?.name) continue;
        map.set(String(option.name).trim().toLowerCase(), String(option.value).trim().toLowerCase());
      }
      return map;
    }

    // Fall back to the picker, which always knows the option names.
    const names = this.#picker()?.optionNames || [];
    const values = variant.options || [];

    for (const [index, name] of names.entries()) {
      if (values[index] === undefined) continue;
      map.set(String(name).trim().toLowerCase(), String(values[index]).trim().toLowerCase());
    }

    return map;
  }

  /**
   * @param {HTMLElement} item
   * @param {Map<string, string>} selected
   * @param {string} variantId
   * @returns {boolean}
   * @private
   */
  #itemMatches(item, selected, variantId) {
    const tagged = item.dataset.variantIds;
    if (tagged) return tagged.split(',').includes(variantId);

    const raw = item.dataset.options;
    if (!raw) return !this.filterStrict;

    let pairs;
    try {
      pairs = JSON.parse(raw);
    } catch {
      // Malformed alt text must not hide the image.
      return !this.filterStrict;
    }

    const entries = Object.entries(pairs || {});
    if (entries.length === 0) return !this.filterStrict;

    // Every option named on the image has to match. An image labelled
    // `flavour:Mango,size:Large` belongs to that combination, not to either.
    return entries.every(([name, value]) => {
      const current = selected.get(String(name).trim().toLowerCase());
      if (current === undefined) return true;
      return current === String(value).trim().toLowerCase();
    });
  }

  /**
   * Show only media tagged for this variant, plus any untagged media.
   *
   * Media is tagged by Liquid with `data-variant-ids`, because the association
   * comes from Shopify's media grouping and cannot be inferred here. Untagged
   * media is always shown: it is the product's shared photography, and hiding it
   * would empty the gallery for most stores.
   *
   * @param {Object} variant
   * @param {HTMLElement} gallery
   * @private
   */
  #filterToVariant(variant, gallery) {
    const id = String(variant.id);
    let visible = 0;

    for (const item of gallery.media || []) {
      const tagged = item.dataset.variantIds;
      const matches = !tagged || tagged.split(',').includes(id);

      item.toggleAttribute('hidden', !matches);
      if (matches) visible += 1;
    }

    // A filter that hides everything is worse than no filter. If the tagging is
    // wrong or incomplete, show it all rather than an empty stage.
    if (visible === 0) {
      for (const item of gallery.media || []) item.removeAttribute('hidden');
    }

    gallery.querySelector('media-thumbnails')?.setActive?.(variant.featured_media?.id ?? null);
  }
}

defineComponent('media-coordinator', MediaCoordinator);

export default MediaCoordinator;
