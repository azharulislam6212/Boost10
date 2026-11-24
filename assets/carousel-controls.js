/**
 * The three functions that fill in the controls bar rendered by
 * `snippets/carousel-controls.liquid`:
 *
 * @module @theme/carousel-controls
 */

/**
 * @typedef {Object} ControlRefs
 * @property {HTMLElement|null} [previous]
 * @property {HTMLElement|null} [next]
 * @property {HTMLElement|null} [current]
 * @property {HTMLElement|null} [total]
 * @property {HTMLElement|null} [bar]
 */

/**
 * Zero-pads to at least two digits.
 *
 * @param {number} value
 * @returns {string}
 */
export function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Writes a position into a controls bar.
 *
 * @param {ControlRefs} refs
 * @param {number} index One-based position of the current slide.
 * @param {number} count Total slides.
 * @param {number} [progress] Travel normalised to 0…1. Falls back to index/count.
 */
export function renderControls(refs, index, count, progress) {
  if (!refs) return;

  if (refs.current) refs.current.textContent = pad(index);
  if (refs.total) refs.total.textContent = pad(count);

  if (refs.bar) {
    const fraction = Number.isFinite(progress) ? progress : count > 0 ? index / count : 0;
    refs.bar.style.setProperty('--carousel-progress', String(Math.min(Math.max(fraction, 0), 1)));
  }
}

/**
 * Finds controls rendered outside the component they drive.
 *
 * @param {string} id The driving element's id.
 * @returns {ControlRefs}
 */
export function findExternalControls(id) {
  const scope = id ? `[data-carousel-for="${CSS.escape(id)}"]` : '';
  /** @param {string} name */
  const find = (name) => (scope ? document.querySelector(`${scope}[data-ref="${name}"]`) : null);

  return { previous: find('previous'), next: find('next'), current: find('current'), total: find('total'), bar: find('bar') };
}

/**
 * Shows or hides the wrapper a set of controls belongs to.
 *
 * @param {ControlRefs} refs
 * @param {boolean} active
 */
export function toggleControls(refs, active) {
  if (!refs) return;

  const wrappers = new Set(Object.values(refs).map((element) => element?.closest?.('[data-carousel-nav]')));
  for (const wrapper of wrappers) wrapper?.toggleAttribute('data-carousel-active', active);
}
