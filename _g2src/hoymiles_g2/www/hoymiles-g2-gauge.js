/* ============================================================================
 * Hoymiles Micro Storage — Gauge card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-gauge`
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
 *   type: custom:hoymiles-g2-gauge
 *   entity: sensor.x_battery_discharge_energy_today
 *   name: 当日发电量
 *   unit: kWh                 # optional display unit
 *   scale: 0.001              # optional multiplier applied before display
 *   max: 5                    # optional (in display units)
 *   min: 0                    # optional (default 0)
 *   decimals: 2               # optional (default 2)
 *   icon: ☀️                   # optional, shown next to the title; an emoji,
 *                             #   an `mdi:<name>`, or one of the named
 *                             #   drawings in `ICON_SVG` (`panel`, `sun`,
 *                             #   `cycle`, `battery`, `solar`, `rays`, `flow`,
 *                             #   `sankey`, `swap`, `all`)
 *   label: 自发自用率          # optional caption under the percentage
 *   color: "#22c55e"          # optional arc colour (default green)
 *   show_arc: false           # optional, drop the arch and its percentage
 *                             #   altogether - the card is then just the
 *                             #   readout (default true)
 *   compact: true             # optional, read the tile sideways: the name and
 *                             #   the reading share one line instead of
 *                             #   stacking, so the card is roughly half as
 *                             #   tall.  Meant for a stack of tiles in a
 *                             #   narrow column (the System tab's 今日/总发电量)
 *                             #   where the full tile costs more height than
 *                             #   the numbers are worth.  No arch in this mode.
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

  /* The shared language module (`hoymiles-g2-i18n.js`) is injected before this
   * file, so `window.HoymilesG2I18n` is already there.  The fallback below only
   * matters if that asset failed to load - the cards then keep rendering in the
   * Home Assistant UI language instead of breaking. */
  const I18N = window.HoymilesG2I18n || {
    lang(hass, config) {
      const wanted = config && config.language;
      const ui = wanted || (hass && hass.language);
      return String(ui || "").toLowerCase().startsWith("zh") ? "zh" : "en";
    },
    text(value, lang) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const hit = value[lang];
        if (hit != null) return hit;
        if (value.en != null) return value.en;
        const first = Object.values(value)[0];
        return first == null ? "" : first;
      }
      return value;
    },
    field: (value) => (typeof value === "string" ? value : ""),
    pick(current, en, zh) {
      return current === "zh" ? zh : en;
    },
    watch: () => {},
    unwatch: () => {},
  };

  /* ------------------------------------------------------------------ *
   * Language
   *
   * Resolved by the shared `hoymiles-g2-i18n.js` module, which mirrors the
   * official integration's toolbar switch: an explicit choice stored under
   * `hoymiles.language` wins, then a per-card `language:`, then the Home
   * Assistant user's own language.  `en`, `zh` and `de` are supported.
   * ------------------------------------------------------------------ */
  const hmLang = (hass, config) => I18N.lang(hass, config);

  /* ------------------------------------------------------------------ *
   * Localised config strings
   *
   * A config value may be a plain string (used as-is, so every existing
   * dashboard keeps working) or a language map:
   *
   *   title:
   *     en: Battery packs
   *     zh: 电池包
   *
   * That is what lets the text *you* write follow the UI language too, instead
   * of pinning a dashboard to one language. A map missing the current language
   * falls back to `en`, then to whichever entry exists.
   * ------------------------------------------------------------------ */
  const hmText = (value, lang) => I18N.text(value, lang);

  /** A text field can only hold a plain string, so a language map shows empty. */
  const hmField = (value) => I18N.field(value);

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

  /* ------------------------------------------------------------------ *
   * Head artwork.
   *
   * `icon` used to be an emoji and nothing else.  The vendor app draws a few of
   * its summary icons as line art instead, and the ones that matter here have no
   * Material equivalent - the lifetime counter's "All" is a broken ring with
   * lettering inside it, and no `mdi:` icon carries text.  So the option now
   * accepts three shapes: an emoji (printed as text), an `mdi:<name>` (handed to
   * `<ha-icon>`, i.e. the same icon set the stock dashboard uses), and a key of
   * `ICON_SVG` (drawn here, at whatever size the card can give it).
   * ------------------------------------------------------------------ */
  /* The built-in icon set, matching the official Hoymiles cards name for name.
     Each entry is a function of a unique id prefix `u`, because several cards
     can sit on one page and two gradients sharing an id would clash. */
  const ICON_SVG = {
    /* ---- production ---- */

    /* A four-cell module on a stand.  Drawn as a real 2x2 array rather than a
       single block: the gap between the cells is what makes it read as a panel
       instead of a yellow brick, and the stand keeps it from floating. */
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
       own arrowhead, so the eye reads "energy going round and coming back"
       instead of "refresh this page".  The arcs are symmetrical - 156 degrees of
       sweep each, 12 degrees of gap at the ends. */
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
       "battery", and a squat body made it look like a power bank lying down. */
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

    /* ---- energy flow ---- */

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

    /* The lifetime counter: a broken ring with "All" inside it, because no
       Material icon carries lettering.

       A function like every other entry, even though it needs no uid: the
       lookup in `_iconMarkup()` calls `build(uid)`, so a plain string here
       threw `build is not a function` and took the whole card down with it -
       which is why the "PV total" tile vanished from the System view. */
    all: () =>
      "<g fill=\"none\" stroke=\"#3b9de8\" stroke-width=\"2.1\" stroke-linecap=\"round\">"
      + "<path d=\"M13.64 3.56A8.6 8.6 0 0 1 13.64 20.44\"/>"
      + "<path d=\"M10.36 20.44A8.6 8.6 0 0 1 10.36 3.56\"/>"
      + "</g>"
      + "<text x=\"12\" y=\"12.2\" text-anchor=\"middle\" dominant-baseline=\"central\""
      + " font-size=\"7.6\" font-weight=\"700\" fill=\"#3b9de8\""
      + " font-family=\"inherit\">All</text>",

    /* A neutral fallback, so an unknown name is never invisible. */
    dot: () => `<circle cx="12" cy="12" r="4.2" fill="currentColor"/>`,
  };

  /* Older names point at the current glyphs, so a dashboard written before this
     set existed keeps its look without being regenerated. */
  ICON_SVG.batOut = ICON_SVG.cycle;
  ICON_SVG.batIn = ICON_SVG.battery;

  /* The tinted disc behind each glyph.  16 % alpha rather than a solid pastel,
     so the same badge looks right on a white card and on a dark theme. */
  const ICON_TINT = {
    panel: "rgba(245, 158, 11, .16)",
    sun: "rgba(245, 158, 11, .16)",
    rays: "rgba(245, 158, 11, .16)",
    cycle: "rgba(59, 130, 246, .15)",
    battery: "rgba(34, 197, 94, .16)",
    solar: "rgba(37, 99, 235, .14)",
    batOut: "rgba(59, 130, 246, .15)",
    batIn: "rgba(34, 197, 94, .16)",
    flow: "rgba(148, 163, 184, .16)",
    sankey: "rgba(148, 163, 184, .16)",
    swap: "rgba(148, 163, 184, .16)",
    all: "rgba(59, 157, 232, .14)",
    dot: "rgba(148, 163, 184, .16)",
  };

  /* Every name the card understands, listed in the editor hint. */
  const ICON_NAMES = Object.keys(ICON_SVG).filter((n) => n !== "batOut" && n !== "batIn");

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
      return document.createElement("hoymiles-g2-gauge-editor");
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
        /* The glyph sits on a tinted disc, which is what gives the tiles a
           common shape while keeping each icon one colour.  The tint is an
           inline background because it belongs to the icon, not to the card. */
        .icon .badge { width: 36px; height: 36px; border-radius: 50%;
                       display: flex; align-items: center;
                       justify-content: center; }
        .icon svg { display: block; }
        .icon ha-icon { --mdc-icon-size: 22px; }
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

        /* Compact tile: one line, name on the left and the reading on the
           right, roughly half the height of a full tile.  Used where a narrow
           column has to carry two numbers without spending a whole card each.
           The row is centred vertically because the cell it lands in is usually
           half of a taller neighbour, and one line pinned to the top of that
           box reads as a layout mistake rather than as a small tile. */
        ha-card.compact { padding: 10px 16px; justify-content: center; }
        .row { display: flex; align-items: center; gap: 10px; min-height: 26px; }
        .row .name { font-size: 13.5px; font-weight: 500; flex: 1 1 auto;
                     min-width: 0; overflow: hidden; text-overflow: ellipsis;
                     white-space: nowrap; }
        .row .readout { margin: 0; flex: 0 0 auto; gap: 4px; }
        .row .value { font-size: 26px; font-weight: 700; }
        .row .unit { font-size: 13px; }
        .row .icon { flex: 0 0 auto; }
        .row .icon .badge { width: 28px; height: 28px; }
        .row .icon ha-icon { --mdc-icon-size: 18px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.entity) {
        throw new Error("hoymiles-g2-gauge: 'entity' is required");
      }
      this._config = { ...config };
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
    }

    /** The language this card should render in (`en` | `zh` | `de`). */
    _lang() {
      return hmLang(this._hass, this._config);
    }

