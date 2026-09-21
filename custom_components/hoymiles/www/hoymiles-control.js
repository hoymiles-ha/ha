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
        :host { display: block; }
        ha-card { padding: 14px 16px 16px; }
        .title { font-size: 16px; font-weight: 600;
                 color: var(--primary-text-color); margin-bottom: 4px; }
        .row { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center;
               padding: 11px 0; border-top: 1px solid var(--divider-color); }
        .row:first-of-type { border-top: none; }
        .label { flex: 0 0 158px; font-size: 13.5px;
                 color: var(--primary-text-color); font-weight: 500; }
        .label small { display: block; font-weight: 400; font-size: 11.5px;
                       color: var(--secondary-text-color); margin-top: 3px;
                       word-break: break-all; }
        .body { flex: 1 1 260px; display: flex; flex-wrap: wrap; gap: 8px;
                align-items: center; }
        .btn {
          font: inherit; font-size: 13px; padding: 7px 15px; border-radius: 9px;
          border: 1px solid var(--divider-color); cursor: pointer;
          background: none; color: var(--primary-text-color); transition: all .15s;
        }
        .btn:hover { background: var(--secondary-background-color, rgba(127,127,127,.1)); }
        .btn.on { background: var(--primary-color); border-color: var(--primary-color);
                  color: var(--text-primary-color, #fff); }
        .btn.warn { color: var(--error-color); border-color: var(--error-color); }
        .btn.warn.on { background: var(--error-color); color: #fff; }
        .btn:disabled { opacity: .45; cursor: not-allowed; }
        .btn.small { padding: 7px 12px; }
        input {
          font: inherit; font-size: 13.5px; width: 108px; padding: 6px 9px;
          border: 1px solid var(--divider-color); border-radius: 9px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none;
        }
        input:focus { border-color: var(--primary-color); }
        input.narrow { width: 76px; }
        select {
          font: inherit; font-size: 13.5px; padding: 6px 9px; border-radius: 9px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none;
        }
        .hint { font-size: 11.5px; color: var(--secondary-text-color); flex: 1 1 100%; }
        .state { font-size: 13px; color: var(--secondary-text-color); }
        .toast { margin-top: 10px; font-size: 12.5px; padding: 8px 11px;
                 border-radius: 9px; background: var(--secondary-background-color, rgba(127,127,127,.12)); }
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
          <div class="title">${esc(this._config.title || this._t("Control", "控制"))}</div>
          ${this._switchRow()}
          ${this._emsRow()}
          ${showPowerCtrl ? this._powerCtrlRow() : ""}
          ${this._outputRow()}
          ${showPhase ? this._phaseRow() : ""}
          ${this._touRow()}
          ${this._rebootRow()}
          ${this._toast === "" ? "" : html`
            <div class="toast ${this._toastError ? "err" : ""}">${esc(this._toast)}</div>`}
        </ha-card>
      `;
    }

    _row(label, topic, body, hint) {
      return html`
        <div class="row">
          <div class="label">${label}<small>${esc(topic)}</small></div>
          <div class="body">${body}${hint || ""}</div>
        </div>`;
    }

    _switchRow() {
      const on = this._isSwitchOn();
      return this._row(
        this._t("Power", "设备开关"),
        this._topic("switch/<dev_id>/set"),
        html`
          <button class="btn ${on ? "on" : ""}"
            @click=${() => this._setSwitch(true)}>${this._t("On", "开机")}</button>
          <button class="btn warn ${on ? "" : "on"}"
            @click=${() => this._setSwitch(false)}>${this._t("Off", "关机")}</button>
          <span class="state">${on ? this._t("running", "运行中") : this._t("standby", "已休眠")}</span>`,
      );
    }

    _emsRow() {
      const current = this._emsMode();
      const supported = this._emsOptions();
      const buttons = EMS_MODES.map((mode) => {
        const ok = supported.includes(mode.id);
        const title = ok ? "" : this._t(
          "This device does not offer this mode (an on-grid micro inverter is present).",
          "该模式当前不可用（并网口存在微逆）。",
        );
        return html`
          <button class="btn ${current === mode.id ? "on" : ""}" ?disabled=${!ok}
            title=${title}
            @click=${() => this._setEmsMode(mode.id)}>${esc(this._t(mode.en, mode.zh))}</button>`;
      });
      return this._row(
        this._t("EMS mode", "EMS 模式"),
        this._topic("select/<dev_id>/ems_mode/command"),
        html`${buttons}
          <span class="state">${current === "" ? "—" : esc(current)}</span>`,
        html`<div class="hint">${this._t(
          "mqtt_ctrl requires the LAN to have no micro inverter; changing the mode takes effect immediately.",
          "mqtt_ctrl 要求局域网内无微逆；模式切换立即生效。",
        )}</div>`,
      );
    }

    _powerCtrlRow() {
      const mode = this._emsMode();
      const ready = mode === "mqtt_ctrl";
      const min = this._attr("power_ctrl", "number", "min");
      const max = this._attr("power_ctrl", "number", "max");
      const range = min != null && max != null
        ? `${min} ~ ${max} W`
        : "-1000 ~ 1000 W";
      return this._row(
        this._t("Power control", "功率控制"),
        this._topic("number/<dev_id>/power_ctrl/set"),
        html`
          <input type="number" step="0.1" .value=${this._powerCtrl}
            @input=${(e) => { this._powerCtrl = e.target.value; }} />
          <button class="btn on" @click=${() => this._sendPowerCtrl()}>${this._t("Send", "下发")}</button>
          ${ready ? "" : html`<span class="state">${this._t("switch EMS to mqtt_ctrl first", "需先切到 mqtt_ctrl")}</span>`}`,
        html`<div class="hint">${this._t(
          `Range ${range}. Must be re-sent at least once a minute, otherwise the device falls back to self-consumption.`,
          `范围 ${range}。需至少每分钟下发一次，否则设备会切回自发自用。`,
        )}</div>`,
      );
    }

    _outputRow() {
      const min = this._attr("output_power", "number", "min");
      const max = this._attr("output_power", "number", "max");
      const range = min != null && max != null ? `${min} ~ ${max} W` : "100 ~ 2000 W";
      return this._row(
        this._t("Output power", "输出功率"),
        this._topic("number/<dev_id>/output_power/set"),
        html`
          <input type="number" step="1" .value=${this._outputPower}
            @input=${(e) => { this._outputPower = e.target.value; }} />
          <button class="btn on" @click=${() => this._sendOutputPower()}>${this._t("Send", "下发")}</button>`,
        html`<div class="hint">${this._t(`Range ${range}.`, `范围 ${range}。`)}</div>`,
      );
    }

    _phaseRow() {
      const min = this._attr("phase_a_output_power", "number", "min");
      const max = this._attr("phase_a_output_power", "number", "max");
      const range = min != null && max != null ? `${min} ~ ${max} W` : "100 ~ 2500 W";
      const field = (key, label) => html`
        <label class="state">${label}</label>
        <input class="narrow" type="number" step="1" .value=${this._phase[key]}
          @input=${(e) => { this._phase = { ...this._phase, [key]: e.target.value }; }} />`;
      return this._row(
        this._t("Phase output", "多相输出功率"),
        this._topic("number/<dev_id>/phase_output_power/set"),
        html`
          ${field("a", "A")}${field("b", "B")}${field("c", "C")}
          <button class="btn on" @click=${() => this._sendPhase()}>${this._t("Send", "下发")}</button>`,
        html`<div class="hint">${this._t(
          `Range ${range}, sent as {"phase_a":..,"phase_b":..,"phase_c":..}.`,
          `范围 ${range}，按 {"phase_a":..,"phase_b":..,"phase_c":..} 下发。`,
        )}</div>`,
      );
    }

    _touRow() {
      const options = WEEKDAYS.map((d) =>
        `<option value="${d}" ${d === this._week ? "selected" : ""}>${d}</option>`).join("");
      return this._row(
        this._t("Get TOU plan", "获取 TOU 计划"),
        this._topic("sensor/<dev_id>/tou_plan/get"),
        html`
          <select @change=${(e) => { this._week = e.target.value; }}>
            ${this._untrusted(options)}
          </select>
          <button class="btn on" @click=${() => this._sendTouGet()}>${this._t("Get", "获取")}</button>`,
        html`<div class="hint">${this._t(
          "The reply arrives on tou_plan/status; the full plan editor is below.",
          "应答发布在 tou_plan/status；完整的日/周计划编辑器见下方。",
        )}</div>`,
      );
    }

    _rebootRow() {
      return this._row(
        this._t("Reboot", "重启设备"),
        this._topic("button/<dev_id>/reboot/trigger"),
        html`
          <button class="btn warn" @click=${() => this._reboot()}>${this._t("Reboot", "重启")}</button>`,
      );
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
          <ha-textfield label="title" .value=${config.title || ""}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="language (en|zh)" .value=${config.language || "zh"}
            @change=${this._changed("language")}></ha-textfield>
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
