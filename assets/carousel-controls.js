/**
 * carousel-controls.js — Boost10
 *
 * The three functions that fill in the controls bar rendered by
 * `snippets/carousel-controls.liquid`:
 *
 *     ( ← )   01  ▬▬▬▬▬▬▭▭▭▭▭  05   ( → )
 *
 * ## Why this is a module and not part of the carousel
 *
 * Two very different components render that bar. `<swiper-carousel>` is a
 * Swiper adapter; `<media-gallery>` is a hand-written gallery that coordinates
 * zoom, video playback and a thumbnail strip and has no Swiper in it at all.
 *
 * Both need the same four things done — pad the numbers, scale the bar, find
 * detached controls, toggle their visibility — and duplicating that in two
 * components is how the product gallery and the collection carousels come to
 * look subtly different after six months.
 *
 * Nothing here touches Swiper or the gallery. It takes a set of elements and a
 * position; it does not know or care what is driving them.
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
 * The design shows `01` and `05`, and the padding matters beyond looks: with
 * `font-variant-numeric: tabular-nums` a padded pair keeps a constant width, so
 * the progress bar beside it does not shift by a character when the count
 * crosses ten.
 *
 * Three-digit counts are left alone rather than truncated — a hundred-slide
 * carousel is a bad idea, but silently showing `99` for slide 100 is worse.
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
 * ## The bar is driven by Swiper's own progress, not by the numbers
 *
 * It used to be `index / count`, which is only right when one slide shows at a
 * time. With `slidesPerView: 4` and seven slides, Swiper stops at slide four —
 * that is the last position where four slides still fit — so the old maths gave
 * 4/7 and the bar sat at 57% while the carousel was visibly at the end.
 *
 * `swiper.progress` is the translate position normalised to 0…1. It is exactly
 * 0 at the first snap point and exactly 1 at the last, for any `slidesPerView`,
 * any `spaceBetween`, loop or not. So the caller passes it through rather than
 * recomputing something Swiper already knows.
 *
 * When nothing can scroll — fewer slides than fit — Swiper reports progress 0
 * forever. A bar stuck empty reads as broken, so that case is filled instead.
 *
 * The numbers stay slide-based: `04` of `07` names which slide you are looking
 * at, which is what a customer reads. It is deliberately not a page count.
 *
 * @param {ControlRefs} refs
 * @param {number} index One-based position of the current slide.
 * @param {number} count Total slides.
 * @param {number} [progress] Swiper's 0…1 progress. Falls back to index/count.
 */
export function renderControls(refs, index, count, progress) {
  if (!refs) return;

  if (refs.current) refs.current.textContent = pad(index);
  if (refs.total) refs.total.textContent = pad(count);

  if (refs.bar) {
    const fraction = Number.isFinite(progress)
      ? progress
      : count > 0
        ? index / count
        : 0;

    // Clamped because Swiper reports slightly out of range while rubber-banding
    // past either end, and a bar scaled to 1.08 spills out of its track.
    const clamped = Math.min(Math.max(fraction, 0), 1);
    refs.bar.style.setProperty('--carousel-progress', String(clamped));
  }
}

/**
 * Finds controls rendered outside the component they drive.
 *
 * A section header holding the arrows is not a descendant of the carousel, so
 * `data-ref` collection cannot reach it. The markup opts in instead: every
 * button and readout carries `data-carousel-for="<id>"`.
 *
 * @param {string} id The driving element's id.
 * @returns {ControlRefs}
 */
export function findExternalControls(id) {
  /** @type {ControlRefs} */
  const empty = { previous: null, next: null, current: null, total: null, bar: null };
  if (!id) return empty;

  const scope = `[data-carousel-for="${CSS.escape(id)}"]`;

  return {
    previous: document.querySelector(`${scope}[data-ref="previous"]`),
    next: document.querySelector(`${scope}[data-ref="next"]`),
    current: document.querySelector(`${scope}[data-ref="current"]`),
    total: document.querySelector(`${scope}[data-ref="total"]`),
    bar: document.querySelector(`${scope}[data-ref="bar"]`),
  };
}

/**
 * Shows or hides the wrapper a set of controls belongs to.
 *
 * Detached controls are not descendants of the carousel, so no CSS selector on
 * `.carousel-shell` can hide them when the section is a grid at that
 * breakpoint. The attribute is what does it, and the stylesheet matches on
 * `[data-carousel-active]`.
 *
 * @param {ControlRefs} refs
 * @param {boolean} active
 */
export function toggleControls(refs, active) {
  if (!refs) return;

  const seen = new Set();

  for (const element of Object.values(refs)) {
    const wrapper = element?.closest?.('[data-carousel-nav]');
    if (!wrapper || seen.has(wrapper)) continue;

    seen.add(wrapper);
    wrapper.toggleAttribute('data-carousel-active', active);
  }
}
