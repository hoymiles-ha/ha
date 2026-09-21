/* ============================================================================
 * Hoymiles Micro Storage — Gauge card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-gauge`
 *
 * A car-dashboard dial: a graduated scale with tick labels, an optional
 * coloured zone strip (severity), a needle and a digital readout — matching
 * the vendor app's stat dials (今日发电量 / 今日放电量 / 今日充电量, 电池 SOC ...).
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
 *   min: 0                    # optional (default 0)
 *   decimals: 2               # optional (default 2)
 *   ticks: 5                  # optional number of labelled ticks (default 5)
 *   severity:                 # optional coloured zones, in display units
 *     green: 3
 *     yellow: 1
 *     red: 0
 * ========================================================================== */

function _hmGaugeRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Dial geometry. The scale and the needle sit on the outside, the progress
   * arc inside them, and the digital readout uses the opening at the bottom.
   * ------------------------------------------------------------------ */
  const VB_W = 240;
  const VB_H = 176;
  const CX = VB_W / 2;
  const CY = 100;          // needle pivot
  const START_DEG = 150;   // bottom-left, opening at the bottom
  const SWEEP_DEG = 240;   // sweeps clockwise to 30 deg (bottom-right)

  const R_TICK_OUT = 96;
  const R_TICK_MAJOR = 86;
  const R_TICK_MINOR = 91;
  const R_ZONE = 80;       // severity strip, just under the ticks
  const R_NUM = 66;        // tick labels
  const R_ARC = 52;        // progress track
  const ARC_STROKE = 12;
  const NEEDLE_LEN = 30;
  const HUB_R = 7;
  const VALUE_Y = CY + 46;
  const UNIT_Y = CY + 62;

  const DEFAULT_TICKS = 5;
  const MINOR_PER_MAJOR = 4;

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

  /** "1234.50" -> "1 234.50"; keeps the big readouts readable. */
  function group(text) {
    const parts = String(text).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  /** Smallest number of decimals (0..2) that renders `step` exactly. */
  function decimalsFor(step) {
    const abs = Math.abs(num(step));
    if (!(abs > 0)) return 0;
    for (let d = 0; d <= 2; d += 1) {
      if (Math.abs(abs - Number(abs.toFixed(d))) < abs * 1e-6) return d;
    }
    return 2;
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
        .value { font-size: 28px; font-weight: 600;
                 fill: var(--primary-text-color); letter-spacing: 0.3px; }
        .unit { font-size: 12px; fill: var(--secondary-text-color); }
        .num { font-size: 10px; fill: var(--secondary-text-color); }
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

      if (value == null) {
        return html`<ha-card>
          <div class="na">${esc(this._config.name || this._config.entity)}: —</div>
        </ha-card>`;
      }

      return html`
        <ha-card>
          ${this._untrusted(this._svg(value, min, max))}
          <div class="name">${esc(this._config.name || this._config.entity)}</div>
        </ha-card>
      `;
    }

    /**
     * The whole dial, as one `<svg>` string.
     *
     * It has to be a single string that starts with `<svg>`: markup parsed
     * outside an SVG context lands in the HTML namespace, and the browser then
     * silently refuses to draw it (that is why the arcs and the needle used to
     * be invisible). Concatenating everything here keeps the parser in foreign
     * content mode for all of it.
     */
    _svg(value, min, max) {
      const span = max - min || 1;
      const frac = (v) => Math.min(Math.max((num(v) - min) / span, 0), 1);
      const bands = this._bands(min, max);
      const tickCount = Math.max(2, Math.round(num(this._config.ticks) || DEFAULT_TICKS));
      const majorStep = (max - min) / (tickCount - 1);
      const labelDecimals = decimalsFor(majorStep);

      /* graduated scale: minor ticks between the labelled majors */
      const steps = (tickCount - 1) * MINOR_PER_MAJOR;
      let scale = "";
      for (let i = 0; i <= steps; i += 1) {
        const major = i % MINOR_PER_MAJOR === 0;
        const angle = START_DEG + SWEEP_DEG * (i / steps);
        const inner = polar(angle, major ? R_TICK_MAJOR : R_TICK_MINOR);
        const outer = polar(angle, R_TICK_OUT);
        scale += `<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}"`
          + ` x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}"`
          + ` stroke="${major ? "var(--primary-text-color)" : "var(--secondary-text-color)"}"`
          + ` stroke-width="${major ? 2.1 : 1.2}" stroke-linecap="round"`
          + ` opacity="${major ? 0.8 : 0.45}"/>`;
      }
      for (let i = 0; i < tickCount; i += 1) {
        const p = polar(START_DEG + SWEEP_DEG * (i / (tickCount - 1)), R_NUM);
        const label = Number((min + majorStep * i).toFixed(labelDecimals));
        scale += `<text class="num" x="${p.x.toFixed(2)}" y="${(p.y + 3.6).toFixed(2)}"`
          + ` text-anchor="middle">${esc(group(String(label)))}</text>`;
      }

      /* severity zones, drawn as a coloured strip under the ticks */
      let zones = "";
      if (bands) {
        for (const band of bands) {
          const from = frac(band.from);
          const to = frac(band.to);
          if (to - from < 0.004) continue;
          zones += `<path d="${arcPath(from, to, R_ZONE)}" fill="none"`
            + ` stroke="${esc(band.color)}" stroke-width="5"`
            + ` stroke-linecap="butt" opacity="0.75"/>`;
        }
      }

      /* progress track + fill */
      const filled = frac(value);
      const track = `<path d="${arcPath(0, 1, R_ARC)}" fill="none"`
        + ` stroke="var(--divider-color)" stroke-width="${ARC_STROKE}"`
        + ` stroke-linecap="round" opacity="0.5"/>`;
      const progress = filled <= 0.002 ? ""
        : `<path d="${arcPath(0, filled, R_ARC)}" fill="none"`
          + ` stroke="var(--primary-color)" stroke-width="${ARC_STROKE}"`
          + ` stroke-linecap="round"/>`;

      /* needle + hub */
      const angle = START_DEG + SWEEP_DEG * filled;
      const tip = polar(angle, NEEDLE_LEN);
      const back = polar(angle + 180, 11);
      const needle = `<line x1="${back.x.toFixed(2)}" y1="${back.y.toFixed(2)}"`
        + ` x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}"`
        + ` stroke="var(--primary-text-color)" stroke-width="3.4" stroke-linecap="round"/>`
        + `<circle cx="${CX}" cy="${CY}" r="${HUB_R}" fill="var(--primary-text-color)"/>`;

      /* digital readout, sitting in the opening at the bottom */
      const unit = this._unit();
      const readout = `<text class="value" x="${CX}" y="${VALUE_Y}"`
        + ` text-anchor="middle">${esc(group(value.toFixed(this._decimals())))}</text>`
        + (unit === "" ? "" : `<text class="unit" x="${CX}" y="${UNIT_Y}"`
          + ` text-anchor="middle">${esc(unit)}</text>`);

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"`
        + ` xmlns="http://www.w3.org/2000/svg" role="img">`
        + `${scale}${zones}${track}${progress}${needle}${readout}</svg>`;
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
          <ha-textfield label="ticks (default 5)" .value=${config.ticks || ""}
            @change=${this._changed("ticks")}></ha-textfield>
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
