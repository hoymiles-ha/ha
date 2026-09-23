/* ============================================================================
 * Hoymiles Micro Storage — Power flow card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-power-flow`
 *
 * Draws the home as an illustration and overlays the live power flow of a
 * Hoymiles micro storage device — 光伏 (PV), 微储 (battery), 电网 (grid) and
 * 负载 (house load) — exactly like the vendor app's home screen.
 *
 * Everything is hand-rolled SVG (no chart library, no CDN), so the card keeps
 * working offline on a Raspberry Pi.
 *
 * Data sources (plain entity states, no recorder required):
 *   system_pv_power (+ system_pv2_power)   PV production            [W]
 *   system_battery_power                   battery, negative=charge  [W]
 *   system_soc                             battery state of charge   [%]
 *   system_grid_power                      grid, positive=importing  [W]
 *   system_load_power                      house consumption         [W]
 *   battery_status                         standby|charge|discharge|lock
 *   rssi                                   Wi-Fi RSSI, dBm -> signal bars
 *
 * Card config:
 *   type: custom:hoymiles-power-flow
 *   dev_id: MSA-280520260806      # required
 *   title: 我的家                # optional, defaults to the device id
 *   show_title: true              # optional, false hides the title + device id
 *   language: zh                  # optional (en|zh)
 *   temperature_entity: sensor.x  # optional, shown next to the title
 *   gradient: true                # optional light backdrop (default true)
 *   max_width: 620                # optional px, the drawing stays centered
 *   entities:                     # optional entity id overrides
 *     pv: sensor.my_pv_power
 *     battery: sensor.my_battery_power
 *     grid: sensor.my_grid_power
 *     load: sensor.my_load_power
 *     soc: sensor.my_soc
 *     battery_status: sensor.my_battery_status
 *     rssi: sensor.my_rssi
 *     pv2: sensor.my_system_pv2_power
 *     smart_plug: sensor.my_system_smart_plug_power
 *   show_rssi: true               # optional, hide the fan with false
 *   show_extras: true             # optional, hide the PV2 / smart plug chips
 *                                 # (a chip only shows when its reading is
 *                                 #  non-zero, so idle branches stay hidden)
 * ========================================================================== */

