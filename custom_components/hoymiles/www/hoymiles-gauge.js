/* ============================================================================
 * Hoymiles Micro Storage — Gauge card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-gauge`
 *
 * A single-value arc gauge with a needle and colour bands, matching the vendor
 * app's stat dials (今日发电量 / 今日放电量 / 今日充电量, 电池 SOC ...).
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
 *   name: 今日放电量
 *   unit: kWh                 # optional display unit
 *   scale: 0.001              # optional multiplier applied before display
 *   max: 5                    # optional (in display units)
 *   decimals: 2               # optional (default 2)
 *   severity:                 # optional, in display units
 *     green: 3
 *     yellow: 1
 *     red: 0
 * ========================================================================== */

function _hmGaugeRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  const VB_W = 220;
  const VB_H = 150;
  const CX = VB_W / 2;
  const CY = 118;
  const R = 82;
  const STROKE = 15;
  const START_DEG = 135;   // bottom-left
  const SWEEP_DEG = 270;   // ends bottom-right

  const LEVEL_COLORS = {
    red: "#db4437",
    yellow: "#ffa600",
    orange: "#ffa600",
    green: "#0da035",
    blue: "#4a90d9",
  };

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
        ha-card { padding: 10px 12px 12px; }
        .name { font-size: 13px; color: var(--secondary-text-color);
                text-align: center; margin-top: 2px; }
        svg { display: block; width: 100%; height: auto; }
        .value { font-size: 27px; font-weight: 600;
                 fill: var(--primary-text-color); letter-spacing: 0.3px; }
        .unit { font-size: 13px; fill: var(--secondary-text-color); }
        .na { font-size: 13px; color: var(--secondary-text-color);
              text-align: center; padding: 28px 0; }
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
      // Grow the dial gently so the needle stays informative.
      if (value <= 0) return 1;
      const exp = Math.pow(10, Math.floor(Math.log10(value)));
      return Math.ceil(value / exp) * exp;
    }

    /** `severity` accepts HA's `{green: 60, yellow: 25, red: 0}` shape. */
    _bands(min, max) {
      const severity = this._config.severity;
      if (!severity || typeof severity !== "object") return null;
      const entries = Object.entries(severity)
        .map(([level, from]) => ({ from: num(from), color: LEVEL_COLORS[level] || level }))
        .sort((a, b) => a.from - b.from);
      if (!entries.length) return null;
      return entries.map((entry, i) => ({
        from: entry.from,
        to: i + 1 < entries.length ? entries[i + 1].from : Math.max(max, entry.from),
        color: entry.color,
      })).filter((b) => b.to > b.from);
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const value = this._read();
      const max = Math.max(this._max(), 1e-9);
      const min = this._config.min == null ? 0 : num(this._config.min);
      const span = max - min || 1;

      if (value == null) {
        return html`<ha-card>
          <div class="na">${esc(this._config.name || this._config.entity)}: —</div>
        </ha-card>`;
      }

      const frac = (v) => Math.min(Math.max((num(v) - min) / span, 0), 1);
      const bands = this._bands(min, max);

      let arcs = `<path d="${arcPath(0, 1, R)}" fill="none"
        stroke="var(--divider-color)" stroke-width="${STROKE}" stroke-linecap="round"
        opacity="0.5"/>`;

      if (bands) {
        for (const band of bands) {
          const from = frac(band.from);
          const to = frac(band.to);
          if (to - from < 0.001) continue;
          arcs += `<path d="${arcPath(from, to, R)}" fill="none" stroke="${esc(band.color)}"
            stroke-width="${STROKE}" stroke-linecap="butt"/>`;
        }
      } else {
        arcs += `<path d="${arcPath(0, frac(value), R)}" fill="none"
          stroke="var(--primary-color)" stroke-width="${STROKE}" stroke-linecap="round"/>`;
      }

      // needle
      const deg = START_DEG + SWEEP_DEG * frac(value);
      const tip = polar(deg, R - STROKE / 2 - 3);
      const back = polar(deg + 180, 13);
      const needle = `<line x1="${back.x.toFixed(1)}" y1="${back.y.toFixed(1)}"
          x2="${tip.x.toFixed(1)}" y2="${tip.y.toFixed(1)}"
          stroke="var(--primary-text-color)" stroke-width="3.1" stroke-linecap="round"/>
        <circle cx="${CX}" cy="${CY}" r="6.5" fill="var(--primary-text-color)"/>`;

      const decimals = this._decimals();
      const parts = value.toFixed(decimals).split(".");
      const shown = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009")
        + (parts[1] ? `.${parts[1]}` : "");
      const unit = this._unit();

      return html`
        <ha-card>
          <svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"
               xmlns="http://www.w3.org/2000/svg" role="img">
            ${this._untrusted(arcs)}
            ${this._untrusted(needle)}
            <text class="value" x="${CX}" y="${CY - 22}" text-anchor="middle">${shown}</text>
            ${unit === "" ? "" : this._untrusted(
              `<text class="unit" x="${CX}" y="${CY - 4}" text-anchor="middle">${esc(unit)}</text>`,
            )}
          </svg>
          <div class="name">${esc(this._config.name || this._config.entity)}</div>
        </ha-card>
      `;
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
