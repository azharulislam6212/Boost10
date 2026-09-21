/**
 * `<store-locator>` — search, filter and pan a list of stores.
 *
 * @module @theme/store-locator
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { debounce, themeString, announce, announceUrgent } from '@theme/utilities';

/** Earth's mean radius in kilometres. */
const EARTH_RADIUS_KM = 6371;

export class StoreLocator extends BaseComponent {
  static requiredRefs = ['list'];

  /** @type {{ latitude: number, longitude: number }|null} */
  #origin = null;

  setup() {
    if (this.refs.search) {
      this.on(this.refs.search, 'input', debounce(() => this.filter(), 200));

      this.on(this.refs.search, 'keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.filter();
      });
    }

    if (this.refs.radius) {
      this.on(this.refs.radius, 'change', () => this.filter());
    }

    if (this.refs.locate) {
      this.on(this.refs.locate, 'click', () => this.locate());
    }

    this.on(this, 'click', (event) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-store-select]') : null;
      if (!trigger) return;

      const card = trigger.closest('[data-store]');
      if (card instanceof HTMLElement) this.select(card);
    });

    this.filter();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement[]}
   */
  get stores() {
    return Array.from(this.refs.list.querySelectorAll('[data-store]'));
  }

  /**
   * @returns {HTMLElement[]}
   */
  get visibleStores() {
    return this.stores.filter((store) => !store.hasAttribute('hidden'));
  }

  /**
   * @returns {number} Radius in kilometres, or 0 for no limit.
   */
  get radius() {
    return Number(this.refs.radius?.value) || 0;
  }

  /** Apply the current search term and radius. */
  filter() {
    const term = (this.refs.search?.value || '').trim().toLowerCase();
    let matches = 0;

    for (const store of this.stores) {
      const text = `${store.dataset.name || ''} ${store.dataset.address || ''}`.toLowerCase();
      let hit = term === '' || text.includes(term);

      if (hit && this.#origin && this.radius > 0) {
        const distance = this.#distanceTo(store);
        hit = Number.isFinite(distance) && distance <= this.radius;
      }

      store.toggleAttribute('hidden', !hit);
      if (hit) matches += 1;
    }

    if (this.#origin) this.#sortByDistance();

    this.#status(
      matches === 0
        ? themeString('storesNoResults', '')
        : themeString('storesFound', '', { count: matches })
    );

    if (this.refs.empty instanceof HTMLElement) {
      this.refs.empty.toggleAttribute('hidden', matches > 0);
    }
  }

  /**
   * Focus a store: mark it current, show it on the embed, bring it into view.
   *
   * @param {HTMLElement} store
   */
  select(store) {
    for (const other of this.stores) {
      const current = other === store;
      other.toggleAttribute('data-current', current);
      other.querySelector('[data-store-select]')?.setAttribute('aria-pressed', String(current));
    }

    this.#showOnMap(store);

    store.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    announce(themeString('storeSelected', '', { name: store.dataset.name || '' }));
  }

  /**
   * Ask the browser where the customer is, then sort by distance.
   *
   * @returns {Promise<boolean>}
   */
  locate() {
    if (!('geolocation' in navigator)) {
      announceUrgent(themeString('storesLocationUnavailable', ''));
      return Promise.resolve(false);
    }

    this.setLoading(true);

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          this.#origin = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          };

          this.setLoading(false);
          this.#renderDistances();
          this.filter();

          const nearest = this.visibleStores[0];
          if (nearest) this.select(nearest);

          resolve(true);
        },
        () => {
          this.setLoading(false);
          announceUrgent(themeString('storesLocationDenied', ''));
          resolve(false);
        },
        { timeout: 10_000, maximumAge: 300_000 }
      );
    });
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Great-circle distance in kilometres.
   *
   * @param {HTMLElement} store
   * @returns {number}
   * @private
   */
  #distanceTo(store) {
    if (!this.#origin) return Number.NaN;

    const lat = Number(store.dataset.latitude);
    const lng = Number(store.dataset.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Number.NaN;

    const toRadians = (value) => (value * Math.PI) / 180;

    const dLat = toRadians(lat - this.#origin.latitude);
    const dLng = toRadians(lng - this.#origin.longitude);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRadians(this.#origin.latitude)) *
        Math.cos(toRadians(lat)) *
        Math.sin(dLng / 2) ** 2;

    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** @private */
  #renderDistances() {
    for (const store of this.stores) {
      const distance = this.#distanceTo(store);
      const target = store.querySelector('[data-store-distance]');

      if (!(target instanceof HTMLElement)) continue;

      if (!Number.isFinite(distance)) {
        target.textContent = '';
        target.hidden = true;
        continue;
      }

      const unit = this.dataset.unit === 'mi' ? 'mi' : 'km';
      const value = unit === 'mi' ? distance * 0.621371 : distance;

      target.hidden = false;
      target.textContent = themeString('storeDistance', '', {
        distance: value < 10 ? value.toFixed(1) : Math.round(value),
        unit
      });

      store.dataset.distance = String(distance);
    }
  }

  /** @private */
  #sortByDistance() {
    const sorted = this.stores.sort((a, b) => {
      const first = Number(a.dataset.distance);
      const second = Number(b.dataset.distance);

      if (!Number.isFinite(first)) return 1;
      if (!Number.isFinite(second)) return -1;

      return first - second;
    });

    for (const store of sorted) this.refs.list.appendChild(store);
  }

  /**
   * Point the embed at a store.
   *
   * @param {HTMLElement} store
   * @private
   */
  #showOnMap(store) {
    const frame = this.refs.map;
    const template = this.dataset.embed;

    if (!(frame instanceof HTMLIFrameElement) || !template) return;

    const query = store.dataset.query || `${store.dataset.latitude},${store.dataset.longitude}`;
    const next = template.replace('{query}', encodeURIComponent(query));

    if (frame.getAttribute('src') === next) return;

    frame.setAttribute('src', next);
    frame.setAttribute('title', themeString('storeMapTitle', '', { name: store.dataset.name || '' }));
  }

  /**
   * @param {string} message
   * @private
   */
  #status(message) {
    if (this.refs.status instanceof HTMLElement) this.refs.status.textContent = message;
  }
}

defineComponent('store-locator', StoreLocator);

export default StoreLocator;
