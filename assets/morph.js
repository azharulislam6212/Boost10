/**
 * morph.js — Boost10
 *
 * A focused DOM morphing algorithm. Given a live element and a freshly rendered
 * one, it mutates the live tree in place so that it matches the new markup,
 * while deliberately preserving the state the browser owns and the server does
 * not know about:
 *
 *   - the focused element, its selection range and its current value
 *   - scroll offsets of the root and of any scrollable descendant
 *   - `open` on `<dialog>` and `<details>` (drawers, accordions, filter groups)
 *   - live media playback, maps and canvases marked `data-morph-preserve`
 *   - custom element instances, which keep their `connectedCallback` state
 *
 * That last point is the reason this file exists at all. Replacing innerHTML
 * would disconnect and reconnect every `<variant-picker>`, `<quantity-selector>`
 * and `<accordion-element>` inside a section, throwing away their state and
 * re-running their setup on every filter click. Morphing keeps the instances.
 *
 * Markup opt-outs, all read from the LIVE node:
 *   data-morph-key            Stable identity, used instead of positional matching
 *   data-morph-preserve       Leave this node and its subtree completely untouched
 *   data-morph-skip-children  Sync attributes only, never descend
 *   data-morph-preserve-value Never overwrite this control's value or checked state
 *   data-morph-force-value    Always overwrite it, even while focused
 *
 * @module @theme/morph
 */

/* ==========================================================================
   Constants
   ========================================================================== */

/** Attributes that must be assigned as properties, not just as attributes. */
const VALUE_ELEMENTS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

/** Text-like inputs whose caret position is worth restoring. */
const CARET_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

/** Elements whose `open` state belongs to the customer, not the server. */
const OPEN_STATE_ELEMENTS = new Set(['DIALOG', 'DETAILS']);

/* ==========================================================================
   Public API
   ========================================================================== */

/**
 * Morph `fromNode` so that it matches `toNode`.
 *
 * The operation is best effort: if anything throws, the live node is left in a
 * usable state by falling back to a child replacement, and the error is logged
 * rather than propagated. A broken morph must never take a storefront down.
 *
 * @param {Element} fromNode The live element. Mutated in place.
 * @param {Element} toNode The freshly rendered element. Never mutated.
 * @param {Object} [options]
 * @param {boolean} [options.childrenOnly=false] Morph children but leave the root's own attributes alone.
 * @param {(node: Element, next: Element) => boolean} [options.shouldMorph] Return false to skip a node entirely.
 * @param {(node: Element) => void} [options.onNodeAdded] Called for every element inserted.
 * @param {(node: Element) => void} [options.onNodeRemoved] Called for every element discarded.
 * @returns {boolean} True when the morph completed, false when the fallback ran.
 */
export function morph(fromNode, toNode, options = {}) {
  if (!(fromNode instanceof Element) || !(toNode instanceof Element)) {
    console.warn('[Boost10] morph expects two elements.');
    return false;
  }

  const context = {
    shouldMorph: options.shouldMorph || null,
    onNodeAdded: options.onNodeAdded || null,
    onNodeRemoved: options.onNodeRemoved || null
  };

  const focus = captureFocus(fromNode);
  const scroll = captureScroll(fromNode);

  try {
    if (options.childrenOnly) {
      morphChildren(fromNode, toNode, context);
    } else {
      morphNode(fromNode, toNode, context);
    }
  } catch (error) {
    console.error('[Boost10] morph failed, falling back to child replacement.', error);
    try {
      fromNode.replaceChildren(...Array.from(toNode.cloneNode(true).childNodes));
    } catch (fallbackError) {
      console.error('[Boost10] morph fallback failed.', fallbackError);
    }
    restoreScroll(scroll);
    return false;
  }

  restoreScroll(scroll);
  restoreFocus(focus);

  return true;
}

