/* ============================================================================
 * Hoymiles Micro Storage — Control panel card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-control`
 *
 * Every command from《禾迈微储MQTT协议开发指南》V0.5.1, as buttons / inputs:
 *
 *   §10 switch      homeassistant/switch/<dev_id>/set                 ON | OFF
 *   §11 reboot      homeassistant/button/<dev_id>/reboot/trigger      RESTART
 *   §12 ems mode    homeassistant/select/<dev_id>/ems_mode/command    general |
 *                                                                     mqtt_ctrl |
 *                                                                     tou_plan
 *   §13 power ctrl  homeassistant/number/<dev_id>/power_ctrl/set      float (W)
 *   §14 output pwr  homeassistant/number/<dev_id>/output_power/set    int (W)
 *   §15 phase pwr   homeassistant/number/<dev_id>/phase_output_power/set
 *                   {"phase_a":..,"phase_b":..,"phase_c":..}
 *   §20 tou get     homeassistant/sensor/<dev_id>/tou_plan/get        {"week":..}
 *
 * Commands are published straight to those topics (qos 1, retain false), which
 * keeps the card working even when a discovery entity is missing or has a
 * narrower option list than the protocol allows. Current values are read back
 * from the matching entities when they exist.
 *
 * Card config:
 *   type: custom:hoymiles-control
 *   dev_id: MSA-280520260806
 *   language: zh
 *   title: 控制
 *   show_phase: true            # optional, default true
 *   show_power_ctrl: true       # optional, default true
 *   show_topics: true           # optional, default false; show the MQTT topic
 *                               # of every row (engineering detail)
 *   subtitle: false             # optional; hide the grey line under the title
 *
 * The layout follows the iOS settings idiom: small grey section headers, one
 * rounded group per section, rows of icon + name + right-aligned control, and
 * hairline separators that stop short of the card edge. The MQTT topic paths
 * are hidden by default - they are useful while debugging but noisy in use.
 * ========================================================================== */

