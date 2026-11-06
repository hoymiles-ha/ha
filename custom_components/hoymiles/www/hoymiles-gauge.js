/* ============================================================================
 * Hoymiles Micro Storage — Gauge card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-gauge`
 *
 * A stat tile with a single progress arc, like the vendor app's summary cards:
 * the title and an optional icon on top, the value underneath, and one green
 * arc at the bottom filled by the value's percentage of `min`..`max`, with the
 * percentage printed inside it.
 *
 * It differs from Home Assistant's built-in `gauge` card in two ways that
 * matter for this device:
 *   - the native unit can be rescaled for display, so an energy sensor in Wh
 *     can be shown as kWh without an extra template sensor;
 *   - `max` may be omitted, in which case the dial grows with the value.
 *
 * Card config:
 *   type: custom:hoymiles-gauge
 *   entity: sensor.x_battery_discharge_energy_today
 *   name: 当日发电量
 *   unit: kWh                 # optional display unit
 *   scale: 0.001              # optional multiplier applied before display
 *   max: 5                    # optional (in display units)
 *   min: 0                    # optional (default 0)
 *   decimals: 2               # optional (default 2)
 *   icon: sun                 # optional, drawn next to the title.  Either a
 *                             #   name from the built-in set (see ICON_SVG) or
 *                             #   any other string, which is shown as text -
 *                             #   emoji included, so old configs keep working
 *   label: 自发自用率          # optional caption under the percentage
 *   color: "#22c55e"          # optional arc colour (default green)
 *   show_arc: false           # optional, drop the arch and its percentage
 *                             #   altogether - the card is then just the
 *                             #   readout (default true)
 *
 * The arch shows the value as a share of `max`.  When the interesting number is
 * a ratio between entities rather than a share of a made-up ceiling, give the
 * arch its own source instead:
 *
 *   percent_numerator:   sensor.energy_today      # required for ratio mode
 *   percent_subtract:    sensor.energy_exported  # optional, taken off it
 *   percent_denominator: sensor.energy_today     # optional, defaults to the
 *                                                #   numerator
 *
 * e.g. self consumption = (发电量 − 上网电量) / 发电量.  The readout (big number)
 * still shows `entity`; only the arch and its percentage come from the ratio.
 * ========================================================================== */