/**
 * Morph a live element from an HTML string.
 *
 * @param {Element} fromNode The live element.
 * @param {string} html Full document HTML, usually a Section Rendering API response.
 * @param {string} [selector] Selector for the replacement inside the parsed document.
 *   Defaults to the live element's tag name.
 * @param {Object} [options] Forwarded to {@link morph}.
 * @returns {boolean} True when a matching node was found and applied.
 */
export function morphFromHTML(fromNode, html, selector, options = {}) {
  const target = selector || fromNode.tagName.toLowerCase();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const next = parsed.querySelector(target);

  if (!next) {
    console.warn(`[Boost10] morphFromHTML found no "${target}" in the response.`);
    return false;
  }

  return morph(fromNode, next, options);
}

/* ==========================================================================
   Node morphing
   ========================================================================== */

/**
 * Morph a single node: attributes first, then children.
 *
 * @param {Node} from
 * @param {Node} to
 * @param {Object} context
 * @private
 */
function morphNode(from, to, context) {
  if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }

  if (from.nodeType !== Node.ELEMENT_NODE) return;
  if (from.hasAttribute('data-morph-preserve')) return;
  if (context.shouldMorph && context.shouldMorph(from, to) === false) return;

  morphAttributes(from, to);

  if (VALUE_ELEMENTS.has(from.tagName)) {
    morphFormControl(from, to);
  }

  if (OPEN_STATE_ELEMENTS.has(from.tagName)) {
    preserveOpenState(from, to);
  }

  if (from.hasAttribute('data-morph-skip-children')) return;

  morphChildren(from, to, context);

  // A <select> only settles once its <option> children exist.
  if (from.tagName === 'SELECT' && !shouldPreserveValue(from)) {
    syncSelectValue(from, to);
  }
}

/**
 * Copy attributes across, adding, updating and removing as needed.
 *
 * @param {Element} from
 * @param {Element} to
 * @private
 */
