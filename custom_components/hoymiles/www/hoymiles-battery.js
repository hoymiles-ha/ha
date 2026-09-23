/* ============================================================================
 * Hoymiles Micro Storage — Battery (HiBattery X) card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-battery`
 *
 * Renders the physical battery stack of a Hoymiles micro storage device the
 * way the vendor app does:
 *
 *   - the stack is drawn module by module, so the picture always matches how
 *     many battery packs are actually installed (1 – 4, driven by the
 *     `pack_count` sensor and cross-checked against `packN_soc`);
 *   - every module gets a callout with its own SOC and temperature, the
 *     callouts alternate left / right like in the app;
 *   - PV / grid-on / battery / grid-off powers frame the picture;
 *   - an optional history section plots the pack SOC and the charged /
 *     discharged energy for 日 / 月 / 年 / 总 (from long term statistics).
 *
 * Everything is hand-rolled SVG (no chart library, no CDN).
 *
 * Card config:
 *   type: custom:hoymiles-battery
 *   dev_id: MSA-280520260806     # required
 *   title: HiBattery X           # optional, overrides the detected model
 *   show_title: false            # optional, hide the header title
 *   language: zh                 # optional (en|zh)
 *   show_history: true           # optional (default true)
 *   max_width: 560               # optional px for the illustration
 *   alarm_entity: binary_sensor.x # optional, shows a bell when "on"
 *   entities:                    # optional entity id overrides
 *     pack_count: sensor.my_pack_count
 *     pv: sensor.my_pv_power
 *     grid_on: sensor.my_grid_on_power
 *     grid_off: sensor.my_grid_off_power
 *     battery: sensor.my_battery_power
 *     battery_status: sensor.my_battery_status
 *     soc: sensor.my_soc
 *     pack1_soc: sensor.my_pack1_soc
 *     pack1_temperature: sensor.my_pack1_temperature
 * ========================================================================== */

