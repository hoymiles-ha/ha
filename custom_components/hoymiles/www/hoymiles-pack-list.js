/* ============================================================================
 * Hoymiles Micro Storage — Pack list card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-pack-list`
 *
 * One row per battery pack: SOC bar, SOC %, temperature and the heating flag.
 * The number of rows follows the same rule as the battery card (the
 * `pack_count` sensor, cross-checked against the packs that report a SOC).
 *
 * Card config:
 *   type: custom:hoymiles-pack-list
 *   dev_id: MSA-280520260806
 *   language: zh
 *   title: 电池包
 *   columns: 2                 # optional, lay the rows out in N columns
 *   show_temperature: false    # optional; hide the ℃ reading (SOC only)
 * ========================================================================== */

function _hmPackListRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  const PACK_MAX = 4;

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

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

  class HoymilesPackList extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object } };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
    }

    static getConfigElement() {
      return document.createElement("hoymiles-pack-list-editor");
    }

    static getStubConfig() {
      return { dev_id: "", language: "zh", title: "电池包" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; }
        .title { font-size: 15px; font-weight: 600;
                 color: var(--primary-text-color); margin-bottom: 10px; }
        .grid { display: grid; gap: 10px 14px; }
        .item { display: grid; grid-template-columns: 52px 1fr auto;
                align-items: center; gap: 10px; }
        .nm { font-size: 13px; color: var(--secondary-text-color); }
        .bar { height: 13px; border-radius: 7px; overflow: hidden;
               background: var(--divider-color); }
        .fill { height: 100%; border-radius: 7px; transition: width .3s; }
        .vals { display: flex; align-items: baseline; gap: 9px;
                font-variant-numeric: tabular-nums; }
        .soc { font-size: 14.5px; font-weight: 600;
               color: var(--primary-text-color); min-width: 62px; text-align: right; }
        .temp { font-size: 12.5px; color: var(--secondary-text-color); min-width: 46px;
                text-align: right; }
        .heat { font-size: 12px; }
        .none { font-size: 12.5px; color: var(--secondary-text-color); }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-pack-list: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
    }

    getCardSize() {
      return 4;
    }

    /* ----------------------------- lookups ----------------------------- */

    _t(en, zh) {
      return this._config && this._config.language === "zh" ? zh : en;
    }

    _dev() {
      return this._config.dev_id;
    }

    _resolve(key, domain = "sensor") {
      const overrides = this._config.entities || {};
      if (overrides[key]) return overrides[key];

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cacheKey = `${domain}:${key}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      const prefix = `${domain}.${slug(this._dev())}`;
      const wanted = norm(key);
      let found = null;
      for (const entityId of Object.keys(hass.states)) {
        if (!entityId.startsWith(prefix)) continue;
        if (norm(entityId.slice(prefix.length + 1)) !== wanted) continue;
        if (!found || entityId.length < found.length) found = entityId;
      }

      if (!found && hass.entities) {
        const wantUid = new Set([`${this._dev()}_${key}`, `hoymiles_${this._dev()}_${key}`]);
        for (const [entityId, entry] of Object.entries(hass.entities)) {
          if (entry && wantUid.has(entry.unique_id)) { found = entityId; break; }
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    _state(key, domain = "sensor") {
      const entityId = this._resolve(key, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unknown" || value === "unavailable") return null;
      return state;
    }

    _number(key, domain = "sensor") {
      const state = this._state(key, domain);
      return state ? num(state.state) : null;
    }

    /** Number of packs: `pack_count` is authoritative, SOC reporting is the fallback. */
    _packCount() {
      let reported = 0;
      for (let i = 1; i <= PACK_MAX; i += 1) {
        if (this._state(`pack_${i}_soc`)) reported = i;
      }
      const declared = Math.round(this._number("pack_count") || 0);
      return Math.max(1, Math.min(declared > 0 ? declared : reported, PACK_MAX));
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const count = this._packCount();
      const columns = Math.max(1, num(this._config.columns) || 1);
      const showTemp = this._config.show_temperature !== false;

      const rows = [];
      for (let i = 1; i <= count; i += 1) {
        const soc = this._number(`pack_${i}_soc`);
        const temp = this._number(`pack_${i}_temperature`);
        const heat = this._state(`pack_${i}_heating`, "binary_sensor");
        const pct = soc == null ? 0 : Math.min(Math.max(soc, 0), 100);
        rows.push(html`
          <div class="item">
            <span class="nm">${this._t("Battery", "电池")} ${i}</span>
            <div class="bar">
              <div class="fill" style="width:${pct}%;background:${this._color(pct)}"></div>
            </div>
            <div class="vals">
              <span class="soc">${soc == null ? "—" : `${soc.toFixed(2)}%`}</span>
              ${showTemp ? html`<span class="temp">${temp == null ? "—" : `${temp.toFixed(1)}°C`}</span>` : ""}
              <span class="heat">${heat && heat.state === "on" ? "🔥" : ""}</span>
            </div>
          </div>`);
      }

      return html`
        <ha-card>
          <div class="title">${esc(this._config.title || this._t("Battery packs", "电池包"))}</div>
          ${count === 0
            ? html`<div class="none">${this._t("No pack data", "无电池包数据")}</div>`
            : html`<div class="grid" style="grid-template-columns:repeat(${columns},1fr)">${rows}</div>`}
        </ha-card>
      `;
    }

    /** Red below 25 %, amber below 60 %, green above — same idea as the app. */
    _color(pct) {
      if (pct < 20) return "#db4437";
      if (pct < 45) return "#ffa600";
      if (pct < 65) return "#8bc34a";
      return "#0da035";
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
  class HoymilesPackListEditor extends LitElement {
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

    _toggle(field) {
      return (event) => {
        const config = { ...(this._config || {}), [field]: event.target.checked };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    static get styles() {
      return css`
        .row { padding: 8px; }
        ha-textfield { display: block; width: 100%; margin-bottom: 8px; }
        .sw { display: flex; align-items: center; gap: 10px; padding: 6px 0;
              font-size: 14px; color: var(--primary-text-color); }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="dev_id (required)" .value=${config.dev_id || ""}
            @change=${this._changed("dev_id")}></ha-textfield>
          <ha-textfield label="title" .value=${config.title || ""}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="columns" .value=${config.columns || "1"}
            @change=${this._changed("columns")}></ha-textfield>
          <ha-textfield label="language (en|zh)" .value=${config.language || "zh"}
            @change=${this._changed("language")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_temperature !== false}
              @change=${this._toggle("show_temperature")}></ha-switch>
            <span>show_temperature (显示 ℃)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-pack-list-editor")) {
    customElements.define("hoymiles-pack-list-editor", HoymilesPackListEditor);
  }
  if (!customElements.get("hoymiles-pack-list")) {
    customElements.define("hoymiles-pack-list", HoymilesPackList);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-pack-list")) {
    window.customCards.push({
      type: "hoymiles-pack-list",
      name: "Hoymiles Pack List",
      description: "Per-pack SOC bar, SOC, temperature and heating flag.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmPackListRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmPackListRegister());
}