function _hmPowerFlowRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Drawing constants. The SVG uses a fixed viewBox and is scaled by CSS,
   * so the illustration stays valid at any card width.
   * ------------------------------------------------------------------ */
  const VB_W = 700;
  const VB_H = 470;
  const MIN_FLOW = 5; // W; below this a branch is drawn as idle
  const LINE_END_Y = 376; // where the vertical connector lines stop

  const COLORS = {
    pv: "#f5a623",
    pv6: "#f5a623",
    sp: "#0ea5e9",
    battery: "#22c55e",
    battery_idle: "#9aa3ae",
    charge: "#22c55e",
    discharge: "#f59e0b",
    lock: "#ef4444",
    grid: "#4a90d9",
    grid_out: "#f59e0b",
    load: "#8b95a5",
  };

  /* ------------------------------------------------------------------ *
   * The house. Static markup; the battery in front and the flow overlay
   * are appended on top of it.
   * ------------------------------------------------------------------ */
  const HOUSE = `
    <ellipse cx="305" cy="384" rx="252" ry="13" fill="rgba(15,23,42,0.06)"/>

    <!-- base plinth -->
    <rect x="70" y="350" width="470" height="26" rx="7" fill="#c6ccd4"/>
    <rect x="70" y="350" width="470" height="9" rx="4.5" fill="#dce1e7"/>

    <!-- left wing: single storey, flat roof -->
    <polygon points="100,226 84,210 84,336 100,352" fill="#d3d8df"/>
    <polygon points="84,210 276,210 292,226 100,226" fill="#e5e9ee"/>
    <rect x="100" y="226" width="192" height="126" fill="#f6f7f9"/>
    <rect x="80" y="200" width="104" height="11" rx="3" fill="#c9ced6"/>
    <g stroke="#b0b7c1" stroke-width="2.4" stroke-linecap="round">
      <line x1="88" y1="200" x2="88" y2="170"/>
      <line x1="114" y1="200" x2="114" y2="170"/>
      <line x1="140" y1="200" x2="140" y2="170"/>
      <line x1="166" y1="200" x2="166" y2="170"/>
      <line x1="84" y1="170" x2="174" y2="170"/>
    </g>
    <polygon points="186,190 270,190 286,212 202,212" fill="#2f3b4d"/>
    <g stroke="#61708a" stroke-width="1.2">
      <line x1="207" y1="190" x2="223" y2="212"/>
      <line x1="228" y1="190" x2="244" y2="212"/>
      <line x1="249" y1="190" x2="265" y2="212"/>
      <line x1="194" y1="201" x2="278" y2="201"/>
    </g>

    <!-- right wing: two storeys with a pitched roof -->
    <polygon points="510,196 526,212 526,368 510,352" fill="#e7eaee"/>
    <rect x="292" y="196" width="218" height="156" fill="#f8f9fb"/>
    <rect x="304" y="206" width="194" height="64" fill="#f9e8d5"/>
    <rect x="296" y="270" width="208" height="9" fill="#dde1e7"/>
    <rect x="304" y="279" width="194" height="61" fill="#fbeddb"/>

    <!-- roof + roof solar array -->
    <polygon points="276,200 400,84 524,200" fill="#474d56"/>
    <polygon points="276,200 524,200 514,209 286,209" fill="#3b4149"/>
    <polygon points="301,177 381,101 396,117 316,193" fill="#28323f"/>
    <g stroke="#5b6b84" stroke-width="1.1">
      <line x1="320.9" y1="157.9" x2="335.9" y2="173.9"/>
      <line x1="341.1" y1="139.1" x2="356.1" y2="155.1"/>
      <line x1="361.3" y1="120.3" x2="376.3" y2="136.3"/>
      <line x1="308.5" y1="185" x2="388.5" y2="109"/>
    </g>

    <!-- upper room -->
    <rect x="308" y="212" width="7" height="52" rx="3" fill="#fdf1de"/>
    <rect x="352" y="252" width="12" height="12" rx="3" fill="#c98f63"/>
    <path d="M358 252 C352 240 348 236 344 234 M358 252 C364 240 368 236 372 234 M358 252 L358 236"
          stroke="#3f9d5c" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <rect x="472" y="226" width="7" height="38" rx="2" fill="#c9a072"/>
    <rect x="424" y="244" width="55" height="20" rx="5" fill="#ffffff"/>
    <rect x="428" y="248" width="18" height="12" rx="4" fill="#f0f3f7"/>
    <rect x="412" y="248" width="16" height="16" rx="4" fill="#cdd8e5"/>
    <circle cx="404" cy="236" r="6" fill="#ffd27a"/>
    <rect x="402" y="242" width="4" height="24" rx="2" fill="#d9cfc2"/>

    <!-- lower room -->
    <rect x="304" y="279" width="10" height="60" fill="#f7efe1"/>
    <rect x="342" y="300" width="54" height="14" rx="5" fill="#d6c8ae"/>
    <rect x="342" y="312" width="54" height="20" rx="5" fill="#c3b295"/>
    <rect x="404" y="322" width="36" height="6" rx="2" fill="#bb8f63"/>
    <rect x="408" y="328" width="4" height="8" fill="#a97f57"/>
    <rect x="432" y="328" width="4" height="8" fill="#a97f57"/>
    <rect x="452" y="292" width="44" height="28" rx="3" fill="#20242b"/>
    <rect x="456" y="296" width="36" height="20" rx="2" fill="#3b4450"/>
  `;

  /**
   * Small battery stack drawn in front of the house. Its lower block is
   * tinted with `color` so the picture reflects the battery state.
   */
  function stackMarkup(color) {
    return `
    <g class="pf-stack">
      <rect x="270" y="278" width="48" height="72" rx="5" fill="${color}"/>
      <path d="M275 278 h38 a5 5 0 0 1 5 5 v19 h-48 v-19 a5 5 0 0 1 5 -5 z" fill="#2c3138"/>
      <circle cx="294" cy="290" r="5" fill="rgba(255,255,255,0.28)"/>
      <rect x="318" y="286" width="11" height="56" rx="3" fill="#39404a"/>
      <rect x="276" y="350" width="10" height="8" rx="2" fill="#2c3138"/>
      <rect x="302" y="350" width="10" height="8" rx="2" fill="#2c3138"/>
    </g>`;
  }

  /* ------------------------------------------------------------------ *
   * Tiny helpers (kept local, the card is standalone)
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

  /** "1058.9" -> "1 058.9"; keeps the big numbers readable in the diagram. */
  function group(value) {
    const parts = String(value).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  /** Absolute power as it is shown under each node. */
  function fmtW(value) {
    const abs = Math.abs(num(value));
    const text = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    return `${group(text)} W`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Signal strength tiers, shared with the battery card so both cards draw the
   * same icon for the same reading. Returns the number of lit bars (0..4).
   */
  function rssiBars(rssi) {
    if (rssi === null || !Number.isFinite(rssi)) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -75) return 2;
    return 1;
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesPowerFlow extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
    }

    static getConfigElement() {
      return document.createElement("hoymiles-power-flow-editor");
    }

    static getStubConfig() {
      return { dev_id: "", language: "zh" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 10px 12px 6px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 8px;
                justify-content: space-between; margin: 2px 4px 4px; }
        .head.bare { justify-content: flex-end; }
        .hname { font-size: 20px; font-weight: 600;
                 color: var(--primary-text-color); letter-spacing: 0.2px; }
        .hname .dev { font-size: 13px; font-weight: 400; opacity: 0.65;
                      margin-left: 6px; }
        .hright { display: flex; align-items: center; gap: 14px; flex: none; }
        .signal { display: inline-flex; align-items: center; gap: 6px;
                  font-size: 13.5px; color: var(--secondary-text-color);
                  font-variant-numeric: tabular-nums; }
        .signal .bars { display: block; width: 22px; height: 18px; flex: none; }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                font-size: 14px; color: var(--primary-text-color); }
        .wrap { display: flex; justify-content: center; }
        svg { display: block; width: 100%; height: auto; }

        .pf-halo { fill: none; stroke: var(--hm-pf-halo, rgba(132,150,174,0.5));
                   stroke-width: 5.4; stroke-linecap: round;
                   stroke-linejoin: round; }
        .pf-line { fill: none; stroke: var(--hm-pf-line, #ffffff);
                   stroke-width: 2.6; stroke-linecap: round;
                   stroke-linejoin: round; }
        .pf-dot { stroke: #fff; stroke-width: 1.2; }

        .pf-v { font-size: 26px; font-weight: 600;
                fill: var(--primary-text-color); letter-spacing: 0.2px; }
        .pf-soc { font-size: 20px; font-weight: 500; opacity: 0.9; }
        .pf-c { font-size: 14px; fill: var(--secondary-text-color); }
        .pf-pill rect { fill: var(--hm-pf-pill, rgba(120,133,150,0.16)); }
        .pf-pill text { font-size: 12.5px; fill: var(--hm-pf-pill-text, #4b5563); }
        .pf-pill.warn rect { fill: rgba(245,158,11,0.18); }
        .pf-pill.warn text { fill: #b45309; }
        .pf-pill.ok rect { fill: rgba(34,197,94,0.18); }
        .pf-pill.ok text { fill: #15803d; }
        .pf-pill.busy rect { fill: rgba(74,144,217,0.18); }
        .pf-pill.busy text { fill: #1d4ed8; }
        /* small side chips (PV2 / smart plug), top left corner */
        .pf-chip rect { fill: var(--hm-pf-chip, rgba(120,133,150,0.14)); }
        .pf-chip text { font-size: 12px; fill: var(--hm-pf-chip-text, #4b5563); }
        .pf-chip .v { font-weight: 600; }
        .note { font-size: 12px; color: var(--secondary-text-color);
                text-align: center; padding: 4px 0 8px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-power-flow: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
    }

    getCardSize() {
      return 9;
    }

    /**
     * ``quick/state`` arrives every second, but the drawing only depends on a
     * handful of values — rebuilding the whole SVG on every push is wasteful
     * on a Raspberry Pi, so re-render only when something visible changed.
     */
    shouldUpdate() {
      if (!this._config || !this._hass) return true;
      const signature = this._signature();
      if (signature === this._signatureCache) return false;
      this._signatureCache = signature;
      return true;
    }

    _signature() {
      const d = this._data();
      return [
        this._config.language, this._config.gradient, this._config.max_width,
        this._config.title, this._config.show_title, this._config.show_rssi,
        this._config.show_extras, this._temperature(),
        d.pv, d.battery, d.grid, d.load, d.soc, d.status, d.rssi,
        d.pv2, d.smartPlug,
      ].join("\u0001");
    }

    /* ----------------------------- lookup ----------------------------- */

    _t(en, zh) {
      return this._config && this._config.language === "zh" ? zh : en;
    }

    _dev() {
      return this._config.dev_id;
    }

    /**
     * Resolve an entity id for this device.
     *
     * Three strategies, cheapest first: the conventional
     * ``<domain>.<slug(dev_id)>_<suffix>`` id, a prefix+suffix scan and
     * finally the integration's ``hoymiles_<dev_id>_<suffix>`` unique id.
     * Results are cached, because the scan is O(entities) and the card
     * re-renders on every state change.
     */
    _resolveEntity(suffix, domain = "sensor") {
      const overrides = (this._config.entities || {});
      if (overrides[suffix]) return overrides[suffix];

      const cacheKey = `${domain}:${suffix}`;
      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${suffix}`;
      let found = hass.states[conventional] ? conventional : null;

      if (!found) {
        // Normalized exact match on the part after `<domain>.<dev>_`.  Using
        // the normalized tail (instead of a plain suffix test) keeps `soc`
        // from matching `system_soc` and still accepts `pack_1_soc` for
        // `pack1_soc`.
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

    /** Numeric state of a device sensor, or `fallback` when unavailable. */
    _read(suffix, fallback = 0, domain = "sensor") {
      const state = this._stateOf(suffix, domain);
      if (!state) return fallback;
      const value = Number(state.state);
      return Number.isFinite(value) ? value : fallback;
    }

    /** Raw string state of a device sensor (used for `bat_sts`). */
    _readText(suffix) {
      const state = this._stateOf(suffix);
      return state ? String(state.state) : "";
    }

    /** State object of a device sensor, or null when missing/unavailable. */
    _stateOf(suffix, domain = "sensor") {
      const entityId = this._resolveEntity(suffix, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unavailable" || value === "unknown") return null;
      return state;
    }

    /** Collect everything the drawing needs in one pass. */
    _data() {
      let battery = this._read("system_battery_power", 0);
      if (!this._resolveEntity("system_battery_power")) {
        battery = this._read("bat_power", 0);
      }

      let pv = this._read("system_pv_power", 0);
      if (!this._resolveEntity("system_pv_power")) {
        pv = this._read("pv_power", 0);
      }

      let grid = this._read("system_grid_power", 0);
      if (!this._resolveEntity("system_grid_power")) {
        grid = this._read("grid_on_power", 0);
      }

      let load = this._read("system_load_power", 0);
      if (!this._resolveEntity("system_load_power")) {
        load = this._read("inv_power", 0);
      }

      // Battery SOC is deliberately the device level `soc` entity
      // (`quick/state`, 1 s, the average of this unit's own packs) and NOT
      // `system_soc`: the latter is capacity weighted across the whole network
      // (this unit plus every slave), so it reads differently from the gauge on
      // the dashboard and from the per-pack values.
      let soc = this._read("soc", null);
      if (soc === null) soc = this._read("system_soc", null);

      let status = this._readText("battery_status");
      if (!status) status = this._readText("bat_sts");

      // Wi-Fi signal strength; the power flow card prints it as a fan in the
      // top right corner of the header.
      const rssi = this._read("rssi", null);

      // The two branches the four main nodes do not show, but which the load
      // formula does include: `load = grid + plug + pv2 - sp`. Without them the
      // four numbers on screen cannot be made to balance. `null` means the
      // device does not report the field (a slave unit), and the chip is hidden.
      const pv2 = this._read("system_pv2_power", null);
      const smartPlug = this._read("system_smart_plug_power", null);

      return {
        pv, battery, grid, load, soc, status: status.toLowerCase(), rssi, pv2, smartPlug,
      };
    }

    /* ----------------------------- render ----------------------------- */

    render() {
      if (!this._config) return html``;
      const d = this._data();
      const temp = this._temperature();
      const showName = this._showName();

      return html`
        <ha-card>
          <div class="head ${showName ? "" : "bare"}">
            ${showName ? html`
              <div class="hname">
                ${esc(this._config.title || this._t("My home", "我的家"))}
                <span class="dev">${esc(this._dev())}</span>
              </div>` : ""}
            <div class="hright">
              ${this._signal(d)}
              ${temp === null ? "" : html`
                <div class="chip">
                  <span>☀️</span><span>${temp}</span>
                </div>`}
            </div>
          </div>
          <div class="wrap" style=${this._wrapStyle()}>
            ${this._untrusted(this._svg(d))}
          </div>
        </ha-card>
      `;
    }

    /** The title block (heading + device id) can be hidden with `show_title`.
     * ``title: false`` works too, so a single switch is enough in YAML.
     */
    _showName() {
      return this._config.show_title !== false && this._config.title !== false;
    }

    _wrapStyle() {
      const width = num(this._config.max_width);
      return width > 0 ? `max-width:${width}px` : "max-width:620px";
    }

    _temperature() {
      const entityId = this._config.temperature_entity;
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state || state.state === "unavailable" || state.state === "unknown") {
        return null;
      }
      const unit = (state.attributes && state.attributes.unit_of_measurement) || "°C";
      return `${num(state.state).toFixed(0)}${unit}`;
    }

    /**
     * RSSI shown in the top right corner: the same four-bar Wi-Fi icon the
     * battery card uses, plus the raw dBm reading.  Hidden when the device
     * reports no signal value, and switchable off with ``show_rssi: false``.
     */
    _signal(d) {
      if (this._config.show_rssi === false) return null;
      const rssi = d.rssi;
      if (rssi === null || !Number.isFinite(rssi)) return null;

      const bars = rssiBars(rssi);
      const quality = bars === 4 ? this._t("excellent", "优秀")
        : bars === 3 ? this._t("good", "良好")
          : bars === 2 ? this._t("fair", "一般")
            : this._t("weak", "较弱");

      return html`
        <div class="signal" title=${`${this._t("Wi-Fi signal", "Wi-Fi 信号")}: ${quality}`}>
          ${this._untrusted(this._signalBars(bars))}
          <span>${rssi.toFixed(0)} dBm</span>
        </div>`;
    }

    /**
     * The icon: four bars of increasing height. Geometry and colours match
     * ``hoymiles-battery``'s `_signal()` exactly, so the same reading looks
     * identical on both cards.
     */
    _signalBars(bars) {
      const color = bars === 0
        ? "var(--disabled-text-color, #b6bcc4)"
        : "var(--primary-color)";
      let out = "<svg class=\"bars\" width=\"22\" height=\"18\" viewBox=\"0 0 22 18\" "
        + "xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\">";
      for (let i = 0; i < 4; i += 1) {
        const h = 4 + i * 3.4;
        out += `<rect x="${1 + i * 5}" y="${16 - h}" width="3.4" height="${h}" rx="1.4"`
          + ` fill="${i < bars ? color : "var(--divider-color, #dcdfe4)"}"/>`;
      }
      return `${out}</svg>`;
    }

    /* --------------------------- the diagram --------------------------- */

    _svg(d) {
      const status = this._batteryStatus(d);
      const stack = stackMarkup(
        status.key === "charge" ? COLORS.charge
          : status.key === "discharge" ? COLORS.discharge
            : status.key === "lock" ? COLORS.lock
              : COLORS.battery_idle,
      );

      const routes = [
        { id: "pv", d: "M236 182 H105 V376", power: d.pv,
          color: COLORS.pv },
        { id: "battery", d: "M294 358 V376", power: d.battery,
          color: COLORS.battery },
        { id: "grid", d: "M512 316 H648 V376", power: d.grid,
          color: d.grid >= 0 ? COLORS.grid : COLORS.grid_out },
        { id: "load", d: "M480 152 H612 V96", power: d.load,
          color: COLORS.load },
      ];

      // Every route is drawn twice: a soft grey halo first, then a white line
      // on top. That is what makes the thin connectors readable on the light
      // backdrop (and it mirrors the vendor app's soft-edged lines).
      const halos = routes.map((r) => `
        <path class="pf-halo" d="${r.d}" fill="none"
              vector-effect="non-scaling-stroke"/>`).join("");
      const lines = routes.map((r) => `
        <path class="pf-line" d="${r.d}" fill="none"
              vector-effect="non-scaling-stroke"/>`).join("");

      const dots = routes.filter((r) => Math.abs(r.power) >= MIN_FLOW).map((r) => {
        const dur = clamp(6 - Math.abs(r.power) / 600, 1.2, 4.5).toFixed(2);
        return `
        <circle class="pf-dot" r="3.6" fill="${r.color}">
          <animateMotion dur="${dur}s" repeatCount="indefinite" path="${r.d}"/>
        </circle>`;
      }).join("");

      const pill = (x, y, text, cls) => {
        if (!text) return "";
        const wide = [...text].filter((ch) => ch.charCodeAt(0) > 0x2e80).length;
        const narrow = [...text].length - wide;
        const w = 20 + wide * 13 + narrow * 7.6;
        return `<g class="pf-pill ${cls}">
            <rect x="${(x - w / 2).toFixed(1)}" y="${y - 20}" width="${w.toFixed(1)}"
                  height="21" rx="10.5"/>
            <text x="${x}" y="${y - 5}" text-anchor="middle">${esc(text)}</text>
          </g>`;
      };

      const label = (x, y, value, caption, opts = {}) => {
        const soc = opts.soc == null
          ? ""
          : `<tspan class="pf-soc" dx="8">${num(opts.soc).toFixed(2)}%</tspan>`;
        return `
          ${pill(x, y - 24, opts.pill, opts.pillClass)}
          <text class="pf-v" x="${x}" y="${y}" text-anchor="middle">${value}${soc}</text>
          <text class="pf-c" x="${x}" y="${y + 22}" text-anchor="middle">${esc(caption)}</text>`;
      };

      const gridPill = this._gridPill(d.grid);
      const showSoc = d.soc !== null && !Number.isNaN(d.soc);

      /**
       * Small side chip: a coloured dot, a name and a value. Used for the two
       * branches the illustration has no node for (PV2 on the grid side and
       * the smart plug), so the four big numbers can be reconciled.
       */
      const chip = (x, y, name, value, color) => {
        const dot = 7;
        const nameW = [...name].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e80 ? 12.5 : 7.2), 0);
        const valW = [...value].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e80 ? 12.5 : 7), 0);
        const gap = 9;
        const padR = 12;
        const w = dot + 7 + nameW + gap + valW + padR;
        const h = 24;
        return `<g class="pf-chip">
            <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}"
                  height="${h}" rx="${h / 2}"/>
            <circle cx="${(x + 12).toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" r="3.6" fill="${color}"/>
            <text x="${(x + 21).toFixed(1)}" y="${(y + h / 2 + 4).toFixed(1)}">${esc(name)}</text>
            <text class="v" x="${(x + 21 + nameW + gap).toFixed(1)}"
                  y="${(y + h / 2 + 4).toFixed(1)}">${esc(value)}</text>
          </g>`;
      };

      /* A branch only gets a chip when the unit actually reports it and the
         reading is not zero: at zero there is nothing flowing on that branch,
         so the illustration stays clean. */
      const live = (v) => v !== null && v !== undefined && !Number.isNaN(v) && v !== 0;

      const extras = [];
      if (this._config.show_extras !== false) {
        const chips = [];
        if (live(d.pv2)) {
          chips.push([this._t("PV2", "光伏2"), fmtW(d.pv2), COLORS.pv6]);
        }
        if (live(d.smartPlug)) {
          chips.push([this._t("Smart plug", "智能插座"), fmtW(d.smartPlug), COLORS.sp]);
        }
        /* Stack them from the top down so that hiding one closes the gap. */
        chips.forEach(([name, value, color], i) => {
          extras.push(chip(40, 34 + i * 32, name, value, color));
        });
      }

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <linearGradient id="hm-pf-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#e9f2fc"/>
            <stop offset="1" stop-color="#fbfdff"/>
          </linearGradient>
        </defs>
        ${this._config.gradient === false
          ? ""
          : `<rect x="0" y="0" width="${VB_W}" height="${VB_H}" rx="12" fill="url(#hm-pf-bg)"/>`}
        ${HOUSE}
        ${stack}
        ${halos}
        ${lines}
        ${dots}
        ${label(105, 428, fmtW(d.pv), this._t("PV", "光伏"))}
        ${label(294, 428, fmtW(d.battery), this._t("Storage", "微储"),
          { pill: status.text, pillClass: status.cls, soc: showSoc ? d.soc : null })}
        ${label(648, 428, fmtW(d.grid), this._t("Grid", "电网"),
          { pill: gridPill.text, pillClass: gridPill.cls })}
        ${label(612, 52, fmtW(d.load), this._t("Load", "负载"))}
        ${extras.join("")}
      </svg>`;
    }

    /** Map the firmware's `bat_sts` string to a label + pill style. */
    _batteryStatus(d) {
      const table = {
        charge: { cls: "ok", en: "Charging", zh: "充电" },
        discharge: { cls: "warn", en: "Discharging", zh: "放电" },
        lock: { cls: "warn", en: "Locked", zh: "锁定" },
        standby: { cls: "", en: "Standby", zh: "待机" },
      };
      let key = d.status;
      if (!table[key]) {
        if (Math.abs(d.battery) < MIN_FLOW) key = "standby";
        else key = d.battery < 0 ? "charge" : "discharge";
      }
      const entry = table[key] || table.standby;
      return { key, cls: entry.cls, text: this._t(entry.en, entry.zh) };
    }

    /** Grid direction pill, matching the vendor app's 电网输入/电网输出. */
    _gridPill(grid) {
      if (Math.abs(grid) < MIN_FLOW) {
        return { text: this._t("Standby", "待机"), cls: "" };
      }
      if (grid > 0) return { text: this._t("Grid in", "电网输入"), cls: "warn" };
      return { text: this._t("Grid out", "电网输出"), cls: "warn" };
    }

    /**
     * Build a DocumentFragment from raw markup.
     * Lit escapes plain strings, and it has no cheap SVG builder, so the
     * diagram goes through <template>. Every interpolated value is escaped by
     * `esc()` before it lands in the markup.
     */
    _untrusted(markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      return template.content.cloneNode(true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesPowerFlowEditor extends LitElement {
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
          <ha-textfield label="language (en|zh)" .value=${config.language || "zh"}
            @change=${this._changed("language")}></ha-textfield>
          <ha-textfield label="temperature_entity" .value=${config.temperature_entity || ""}
            @change=${this._changed("temperature_entity")}></ha-textfield>
          <ha-textfield label="max_width (px)" .value=${config.max_width || ""}
            @change=${this._changed("max_width")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_title !== false}
              @change=${this._toggle("show_title")}></ha-switch>
            <span>show_title (标题与设备 SN)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.show_rssi !== false}
              @change=${this._toggle("show_rssi")}></ha-switch>
            <span>show_rssi (信号图标)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-power-flow-editor")) {
    customElements.define("hoymiles-power-flow-editor", HoymilesPowerFlowEditor);
  }
  if (!customElements.get("hoymiles-power-flow")) {
    customElements.define("hoymiles-power-flow", HoymilesPowerFlow);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-power-flow")) {
    window.customCards.push({
      type: "hoymiles-power-flow",
      name: "Hoymiles Power Flow",
      description:
        "Illustrated live power flow (PV / storage / grid / load) of a Hoymiles "
        + "micro storage device.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmPowerFlowRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmPowerFlowRegister());
}
