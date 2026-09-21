/**
 * The product bundle's category strip.
 *
 * @element collection-tabs
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { isDesignMode } from '@theme/utilities';

export class CollectionTabs extends BaseComponent {
  setup() {
    this.on(this, 'change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
      remeasure(input.closest('[data-bundle-category]'));
    });

    if (isDesignMode()) {
      this.on(document, 'shopify:block:select', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const category = target.closest('[data-bundle-category]') ?? target;
        const input = category.querySelector?.('input[type="radio"]');
        if (!(input instanceof HTMLInputElement) || input.checked) return;

        input.checked = true;
        remeasure(category);
      });
    }
  }
}

/**
 * Re-measures anything inside a category whose panel has just been revealed.
 *
 * @param {Element | null} scope
 */
function remeasure(scope) {
  if (!scope) return;
  for (const carousel of scope.querySelectorAll('carousel-slider')) {
    /** @type {any} */ (carousel).refresh?.();
  }
}

defineComponent('collection-tabs', CollectionTabs);

export default { CollectionTabs };
