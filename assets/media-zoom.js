/**
 * `<media-zoom>` and `<media-zoom-modal>` — product image zoom.
 *
 * @module @theme/media-zoom
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { ModalDialog } from '@theme/dialog';
import { EVENTS } from '@theme/events';
import { clamp, isTouchDevice, prefersReducedMotion, themeString, createPinchDetector } from '@theme/utilities';

/* ==========================================================================
   <media-zoom>
   ========================================================================== */

export class MediaZoom extends BaseComponent {
  /** @type {HTMLImageElement|null} */
  #zoomImage = null;

  /** @type {boolean} */
  #active = false;

  setup() {
    this.#active = false;

    if (this.#usesModal()) {
      this.on(this, 'click', (event) => {
        if (event.target instanceof Element && event.target.closest('a[href]')) return;
        event.preventDefault();
        this.openModal();
      });
      return;
    }

    this.on(this, 'pointerenter', () => this.enter());
    this.on(this, 'pointerleave', () => this.leave());
    this.on(this, 'pointermove', this.#onPointerMove);

    if (this.refs.trigger) {
      this.on(this.refs.trigger, 'click', (event) => {
        event.preventDefault();
        this.openModal();
      });
    }
  }

  teardown() {
    this.leave();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {string} The high-resolution source.
   */
  get zoomSrc() {
    return this.dataset.zoomSrc || this.refs.image?.src || '';
  }

  /**
   * @returns {number} Magnification factor.
   */
  get level() {
    return Number(this.dataset.level) || 2;
  }

  /**
   * Begin magnifying.
   *
   * @returns {Promise<void>}
   */
  async enter() {
    if (this.#active || prefersReducedMotion()) return;

    const image = await this.#loadZoomImage();
    if (!image) return;

    this.#active = true;
    this.setAttribute('data-zooming', '');
    this.dispatch(EVENTS.ZOOM_OPEN, { src: this.zoomSrc, mode: 'inline' });
  }

  /** Stop magnifying. */
  leave() {
    if (!this.#active) return;

    this.#active = false;
    this.removeAttribute('data-zooming');
    this.style.removeProperty('--zoom-x');
    this.style.removeProperty('--zoom-y');
    this.dispatch(EVENTS.ZOOM_CLOSE, { mode: 'inline' });
  }

  /** Open the full-screen zoom modal. */
  openModal() {
    const modal = document.querySelector('media-zoom-modal');
    if (!modal?.openWith) return;

    modal.openWith({
      src: this.zoomSrc,
      alt: this.refs.image?.alt || '',
      trigger: this.refs.trigger instanceof HTMLElement ? this.refs.trigger : this
    });
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @returns {boolean}
   * @private
   */
  #usesModal() {
    return isTouchDevice() || this.dataset.mode === 'modal';
  }

  /**
   * Fetch the high-resolution image once, on first use.
   *
   * @returns {Promise<HTMLImageElement|null>}
   * @private
   */
  #loadZoomImage() {
    if (this.#zoomImage) return Promise.resolve(this.#zoomImage);
    if (!this.zoomSrc) return Promise.resolve(null);

    return new Promise((resolve) => {
      const image = new Image();

      image.addEventListener('load', () => {
        this.style.setProperty('--zoom-image', `url("${this.zoomSrc}")`);
        this.style.setProperty('--zoom-level', String(this.level));
        this.#zoomImage = image;
        resolve(image);
      });

      image.addEventListener('error', () => {
        this.leave();
        resolve(null);
      });

      image.src = this.zoomSrc;
    });
  }

  /**
   * Translate the magnified image so the point under the cursor stays put.
   *
   * @param {PointerEvent} event
   * @private
   */
  #onPointerMove = (event) => {
    if (!this.#active) return;

    const rect = this.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100);
    const y = clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100);

    this.style.setProperty('--zoom-x', `${x}%`);
    this.style.setProperty('--zoom-y', `${y}%`);
  };
}

defineComponent('media-zoom', MediaZoom);

/* ==========================================================================
   <media-zoom-modal>
   ========================================================================== */

/** Full-screen image zoom. */
export class MediaZoomModal extends ModalDialog {
  /** @type {number} */
  #scale = 1;

  /** @type {{ x: number, y: number }} */
  #offset = { x: 0, y: 0 };

  /** @type {(() => void)|null} */
  #releasePinch = null;

  get overlayType() {
    return 'zoom';
  }

  setup() {
    super.setup();

    this.#reset();

    if (this.refs.zoomIn) this.on(this.refs.zoomIn, 'click', () => this.zoomBy(0.5));
    if (this.refs.zoomOut) this.on(this.refs.zoomOut, 'click', () => this.zoomBy(-0.5));
    if (this.refs.reset) this.on(this.refs.reset, 'click', () => this.#reset());

    const viewport = this.refs.viewport;
    if (!(viewport instanceof HTMLElement)) return;

    this.on(viewport, 'dblclick', (event) => {
      event.preventDefault();
      this.#scale > 1 ? this.#reset() : this.zoomBy(1);
    });

    this.on(viewport, 'pointerdown', this.#onPointerDown);

    this.on(viewport, 'wheel', (event) => {
      if (!event.ctrlKey) return; // Leave plain wheel scrolling alone.
      event.preventDefault();
      this.zoomBy(event.deltaY > 0 ? -0.25 : 0.25);
    }, { passive: false });

    this.#releasePinch = createPinchDetector?.(viewport, {
      onChange: ({ scale }) => this.setScale(this.#scale * scale)
    });
  }

  teardown() {
    this.#releasePinch?.();
    this.#releasePinch = null;
    super.teardown();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * Open the modal showing a specific image.
   *
   * @param {Object} options
   * @param {string} options.src
   * @param {string} [options.alt]
   * @param {HTMLElement} [options.trigger]
   * @returns {Promise<void>}
   */
  async openWith({ src, alt = '', trigger }) {
    const image = this.refs.image;

    if (image instanceof HTMLImageElement && src) {
      image.src = src;
      image.alt = alt;
    }

    this.#reset();
    await this.open(trigger);
  }

  /**
   * @param {number} delta
   */
  zoomBy(delta) {
    this.setScale(this.#scale + delta);
  }

  /**
   * @param {number} scale
   */
  setScale(scale) {
    this.#scale = clamp(scale, 1, 4);

    if (this.#scale === 1) this.#offset = { x: 0, y: 0 };

    this.#paint();

    if (this.refs.zoomIn instanceof HTMLButtonElement) this.refs.zoomIn.disabled = this.#scale >= 4;
    if (this.refs.zoomOut instanceof HTMLButtonElement) this.refs.zoomOut.disabled = this.#scale <= 1;
  }

  /**
   * @returns {number}
   */
  get scale() {
    return this.#scale;
  }

  afterClose() {
    this.#reset();
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #reset() {
    this.#scale = 1;
    this.#offset = { x: 0, y: 0 };
    this.#paint();
  }

  /** @private */
  #paint() {
    const image = this.refs.image;
    if (!(image instanceof HTMLElement)) return;

    image.style.setProperty(
      'transform',
      `translate3d(${this.#offset.x}px, ${this.#offset.y}px, 0) scale(${this.#scale})`
    );

    this.toggleAttribute('data-zoomed', this.#scale > 1);

    const status = this.refs.zoomStatus;
    if (status instanceof HTMLElement) {
      status.textContent = themeString('zoomLevel', '', { level: this.#scale.toFixed(1) });
    }
  }

  /**
   * Drag to pan, using pointer capture so the gesture survives leaving the
   * element — which it will, because a zoomed image is bigger than its frame.
   *
   * @param {PointerEvent} event
   * @private
   */
  #onPointerDown = (event) => {
    if (this.#scale <= 1) return;

    const viewport = this.refs.viewport;
    const start = { x: event.clientX, y: event.clientY };
    const origin = { ...this.#offset };

    viewport.setPointerCapture?.(event.pointerId);

    const onMove = (move) => {
      this.#offset = {
        x: origin.x + (move.clientX - start.x),
        y: origin.y + (move.clientY - start.y)
      };
      this.#paint();
    };

    const onUp = () => {
      viewport.removeEventListener('pointermove', onMove);
      viewport.releasePointerCapture?.(event.pointerId);
    };

    viewport.addEventListener('pointermove', onMove, { signal: this.signal });
    viewport.addEventListener('pointerup', onUp, { once: true, signal: this.signal });
    viewport.addEventListener('pointercancel', onUp, { once: true, signal: this.signal });
  };
}

defineComponent('media-zoom-modal', MediaZoomModal);

export default { MediaZoom, MediaZoomModal };
