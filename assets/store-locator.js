/**
 * store-locator.js — Boost10
 *
 * `<store-locator>` — search, filter and pan a list of stores.
 *
 * ## The map decision, stated plainly
 *
 * This module does **not** bundle Leaflet, Mapbox or the Google Maps SDK. The
 * theme's first rule is zero external JavaScript, and every one of those is a
 * third-party script — often a third-party *account* — that a merchant has to
 * configure before the page works at all. A theme whose store finder is blank
 * until someone pastes an API key is a theme that ships broken.
 *
 * So the map is an `<iframe>` the merchant supplies, loaded on interaction, and
 * everything genuinely useful — searching, filtering by distance, opening hours,
 * directions — is done here without a map at all. Customers overwhelmingly want
 * the address, the hours and a directions link; the map is decoration around
 * that, and decoration should not be a hard dependency.
 *
 * Panning is real when an embed exists: selecting a store rewrites the iframe's
 * `src` to that store's query, which is what "pan and open the info window"
 * means for an embed. Without an embed, selecting a store scrolls its card into
 * view and announces it, which is the same information by another route.
 *
 * ## Distance
 *
 * Calculated with the haversine formula against coordinates rendered by Liquid.
 * Geolocation is offered, never taken: `navigator.geolocation` prompts, and a
 * page that prompts on load is a page people leave.
 *
 * @module @theme/store-locator
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { debounce, themeString, announce, announceUrgent } from '@theme/utilities';

/** Earth's mean radius in kilometres. */
const EARTH_RADIUS_KM = 6371;

/**
 * Markup:
 *
 *   <store-locator data-embed="https://www.google.com/maps?q={query}&output=embed">
 *     <input type="search" data-ref="search">
 *     <select data-ref="radius">…</select>
 *     <button data-ref="locate">…</button>
 *
 *     <ul data-ref="list">
 *       <li data-store
 *           data-latitude="51.5" data-longitude="-0.12"
 *           data-name="…" data-address="…" data-query="…">
 *         <button data-store-select>…</button>
 *       </li>
 *     </ul>
 *
 *     <p data-ref="empty" hidden></p>
 *     <p data-ref="status" class="visually-hidden" role="status"></p>
 *     <iframe data-ref="map" loading="lazy"></iframe>
 *   </store-locator>
 */
export class StoreLocator extends BaseComponent {
  static requiredRefs = ['list'];

  /** @type {{ latitude: number, longitude: number }|null} */
  #origin = null;

  setup() {
    if (this.refs.search) {
      this.on(this.refs.search, 'input', debounce(() => this.filter(), 200));

      // Enter in a search field would otherwise submit an ancestor form and
      // reload the page, losing the filter the customer just typed.
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

  /* --------------------------------------------------------- public API -- */

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

  /**
   * Apply the current search term and radius.
   */
  filter() {
    const term = (this.refs.search?.value || '').trim().toLowerCase();
    let matches = 0;

    for (const store of this.stores) {
      const text = `${store.dataset.name || ''} ${store.dataset.address || ''}`.toLowerCase();
      let hit = term === '' || text.includes(term);

      // Distance only narrows the result when we know where the customer is.
      // Filtering by radius from nowhere would hide every store.
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
   * Offered on a button, never on load: a page that prompts for location before
   * anyone has asked for anything is a page people leave.
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
          // A denied prompt is a choice, not an error. Say what happened and
          // leave the list usable rather than blocking on it.
          this.setLoading(false);
          announceUrgent(themeString('storesLocationDenied', ''));
          resolve(false);
        },
        { timeout: 10_000, maximumAge: 300_000 }
      );
    });
  }

  /* ---------------------------------------------------------- internals -- */

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

      // Stores with no coordinates sink to the bottom rather than jumping to the
      // top, which is what NaN comparisons do if left alone.
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
