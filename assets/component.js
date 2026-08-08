/**
 * component.js — Boost10
 *
 * `BaseComponent` is the class every interactive element in the theme extends.
 * It provides four things and nothing else:
 *
 *   1. Automatic listener cleanup through a per-connection `AbortController`.
 *   2. `data-ref` resolution, so markup and behaviour stay decoupled.
 *   3. A thin `dispatch()` wrapper over native `dispatchEvent()`.
 *   4. Theme Editor lifecycle hooks that only bind when a subclass uses them.
 *
 * What it deliberately does NOT provide: a message bus, a subscriber registry,
 * `emit()`, a global state container, or any cross-component routing. Commands
 * travel by direct method call on a element reference; broadcasts travel by
 * native events dispatched by whichever element owns the state.
 *
 * @module @theme/component
 */

import { EDITOR_EVENTS } from '@theme/events';

/**
 * Registers a custom element exactly once.
 *
 * The Theme Editor re-executes section scripts on `shopify:section:load`, and a
 * second `customElements.define()` for the same tag throws `NotSupportedError`,
 * which kills the rest of the module. Always register through this function.
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
 * Subclass contract:
 *   - Put initialisation in `setup()`, not in `connectedCallback()`.
 *   - Put cleanup that is not a listener in `teardown()`.
 *   - Bind every listener with `this.on()` so it dies with the element.
 *   - `setup()` must be idempotent: moving an element in the DOM disconnects
 *     and reconnects it, and morphing does exactly that.
 *
 * @extends HTMLElement
 */
export class BaseComponent extends HTMLElement {
  /**
   * Attributes that trigger `attributeChanged()`.
   * @type {string[]}
   */
  static observedAttributes = [];

  /**
   * `data-ref` names that must be present. If any is missing the component
   * logs once and disables itself rather than throwing on every interaction.
   * @type {string[]}
   */
  static requiredRefs = [];

  /** @type {AbortController|null} */
  #controller = null;

  /** @type {boolean} */
  #connected = false;

  /**
   * Resolved `[data-ref]` descendants.
   *
   * A single match is the element itself; repeated names collect into an array,
   * which is what makes lists (`data-ref="item"` on every row) work without
   * extra markup.
   *
   * @type {Record<string, HTMLElement|HTMLElement[]>}
   */
  refs = {};

  /* ---------------------------------------------------------- lifecycle -- */

  connectedCallback() {
    // Guard against a double connect during morphing.
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

    // Aborting removes every listener bound through `on()` in one step. There
    // is no manual removeEventListener anywhere in this theme.
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

  /* --------------------------------------------------------- listeners -- */

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

  /* ------------------------------------------------------------ events -- */

  /**
   * Dispatches a native `CustomEvent` from this element.
   *
   * This is a one-line wrapper over `dispatchEvent()`, not a bus: there is no
   * subscriber list, no central registry and no delivery to anything the event
   * does not naturally reach by bubbling.
   *
   * `composed` defaults to `true` so events still cross a shadow boundary when
   * the dispatcher is a `ShadowComponent`.
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

  /* --------------------------------------------------------------- DOM -- */

  /**
   * Replaces this element's contents from server-rendered HTML while keeping
   * focus, scroll position, open dialogs and in-progress input intact.
   *
   * `morph` is imported lazily. `global.js` loads it on every page anyway, so
   * this resolves from the module cache with no extra request; the dynamic
   * import exists so `component.js` has no hard dependency on the renderer and
   * can be unit-tested on its own.
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

  /* --------------------------------------------------------------- refs -- */

  /**
   * A `[data-ref]` node belongs to this component only if no other registered
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
      if (tag.includes('-') && customElements.get(tag)) return false;
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

      // Space-separated, so one element can answer to two names. That is not
      // decoration: a product recommendations list is both the thing the module
      // morphs into (`content`) and the thing the carousel scrolls (`track`),
      // and giving them separate wrappers would mean the morph replaced the
      // element the carousel holds a reference to.
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

  /* ------------------------------------------------------ theme editor -- */

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
        // Only react to events for the section or block that contains us.
        const target = /** @type {CustomEvent} */ (event).target;
        if (target instanceof Node && !target.contains(this)) return;
        method.call(this, event);
      });
    }
  }

  /* Hooks below are intentionally empty. Overriding one is what opts a        */
  /* component into the corresponding Theme Editor listener.                   */

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