function _hmGaugeRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Language
   *
   * This card has no built-in wording - every word on it comes from the user's
   * own `name` / `label` / `icon` - so it has no `_t()`. It still has to
   * resolve *those* against the language, because otherwise the tiles are the
   * one part of a dashboard that cannot follow the UI language:
   *
   *   name:
   *     en: PV today
   *     zh: 今日发电量
   *     de: PV heute
   *
   * Three languages: English, Simplified Chinese and German.  The card's own
   * `language:` wins, then the Home Assistant user's language, then English.
   * A `name` map missing the current language falls back to `en` (then to
   * whichever entry exists), so an older two-language dashboard still works.
   * ------------------------------------------------------------------ */
  /* No `_t()` in this card, but `hmPick` is shared code: an empty table keeps
     the reference valid rather than throwing if it is ever called. */
  const T_DE = {};

  /** Map any Home Assistant language tag to one of the three card languages. */
  function hmNormalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  /* ------------------------------------------------------------------ *
   * The language the user picked
   *
   * The choice belongs to the viewer, not to the dashboard: it lives in one
   * localStorage key and is announced with one window event, so the dropdown
   * on any card switches every card on the page at once, and the choice
   * survives a reload.
   *
   * English is the default.  It deliberately does NOT follow the Home
   * Assistant UI language any more: a dashboard is often shared, and the point
   * of the dropdown is that the reader decides.
   * ------------------------------------------------------------------ */
  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";
  const LANG_CHOICES = [["en", "English"], ["zh", "\u4e2d\u6587"], ["de", "Deutsch"]];

  /** The stored choice, or "" when nothing has been picked (or no storage). */
  function hmStored() {
    try {
      return hmNormalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return ""; // private mode / storage disabled: fall back to the default
    }
  }

  /** Remember a choice and tell every card about it. */
  function hmSetLang(value) {
    const lang = hmNormalise(value) || "en";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      /* nothing to remember it with; the event still switches this page */
    }
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
  }

  function hmLang(hass, config) {
    return hmStored() || hmNormalise(config && config.language) || "en";
  }

  /**
   * One of the three wordings.
   *
   * German comes from the card's own dictionary, keyed by the English string -
   * that is why `_t()` call sites did not have to change when the third
   * language was added.  A missing entry falls back to English, so an
   * untranslated string shows English rather than nothing.
   */
  function hmPick(lang, en, zh) {
    if (lang === "zh") return zh;
    if (lang === "de") {
      const de = T_DE[en];
      return de == null ? en : de;
    }
    return en;
  }

  /* (hmLang defined above, with the dictionary.) */

  function hmText(value, lang) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const hit = value[lang];
      if (hit != null) return hit;
      if (value.en != null) return value.en;
      const first = Object.values(value)[0];
      return first == null ? "" : first;
    }
    return value;
  }

  /** A text field can only hold a plain string, so a language map shows empty. */
  function hmField(value) {
    return typeof value === "string" ? value : "";
  }

  /* ------------------------------------------------------------------ *
   * Arc geometry: one half circle over a centre that sits on the bottom edge,
   * so the card shows a simple arch.
   * ------------------------------------------------------------------ */
  const VB_W = 220;
  const VB_H = 126;
  const CX = VB_W / 2;
  const CY = 110;          // centre, on the bottom edge of the viewBox
  const R_ARC = 84;
  const ARC_STROKE = 14;
  const START_DEG = 180;   // nine o'clock
  const SWEEP_DEG = 180;   // over the top to three o'clock
  const PCT_Y = CY - 20;   // percentage, inside the arch
  const LABEL_Y = CY + 2;  // caption under it

  const DEFAULT_COLOR = "#22c55e";

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /** "1234.50" -> "1 234.50"; keeps the big readouts readable. */
  function group(text) {
    const parts = String(text).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function polar(deg, radius) {
    const rad = (deg * Math.PI) / 180;
    return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
  }

  /** Arc path between two fractions (0..1) of the sweep. */
  function arcPath(from, to, radius) {
    const a0 = START_DEG + SWEEP_DEG * from;
    const a1 = START_DEG + SWEEP_DEG * to;
    const p0 = polar(a0, radius);
    const p1 = polar(a1, radius);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    const sweep = a1 > a0 ? 1 : 0;
    return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A${radius} ${radius} 0 ${large} ${sweep} `
      + `${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  }

  /* ------------------------------------------------------------------ *
   * Icon set
   *
   * The same visual language as the control card: filled, multi-colour SVG
   * with a soft gradient, so the tiles in one dashboard look like they came
   * from the same app instead of half emoji and half line art.
   *
   * Each entry is a function of a unique id prefix, because two gradients
   * sharing an id on one page is a collision - only the first one paints.
   *
   * The colours mean something and are shared with the other cards: blue is
   * the grid / a cycle of exchange, green is the battery, amber is production,
   * slate is neutral.
   *
   * Every icon sits on a soft tinted circle (see ICON_TINT). The badge does the
   * colouring, so each glyph stays one colour with one bold shape - the only
   * composition that still reads at 20 px next to a 15 px label.
   *
   * `icon:` takes one of these names, or any other string, which is rendered
   * as text (that is how the emoji configs kept working).
   * ------------------------------------------------------------------ */
  const ICON_SVG = {
    /* ---- production ---- */

    /* A four-cell module on a stand.
     *
     * Drawn as a real 2x2 array rather than a single block: the gap between the
     * cells is what makes it read as a panel instead of a yellow brick, and the
     * stand keeps it from floating. Cell gaps are equal horizontally and
     * vertically (1.5) so the four cells look like one grid, and the two bottom
     * cells are not cut off by the stem. */
    panel: (u) => `
      <defs><linearGradient id="${u}pg" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <g fill="url(#${u}pg)">
        <rect x="2.9" y="2.6" width="8.4" height="5.4" rx="1.5"/>
        <rect x="12.7" y="2.6" width="8.4" height="5.4" rx="1.5"/>
        <rect x="2.9" y="9.5" width="8.4" height="5.4" rx="1.5"/>
        <rect x="12.7" y="9.5" width="8.4" height="5.4" rx="1.5"/>
      </g>
      <g stroke="#f59e0b" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 15.8v3.5"/>
        <path d="M8.3 19.9h7.4"/>
      </g>`,

    /* A sun, for anyone who prefers the abstract reading. */
    sun: (u) => `
      <defs><radialGradient id="${u}su" cx=".36" cy=".3" r=".8">
        <stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/>
      </radialGradient></defs>
      <g stroke="#f59e0b" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 1.9v2.2"/><path d="M12 19.9v2.2"/>
        <path d="M1.9 12h2.2"/><path d="M19.9 12h2.2"/>
        <path d="M4.9 4.9 6.5 6.5"/><path d="M17.5 17.5l1.6 1.6"/>
        <path d="M19.1 4.9 17.5 6.5"/><path d="M6.5 17.5l-1.6 1.6"/>
      </g>
      <circle cx="12" cy="12" r="5.2" fill="url(#${u}su)"/>`,

    /* ---- discharge: two arrows chasing each other round a dot ---- */

    /* Not one rotated ring with a single head: two separate arcs, each with its
     * own arrowhead, so the eye reads "energy going round and coming back"
     * instead of "refresh this page".
     *
     * The arcs are symmetrical - 156 degrees of sweep each, 12 degrees of gap
     * at the ends - and each head is a triangle laid along the tangent at that
     * end, which is why they both point clockwise. Hand-computed: the tangent
     * at angle t is (sin t, cos t) in screen coordinates. */
    cycle: () => `
      <g fill="none" stroke="#3b82f6" stroke-width="2.3" stroke-linecap="round">
        <path d="M4.76 10.46A7.4 7.4 0 0 1 19.24 10.46"/>
        <path d="M19.24 13.54A7.4 7.4 0 0 1 4.76 13.54"/>
      </g>
      <path fill="#3b82f6" d="M19.76 12.91 17.18 10.9 21.29 10.02z"/>
      <path fill="#3b82f6" d="M4.24 11.09 6.82 13.1 2.71 13.98z"/>
      <circle cx="12" cy="12" r="2.9" fill="#2563eb"/>`,

    /* ---- charge: a battery with a bolt in it ---- */

    /* Taller than wide, unlike a pill: the terminal on the right is what says
     * "battery", and a squat body made it look like a power bank lying down.
     * The bolt is a real lightning polygon, scaled and centred inside the body
     * with equal margins top and bottom, instead of a squiggle that touched the
     * frame. */
    battery: (u) => `
      <defs><linearGradient id="${u}bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/>
      </linearGradient></defs>
      <rect x="2.6" y="4.6" width="14.2" height="14.8" rx="3.4" fill="none"
        stroke="url(#${u}bg)" stroke-width="2.3"/>
      <rect x="18.2" y="9.3" width="2.7" height="5.4" rx="1.35" fill="#16a34a"/>
      <path fill="url(#${u}bg)"
        d="M10.82 6.4 6.06 12.56h3.08l-.56 5.04 4.76-6.16h-3.08z"/>`,

    /* A tilted blue panel with a small amber sun: unambiguous "this is PV". */
    solar: (u) => `
      <defs><linearGradient id="${u}sp" x1="0" y1="0" x2=".4" y2="1">
        <stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#2563eb"/>
      </linearGradient></defs>
      <path fill="url(#${u}sp)" d="M4.3 21.6h13.5l2.4-10.1H6.7z"/>
      <g stroke="#dbeafe" stroke-width="1.05" stroke-opacity=".8">
        <path d="M9.6 11.5 8.1 21.6"/><path d="M13.9 11.5l-.2 10.1"/>
        <path d="M18.2 11.5l1.9 10.1"/>
        <path d="M5.4 15.2h14.4"/><path d="M4.5 18.4h15.4"/>
      </g>
      <circle cx="18.6" cy="5.2" r="2.9" fill="#f59e0b"/>
      <g stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round">
        <path d="M18.6 1v1.1"/><path d="M22.8 5.2h-1.1"/><path d="M21.6 2.2l-.8.8"/>
      </g>`,

    /* Three amber rays landing on a glowing base: "energy arriving". */
    rays: (u) => `
      <defs><linearGradient id="${u}ra" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <g stroke="url(#${u}ra)" stroke-width="2.5" stroke-linecap="round" fill="none">
        <path d="M12 2.4v8.2"/>
        <path d="M5.6 4.6l3.3 6.5"/>
        <path d="M18.4 4.6l-3.3 6.5"/>
      </g>
      <rect x="3.2" y="13.8" width="17.6" height="6.6" rx="3.3" fill="#f59e0b"/>`,

    /* ---- energy flow (sankey title) ---- */

    /* Three coloured sources merging into one thick slate line. */
    flow: (u) => `
      <g fill="none" stroke-linecap="round" stroke-width="2.5">
        <path d="M2.2 5.4h3.3l3.7 5.3" stroke="#f59e0b"/>
        <path d="M2.2 12h7" stroke="#22c55e"/>
        <path d="M2.2 18.6h3.3l3.7-5.3" stroke="#3b82f6"/>
        <path d="M10.9 12h10.9" stroke="#94a3b8" stroke-width="3.4"/>
      </g>
      <circle cx="9.9" cy="12" r="1.8" fill="#94a3b8"/>`,

    /* Two source nodes and a sink, joined by ribbons: a sankey diagram. */
    sankey: (u) => `
      <rect x="1.5" y="2.8" width="2.7" height="6.6" rx="1.1" fill="#f59e0b"/>
      <rect x="1.5" y="14.6" width="2.7" height="6.6" rx="1.1" fill="#22c55e"/>
      <rect x="19.8" y="6.2" width="2.7" height="11.6" rx="1.1" fill="#3b82f6"/>
      <g fill="none" stroke-width="1.9" stroke-linecap="round">
        <path d="M4.6 6.1c3.3 0 5.9 4.3 8.6 4.3 2.1 0 3.3-.8 6.1-1.6"
          stroke="#f59e0b" stroke-opacity=".8"/>
        <path d="M4.6 17.9c3.3 0 5.9-4.3 8.6-4.3 2.1 0 3.3.8 6.1 1.6"
          stroke="#22c55e" stroke-opacity=".8"/>
      </g>`,

    /* Two arrows in opposite directions: "in and out", an exchange. */
    swap: (u) => `
      <g stroke-linecap="round" stroke-width="2.1" fill="none">
        <path d="M3 8.4h13.4" stroke="#f59e0b"/>
        <path d="M21 15.6H7.6" stroke="#22c55e"/>
      </g>
      <path fill="#f59e0b" d="M14.9 4.9 20.2 8.4l-5.3 3.5z"/>
      <path fill="#22c55e" d="M9.1 12.1 3.8 15.6L9.1 19.1z"/>`,

    /* A neutral fallback, so an unknown name is never invisible. */
    dot: () => `<circle cx="12" cy="12" r="4.2" fill="currentColor"/>`,
  };

  /* The tinted circle behind each glyph.
   *
   * 16 % alpha rather than a solid pastel, so the same badge looks right on a
   * white card and on a dark theme - a solid #fef3c7 chip turns into a glowing
   * disc the moment the theme flips. */
  const ICON_TINT = {
    panel: "rgba(245, 158, 11, .16)",
    sun: "rgba(245, 158, 11, .16)",
    cycle: "rgba(59, 130, 246, .15)",
    battery: "rgba(34, 197, 94, .16)",
    /* The three older names point at the current glyphs: a dashboard written
     * before the redesign keeps its look without being regenerated. */
    batOut: "rgba(59, 130, 246, .15)",
    batIn: "rgba(34, 197, 94, .16)",
    flow: "rgba(148, 163, 184, .16)",
    sankey: "rgba(148, 163, 184, .16)",
    swap: "rgba(148, 163, 184, .16)",
    dot: "rgba(148, 163, 184, .16)",
  };

  /* Names kept from before the redesign, mapped onto the new glyphs. */
  Object.assign(ICON_SVG, {
    batOut: ICON_SVG.cycle,
    batIn: ICON_SVG.battery,
  });

  /* Every name the card understands, exported for the docs and the editor. */
  const ICON_NAMES = Object.keys(ICON_SVG);

  class HoymilesGauge extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object } };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-gauge-editor");
    }

    static getStubConfig() {
      return { entity: "", name: "" };
    }

    static get styles() {
      return css`
        /* The card fills whatever height its grid cell gives it, so it can be
           stacked next to a taller neighbour without leaving a ragged bottom
           edge.  In an auto-height container this resolves to the natural
           height, i.e. nothing changes. */
        :host { display: block; height: 100%; }
        ha-card { padding: 14px 16px 8px; height: 100%; box-sizing: border-box;
                  display: flex; flex-direction: column; }
        .head { display: flex; align-items: flex-start;
                justify-content: space-between; gap: 10px; }
        /* Takes the slack when the card is taller than its content: the readout
           and the arch stay together, centred in the space that is left. */
        .body { flex: 1 1 auto; min-height: 0;
                display: flex; flex-direction: column; justify-content: center; }
        .name { font-size: 15px; font-weight: 500;
                color: var(--primary-text-color); line-height: 1.3; }
        .icon { font-size: 19px; line-height: 1; flex: none;
                display: flex; align-items: center; }
        /* The glyph sits on a tinted disc, which is what gives the three tiles
           a common shape while keeping each icon one colour.  The tint is an
           inline background because it belongs to the icon, not to the card. */
        .icon .badge { width: 36px; height: 36px; border-radius: 50%;
                       display: flex; align-items: center;
                       justify-content: center; }
        .icon svg { display: block; }
        .readout { display: flex; align-items: baseline; gap: 6px;
                   margin: 10px 0 0; }
        .value { font-size: 34px; font-weight: 700;
                 color: var(--primary-text-color); letter-spacing: 0.3px; }
        .unit { font-size: 15px; color: var(--secondary-text-color); }
        .dial { margin-top: -4px; }
        .dial svg { display: block; width: 100%; height: auto; }
        .pct { font-size: 26px; font-weight: 600;
               fill: var(--primary-text-color); }
        .cap { font-size: 12.5px; fill: var(--secondary-text-color); }
        .na { font-size: 13px; color: var(--secondary-text-color);
              text-align: center; padding: 24px 0; }
      `;
    }

    /**
     * Language changes are announced on `window`; re-rendering is all a card
     * has to do, because the wording is chosen while it renders.  This card has
     * no `_t()` of its own, but its `name` / `label` maps do follow the language.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
    }

    setConfig(config) {
      if (!config || !config.entity) {
        throw new Error("hoymiles-gauge: 'entity' is required");
      }
      this._config = { ...config };
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
    }

    getCardSize() {
      return 3;
    }

    /* ---------------------------- the numbers ---------------------------- */

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
    }

    _read() {
      const entityId = this._config.entity;
      const state = this._hass && this._hass.states ? this._hass.states[entityId] : null;
      if (!state || ["unknown", "unavailable", ""].includes(String(state.state))) {
        return null;
      }
      const scale = this._config.scale == null ? 1 : num(this._config.scale);
      return num(state.state) * scale;
    }

    _decimals() {
      return this._config.decimals == null ? 2 : num(this._config.decimals);
    }

    _unit() {
      if (this._config.unit) return this._config.unit;
      const state = this._hass && this._hass.states
        ? this._hass.states[this._config.entity] : null;
      return (state && state.attributes && state.attributes.unit_of_measurement) || "";
    }

    _max() {
      if (this._config.max != null) return num(this._config.max);
      const value = this._read();
      if (value == null) return 100;
      // Grow the dial gently so the arc stays informative.
      if (value <= 0) return 1;
      const exp = Math.pow(10, Math.floor(Math.log10(value)));
      return Math.ceil(value / exp) * exp;
    }

    /**
     * A numeric state, or null when it is missing or unusable.  Deliberately not
     * `_read()`: that one applies `scale` for the readout, while a ratio mixes
     * entities whose units cancel out, so only the raw numbers belong here.
     */
    _entityNumber(entityId) {
      const state = this._hass && this._hass.states ? this._hass.states[entityId] : null;
      if (!state) return null;
      const raw = String(state.state);
      if (["unknown", "unavailable", ""].includes(raw)) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }

    /**
     * The arch fraction asked for by `percent_numerator` et al, or null to fall
     * back to value/max.  See the header comment: self consumption is
     * `(发电量 − 上网电量) / 发电量`.  `percent_subtract` is taken as a magnitude,
     * because "how much was exported" is a quantity - the sign convention of the
     * source entity must not flip the ratio.
     */
    _ratio() {
      const config = this._config || {};
      if (!config.percent_numerator) return null;
      const numerator = this._entityNumber(config.percent_numerator);
      const denominator = config.percent_denominator
        ? this._entityNumber(config.percent_denominator)
        : numerator;
      const subtract = config.percent_subtract
        ? this._entityNumber(config.percent_subtract)
        : 0;
      if (numerator == null || denominator == null || subtract == null) return null;
      if (!(denominator > 0)) return null; // nothing to divide by yet
      return clamp((numerator - Math.abs(subtract)) / denominator, 0, 1);
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const value = this._read();
      const name = this._text(this._config.name) || this._config.entity;
      const icon = this._config.icon == null ? "" : String(this._config.icon);
      const min = this._config.min == null ? 0 : num(this._config.min);
      const max = Math.max(this._max(), 1e-9);
      // A configured ratio wins over value/max: it is the number the arch is
      // asked to show, and a made-up `max` only ever produced a meaningless
      // percentage.  When a ratio is configured but cannot be computed (an
      // entity is briefly unknown after a restart, say) the arch shows "—"
      // rather than falling back to that meaningless percentage; the readout
      // above it keeps showing whatever it has.
      const ratioWanted = !!this._config.percent_numerator;
      const ratio = this._ratio();
      const dialHasValue = ratioWanted ? ratio != null : value != null;
      const frac = ratio != null ? ratio
        : (dialHasValue && value != null ? clamp((value - min) / (max - min || 1), 0, 1) : 0);
      const shown = value == null ? "—" : group(value.toFixed(this._decimals()));
      const unit = this._unit();
      // `show_arc: false` drops the whole indicator: no arch, no percentage, no
      // empty space where they used to be.  Checked against `false` so an absent
      // option keeps the arch.
      const dial = this._config.show_arc === false ? "" : this._arc(frac, dialHasValue);

      return html`
        <ha-card>
          <div class="head">
            <div class="name">${esc(name)}</div>
            ${this._icon(icon)}
          </div>
          <div class="body">
            <div class="readout">
              <span class="value">${shown}</span>
              ${unit === "" || value == null ? "" : html`<span class="unit">${esc(unit)}</span>`}
            </div>
            ${dial === "" ? "" : html`<div class="dial">${this._untrusted(dial)}</div>`}
          </div>
        </ha-card>
      `;
    }

    /**
     * The header icon: a named SVG from the built-in set, or plain text.
     *
     * A name that is not in the set falls through to text, which is how the
     * emoji configs (`icon: ☀️`) written before the set existed keep working.
     * The SVG is injected as a string because a `<path>` built inside a lit
     * template is parsed in the HTML namespace and never paints; the HTML
     * parser, on the other hand, handles SVG foreign content properly.
     */
    _icon(name) {
      if (!name) return "";
      const build = ICON_SVG[name];
      if (!build) return html`<div class="icon">${esc(name)}</div>`;
      const uid = "hmg" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-";
      const tint = ICON_TINT[name] || ICON_TINT.dot;
      const svg = `<svg viewBox="0 0 24 24" width="22" height="22" `
        + `xmlns="http://www.w3.org/2000/svg">${build(uid)}</svg>`;
      return html`<div class="icon"><span class="badge"
        style="background:${tint}">${this._untrusted(svg)}</span></div>`;
    }

    /**
     * The arch, as one `<svg>` string.
     *
     * It has to be a single string that starts with `<svg>`: markup parsed
     * outside an SVG context lands in the HTML namespace, and the browser then
     * silently refuses to draw it (that is why the arcs used to be invisible).
     */
    _arc(frac, hasValue = true) {
      const color = this._config.color || DEFAULT_COLOR;
      const percent = Math.round(frac * 100);
      const track = `<path d="${arcPath(0, 1, R_ARC)}" fill="none"`
        + ` stroke="var(--divider-color)" stroke-width="${ARC_STROKE}"`
        + ` stroke-linecap="round" opacity="0.45"/>`;
      const progress = !hasValue || frac <= 0.002 ? ""
        : `<path d="${arcPath(0, frac, R_ARC)}" fill="none"`
          + ` stroke="${esc(color)}" stroke-width="${ARC_STROKE}"`
          + ` stroke-linecap="round"/>`;
      const caption = this._config.label == null ? ""
        : `<text class="cap" x="${CX}" y="${LABEL_Y}"`
          + ` text-anchor="middle">${esc(this._text(this._config.label))}</text>`;

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"`
        + ` xmlns="http://www.w3.org/2000/svg" role="img">`
        + `${track}${progress}`
        + `<text class="pct" x="${CX}" y="${PCT_Y}"`
        + ` text-anchor="middle">${hasValue ? `${percent}%` : "—"}</text>`
        + `${caption}</svg>`;
    }

    _untrusted(markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      return template.content.cloneNode(true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesGaugeEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, hass: { type: Object } };
    }

    setConfig(config) {
      this._config = { ...(config || {}) };
    }

    _changed(field) {
      return (event) => {
        const config = { ...(this._config || {}), [field]: event.target.value };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    static get styles() {
      return css`
        .row { padding: 8px; }
        ha-textfield { display: block; width: 100%; margin-bottom: 8px; }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="entity (required)" .value=${config.entity || ""}
            @change=${this._changed("entity")}></ha-textfield>
          <ha-textfield label="name (accepts an en/zh map)" .value=${hmField(config.name)}
            @change=${this._changed("name")}></ha-textfield>
          <ha-textfield label="unit" .value=${config.unit || ""}
            @change=${this._changed("unit")}></ha-textfield>
          <ha-textfield label="scale" .value=${config.scale || ""}
            @change=${this._changed("scale")}></ha-textfield>
          <ha-textfield label="max" .value=${config.max || ""}
            @change=${this._changed("max")}></ha-textfield>
          <ha-textfield label="icon (a name from the icon set, or any text / emoji)"
            .value=${config.icon || ""}
            @change=${this._changed("icon")}></ha-textfield>
          <ha-textfield label="label (caption under the percentage; accepts an en/zh map)" .value=${hmField(config.label)}
            @change=${this._changed("label")}></ha-textfield>
          <ha-textfield label="color (default #22c55e)" .value=${config.color || ""}
            @change=${this._changed("color")}></ha-textfield>
          <ha-textfield label="show_arc (false = drop the arc and its percentage)"
            .value=${config.show_arc === false ? "false" : ""}
            @change=${this._changed("show_arc")}></ha-textfield>
          <ha-textfield label="percent_numerator (numerator of the arc percentage)"
            .value=${config.percent_numerator || ""}
            @change=${this._changed("percent_numerator")}></ha-textfield>
          <ha-textfield label="percent_subtract (optional, taken off the numerator)"
            .value=${config.percent_subtract || ""}
            @change=${this._changed("percent_subtract")}></ha-textfield>
          <ha-textfield label="percent_denominator (optional, defaults to the numerator)"
            .value=${config.percent_denominator || ""}
            @change=${this._changed("percent_denominator")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-gauge-editor")) {
    customElements.define("hoymiles-gauge-editor", HoymilesGaugeEditor);
  }
  if (!customElements.get("hoymiles-gauge")) {
    customElements.define("hoymiles-gauge", HoymilesGauge);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-gauge")) {
    window.customCards.push({
      type: "hoymiles-gauge",
      name: "Hoymiles Gauge",
      description: "Arc gauge with needle and colour bands; rescales Wh to kWh for display.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmGaugeRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmGaugeRegister());
}
