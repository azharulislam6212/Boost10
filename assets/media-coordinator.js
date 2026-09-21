/**
 * `<media-coordinator>` — keeps the product gallery in step with the selected
 * variant.
 *
 * @module @theme/media-coordinator
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';

export class MediaCoordinator extends BaseComponent {
  setup() {
    const picker = this.#picker();

    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => {
      this.syncToVariant(event.detail?.variant);
    });

    if (picker?.currentVariant) {
      this.syncToVariant(picker.currentVariant, { animate: false });
    }
  }

  /* --------------------------------------------------------- public API -- ---- */

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

    if (visible === 0) {
      for (const item of gallery.media || []) item.removeAttribute('hidden');
    }

    gallery.querySelector('media-thumbnails')?.setActive?.(variant.featured_media?.id ?? null);
  }

  /* ---------------------------------------------------------- internals -- ---- */

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
      return !this.filterStrict;
    }

    const entries = Object.entries(pairs || {});
    if (entries.length === 0) return !this.filterStrict;

    return entries.every(([name, value]) => {
      const current = selected.get(String(name).trim().toLowerCase());
      if (current === undefined) return true;
      return current === String(value).trim().toLowerCase();
    });
  }

  /**
   * Show only media tagged for this variant, plus any untagged media.
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

    if (visible === 0) {
      for (const item of gallery.media || []) item.removeAttribute('hidden');
    }

    gallery.querySelector('media-thumbnails')?.setActive?.(variant.featured_media?.id ?? null);
  }
}

defineComponent('media-coordinator', MediaCoordinator);

export default MediaCoordinator;