function morphAttributes(from, to) {
  const toAttributes = to.attributes;

  for (let i = 0; i < toAttributes.length; i += 1) {
    const { name, value } = toAttributes[i];
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }

  // Iterate backwards: removing shifts the live NamedNodeMap.
  const fromAttributes = from.attributes;
  for (let i = fromAttributes.length - 1; i >= 0; i -= 1) {
    const { name } = fromAttributes[i];
    if (name.startsWith('data-morph-')) continue;
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
}

/**
 * Reconcile a form control without discarding what the customer has typed.
 *
 * Rule: the control the customer is currently interacting with keeps its value.
 * Everything else takes the server's value, because the server is the authority
 * on quantities, selected variants and applied filters.
 *
 * @param {Element} from
 * @param {Element} to
 * @private
 */
function morphFormControl(from, to) {
  if (shouldPreserveValue(from)) return;

  const forced = from.hasAttribute('data-morph-force-value');
  const isActive = document.activeElement === from;

  switch (from.tagName) {
    case 'INPUT': {
      const type = from.type;

      if (type === 'checkbox' || type === 'radio') {
        const nextChecked = to.hasAttribute('checked') || to.checked === true;
        if (from.checked !== nextChecked) from.checked = nextChecked;
        break;
      }

      if (type === 'file') break; // Value is read-only for security reasons.

      if (forced || !isActive) {
        const nextValue = to.getAttribute('value') ?? to.value ?? '';
        if (from.value !== nextValue) from.value = nextValue;
      }
      break;
    }

    case 'TEXTAREA': {
      if (forced || !isActive) {
        const nextValue = to.value ?? to.textContent ?? '';
        if (from.value !== nextValue) from.value = nextValue;
      }
      break;
    }

    case 'OPTION': {
      const nextSelected = to.hasAttribute('selected') || to.selected === true;
      if (from.selected !== nextSelected) from.selected = nextSelected;
      break;
    }

    default:
      break;
  }

  if (from.disabled !== to.disabled) from.disabled = to.disabled;
}

/**
 * @param {Element} select
 * @param {Element} next
 * @private
 */
function syncSelectValue(select, next) {
  if (document.activeElement === select) return;

  const selected = next.querySelector('option[selected]');
  const nextValue = selected ? selected.value : next.value;

  if (nextValue != null && select.value !== nextValue) select.value = nextValue;
}

/**
 * Keep drawers, modals and accordions open across a morph.
 *
 * The server always renders the closed state, so taking its `open` attribute
 * literally would slam every open accordion shut whenever filters refresh.
 *
 * @param {Element} from
 * @param {Element} to
 * @private
 */
function preserveOpenState(from, to) {
  if (from.hasAttribute('data-morph-force-open')) return;

  const wasOpen = from.hasAttribute('open') || from.open === true;
  if (wasOpen && !to.hasAttribute('open')) from.setAttribute('open', '');
}

/**
 * @param {Element} element
 * @returns {boolean}
 * @private
 */
function shouldPreserveValue(element) {
  return element.hasAttribute('data-morph-preserve-value');
}

/* ==========================================================================
   Children reconciliation
   ========================================================================== */

/**
 * Reconcile the child lists of two nodes.
 *
 * Keyed children are matched by `data-morph-key` or `id` regardless of position,
 * so a reordered product grid moves nodes rather than rebuilding them. Unkeyed
 * children fall back to positional matching against a moving cursor.
 *
 * @param {Element} from
 * @param {Element} to
 * @param {Object} context
 * @private
 */
function morphChildren(from, to, context) {
  const keyed = collectKeyedChildren(from);
  let cursor = from.firstChild;

  for (let next = to.firstChild; next !== null; next = next.nextSibling) {
    const key = keyOf(next);

    if (key !== null && keyed.has(key)) {
      const match = keyed.get(key);
      keyed.delete(key);

      if (match !== cursor) {
        from.insertBefore(match, cursor);
      } else {
        cursor = cursor.nextSibling;
      }

      morphNode(match, next, context);
      continue;
    }

    // Skip over live nodes that are keyed but claimed later in the new list.
    while (cursor !== null && keyOf(cursor) !== null && keyed.has(keyOf(cursor))) {
      cursor = cursor.nextSibling;
    }

    if (cursor !== null && isCompatible(cursor, next)) {
      const current = cursor;
      cursor = cursor.nextSibling;
      morphNode(current, next, context);
      continue;
    }

    const clone = next.cloneNode(true);
    from.insertBefore(clone, cursor);
    if (clone.nodeType === Node.ELEMENT_NODE) context.onNodeAdded?.(clone);
  }

  // Anything still unclaimed is gone from the new markup.
  removeRemaining(from, cursor, keyed, context);
}

/**
 * @param {Element} parent
 * @returns {Map<string, Node>}
 * @private
 */
function collectKeyedChildren(parent) {
  const keyed = new Map();

  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    const key = keyOf(child);
    if (key !== null) keyed.set(key, child);
  }

  return keyed;
}

/**
 * @param {Element} parent
 * @param {Node|null} cursor
 * @param {Map<string, Node>} unclaimed
 * @param {Object} context
 * @private
 */
function removeRemaining(parent, cursor, unclaimed, context) {
  let node = cursor;

  while (node !== null) {
    const next = node.nextSibling;
    const key = keyOf(node);

    // A keyed node still in the map was never matched, so it is safe to drop.
    if (key === null || unclaimed.has(key)) discard(parent, node, context);

    node = next;
  }

  for (const node of unclaimed.values()) {
    if (node.parentNode === parent) discard(parent, node, context);
  }
}

/**
 * @param {Element} parent
 * @param {Node} node
 * @param {Object} context
 * @private
 */
function discard(parent, node, context) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.hasAttribute('data-morph-preserve')) return;
    context.onNodeRemoved?.(node);
  }
  parent.removeChild(node);
}

