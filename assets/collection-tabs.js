/**
 * collection-tabs.js — Boost10
 *
 * The product bundle's category strip.
 *
 * ## It does not build the strip any more, and that is the point
 *
 * It used to. The Tabs block rendered an empty `role="tablist"`, each Category
 * published its pill beside its panel as inert markup, and this module copied
 * the pills into the strip — because `block.blocks` does not exist in Liquid, a
 * block cannot read its children's settings, and so the Tabs block could not
 * draw its children's buttons.
 *
 * That constraint is real. The conclusion drawn from it was not. Every route
 * into the strip ran through a copy of the pill's markup — cloning child nodes,
 * re-parsing `innerHTML`, moving nodes — and a copy that comes back short has
 * nothing in the DOM to say so. The label survived every version, because this
 * module could rebuild it from `data-label` on its own. The icon has no second
 * source and never once appeared. One bug, three implementations.
 *
 * So each Category draws its own pill now, in Liquid, where it stands, with the
 * theme's `<svg>` inside it. `assets/base.css` lays those pills out as a strip
 * without moving them — `display: contents` on the Category root and `order` on
 * its children — and a radio group with `:checked` decides which panel is open.
 * The strip is complete, correct and interactive with this file absent.
 *
 * What is left here are the two things CSS cannot do, and neither of them can
 * fail in a way the customer sees:
 *
 *   - re-measure a carousel in a panel that has just been revealed
 *   - follow the Theme Editor's block selection
 *
 * ## Why the keyboard handling went
 *
 * The ARIA tab pattern needs a roving tabindex, which is script. A radio group
 * gives the same interaction natively — one tab stop into the group, arrow keys
 * between the options, each announced with its position — so there is nothing
 * to hand-roll and nothing to keep in step with the markup.
 *
 * @element collection-tabs
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { isDesignMode } from '@theme/utilities';

export class CollectionTabs extends BaseComponent {
  setup() {
    // `change` fires on the radio that became checked, and it bubbles. The
    // panel it controls is the one CSS has just stopped hiding.
    this.on(this, 'change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
      remeasure(input.closest('[data-bundle-category]'));
    });

    if (isDesignMode()) {
      // The editor selects blocks the customer cannot see. Every panel but the
      // open one is `display: none`, so clicking a Category in the sidebar
      // scrolled to nothing and read as a broken block. Open its category
      // instead, and let the editor's own scroll land on something visible.
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
 * A carousel mounted inside a `display: none` panel measured a container with
 * no width and no height, so every slide it sized came out at zero. Swiper's
 * own `resizeObserver` does fire when the panel is shown, but not before the
 * frame in which the customer first sees it — so the first paint after a pill
 * is pressed is a collapsed track that then snaps to its real size.
 *
 * Asking for the update here makes the measurement part of the same frame as
 * the reveal. It matters twice over for this picker, whose carousels are
 * vertical: a vertical carousel divides its container's *height* between its
 * slides, so a container with no height is a panel with nothing visible in it
 * at all rather than a track that is merely the wrong width.
 *
 * `element.swiper` is Swiper's own handle, set on the element it mounts. A
 * carousel whose module has not landed yet does not have one and does not need
 * one — by the time it mounts, the panel is visible.
 *
 * @param {Element | null} scope
 */
function remeasure(scope) {
  if (!scope) return;
  for (const carousel of scope.querySelectorAll('swiper-carousel')) {
    /** @type {any} */ (carousel).swiper?.update();
  }
}

defineComponent('collection-tabs', CollectionTabs);

export default { CollectionTabs };