function _hmBatteryRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Drawing constants
   * ------------------------------------------------------------------ */
  const VB_W = 620;
  const PACK_MAX = 4;

  const TOP_H = 66;      // dark head module (BMS / PCS)
  const MOD_H = 158;     // one battery module
  const HEAD_TOP = 96;   // y of the top of the stack
  const FRONT_W = 300;   // front face width
  const SIDE_W = 34;     // right hand side panel width
  const FRONT_X = 130;   // x of the left edge of the front face

  const CALLOUT_W = 164;
  const CALLOUT_H = 62;
  const LEFT_BOX_X = 2;
  const RIGHT_BOX_X = VB_W - 2;      // right edge of the right hand box
  const LEFT_DOT_X = FRONT_X + FRONT_W * 0.40;
  const RIGHT_DOT_X = FRONT_X + FRONT_W * 0.62;
  const DOT_COLOR = "#22c55e";

  const HEADER_GAP = 84;   // space between the stack and the bottom row
  const TAIL_GAP = 30;

  const RANGES = [
    { id: "day", en: "Day", zh: "日", period: "hour", days: 1 },
    { id: "month", en: "Month", zh: "月", period: "day", days: 30 },
    { id: "year", en: "Year", zh: "年", period: "month", days: 365 },
    { id: "total", en: "Total", zh: "总", period: "month", days: 365 * 6 },
  ];
  const HIST_TTL_MS = 5 * 60 * 1000;

  const STATUS = {
    charge: { cls: "ok", en: "Charging", zh: "充电" },
    discharge: { cls: "warn", en: "Discharging", zh: "放电" },
    lock: { cls: "warn", en: "Locked", zh: "锁定" },
    standby: { cls: "", en: "Standby", zh: "待机" },
  };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /**
   * Collapse a name to its alphanumeric characters so `pack_1_soc` and
   * `pack1_soc` compare equal.  The integration's entity ids slugify the
   * entity *name* (`Pack 1 SOC` -> `pack_1_soc`), which does not match the
   * raw description key, so suffix matching is done normalized.
   */
  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function group(value) {
    const parts = String(value).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  function fmtW(value) {
    const abs = Math.abs(num(value));
    const text = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    return `${group(text)} W`;
  }

  function fmtEnergy(kwh) {
    const v = num(kwh);
    const abs = Math.abs(v);
    if (abs >= 1000) return `${(v / 1000).toFixed(2)} MWh`;
    if (abs >= 1) return `${v.toFixed(2)} kWh`;
    return `${(v * 1000).toFixed(0)} Wh`;
  }

  function dayStart(date, offsetDays = 0) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offsetDays);
    return d;
  }

  /* ------------------------------------------------------------------ *
   * The stack itself
   * ------------------------------------------------------------------ */
  function stackMarkup(packs, active) {
    const count = Math.max(packs, 1);
    const stackH = TOP_H + count * MOD_H;
    const bottom = HEAD_TOP + stackH;

    const parts = [];

    // right hand side panel (the connectors live there)
    parts.push(`<rect x="${FRONT_X + FRONT_W}" y="${HEAD_TOP + 7}"
        width="${SIDE_W}" height="${stackH}" rx="7" fill="url(#hm-bat-side)"/>`);

    // front face: one rect per module so every module gets its own shading
    parts.push(`<rect x="${FRONT_X}" y="${HEAD_TOP}" width="${FRONT_W}"
        height="${stackH}" rx="7" fill="#b8bec6"/>`);
    for (let i = 0; i < count; i += 1) {
      const y = HEAD_TOP + TOP_H + i * MOD_H;
      parts.push(`<rect x="${FRONT_X}" y="${y}" width="${FRONT_W}" height="${MOD_H}"
          fill="url(#hm-bat-mod)"/>
        <rect x="${FRONT_X}" y="${y}" width="${FRONT_W}" height="2.5"
          fill="rgba(255,255,255,0.35)"/>`);
      // the vendor renders the wordmark at the foot of every module
      parts.push(`<text x="${FRONT_X + 16}" y="${y + MOD_H - 14}"
          font-size="12" letter-spacing="0.4"
          fill="rgba(255,255,255,0.6)">Hoymiles</text>`);
    }

    // dark head module on top
    parts.push(`<path d="M${FRONT_X + 7} ${HEAD_TOP} h${FRONT_W - 14}
        a7 7 0 0 1 7 7 v${TOP_H - 7} h-${FRONT_W} v-${TOP_H - 7}
        a7 7 0 0 1 7 -7 z" fill="url(#hm-bat-top)"/>`);
    parts.push(`<rect x="${FRONT_X}" y="${HEAD_TOP + TOP_H - 3}" width="${FRONT_W}"
        height="3" fill="rgba(0,0,0,0.35)"/>`);

    // brand mark on the head module
    const cx = FRONT_X + FRONT_W / 2;
    parts.push(`<circle cx="${cx}" cy="${HEAD_TOP + 24}" r="13" fill="none"
        stroke="rgba(255,255,255,0.22)" stroke-width="1.6"/>
      <text x="${cx}" y="${HEAD_TOP + 29}" text-anchor="middle" font-size="15"
        font-weight="600" fill="rgba(255,255,255,0.5)">H</text>
      <text x="${cx}" y="${HEAD_TOP + 52}" text-anchor="middle" font-size="11"
        letter-spacing="0.5" fill="rgba(255,255,255,0.38)">Hoymiles</text>`);

    // feet
    for (const fx of [FRONT_X + 20, FRONT_X + FRONT_W / 2 - 12, FRONT_X + FRONT_W - 48]) {
      parts.push(`<rect x="${fx}" y="${bottom}" width="24" height="10" rx="3"
        fill="#23272d"/>`);
    }

    // module callouts: alternate left / right, like the vendor app
    for (let i = 0; i < count; i += 1) {
      const cy = HEAD_TOP + TOP_H + i * MOD_H + MOD_H / 2;
      const onLeft = i % 2 === 0;
      const dotX = onLeft ? LEFT_DOT_X : RIGHT_DOT_X;
      const boxX = onLeft ? LEFT_BOX_X : RIGHT_BOX_X - CALLOUT_W;
      const edgeX = onLeft ? LEFT_BOX_X + CALLOUT_W : RIGHT_BOX_X - CALLOUT_W;

      const soc = i < active.length ? active[i].soc : null;
      const temp = i < active.length ? active[i].temp : null;

      parts.push(`<line x1="${edgeX}" y1="${cy}" x2="${dotX}" y2="${cy}"
        stroke="${DOT_COLOR}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${dotX}" cy="${cy}" r="5" fill="${DOT_COLOR}"
        stroke="#fff" stroke-width="1.6"/>`);
      parts.push(`<g class="bat-call">
        <rect x="${boxX}" y="${cy - CALLOUT_H / 2}" width="${CALLOUT_W}"
          height="${CALLOUT_H}" rx="13" fill="rgba(56,61,70,0.88)"/>
        <text x="${boxX + 16}" y="${cy - 7}" class="bat-call-t">${esc(active[i].label)}</text>
        <text x="${boxX + 16}" y="${cy + 17}" class="bat-call-v">${soc == null ? "--" : `${soc.toFixed(2)}%`}<tspan
          class="bat-call-temp" dx="10">${temp == null ? "--" : `${temp.toFixed(1)}°C`}</tspan></text>
      </g>`);
    }

    return { markup: parts.join(""), stackH, bottom };
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesBattery extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _range: { type: String },
        _history: { type: Object },
        _histLoading: { type: Boolean },
        _histError: { type: String },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
      this._range = RANGES[0].id;
      this._history = null;
      this._histLoading = false;
      this._histError = null;
      this._histFetchedAt = 0;
      this._histToken = 0;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-battery-editor");
    }

    static getStubConfig() {
      return { dev_id: "", language: "zh" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 10px;
                justify-content: space-between; }
        .htitle { flex: 1; text-align: center; font-size: 19px;
                  font-weight: 600; color: var(--primary-text-color); }
        .hstat { display: flex; align-items: center; gap: 10px; min-width: 40px;
                 justify-content: flex-end; }
        .hstat svg { display: block; }
        .bell { color: var(--error-color); font-size: 17px; line-height: 1; }
        .wrap { display: flex; justify-content: center; }
        .wrap svg { display: block; width: 100%; height: auto; }

        .bat-v { font-size: 24px; font-weight: 600;
                 fill: var(--primary-text-color); }
        .bat-c { font-size: 13px; fill: var(--secondary-text-color); }
        .bat-call-t { font-size: 12.5px; fill: rgba(255,255,255,0.66); }
        .bat-call-v { font-size: 20px; font-weight: 600; fill: #ffffff; }
        .bat-call-temp { font-size: 15px; font-weight: 500;
                         fill: rgba(255,255,255,0.82); }

        .hist { margin-top: 10px; border-top: 1px solid var(--divider-color);
                padding-top: 10px; }
        .hhead { display: flex; flex-wrap: wrap; gap: 6px 12px;
                 align-items: center; justify-content: space-between; }
        .hlabel { font-size: 15px; font-weight: 600;
                  color: var(--primary-text-color); }
        .pills { display: flex; gap: 4px; }
        .pill { padding: 3px 14px; border-radius: 999px; font-size: 12.5px;
                cursor: pointer; border: 1px solid transparent;
                background: var(--secondary-background-color, rgba(127,127,127,0.12));
                color: var(--secondary-text-color); }
        .pill.on { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .chart { margin-top: 6px; }
        .chart svg { display: block; width: 100%; height: auto; }
        .soc-axis { font-size: 11px; fill: var(--secondary-text-color); }
        .soc-line { fill: none; stroke: var(--primary-color); stroke-width: 2.2;
                    stroke-linejoin: round; stroke-linecap: round; }
        .soc-last { font-size: 12.5px; font-weight: 600;
                    fill: var(--primary-text-color); }
        .summary { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px;
                   color: var(--secondary-text-color); margin-top: 4px;
                   font-variant-numeric: tabular-nums; }
        .summary b { color: var(--primary-text-color); font-weight: 600; }
        .msg { font-size: 12.5px; color: var(--secondary-text-color);
               padding: 10px 0 2px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-battery: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
      if (config.range) this._range = config.range;
      this._history = null;
      this._histFetchedAt = 0;
      // `hass` may already be set when the dashboard is edited in place.
      this._maybeFetchHistory();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first) this._maybeFetchHistory();
      this.requestUpdate();
    }

    getCardSize() {
      return 12;
    }

    /**
     * Only re-render when something the drawing depends on changed. The device
     * pushes state every second, and the illustration is a few hundred SVG
     * nodes — no reason to rebuild it when the numbers are identical.
     */
    shouldUpdate() {
      if (!this._config || !this._hass) return true;
      const signature = this._signature();
      if (signature === this._signatureCache) return false;
      this._signatureCache = signature;
      return true;
    }

    _signature() {
      const packs = [];
      for (let i = 1; i <= PACK_MAX; i += 1) {
        packs.push(`${this._read(`pack${i}_soc`, null)}:${this._read(`pack${i}_temperature`, null)}`);
      }
      return [
        this._config.language, this._config.max_width, this._config.title,
        this._config.show_title, this._config.alarm_entity, this._range,
        // The model arrives with the device registry, which can load after the
        // first render, so it has to be part of what triggers a rebuild.
        this._title(),
        this._read("rssi", null), this._alarmOn(),
        this._read("pv_power", 0), this._read("grid_on_power", 0),
        this._read("grid_off_power", 0),
        this._packCount(), packs.join(","),
        this._readText("battery_status"), this._readText("bat_sts"),
        this._history ? `${this._history.soc.length}:${this._history.charge}:${this._history.discharge}` : "none",
        this._histError || "",
      ].join("\u0001");
    }

    _alarmOn() {
      const entityId = this._config.alarm_entity;
      if (!entityId || !this._hass) return false;
      const state = (this._hass.states || {})[entityId];
      return !!state && state.state === "on";
    }

    /* ----------------------------- lookup ----------------------------- */

    _t(en, zh) {
      return this._config && this._config.language === "zh" ? zh : en;
    }

    _dev() {
      return this._config.dev_id;
    }

    /**
     * The device the card is looking at, from the device registry.
     *
     * `dev_id` is the integration/DNS identifier the firmware publishes, which
     * is exactly what the device's `identifiers` carry, so no entity lookup is
     * needed.  A device may be registered more than once (the MQTT discovery
     * device and the integration's own), and only some of those entries know
     * the model, so prefer whichever one has it.
     */
    _device() {
      const hass = this._hass;
      if (!hass || !hass.devices) return null;
      const wanted = String(this._dev() || "").toLowerCase();
      if (!wanted) return null;

      let fallback = null;
      for (const device of Object.values(hass.devices)) {
        if (!device) continue;
        const hit = (device.identifiers || []).some(
          (pair) => pair && String(pair[1] || "").toLowerCase() === wanted);
        if (!hit) continue;
        if (device.model) return device;
        if (!fallback) fallback = device;
      }
      if (fallback) return fallback;

      // No identifier matched (renamed by hand, unusual setup): fall back to
      // the device one of our own entities belongs to.
      const entityId = this._resolveEntity("soc") || this._resolveEntity("bat_power");
      const entry = entityId && hass.entities ? hass.entities[entityId] : null;
      return entry && entry.device_id ? (hass.devices[entry.device_id] || null) : null;
    }

    /** Model as reported by the device ("HiBattery 4020 X"), or null. */
    _model() {
      const device = this._device();
      return device && device.model ? String(device.model) : null;
    }

    /**
     * Header title: explicit config wins, then what the device says it is, and
     * only then a generic placeholder — a hard-coded name goes stale as soon as
     * the hardware changes.
     */
    _title() {
      const configured = this._config && this._config.title;
      if (typeof configured === "string" && configured) return configured;
      return this._model() || "HiBattery X";
    }

    _showTitle() {
      const config = this._config || {};
      return config.show_title !== false && config.title !== false;
    }

    _resolveEntity(suffix, domain = "sensor") {
      const overrides = (this._config.entities || {});
      if (overrides[suffix]) return overrides[suffix];

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cacheKey = `${domain}:${suffix}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${suffix}`;
      let found = hass.states[conventional] ? conventional : null;

      if (!found) {
        // Normalized exact match on the part after `<domain>.<dev>_`, so both
        // `pack1_soc` and the slugified `pack_1_soc` resolve.
        const prefix = `${domain}.${dev}`;
        const wanted = norm(suffix);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          if (norm(entityId.slice(prefix.length + 1)) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found && hass.entities) {
        const uniqueSuffix = `hoymiles_${this._dev()}_${suffix}`;
        for (const [entityId, entry] of Object.entries(hass.entities)) {
          if (entry && entry.unique_id === uniqueSuffix) {
            found = entityId;
            break;
          }
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    _stateOf(suffix, domain = "sensor") {
      const entityId = this._resolveEntity(suffix, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unavailable" || value === "unknown") return null;
      return state;
    }

    _read(suffix, fallback = 0, domain = "sensor") {
      const state = this._stateOf(suffix, domain);
      if (!state) return fallback;
      const value = Number(state.state);
      return Number.isFinite(value) ? value : fallback;
    }

    _readText(suffix) {
      const state = this._stateOf(suffix);
      return state ? String(state.state) : "";
    }

    /* ---------------------------- the data ---------------------------- */

    /**
     * How many battery modules to draw.
     *
     * `pack_count` is authoritative, but it is a diagnostic entity and may be
     * hidden or missing on older firmware, so the count of packs that actually
     * report a SOC is used as a cross-check (and as the fallback).
     */
    _packCount() {
      let reported = 0;
      for (let i = 1; i <= PACK_MAX; i += 1) {
        if (this._stateOf(`pack${i}_soc`)) reported = i;
      }

      const declared = Math.round(this._read("pack_count", 0));
      const count = declared > 0 ? declared : reported;
      return Math.max(1, Math.min(count, PACK_MAX));
    }

    _batteryStatus(battery) {
      const raw = (this._readText("battery_status") || this._readText("bat_sts"))
        .toLowerCase();
      let key = raw;
      if (!STATUS[key]) {
        if (Math.abs(battery) < 5) key = "standby";
        else key = battery < 0 ? "charge" : "discharge";
      }
      const entry = STATUS[key] || STATUS.standby;
      return { key, cls: entry.cls, text: this._t(entry.en, entry.zh) };
    }

    /* ----------------------------- render ----------------------------- */

    render() {
      if (!this._config) return html``;

      let battery = this._read("system_battery_power", 0);
      if (!this._resolveEntity("system_battery_power")) {
        battery = this._read("bat_power", 0);
      }
      let pv = this._read("system_pv_power", 0);
      if (!this._resolveEntity("system_pv_power")) pv = this._read("pv_power", 0);

      const gridOn = this._read("grid_on_power", 0);
      const gridOff = this._read("grid_off_power", 0);
      const status = this._batteryStatus(battery);

      const count = this._packCount();
      const packs = [];
      for (let i = 0; i < PACK_MAX; i += 1) {
        packs.push({
          label: `${this._t("Battery", "电池")} ${i + 1}`,
          soc: this._read(`pack${i + 1}_soc`, null),
          temp: this._read(`pack${i + 1}_temperature`, null),
        });
      }
      const batteryCaption = this._t("Battery ", "电池") + status.text;

      return html`
        <ha-card>
          <div class="head">
            <div class="hstat">${this._alarm()}</div>
            ${this._showTitle()
              ? html`<div class="htitle">${esc(this._title())}</div>`
              : html`<div class="htitle"></div>`}
            <div class="hstat">${this._untrusted(this._signal())}</div>
          </div>
          <div class="wrap" style=${this._wrapStyle()}>
            ${this._untrusted(this._svg({
              count, packs, pv, gridOn, gridOff, battery, status, batteryCaption,
            }))}
          </div>
          ${this._config.show_history === false ? "" : this._historySection()}
        </ha-card>
      `;
    }

    _wrapStyle() {
      const width = num(this._config.max_width);
      return width > 0 ? `max-width:${width}px` : "max-width:560px";
    }

    _alarm() {
      return this._alarmOn() ? html`<span class="bell">🔔</span>` : "";
    }

    /** Wi-Fi style signal bars derived from the device's `rssi` sensor. */
    _signal() {
      const rssi = this._read("rssi", null);
      let bars = 0;
      if (rssi !== null) {
        if (rssi >= -55) bars = 4;
        else if (rssi >= -65) bars = 3;
        else if (rssi >= -75) bars = 2;
        else bars = 1;
      }
      const color = bars === 0
        ? "var(--disabled-text-color, #b6bcc4)"
        : "var(--primary-color)";
      let out = `<svg width="22" height="18" viewBox="0 0 22 18">`;
      for (let i = 0; i < 4; i += 1) {
        const h = 4 + i * 3.4;
        out += `<rect x="${1 + i * 5}" y="${16 - h}" width="3.4" height="${h}" rx="1.4"
          fill="${i < bars ? color : "var(--divider-color, #dcdfe4)"}"/>`;
      }
      out += "</svg>";
      return out;
    }

    /* --------------------------- the diagram --------------------------- */

    _svg(d) {
      const { markup, bottom } = stackMarkup(d.count, d.packs);
      const bottomY = bottom + HEADER_GAP;
      const totalH = bottomY + TAIL_GAP;

      return `<svg viewBox="0 0 ${VB_W} ${totalH}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <linearGradient id="hm-bat-top" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stop-color="#40464f"/>
            <stop offset="1" stop-color="#1e2227"/>
          </linearGradient>
          <linearGradient id="hm-bat-mod" x1="0" y1="0" x2="0.15" y2="1">
            <stop offset="0" stop-color="#e3e6ea"/>
            <stop offset="0.55" stop-color="#c3c9d0"/>
            <stop offset="1" stop-color="#a7aeb7"/>
          </linearGradient>
          <linearGradient id="hm-bat-side" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#4c525b"/>
            <stop offset="1" stop-color="#282d33"/>
          </linearGradient>
        </defs>
        ${markup}
        ${this._row(30, 62, "☀️", fmtW(d.pv), this._t("PV", "光伏"), "start")}
        ${this._row(VB_W - 30, VB_W - 58, "socket", fmtW(d.gridOn),
          this._t("Grid port", "并网端口"), "end")}
        ${this._row(30, 62, "⏳", fmtW(d.battery), d.batteryCaption, "start", bottomY)}
        ${this._row(VB_W - 30, VB_W - 58, "dot", fmtW(d.gridOff),
          this._t("Off-grid port", "离网端口"), "end", bottomY)}
      </svg>`;
    }

    /**
     * One corner readout: icon, power value and caption.
     * `anchor` is "start" (icon on the left) or "end" (icon on the right).
     */
    _row(iconX, textX, icon, value, caption, anchor, y = 46) {
      let glyph;
      if (icon === "socket") {
        glyph = `<g transform="translate(${iconX - 15},${y - 26})">
            <rect x="0" y="0" width="24" height="24" rx="6" fill="#cfd4da"/>
            <circle cx="12" cy="10" r="4.2" fill="#3b4149"/>
            <rect x="10" y="14" width="4" height="7" rx="2" fill="#3b4149"/>
          </g>`;
      } else if (icon === "dot") {
        glyph = `<circle cx="${iconX - 6}" cy="${y - 27}" r="5.5" fill="#f5a623"/>`;
      } else {
        glyph = `<text x="${iconX - 12}" y="${y - 22}" font-size="20">${icon}</text>`;
      }
      return `${glyph}
        <text class="bat-v" x="${textX}" y="${y - 22}" text-anchor="${anchor}">${value}</text>
        <text class="bat-c" x="${textX}" y="${y}" text-anchor="${anchor}">${esc(caption)}</text>`;
    }

    /* -------------------------- history section -------------------------- */

    _historySection() {
      const pills = RANGES.map((r) => `
        <button class="pill ${r.id === this._range ? "on" : ""}"
                data-range="${r.id}">${esc(this._t(r.en, r.zh))}</button>`).join("");

      let body;
      if (this._histError) {
        body = html`<div class="msg">${esc(this._histError)}</div>`;
      } else if (!this._history) {
        body = html`<div class="msg">${this._t("Loading…", "加载中…")}</div>`;
      } else if (!this._history.soc.length) {
        body = html`<div class="msg">${this._t(
          "No statistics recorded for this range (the recorder must be enabled).",
          "该时间段没有统计数据（需要启用 recorder）。",
        )}</div>`;
      } else {
        body = html`
          ${this._untrusted(this._socChart(this._history.soc))}
          <div class="summary">
            <span>${this._t("Charged", "充电")} <b>${fmtEnergy(this._history.charge)}</b></span>
            <span>${this._t("Discharged", "放电")} <b>${fmtEnergy(this._history.discharge)}</b></span>
            <span>${this._t("Packs", "电池数量")} <b>${this._packCount()}</b></span>
          </div>`;
      }

      return html`
        <div class="hist">
          <div class="hhead">
            <div class="hlabel">${this._t("History", "历史数据")}</div>
            <div class="pills">${this._untrusted(pills)}</div>
          </div>
          ${body}
        </div>`;
    }

    _socChart(points) {
      const W = VB_W;
      const H = 150;
      const L = 34;
      const R = W - 14;
      const T = 12;
      const B = H - 24;

      const xs = (i) => L + (R - L) * (points.length === 1 ? 0.5 : i / (points.length - 1));
      const ys = (v) => B - (B - T) * (Math.max(0, Math.min(100, v)) / 100);

      const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)} ${ys(p).toFixed(1)}`).join(" ");
      const area = `${line} L${xs(points.length - 1).toFixed(1)} ${B} L${xs(0).toFixed(1)} ${B} Z`;

      let grid = "";
      for (const v of [0, 25, 50, 75, 100]) {
        grid += `<line x1="${L}" y1="${ys(v).toFixed(1)}" x2="${R}" y2="${ys(v).toFixed(1)}"
          stroke="var(--divider-color)" stroke-width="1" stroke-dasharray="3 4"/>
        <text class="soc-axis" x="${L - 6}" y="${(ys(v) + 4).toFixed(1)}"
          text-anchor="end">${v}</text>`;
      }

      const last = points[points.length - 1];
      const lastX = xs(points.length - 1);
      const lastY = ys(last);

      return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <linearGradient id="hm-bat-areafill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--primary-color)" stop-opacity="0.32"/>
            <stop offset="1" stop-color="var(--primary-color)" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#hm-bat-areafill)" stroke="none"/>
        <path class="soc-line" d="${line}" fill="none"/>
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4"
          fill="var(--primary-color)" stroke="#fff" stroke-width="1.6"/>
        <text class="soc-last" x="${Math.min(lastX + 8, R).toFixed(1)}"
          y="${Math.max(lastY - 8, T + 12).toFixed(1)}"
          text-anchor="${lastX > R - 60 ? "end" : "start"}">${last.toFixed(2)}%</text>
      </svg>`;
    }

    /* ---------------------------- statistics ---------------------------- */

    _rangeDef() {
      return RANGES.find((r) => r.id === this._range) || RANGES[0];
    }

    _maybeFetchHistory() {
      if (!this._hass || !this._config) return;
      if (this._config.show_history === false) return;
      if (this._history && Date.now() - this._histFetchedAt < HIST_TTL_MS) return;
      this._fetchHistory();
    }

    async _fetchHistory() {
      if (!this._hass || !this._config) return;
      if (typeof this._hass.callWS !== "function") return;

      // Same as the power flow card: the device level `soc` (1 s, average of
      // this unit's packs) keeps every SOC on the dashboard consistent.
      const socEntity = this._resolveEntity("soc") || this._resolveEntity("system_soc");
      const chgEntity = this._resolveEntity("battery_charge_energy_today");
      const dchgEntity = this._resolveEntity("battery_discharge_energy_today");
      const ids = [socEntity, chgEntity, dchgEntity].filter(Boolean);

      if (!ids.length) {
        this._histError = this._t(
          "No statistics source found for this device.",
          "未找到该设备的统计数据源。",
        );
        return;
      }

      const def = this._rangeDef();
      const token = ++this._histToken;
      this._histLoading = true;
      this._histError = null;

      const end = new Date();
      const start = def.id === "year"
        ? new Date(end.getFullYear(), 0, 1)
        : dayStart(end, def.days - 1);

      try {
        const result = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: def.period,
          types: ["mean", "change"],
        });
        if (token !== this._histToken) return; // a newer request won

        const socRows = (result && result[socEntity]) || [];
        const soc = socRows
          .map((row) => (row.mean == null ? null : num(row.mean)))
          .filter((value) => value !== null);

        const sum = (rows) => (rows || []).reduce((acc, row) => acc + num(row.change), 0);
        this._history = {
          soc,
          charge: sum(chgEntity ? result[chgEntity] : null) / 1000,
          discharge: Math.abs(sum(dchgEntity ? result[dchgEntity] : null)) / 1000,
        };
        this._histFetchedAt = Date.now();
      } catch (err) {
        if (token !== this._histToken) return;
        this._histError = this._t(
          "Statistics are unavailable — is the recorder enabled?",
          "统计数据不可用 —— 是否启用了 recorder？",
        );
        this._history = null;
      } finally {
        if (token === this._histToken) {
          this._histLoading = false;
          this.requestUpdate();
        }
      }
    }

    /* ---------------------------- interaction ---------------------------- */

    _handleClick(event) {
      const pill = event.target.closest("[data-range]");
      if (!pill) return;
      const range = pill.getAttribute("data-range");
      if (!range || range === this._range) return;
      this._range = range;
      this._history = null;
      this._histFetchedAt = 0;
      this._fetchHistory();
    }

    firstUpdated() {
      this.shadowRoot.addEventListener("click", (event) => this._handleClick(event));
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
  class HoymilesBatteryEditor extends LitElement {
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
          <ha-textfield label="dev_id (required)" .value=${config.dev_id || ""}
            @change=${this._changed("dev_id")}></ha-textfield>
          <ha-textfield label="title (默认用设备型号)" .value=${config.title || ""}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="show_title (false = 隐藏标题)"
            .value=${config.show_title === false ? "false" : ""}
            @change=${this._changed("show_title")}></ha-textfield>
          <ha-textfield label="language (en|zh)" .value=${config.language || "zh"}
            @change=${this._changed("language")}></ha-textfield>
          <ha-textfield label="max_width (px)" .value=${config.max_width || ""}
            @change=${this._changed("max_width")}></ha-textfield>
          <ha-textfield label="alarm_entity" .value=${config.alarm_entity || ""}
            @change=${this._changed("alarm_entity")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-battery-editor")) {
    customElements.define("hoymiles-battery-editor", HoymilesBatteryEditor);
  }
  if (!customElements.get("hoymiles-battery")) {
    customElements.define("hoymiles-battery", HoymilesBattery);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-battery")) {
    window.customCards.push({
      type: "hoymiles-battery",
      name: "Hoymiles Battery",
      description:
        "Battery stack of a Hoymiles micro storage device with per-pack SOC / "
        + "temperature callouts, scaled to the number of installed packs.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmBatteryRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmBatteryRegister());
}