connectedCallback() {
      super.connectedCallback();
      /* The toolbar language switch only writes localStorage and fires
         `hoymiles-language`; it never touches `hass.language`, so without this
         the card would keep its old wording until a page reload. */
      I18N.watch(this);
    }

    disconnectedCallback() {
      I18N.unwatch(this);
      super.disconnectedCallback();
    }

    getCardSize() {
      /* A compact tile is one text line plus its padding, i.e. one row of a
         sections grid instead of three. */
      return this._compact() ? 1 : 3;
    }

    /** True when the tile is asked to render as one line.
     *
     * The visual editor stores every field as the string the user typed, so
     * ``"true"`` has to mean the same as ``true`` here; YAML hands over a real
     * boolean.  ``false`` and anything else keeps the full tile - the option is
     * opt-in, never a surprise.
     */
    _compact() {
      const value = this._config && this._config.compact;
      return value === true || value === "true";
    }

    /* ---------------------------- the numbers ---------------------------- */

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, this._lang());
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

      /* Compact mode: the same two pieces of information on one line.  It is a
         different tree rather than a CSS variant because the order changes - the
         reading has to come after the name for a flex row to lay it out right,
         and the arch is never drawn (a tile this short has no room for one). */
      if (this._compact()) {
        return html`
          <ha-card class="compact">
            <div class="row">
              <div class="name">${esc(name)}</div>
              <div class="readout">
                <span class="value">${shown}</span>
                ${unit === "" || value == null ? "" : html`<span class="unit">${esc(unit)}</span>`}
              </div>
              ${icon === "" ? "" : html`<div class="icon">${this._iconMarkup(icon)}</div>`}
            </div>
          </ha-card>
        `;
      }

      return html`
        <ha-card>
          <div class="head">
            <div class="name">${esc(name)}</div>
            ${icon === "" ? "" : html`<div class="icon">${this._iconMarkup(icon)}</div>`}
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

    /**
     * The head icon: a named drawing from `ICON_SVG`, an `mdi:` icon, or text.
     *
     * The SVG is injected as a string because a `<path>` built inside a lit
     * template is parsed in the HTML namespace and never paints; the HTML
     * parser, on the other hand, handles SVG foreign content properly.  The
     * text case stays a plain DOM text node, so an emoji never goes through
     * `innerHTML`.
     */
    _iconMarkup(icon) {
      const build = ICON_SVG[icon];
      if (build) {
        /* Every entry of `ICON_SVG` is a drawing *function* taking the id
         * prefix it must use for its own gradients - a plain string here
         * used to sail through the truthiness check and then throw on the
         * call, which lit turns into a blank card with no message at all.
         * Calling only when it really is a function keeps a stray string
         * entry visible as a slightly odd icon instead of an empty card. */
        const body = typeof build === "function" ? build(
          "hmg" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-",
        ) : String(build);
        const tint = ICON_TINT[icon] || ICON_TINT.dot;
        const svg = `<svg viewBox="0 0 24 24" width="22" height="22"`
          + ` xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.style.background = tint;
        badge.appendChild(this._untrusted(svg));
        return badge;
      }
      if (icon.startsWith("mdi:")) {
        const el = document.createElement("ha-icon");
        el.setAttribute("icon", icon);
        return el;
      }
      return document.createTextNode(icon);
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
          <ha-textfield label="icon (${ICON_NAMES.join(" / ")}, an mdi:name, or any text)"
            .value=${config.icon || ""}
            @change=${this._changed("icon")}></ha-textfield>
          <ha-textfield label="label (caption under the percentage; accepts an en/zh map)" .value=${hmField(config.label)}
            @change=${this._changed("label")}></ha-textfield>
          <ha-textfield label="color (default #22c55e)" .value=${config.color || ""}
            @change=${this._changed("color")}></ha-textfield>
          <ha-textfield label="show_arc (false = drop the arc and its percentage)"
            .value=${config.show_arc === false ? "false" : ""}
            @change=${this._changed("show_arc")}></ha-textfield>
          <ha-textfield label="compact (true = name and reading on one line, half height)"
            .value=${config.compact === true ? "true" : ""}
            @change=${this._changed("compact")}></ha-textfield>
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

  if (!customElements.get("hoymiles-g2-gauge-editor")) {
    customElements.define("hoymiles-g2-gauge-editor", HoymilesGaugeEditor);
  }
  if (!customElements.get("hoymiles-g2-gauge")) {
    customElements.define("hoymiles-g2-gauge", HoymilesGauge);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-gauge")) {
    window.customCards.push({
      type: "hoymiles-g2-gauge",
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