function _hmControlRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  const EMS_MODES = [
    { id: "general", en: "General", zh: "自发自用" },
    { id: "mqtt_ctrl", en: "MQTT ctrl", zh: "MQTT 功率控制" },
    { id: "tou_plan", en: "TOU plan", zh: "分时计划" },
  ];
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const PING_MS = 8000; // how long the "sent" confirmation stays visible

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

  /* `esc()` is only for markup strings handed to `_untrusted()` (they go through
   * `innerHTML`). Lit templates escape their own bindings, so a `${...}` inside a
   * `html` template must keep the value raw. */

  class HoymilesControl extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _powerCtrl: { type: String },
        _outputPower: { type: String },
        _phase: { type: Object },
        _week: { type: String },
        _toast: { type: String },
        _toastError: { type: Boolean },
        _optimistic: { type: Object },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._powerCtrl = "";
      this._outputPower = "";
      this._phase = { a: "", b: "", c: "" };
      this._week = "Mon";
      this._toast = "";
      this._toastError = false;
      this._optimistic = {};
      this._cache = new Map();
      this._initialised = false;
      this._toastTimer = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-control-editor");
    }

    static getStubConfig() {
      return { dev_id: "", language: "zh" };
    }

    static get styles() {
      return css`
        /* iOS-style settings layout: grouped cards, right-aligned controls,
           hairline separators that stop short of the card edge. */
        :host { display: block; }
        ha-card { padding: 14px 16px 16px; }
        .head { display: flex; align-items: baseline; gap: 10px;
                margin-bottom: 12px; }
        .head .title { font-size: 17px; font-weight: 600;
                       color: var(--primary-text-color); }
        .head .sub { font-size: 12.5px; color: var(--secondary-text-color); }

        .group { background: var(--secondary-background-color, rgba(120,120,128,.08));
                 border-radius: 14px; overflow: hidden; margin-bottom: 14px; }
        .group-title { font-size: 12.5px; font-weight: 500;
                       color: var(--secondary-text-color);
                       padding: 0 6px 6px; }
        .group-wrapper:not(:first-of-type) { margin-top: 16px; }

        .item { display: flex; align-items: center; gap: 12px;
                padding: 11px 14px; min-height: 52px;
                box-sizing: border-box; position: relative; }
        .item + .item::before {
          content: ""; position: absolute; top: 0; left: 14px; right: 0;
          height: 1px; background: var(--divider-color); opacity: .7;
        }
        .item .ico { flex: 0 0 auto; width: 24px; text-align: center;
                     font-size: 16px; line-height: 1; }
        .item .nm { flex: 1 1 auto; min-width: 0; font-size: 15px;
                    color: var(--primary-text-color); line-height: 1.3; }
        .item .nm small { display: block; font-size: 12px; font-weight: 400;
                          color: var(--secondary-text-color); margin-top: 2px;
                          line-height: 1.35; }
        .item .nm code { font-size: 11px; color: var(--secondary-text-color);
                         word-break: break-all; }
        .item .ctrl { flex: 0 0 auto; display: flex; align-items: center;
                      gap: 8px; margin-left: auto; }
        .item.stack { flex-direction: column; align-items: stretch; gap: 8px; }
        .item.stack .ctrl { margin-left: 0; flex-wrap: wrap; }
        .item .ctrl .unit { font-size: 13px; color: var(--secondary-text-color); }

        /* segmented control (the iOS signature control) */
        .seg { display: inline-flex; padding: 2px; gap: 2px;
               background: var(--secondary-background-color, rgba(120,120,128,.16));
               border-radius: 10px; }
        .seg button {
          border: none; background: none; font: inherit; font-size: 13px;
          padding: 5px 12px; border-radius: 8px; cursor: pointer;
          color: var(--primary-text-color); white-space: nowrap;
          transition: background .15s, box-shadow .15s;
        }
        .seg button.on {
          background: var(--card-background-color, #fff);
          box-shadow: 0 1px 3px rgba(0,0,0,.14); font-weight: 600;
        }
        .seg button:disabled { opacity: .4; cursor: not-allowed; }
        .seg.danger button.on { color: var(--error-color); }

        /* plain pill button */
        .btn {
          font: inherit; font-size: 13.5px; font-weight: 500;
          padding: 8px 15px; border-radius: 10px; border: none;
          cursor: pointer; background: var(--secondary-background-color, rgba(120,120,128,.16));
          color: var(--primary-text-color); transition: filter .15s;
        }
        .btn:active { filter: brightness(.94); }
        .btn.primary { background: var(--primary-color);
                       color: var(--text-primary-color, #fff); font-weight: 600; }
        .btn.danger { background: none; color: var(--error-color); padding: 8px 10px; }
        .btn:disabled { opacity: .45; cursor: not-allowed; }

        input {
          font: inherit; font-size: 15px; width: 88px; text-align: right;
          padding: 7px 10px; border-radius: 10px;
          border: 1px solid transparent;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none;
          font-variant-numeric: tabular-nums;
        }
        input:focus { border-color: var(--primary-color); }
        input.narrow { width: 62px; }
        select {
          font: inherit; font-size: 15px; padding: 7px 10px;
          border-radius: 10px; border: 1px solid transparent;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none; cursor: pointer;
        }
        select:focus { border-color: var(--primary-color); }
        .state { font-size: 13px; color: var(--secondary-text-color);
                 white-space: nowrap; }
        .state.live { color: var(--primary-color); font-weight: 500; }
        .toast { margin-top: 12px; font-size: 13px; padding: 10px 13px;
                 border-radius: 12px;
                 background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        .toast.err { color: var(--error-color); }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-control: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
      this._initialised = false;
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._initialised) this._seedInputs();
      this.requestUpdate();
    }

    getCardSize() {
      return 13;
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      if (this._toastTimer) clearTimeout(this._toastTimer);
    }

    /* ----------------------------- lookups ----------------------------- */

    _t(en, zh) {
      return this._config && this._config.language === "zh" ? zh : en;
    }

    _dev() {
      return this._config.dev_id;
    }

    /**
     * Resolve an entity by protocol key.
     *
     * The firmware's MQTT discovery uses `<dev_id>_<key>` unique ids, while the
     * integration's own entities use `hoymiles_<dev_id>_<key>`; entity ids are
     * slugified from the *name*, so they are matched normalized.
     */
    _resolve(key, domain = "number") {
      const overrides = this._config.entities || {};
      if (overrides[key]) return overrides[key];

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cacheKey = `${domain}:${key}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      let found = null;
      const wantUid = new Set([
        `${this._dev()}_${key}`,
        `hoymiles_${this._dev()}_${key}`,
      ]);
      for (const [entityId, entry] of Object.entries(hass.entities || {})) {
        if (!entry || !entityId.startsWith(`${domain}.`)) continue;
        if (wantUid.has(entry.unique_id)) { found = entityId; break; }
      }

      if (!found) {
        const prefix = `${domain}.${slug(this._dev())}`;
        const wanted = norm(key);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          const tail = norm(entityId.slice(prefix.length + 1));
          if (tail !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    _state(key, domain = "number") {
      const entityId = this._resolve(key, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unknown" || value === "unavailable") return null;
      return state;
    }

    _number(key) {
      const state = this._state(key, "number");
      return state ? num(state.state) : null;
    }

    _attr(key, domain, name) {
      const state = this._state(key, domain);
      return state && state.attributes ? state.attributes[name] : null;
    }

    _topic(suffix) {
      return `homeassistant/${suffix.replace("<dev_id>", this._dev())}`;
    }

    /** Pre-fill the inputs from the device the first time we see it. */
    _seedInputs() {
      if (!this._hass || !this._hass.states) return;
      const pc = this._number("power_ctrl");
      const op = this._number("output_power");
      if (pc != null) this._powerCtrl = String(pc);
      if (op != null) this._outputPower = String(op);
      const phases = ["a", "b", "c"];
      let any = false;
      for (const p of phases) {
        const value = this._number(`phase_${p}_output_power`)
          ?? this._number("phase_output_power");
        if (value != null) { this._phase[p] = String(value); any = true; }
      }
      if (pc == null && op == null && !any) return; // nothing to seed yet
      this._initialised = true;
    }

    /* ------------------------------ sending ------------------------------ */

    async _publish(topic, payload, label) {
      if (!this._hass || typeof this._hass.callService !== "function") return;
      try {
        await this._hass.callService("mqtt", "publish", {
          topic,
          payload: typeof payload === "string" ? payload : JSON.stringify(payload),
          qos: 1,
          retain: false,
        });
        this._showToast(`${this._t("Sent", "已下发")} ${label} → ${topic}`);
      } catch (err) {
        this._showToast(`${this._t("Failed", "下发失败")}: ${topic} (${err.message || err})`, true);
      }
    }

    _showToast(message, isError = false) {
      this._toast = message;
      this._toastError = isError;
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this._toast = "";
        this.requestUpdate();
      }, PING_MS);
    }

    _setSwitch(on) {
      this._optimistic.switch = on ? "on" : "off";
      this._publish(this._topic("switch/<dev_id>/set"), on ? "ON" : "OFF",
        this._t(on ? "Power on" : "Power off", on ? "开机" : "关机"));
    }

    _isSwitchOn() {
      const state = this._state("mqtt_switch", "switch") || this._state("config", "switch");
      const value = state ? String(state.state) : null;
      if (value === "on" || value === "off") {
        // An optimistic value wins briefly, so the button reacts immediately.
        return value === "on";
      }
      return this._optimistic.switch === "on";
    }

    _setEmsMode(mode) {
      this._optimistic.ems_mode = mode;
      this._publish(this._topic("select/<dev_id>/ems_mode/command"), mode,
        `${this._t("EMS mode", "EMS 模式")} → ${mode}`);
    }

    _emsMode() {
      const state = this._state("ems_mode", "select");
      return (state ? String(state.state) : null) || this._optimistic.ems_mode || "";
    }

    _emsOptions() {
      const options = this._attr("ems_mode", "select", "options");
      if (Array.isArray(options) && options.length) return options;
      return EMS_MODES.map((m) => m.id);
    }

    _sendPowerCtrl() {
      const value = Number(this._powerCtrl);
      if (!Number.isFinite(value)) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      this._publish(this._topic("number/<dev_id>/power_ctrl/set"), String(value),
        `${this._t("Power control", "功率控制")} ${value} W`);
    }

    _sendOutputPower() {
      const value = Number(this._outputPower);
      if (!Number.isFinite(value)) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      this._publish(this._topic("number/<dev_id>/output_power/set"), String(value),
        `${this._t("Output power", "输出功率")} ${value} W`);
    }

    _sendPhase() {
      const payload = {
        phase_a: Number(this._phase.a),
        phase_b: Number(this._phase.b),
        phase_c: Number(this._phase.c),
      };
      if (!Object.values(payload).every(Number.isFinite)) {
        this._showToast(this._t("Invalid value", "数值无效"), true);
        return;
      }
      this._publish(this._topic("number/<dev_id>/phase_output_power/set"), payload,
        `${this._t("Phase output", "多相输出")} ${payload.phase_a}/${payload.phase_b}/${payload.phase_c} W`);
    }

    _sendTouGet() {
      this._publish(this._topic("sensor/<dev_id>/tou_plan/get"), { week: this._week },
        `${this._t("Get TOU plan", "获取 TOU 计划")} ${this._week}`);
    }

    _reboot() {
      const ok = window.confirm(this._t(
        "Reboot the device now?", "确认立即重启设备？",
      ));
      if (!ok) return;
      this._publish(this._topic("button/<dev_id>/reboot/trigger"), "RESTART",
        this._t("Reboot", "重启"));
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const showPhase = this._config.show_phase !== false;
      const showPowerCtrl = this._config.show_power_ctrl !== false;

      return html`
        <ha-card>
          <div class="head">
            <div class="title">${this._config.title || this._t("Control", "控制")}</div>
            ${this._config.subtitle === false ? "" : html`
              <div class="sub">${this._t(
                "Commands are sent straight to the device",
                "指令直接下发到设备",
              )}</div>`}
          </div>
          ${this._group(this._t("Power & mode", "电源与模式"), [
            this._switchItem(),
            this._emsItem(),
          ])}
          ${this._group(this._t("Power settings", "功率设置"), [
            showPowerCtrl ? this._powerCtrlItem() : "",
            this._outputItem(),
            showPhase ? this._phaseItem() : "",
          ])}
          ${this._group(this._t("Plan & maintenance", "计划与维护"), [
            this._touItem(),
            this._rebootItem(),
          ])}
          ${this._toast === "" ? "" : html`
            <div class="toast ${this._toastError ? "err" : ""}">${this._toast}</div>`}
        </ha-card>
      `;
    }

    /** One grouped block, like an iOS settings section. */
    _group(title, items) {
      return html`
        <div class="group-wrapper">
          ${title ? html`<div class="group-title">${title}</div>` : ""}
          <div class="group">${items}</div>
        </div>`;
    }

    /**
     * One settings row: icon, name (with an optional grey sub-line), and the
     * control right-aligned. `stack` puts the control on its own line, which is
     * what the three-phase inputs need.
     */
    _item({ icon, name, sub, topic, ctrl, stack }) {
      const showTopics = this._config.show_topics === true;
      return html`
        <div class="item ${stack ? "stack" : ""}">
          ${icon ? html`<span class="ico">${icon}</span>` : ""}
          <div class="nm">${name}
            ${sub ? html`<small>${sub}</small>` : ""}
            ${showTopics && topic ? html`<small><code>${topic}</code></small>` : ""}
          </div>
          <div class="ctrl">${ctrl}</div>
        </div>`;
    }

    /** iOS segmented control. `options` = [{id, label, enabled, title}] */
    _segment(options, current, onPick, extraClass = "") {
      return html`
        <div class="seg ${extraClass}">
          ${options.map((opt) => html`
            <button class="${opt.id === current ? "on" : ""}"
              ?disabled=${opt.enabled === false}
              title=${opt.title || ""}
              @click=${() => onPick(opt.id)}>${opt.label}</button>`)}
        </div>`;
    }

    _switchItem() {
      const on = this._isSwitchOn();
      return this._item({
        icon: "⚡",
        name: this._t("Power", "设备开关"),
        sub: on ? this._t("running", "运行中") : this._t("standby", "已休眠"),
        topic: this._topic("switch/<dev_id>/set"),
        ctrl: this._segment(
          [
            { id: "on", label: this._t("On", "开机") },
            { id: "off", label: this._t("Off", "关机") },
          ],
          on ? "on" : "off",
          (id) => this._setSwitch(id === "on"),
        ),
      });
    }

    _emsItem() {
      const current = this._emsMode();
      const supported = this._emsOptions();
      const options = EMS_MODES.map((mode) => ({
        id: mode.id,
        label: this._t(mode.en, mode.zh),
        enabled: supported.includes(mode.id),
        title: supported.includes(mode.id)
          ? mode.id
          : this._t(
            "Not available while an on-grid micro inverter is present.",
            "并网口存在微逆时不可用。",
          ),
      }));
      return this._item({
        icon: "🔋",
        name: this._t("EMS mode", "EMS 模式"),
        sub: current === "" ? "—" : current,
        topic: this._topic("select/<dev_id>/ems_mode/command"),
        ctrl: this._segment(options, current, (id) => this._setEmsMode(id)),
      });
    }

    _powerCtrlItem() {
      const ready = this._emsMode() === "mqtt_ctrl";
      const min = this._attr("power_ctrl", "number", "min");
      const max = this._attr("power_ctrl", "number", "max");
      const range = min != null && max != null ? `${min} ~ ${max} W` : "-1000 ~ 1000 W";
      return this._item({
        icon: "🎛",
        name: this._t("Power control", "功率控制"),
        sub: this._t(
          `${range}, re-send at least once a minute`,
          `${range}，需至少每分钟下发一次`,
        ),
        topic: this._topic("number/<dev_id>/power_ctrl/set"),
        ctrl: html`
          <input type="number" step="0.1" .value=${this._powerCtrl}
            @input=${(e) => { this._powerCtrl = e.target.value; }} />
          <span class="unit">W</span>
          <button class="btn primary" ?disabled=${!ready}
            @click=${() => this._sendPowerCtrl()}>${this._t("Send", "下发")}</button>
          ${ready ? "" : html`<span class="state">${this._t(
            "requires mqtt_ctrl", "需先切到 mqtt_ctrl")}</span>`}`,
      });
    }

    _outputItem() {
      const min = this._attr("output_power", "number", "min");
      const max = this._attr("output_power", "number", "max");
      const range = min != null && max != null ? `${min} ~ ${max} W` : "100 ~ 2000 W";
      return this._item({
        icon: "📤",
        name: this._t("Output power", "输出功率"),
        sub: this._t(`Range ${range}.`, `范围 ${range}。`),
        topic: this._topic("number/<dev_id>/output_power/set"),
        ctrl: html`
          <input type="number" step="1" .value=${this._outputPower}
            @input=${(e) => { this._outputPower = e.target.value; }} />
          <span class="unit">W</span>
          <button class="btn primary"
            @click=${() => this._sendOutputPower()}>${this._t("Send", "下发")}</button>`,
      });
    }

    _phaseItem() {
      const min = this._attr("phase_a_output_power", "number", "min");
      const max = this._attr("phase_a_output_power", "number", "max");
      const range = min != null && max != null ? `${min} ~ ${max} W` : "100 ~ 2500 W";
      const field = (key, label) => html`
        <span class="state">${label}</span>
        <input class="narrow" type="number" step="1" .value=${this._phase[key]}
          @input=${(e) => { this._phase = { ...this._phase, [key]: e.target.value }; }} />`;
      return this._item({
        icon: "🔌",
        name: this._t("Phase output", "多相输出功率"),
        sub: this._t(`Range ${range}.`, `范围 ${range}。`),
        topic: this._topic("number/<dev_id>/phase_output_power/set"),
        stack: true,
        ctrl: html`
          ${field("a", "A")}${field("b", "B")}${field("c", "C")}
          <span class="unit">W</span>
          <button class="btn primary"
            @click=${() => this._sendPhase()}>${this._t("Send", "下发")}</button>`,
      });
    }

    _touItem() {
      const options = WEEKDAYS.map((d) =>
        `<option value="${d}" ${d === this._week ? "selected" : ""}>${d}</option>`).join("");
      return this._item({
        icon: "📅",
        name: this._t("Get TOU plan", "获取 TOU 计划"),
        sub: this._t(
          "Reply arrives on tou_plan/status; edited below",
          "应答发布在 tou_plan/status；编辑见下方",
        ),
        topic: this._topic("sensor/<dev_id>/tou_plan/get"),
        ctrl: html`
          <select @change=${(e) => { this._week = e.target.value; }}>
            ${this._untrusted(options)}
          </select>
          <button class="btn"
            @click=${() => this._sendTouGet()}>${this._t("Get", "获取")}</button>`,
      });
    }

    _rebootItem() {
      return this._item({
        icon: "🔄",
        name: this._t("Reboot", "重启设备"),
        sub: this._t("Takes about a minute", "约需一分钟"),
        topic: this._topic("button/<dev_id>/reboot/trigger"),
        ctrl: html`
          <button class="btn danger"
            @click=${() => this._reboot()}>${this._t("Reboot", "重启")}</button>`,
      });
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
  class HoymilesControlEditor extends LitElement {
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
          <label class="sw">
            <ha-switch .checked=${config.show_topics === true}
              @change=${this._toggle("show_topics")}></ha-switch>
            <span>show_topics (显示 MQTT 主题，调试用)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-control-editor")) {
    customElements.define("hoymiles-control-editor", HoymilesControlEditor);
  }
  if (!customElements.get("hoymiles-control")) {
    customElements.define("hoymiles-control", HoymilesControl);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-control")) {
    window.customCards.push({
      type: "hoymiles-control",
      name: "Hoymiles Control",
      description:
        "Buttons and inputs for every control topic of the Hoymiles micro storage "
        + "MQTT protocol (power, EMS mode, output power, phases, TOU, reboot).",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmControlRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmControlRegister());
}
