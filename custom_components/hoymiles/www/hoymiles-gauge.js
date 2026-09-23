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
 *   icon: ☀️                   # optional, shown next to the title
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
        :host { display: block; }
        ha-card { padding: 14px 16px 8px; }
        .head { display: flex; align-items: flex-start;
                justify-content: space-between; gap: 10px; }
        .name { font-size: 15px; font-weight: 500;
                color: var(--primary-text-color); line-height: 1.3; }
        .icon { font-size: 19px; line-height: 1; flex: none; }
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
      const name = this._config.name || this._config.entity;
      const icon = this._config.icon == null ? "" : String(this._config.icon);
      const min = this._config.min == null ? 0 : num(this._config.min);
      const max = Math.max(this._max(), 1e-9);
      // A configured ratio wins over value/max: it is the number the arch is
      // asked to show, and a made-up `max` only ever produced a meaningless
      // percentage.  A missing state still draws the empty arch: a bare "-" on a
      // blank card reads like a broken card, an arc at 0 % does not.
      const ratio = this._ratio();
      const hasValue = value != null || ratio != null;
      const frac = ratio != null ? ratio
        : (value == null ? 0 : clamp((value - min) / (max - min || 1), 0, 1));
      const shown = value == null ? "—" : group(value.toFixed(this._decimals()));
      const unit = this._unit();
      // `show_arc: false` drops the whole indicator: no arch, no percentage, no
      // empty space where they used to be.  Checked against `false` so an absent
      // option keeps the arch.
      const dial = this._config.show_arc === false ? "" : this._arc(frac, hasValue);

      return html`
        <ha-card>
          <div class="head">
            <div class="name">${esc(name)}</div>
            ${icon === "" ? "" : html`<div class="icon">${esc(icon)}</div>`}
          </div>
          <div class="readout">
            <span class="value">${shown}</span>
            ${unit === "" || value == null ? "" : html`<span class="unit">${esc(unit)}</span>`}
          </div>
          ${dial === "" ? "" : html`<div class="dial">${this._untrusted(dial)}</div>`}
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
          + ` text-anchor="middle">${esc(this._config.label)}</text>`;

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
          <ha-textfield label="name" .value=${config.name || ""}
            @change=${this._changed("name")}></ha-textfield>
          <ha-textfield label="unit" .value=${config.unit || ""}
            @change=${this._changed("unit")}></ha-textfield>
          <ha-textfield label="scale" .value=${config.scale || ""}
            @change=${this._changed("scale")}></ha-textfield>
          <ha-textfield label="max" .value=${config.max || ""}
            @change=${this._changed("max")}></ha-textfield>
          <ha-textfield label="icon (emoji)" .value=${config.icon || ""}
            @change=${this._changed("icon")}></ha-textfield>
          <ha-textfield label="label (百分比下的说明)" .value=${config.label || ""}
            @change=${this._changed("label")}></ha-textfield>
          <ha-textfield label="color (default #22c55e)" .value=${config.color || ""}
            @change=${this._changed("color")}></ha-textfield>
          <ha-textfield label="show_arc (false = 不要弧线和百分比）"
            .value=${config.show_arc === false ? "false" : ""}
            @change=${this._changed("show_arc")}></ha-textfield>
          <ha-textfield label="percent_numerator (弧线百分比的分子)"
            .value=${config.percent_numerator || ""}
            @change=${this._changed("percent_numerator")}></ha-textfield>
          <ha-textfield label="percent_subtract (可选，从分子减掉)"
            .value=${config.percent_subtract || ""}
            @change=${this._changed("percent_subtract")}></ha-textfield>
          <ha-textfield label="percent_denominator (可选，默认=分子)"
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
