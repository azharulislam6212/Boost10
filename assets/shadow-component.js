/**
 * shadow-component.js — Boost10
 *
 * `ShadowComponent` extends `BaseComponent` with an open shadow root and a
 * per-class constructable stylesheet.
 *
 * Use it sparingly. Shadow DOM buys style isolation and costs the ability for
 * merchants to restyle the element with Custom CSS, which is a setting this
 * theme ships. Reach for it only when merchant CSS bleeding in would be a bug
 * rather than a feature — currently that is `<toast-notification>` alone, which
 * floats above the whole page and must stay legible no matter what a merchant
 * has done to `.notification` or `[role="status"]`.
 *
 * Everything else in Boost10 stays in the light DOM so that:
 *   - `settings.custom_css` can reach it,
 *   - Liquid renders the markup (no JS-built templates to maintain),
 *   - the Section Rendering API can morph it,
 *   - and it degrades to plain HTML when JavaScript fails.
 *
 * @module @theme/shadow-component
 */

import { BaseComponent } from '@theme/component';

/**
 * @type {WeakMap<typeof ShadowComponent, CSSStyleSheet>}
 */
const styleSheetCache = new WeakMap();

/**
 * Base class for shadow-rooted custom elements.
 *
 * Subclass contract:
 *   - Set `static css` to a CSS string. It is parsed once per class and shared
 *     by every instance through `adoptedStyleSheets`.
 *   - Set `static template` to an HTML string for the initial shadow content,
 *     or leave it empty and use a `<slot>`-only structure.
 *   - Inherit design tokens rather than redeclaring colours: custom properties
 *     pierce the shadow boundary, so `var(--color-background)` works inside.
 *   - Events dispatched via `dispatch()` already set `composed: true`, so they
 *     cross the boundary. Do not override that.
 *
 * @extends BaseComponent
 */
export class ShadowComponent extends BaseComponent {
  /**
   * Component styles. Parsed once per class.
   * @type {string}
   */
  static css = '';

  /**
   * Initial shadow markup. Rendered once, on construction.
   * @type {string}
   */
  static template = '';

  /**
   * `'open'` in every case. A closed root would make the element untestable and
   * unreachable from the Theme Editor without buying any real protection.
   * @type {ShadowRootMode}
   */
  static shadowMode = 'open';

  constructor() {
    super();

    const ElementClass = /** @type {typeof ShadowComponent} */ (this.constructor);

    this.attachShadow({ mode: ElementClass.shadowMode });

    if (ElementClass.template) {
      this.shadowRoot.innerHTML = ElementClass.template;
    }

    const sheet = ShadowComponent.#sheetFor(ElementClass);
    if (sheet) this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  /**
   * Builds — and caches — the constructable stylesheet for a class.
   *
   * `adoptedStyleSheets` is shared by reference, so a hundred instances cost one
   * parse and one stylesheet object. A `<style>` tag per instance would cost a
   * hundred of each.
   *
   * @param {typeof ShadowComponent} ElementClass
   * @returns {CSSStyleSheet|null}
   */
  static #sheetFor(ElementClass) {
    if (!ElementClass.css) return null;

    const cached = styleSheetCache.get(ElementClass);
    if (cached) return cached;

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(ElementClass.css);
      styleSheetCache.set(ElementClass, sheet);
      return sheet;
    } catch (error) {
      console.warn(`[Boost10] Could not build a stylesheet for <${ElementClass.name}>.`, error);
      return null;
    }
  }

  /**
   * Queries inside the shadow root.
   *
   * `this.querySelector()` still searches the light DOM, which is almost never
   * what a shadow component wants — hence the explicit helper.
   *
   * @param {string} selector
   * @returns {HTMLElement|null}
   */
  $(selector) {
    return this.shadowRoot?.querySelector(selector) ?? null;
  }

  /**
   * @param {string} selector
   * @returns {HTMLElement[]}
   */
  $$(selector) {
    return Array.from(this.shadowRoot?.querySelectorAll(selector) ?? []);
  }

  /**
   * Elements assigned to a slot, flattened.
   *
   * @param {string} [name] Slot name. Omit for the default slot.
   * @returns {Element[]}
   */
  assignedTo(name) {
    const selector = name ? `slot[name="${name}"]` : 'slot:not([name])';
    const slot = /** @type {HTMLSlotElement|null} */ (this.$(selector));
    return slot ? slot.assignedElements({ flatten: true }) : [];
  }

  /**
   * Replaces the shadow content. Prefer this over touching `innerHTML`, so the
   * `refs` map stays in step with the markup.
   *
   * @param {string} html
   */
  render(html) {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = html;
    this.refreshRefs();
  }
}

export default ShadowComponent;
