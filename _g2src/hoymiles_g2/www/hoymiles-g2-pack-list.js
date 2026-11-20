/* ============================================================================
 * Hoymiles Micro Storage — Pack list card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-pack-list`
 *
 * One row per battery pack: SOC bar, SOC %, temperature and the heating flag.
 * The number of rows follows the same rule as the battery card (the
 * `pack_count` sensor, cross-checked against the packs that report a SOC).
 *
 * Card config:
 *   type: custom:hoymiles-g2-pack-list
 *   dev_id: MSA-280520260806
 *   language: en               # optional (en|zh); omit to follow Home Assistant
 *   title: Battery packs
 *   columns: 2                 # optional, lay the rows out in N columns
 *   show_temperature: false    # optional; hide the ℃ reading (SOC only)
 * ========================================================================== */

function _hmPackListRegister() {
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
  /** The language this card must render in (`en` | `zh` | `de`). */
  const hmLang = (hass, config) => I18N.lang(hass, config);
  const hmText = (value, lang) => I18N.text(value, lang);

  /** A text field can only hold a plain string, so a language map shows empty. */
  const hmField = (value) => I18N.field(value);

  const PACK_MAX = 4;

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  /**
   * Drop the `_2` / `_3` … Home Assistant appends to a colliding entity id.
   *
   * HA does not fail a registration whose derived `entity_id` is taken; it
   * numbers it.  A unit whose serial was registered once before therefore has
   * every id one suffix away from the plain one this card derives
   * (`sensor.<serial>_pack_1_soc_2`), and the scan below would find nothing.
   * Only a trailing `_<digits>` is removed, so `pack_1_soc` keeps its `1`.
   */
  function stripAuditSuffix(value) {
    const text = String(value == null ? "" : value);
    const at = text.lastIndexOf("_");
    if (at <= 0) return text;
    const tail = text.slice(at + 1);
    if (!/^[0-9]+$/.test(tail) || /^0+$/.test(tail)) return text;
    return text.slice(0, at);
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

  /* `esc()` is for markup that goes through `innerHTML` only. Lit templates
   * escape their own bindings, so `esc()` inside a `${...}` in a `html`
   * template would show the escaped entities verbatim. */

  class HoymilesPackList extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object } };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
      /* Registry device ids owning this serial, filled lazily by `_deviceIds`
         and only used by the name-matching fallback of `_resolve`. */
      this._deviceIdsCache = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-g2-pack-list-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
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
        throw new Error("hoymiles-g2-pack-list: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
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
      return 4;
    }

    /* ----------------------------- lookups ----------------------------- */

    /** One of the two strings the card carries, in the current language. */
    _t(en, zh) {
      return I18N.pick(this._lang(), en, zh);
    }

    /** The language this card should render in (`en` | `zh` | `de`). */
    _lang() {
      return hmLang(this._hass, this._config);
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, this._lang());
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
      // 1. normalized exact match on the tail after `<domain>.<slug>_`.
      for (const entityId of Object.keys(hass.states)) {
        if (!entityId.startsWith(prefix)) continue;
        if (norm(entityId.slice(prefix.length + 1)) !== wanted) continue;
        if (!found || entityId.length < found.length) found = entityId;
      }

      // 2. the same, tolerating Home Assistant's `_2` disambiguation number.
      //    Without this a serial registered once before - every id numbered -
      //    resolved to nothing and the pack list stayed empty.
      if (!found) {
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          if (norm(stripAuditSuffix(entityId.slice(prefix.length + 1))) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found && hass.entities) {
        // The unique_id check this replaced was dead code - `hass.entities`
        // does not carry it - so the registry `name` / `translation_key` is
        // matched instead, which is what the sensor descriptions set.  Scoped
        // to this unit's devices where the serial can be traced: a name match
        // across the whole registry would happily return another unit's sensor.
        const deviceIds = this._deviceIds();
        for (const [entityId, entry] of Object.entries(hass.entities)) {
          if (!entry || !entityId.startsWith(`${domain}.`)) continue;
          if (deviceIds.size && !deviceIds.has(entry.device_id)) continue;
          if (norm(stripAuditSuffix(entry.name)) !== wanted
            && norm(stripAuditSuffix(entry.translation_key)) !== wanted) continue;
          if (!hass.states[entityId]) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    /**
     * The registry device ids that belong to this card's serial, resolved once.
     *
     * `hass.devices` holds an array of `[domain, identifier]` pairs per device
     * and the integration registers the serial verbatim, so a surviving serial
     * in an identifier is what ties a device record to this card.  An empty set
     * means "could not tell" - the caller then skips the scoped fallback.
     */
    _deviceIds() {
      if (this._deviceIdsCache) return this._deviceIdsCache;
      const out = new Set();
      const devices = (this._hass && this._hass.devices) || {};
      const serial = String(this._dev() || "");
      if (serial) {
        for (const [deviceId, device] of Object.entries(devices)) {
          if (!device) continue;
          for (const pair of device.identifiers || []) {
            if (Array.isArray(pair) && String(pair[1]) === serial) {
              out.add(deviceId);
              break;
            }
          }
        }
      }
      this._deviceIdsCache = out;
      return out;
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
          <div class="title">${this._text(this._config.title) || this._t("Battery Packs", "电池包")}</div>
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
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="columns" .value=${config.columns || "1"}
            @change=${this._changed("columns")}></ha-textfield>
          <ha-textfield label="language (auto|en|zh, auto follows Home Assistant)"
            .value=${config.language || ""} @change=${this._changed("language")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_temperature !== false}
              @change=${this._toggle("show_temperature")}></ha-switch>
            <span>show_temperature (show the ℃ reading)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-g2-pack-list-editor")) {
    customElements.define("hoymiles-g2-pack-list-editor", HoymilesPackListEditor);
  }
  if (!customElements.get("hoymiles-g2-pack-list")) {
    customElements.define("hoymiles-g2-pack-list", HoymilesPackList);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-pack-list")) {
    window.customCards.push({
      type: "hoymiles-g2-pack-list",
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