/**
 * Two nodes can be morphed into each other when they are the same kind of node,
 * the same tag, and carry the same key (or no key at all).
 *
 * @param {Node} a
 * @param {Node} b
 * @returns {boolean}
 * @private
 */
function isCompatible(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.ELEMENT_NODE && a.nodeName !== b.nodeName) return false;
  return keyOf(a) === keyOf(b);
}

/**
 * @param {Node} node
 * @returns {string|null}
 * @private
 */
function keyOf(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  return node.getAttribute('data-morph-key') || node.id || null;
}

/* ==========================================================================
   Focus preservation
   ========================================================================== */

/**
 * Record where focus and the caret are before the tree changes.
 *
 * @param {Element} root
 * @returns {Object|null}
 * @private
 */
function captureFocus(root) {
  const active = document.activeElement;
  if (!active || active === document.body || !root.contains(active)) return null;

  const snapshot = { path: pathTo(root, active), selectionStart: null, selectionEnd: null };

  if (CARET_TYPES.has(active.type) || active.tagName === 'TEXTAREA') {
    try {
      snapshot.selectionStart = active.selectionStart;
      snapshot.selectionEnd = active.selectionEnd;
    } catch {
      /* Some input types throw on selection access. */
    }
  }

  return snapshot;
}

/**
 * Put focus back where it was. Morphing keeps nodes alive wherever it can, so in
 * the common case the original element is still there and simply needs focus.
 *
 * @param {Object|null} snapshot
 * @private
 */
function restoreFocus(snapshot) {
  if (!snapshot) return;

  const target = resolvePath(snapshot.path);
  if (!(target instanceof HTMLElement) || !target.isConnected) return;
  if (document.activeElement === target) return;

  target.focus({ preventScroll: true });

  if (snapshot.selectionStart !== null && typeof target.setSelectionRange === 'function') {
    try {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      /* Ignore controls that reject a selection range. */
    }
  }
}

/**
 * Describe an element as a chain of child indices from a root, so it can be
 * found again after its ancestors have been reconciled.
 *
 * @param {Element} root
 * @param {Element} node
 * @returns {{ root: Element, indices: number[] }}
 * @private
 */
function pathTo(root, node) {
  const indices = [];
  let current = node;

  while (current && current !== root) {
    const parent = current.parentNode;
    if (!parent) break;
    indices.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }

  return { root, indices };
}

/**
 * @param {{ root: Element, indices: number[] }} path
 * @returns {Node|null}
 * @private
 */
function resolvePath({ root, indices }) {
  let node = root;

  for (const index of indices) {
    node = node?.childNodes?.[index];
    if (!node) return null;
  }

  return node;
}

/* ==========================================================================
   Scroll preservation
   ========================================================================== */

/**
 * Record scroll offsets for the root and every scrollable descendant that
 * carries an identity we can match again afterwards.
 *
 * @param {Element} root
 * @returns {Array<{ key: string|null, node: Element, top: number, left: number }>}
 * @private
 */
function captureScroll(root) {
  const snapshots = [];

  if (root.scrollTop > 0 || root.scrollLeft > 0) {
    snapshots.push({ key: null, node: root, top: root.scrollTop, left: root.scrollLeft });
  }

  const candidates = root.querySelectorAll('[data-morph-key], [id], [data-morph-scroll]');

  for (const node of candidates) {
    if (node.scrollTop === 0 && node.scrollLeft === 0) continue;
    snapshots.push({ key: keyOf(node), node, top: node.scrollTop, left: node.scrollLeft });
  }

  return snapshots;
}

/**
 * Reapply scroll offsets after the tree has settled.
 *
 * @param {Array<Object>} snapshots
 * @private
 */
function restoreScroll(snapshots) {
  if (snapshots.length === 0) return;

  for (const { node, top, left } of snapshots) {
    if (!node.isConnected) continue;
    if (node.scrollTop !== top) node.scrollTop = top;
    if (node.scrollLeft !== left) node.scrollLeft = left;
  }
}

export default morph;
