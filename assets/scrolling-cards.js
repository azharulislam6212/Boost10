/**
 * `<scrolling-cards>` — the heading's lines slide in from either side and each
 * glass card grows into place as the section scrolls past.
 *
 * Every value is scroll-linked rather than played once: it follows the page in
 * both directions. Positions are eased towards their target on each frame, so
 * the movement trails the scroll slightly instead of snapping with it, and the
 * loop stops as soon as everything has settled.
 *
 * @module @theme/scrolling-cards
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { subscribeToTicker } from '@theme/motion-engine';
import { clamp, prefersReducedMotion } from '@theme/utilities';

/** Share of the remaining distance covered per frame. */
const EASE = 0.1;

/** Below this, a value counts as arrived. */
const SETTLED = 0.05;

/** The heading lines are in place once this share of the section has scrolled by. */
const LINES_DONE = 0.55;

/** A card reaches full size once this share of its own passage has scrolled by. */
const CARD_DONE = 0.45;

const DESKTOP = window.matchMedia('(min-width: 990px)');

export class ScrollingCards extends BaseComponent {
  /** @type {{ el: HTMLElement, dir: number, now: number, target: number }[]} */
  #lines = [];

  /** @type {{ el: HTMLElement, now: number, target: number }[]} */
  #cards = [];

  /** @type {{ top: number, height: number, cards: { top: number, height: number }[] }|null} */
  #geometry = null;

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  /** @type {number|null} */
  #frame = null;

  /** @type {IntersectionObserver|null} */
  #visibility = null;

  /** @type {ResizeObserver|null} */
  #resize = null;

  setup() {
    if (this.dataset.animate === 'false' || prefersReducedMotion()) return;

    const heading = this.querySelector('.scrolling-cards__heading .block-group__content');
    this.#lines = Array.from(heading?.children || [])
      .filter((el) => el instanceof HTMLElement)
      .map((el, index) => ({ el: /** @type {HTMLElement} */ (el), dir: index % 2 === 0 ? -1 : 1, now: 0, target: 0 }));

    this.#cards = Array.from(this.querySelectorAll('[data-scrolling-card]')).map((el) => ({
      el: /** @type {HTMLElement} */ (el),
      now: 1,
      target: 1
    }));

    if (this.#lines.length === 0 && this.#cards.length === 0) return;

    this.#resize = new ResizeObserver(() => {
      this.#geometry = null;
      this.#update(window.scrollY, true);
    });
    this.#resize.observe(this);

    this.#visibility = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.#start();
        else this.#stop();
      },
      { rootMargin: '25% 0px' }
    );
    this.#visibility.observe(this);

    this.on(DESKTOP, 'change', () => {
      this.#geometry = null;
      this.#update(window.scrollY, true);
    });

    this.#update(window.scrollY, true);
  }

  teardown() {
    this.#stop();
    this.#visibility?.disconnect();
    this.#resize?.disconnect();
    this.#visibility = null;
    this.#resize = null;

    for (const item of [...this.#lines, ...this.#cards]) {
      item.el.style.removeProperty('translate');
      item.el.style.removeProperty('scale');
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

  #start() {
    if (this.#unsubscribe) return;
    this.#unsubscribe = subscribeToTicker((scrollY) => this.#update(scrollY));
  }

  #stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /** Page positions, measured without the transforms this component applies. */
  #measure() {
    const scrollY = window.scrollY;
    const rect = this.getBoundingClientRect();
    const top = rect.top + scrollY;

    this.#geometry = {
      top,
      height: rect.height,
      cards: this.#cards.map(({ el }) => {
        let offset = 0;
        let node = /** @type {HTMLElement|null} */ (el);
        while (node && node !== this) {
          offset += node.offsetTop;
          node = /** @type {HTMLElement|null} */ (node.offsetParent);
          if (node && !this.contains(node)) break;
        }
        return { top: top + offset, height: el.offsetHeight };
      })
    };
  }

  /**
   * @param {number} scrollY
   * @param {boolean} [jump] Place everything at its target without easing.
   */
  #update(scrollY, jump = false) {
    if (!this.#geometry) this.#measure();
    const geometry = /** @type {NonNullable<typeof this.#geometry>} */ (this.#geometry);
    const viewport = window.innerHeight;
    const desktop = DESKTOP.matches;

    const sectionProgress = clamp((scrollY + viewport - geometry.top) / (viewport + geometry.height), 0, 1);
    const lineDistance = desktop ? 200 : 48;
    const lineArrived = easeOut(clamp(sectionProgress / LINES_DONE, 0, 1));

    for (const line of this.#lines) {
      line.target = line.dir * lineDistance * (1 - lineArrived);
    }

    const smallest = desktop ? 0.8 : 0.92;

    this.#cards.forEach((card, index) => {
      const box = geometry.cards[index];
      const progress = clamp((scrollY + viewport - box.top) / (viewport + box.height), 0, 1);
      const grown = clamp(progress / CARD_DONE, 0, 1);
      card.target = smallest + (1 - smallest) * easeOut(grown);
    });

    if (jump) {
      for (const line of this.#lines) line.now = line.target;
      for (const card of this.#cards) card.now = card.target;
      this.#paint();
      return;
    }

    if (this.#frame === null) this.#frame = requestAnimationFrame(this.#step);
  }

  #step = () => {
    this.#frame = null;
    let moving = false;

    for (const line of this.#lines) {
      line.now += (line.target - line.now) * EASE;
      if (Math.abs(line.target - line.now) > SETTLED) moving = true;
      else line.now = line.target;
    }

    for (const card of this.#cards) {
      card.now += (card.target - card.now) * EASE;
      if (Math.abs(card.target - card.now) > SETTLED / 1000) moving = true;
      else card.now = card.target;
    }

    this.#paint();

    if (moving) this.#frame = requestAnimationFrame(this.#step);
  };

  #paint() {
    for (const line of this.#lines) {
      line.el.style.translate = `${line.now.toFixed(2)}px 0`;
    }

    for (const card of this.#cards) {
      card.el.style.scale = card.now.toFixed(4);
    }
  }
}

/**
 * @param {number} t 0…1
 * @returns {number}
 */
function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

defineComponent('scrolling-cards', ScrollingCards);

export default ScrollingCards;
