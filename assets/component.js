/**
 * `BaseComponent` is the class every interactive element in the theme extends.
 * It provides four things and nothing else:
 *
 * @module @theme/component
 */

import { EDITOR_EVENTS } from '@theme/events';

/**
 * Registers a custom element exactly once.
 *
 * @param {string} tagName Must contain a hyphen and carry no vendor prefix.
 * @param {CustomElementConstructor} ElementClass
 * @returns {CustomElementConstructor} The registered class, existing or new.
 *
 * @example
 * export class CartDrawer extends BaseComponent {}
 * defineComponent('cart-drawer', CartDrawer);
 */
export function defineComponent(tagName, ElementClass) {
  const existing = customElements.get(tagName);
  if (existing) return existing;

  customElements.define(tagName, ElementClass);
  return ElementClass;
}

/**
 * Base class for every autonomous custom element in Boost10.
 *
 * @extends HTMLElement
 */
export class BaseComponent extends HTMLElement {
  /**
   * Attributes that trigger `attributeChanged()`.
   *
   * @type {string[]}
   */
  static observedAttributes = [];

  /**
   * `data-ref` names that must be present. If any is missing the component
   * logs once and disables itself rather than throwing on every interaction.
   *
   * @type {string[]}
   */
  static requiredRefs = [];

  /**
   * Whether this element stops a `[data-ref]` inside it from belonging to a
   * component further up. True for anything that reads `this.refs`, which is
   * almost everything — a `<product-form>` must not claim the refs of a
   * `<quantity-selector>` nested in it.
   *
   * @type {boolean}
   */
  static refBoundary = true;

  /** @type {AbortController|null} */
  #controller = null;

  /** @type {boolean} */
  #connected = false;

  /**
   * Resolved `[data-ref]` descendants.
   *
   * @type {Record<string, HTMLElement|HTMLElement[]>}
   */
  refs = {};

  /* ---------------------------------------------------------- lifecycle -- ---- */

