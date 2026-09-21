/**
 * `ShadowComponent` extends `BaseComponent` with an open shadow root and a
 * per-class constructable stylesheet.
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
 * @extends BaseComponent
 */
export class ShadowComponent extends BaseComponent {
  /**
   * Component styles. Parsed once per class.
   *
   * @type {string}
   */
  static css = '';

  /**
   * Initial shadow markup. Rendered once, on construction.
   *
   * @type {string}
   */
  static template = '';

  /**
   * `'open'` in every case. A closed root would make the element untestable and
   * unreachable from the Theme Editor without buying any real protection.
   *
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