  connectedCallback() {
    if (this.#connected) return;
    this.#connected = true;

    this.#controller = new AbortController();
    this.refs = this.#collectRefs();

    if (!this.#validateRefs()) return;

    this.#bindEditorHooks();

    try {
      this.setup?.();
    } catch (error) {
      console.error(`[Boost10] ${this.tagName.toLowerCase()} failed to initialise.`, error);
    }
  }

  disconnectedCallback() {
    this.#connected = false;

    this.#controller?.abort();
    this.#controller = null;

    try {
      this.teardown?.();
    } catch (error) {
      console.error(`[Boost10] ${this.tagName.toLowerCase()} failed to tear down.`, error);
    }
  }

  /**
   * @param {string} name
   * @param {string|null} oldValue
   * @param {string|null} newValue
   */
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    this.attributeChanged?.(name, oldValue, newValue);
  }

  /* --------------------------------------------------------- listeners -- ---- */

  /**
   * The `AbortSignal` for this connection. Pass it to `fetch()` so in-flight
   * requests are cancelled when the element leaves the DOM.
   *
   * @returns {AbortSignal|undefined}
   */
  get signal() {
    return this.#controller?.signal;
  }

  /**
   * Adds a listener scoped to this element's lifetime.
   *
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {AddEventListenerOptions} [options]
   */
  on(target, type, handler, options = {}) {
    if (!this.#controller) return;
    target.addEventListener(type, handler, { ...options, signal: this.#controller.signal });
  }

  /**
   * Convenience for delegating a listener on this element to descendants.
   *
   * @param {string} type
   * @param {string} selector
   * @param {(event: Event, target: HTMLElement) => void} handler
   * @param {AddEventListenerOptions} [options]
   */
  delegate(type, selector, handler, options = {}) {
    this.on(
      this,
      type,
      (event) => {
        const match = /** @type {HTMLElement|null} */ (event.target)?.closest?.(selector);
        if (match && this.contains(match)) handler(event, match);
      },
      options
    );
  }

  /* ------------------------------------------------------------ events -- ---- */

  /**
   * Dispatches a native `CustomEvent` from this element.
   *
   * @param {string} type Use a constant from `@theme/events`, never a literal.
   * @param {Object} [detail={}] Plain, serialisable payload.
   * @param {Object} [options]
   * @param {boolean} [options.bubbles=true]
   * @param {boolean} [options.composed=true]
   * @param {boolean} [options.cancelable=false]
   * @returns {CustomEvent} The dispatched event, so callers can read `defaultPrevented`.
   */
  dispatch(type, detail = {}, { bubbles = true, composed = true, cancelable = false } = {}) {
    const event = new CustomEvent(type, { detail, bubbles, composed, cancelable });
    this.dispatchEvent(event);
    return event;
  }

  /* --------------------------------------------------------------- DOM -- ---- */

  /**
   * Replaces this element's contents from server-rendered HTML while keeping
   * focus, scroll position, open dialogs and in-progress input intact.
   *
   * @param {string} html Full document HTML, usually a Section Rendering API response.
   * @param {string} [selector] Defaults to this element's own tag name.
   * @returns {Promise<boolean>} Whether a matching node was found and applied.
   */
  async updateFrom(html, selector = this.tagName.toLowerCase()) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const next = parsed.querySelector(selector);

    if (!next) {
      console.warn(`[Boost10] updateFrom found no "${selector}" in the response.`);
      return false;
    }

    const { morph } = await import('@theme/morph');
    morph(this, next);
    this.refreshRefs();

    return true;
  }

  /**
   * Re-resolves the `data-ref` map. Call this after any markup replacement that
   * did not go through `updateFrom()`.
   */
  refreshRefs() {
    this.refs = this.#collectRefs();
  }

  /**
   * Toggles a busy state that is both visual and announced.
   *
   * @param {boolean} isLoading
   */
  setLoading(isLoading) {
    this.toggleAttribute('data-loading', isLoading);
    this.setAttribute('aria-busy', String(isLoading));
  }

  /**
   * The id of the Shopify section this element belongs to, if any.
   *
   * @returns {string|null}
   */
  get sectionId() {
    return this.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;
  }

  /* --------------------------------------------------------------- refs -- ---- */

  /**
   * A `[data-ref]` node belongs to this component only if no other ref-reading
   * custom element sits between it and us. Without this check, a
   * `<product-form>` would happily claim the refs of a nested
   * `<quantity-selector>`.
   *
   * @param {Element} node
   * @returns {boolean}
   */
  #ownsRef(node) {
    let parent = node.parentElement;

    while (parent && parent !== this) {
      const tag = parent.tagName.toLowerCase();

      if (tag.includes('-')) {
        const constructor = /** @type {typeof BaseComponent|undefined} */ (customElements.get(tag));
        if (constructor && constructor.refBoundary !== false) return false;
      }

      parent = parent.parentElement;
    }

    return true;
  }

  /**
   * @returns {Record<string, HTMLElement|HTMLElement[]>}
   */
  #collectRefs() {
    /** @type {Record<string, HTMLElement|HTMLElement[]>} */
    const refs = {};
    const root = this.shadowRoot ?? this;

    for (const node of root.querySelectorAll('[data-ref]')) {
      if (!this.shadowRoot && !this.#ownsRef(node)) continue;

      const attribute = node.getAttribute('data-ref');
      if (!attribute) continue;

      for (const name of attribute.split(/\s+/).filter(Boolean)) {
        const existing = refs[name];

        if (existing === undefined) {
          refs[name] = /** @type {HTMLElement} */ (node);
        } else if (Array.isArray(existing)) {
          existing.push(/** @type {HTMLElement} */ (node));
        } else {
          refs[name] = [existing, /** @type {HTMLElement} */ (node)];
        }
      }
    }

    return refs;
  }

  /**
   * @returns {boolean}
   */
  #validateRefs() {
    const required = /** @type {typeof BaseComponent} */ (this.constructor).requiredRefs;
    if (!required?.length) return true;

    const missing = required.filter((name) => !this.refs[name]);

    if (missing.length > 0) {
      console.warn(
        `[Boost10] <${this.tagName.toLowerCase()}> is missing required refs: ${missing.join(', ')}. Component disabled.`
      );
      return false;
    }

    return true;
  }

  /* ------------------------------------------------------ theme editor -- ---- */

  /**
   * Binds Shopify Editor listeners only for the hooks a subclass actually
   * overrides. Attaching six document-level listeners per component instance
   * would be measurable on a page with fifty product cards.
   */
  #bindEditorHooks() {
    const proto = BaseComponent.prototype;

    /** @type {Array<[string, string]>} */
    const hooks = [
      [EDITOR_EVENTS.SECTION_LOAD, 'sectionLoaded'],
      [EDITOR_EVENTS.SECTION_UNLOAD, 'sectionUnloaded'],
      [EDITOR_EVENTS.SECTION_SELECT, 'sectionSelected'],
      [EDITOR_EVENTS.SECTION_DESELECT, 'sectionDeselected'],
      [EDITOR_EVENTS.SECTION_REORDER, 'sectionReordered'],
      [EDITOR_EVENTS.BLOCK_SELECT, 'blockSelected'],
      [EDITOR_EVENTS.BLOCK_DESELECT, 'blockDeselected']
    ];

    for (const [eventName, methodName] of hooks) {
      const method = /** @type {any} */ (this)[methodName];
      if (typeof method !== 'function' || method === /** @type {any} */ (proto)[methodName]) continue;

      this.on(document, eventName, (event) => {
        const target = /** @type {CustomEvent} */ (event).target;
        if (target instanceof Node && !target.contains(this)) return;
        method.call(this, event);
      });
    }
  }

  /** @param {CustomEvent} _event */
  sectionLoaded(_event) {}

  /** @param {CustomEvent} _event */
  sectionUnloaded(_event) {}

  /** @param {CustomEvent} _event */
  sectionSelected(_event) {}

  /** @param {CustomEvent} _event */
  sectionDeselected(_event) {}

  /** @param {CustomEvent} _event */
  sectionReordered(_event) {}

  /** @param {CustomEvent} _event */
  blockSelected(_event) {}

  /** @param {CustomEvent} _event */
  blockDeselected(_event) {}
}

export default BaseComponent;
