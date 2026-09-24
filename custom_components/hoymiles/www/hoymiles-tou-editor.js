/* ============================================================================
 * Hoymiles Micro Storage — TOU (time-of-use) plan editor
 * ----------------------------------------------------------------------------
 * Lovelace card bundled with the `hoymiles` custom integration.
 * Protocol: 《禾迈微储MQTT协议开发指南》V0.5.1 §16 ~ §21
 *
 * The card talks to the device through the integration services
 * (hoymiles.set_tou_day_plan / set_tou_week_plan / get_tou_plan / set_ems_mode)
 * and falls back to `mqtt.publish` when the integration is not installed.
 *
 * Card config:
 *   type: custom:hoymiles-tou-editor
 *   dev_id: MSA-280520260806     # required
 *   title: TOU plan              # optional
 *   language: zh                 # optional (en|zh)
 *   ems_entity / status_entity / day_ack_entity / week_ack_entity  # optional
 * ========================================================================== */

function _hmTouRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WEEK_ZH = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };
  const MODE_LABEL = {
    1: { en: "Force charge", zh: "强制充电" },
    2: { en: "PV charge", zh: "光伏充电" },
    4: { en: "Discharge", zh: "放电" },
  };
  const TS_MAX = 96;

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  function tsToTime(ts) {
    const m = Math.max(0, Math.min(TS_MAX, Number(ts) || 0)) * 15;
    const h = Math.floor(m / 60) % 24;
    return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  function timeToTs(value) {
    const [h, mm] = String(value || "00:00").split(":").map(Number);
    return Math.round((((h || 0) * 60 + (mm || 0)) % 1440) / 15);
  }
  function newSegment() {
    return { mode: 1, ts: 0, te: 4, sh: 55, sl: 10, pc: 1000, pd: 1000 };
  }

  class HoymilesTouEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object }, _log: { type: Array } };
    }

    static getConfigElement() {
      return document.createElement("hoymiles-tou-editor-editor");
    }

    static getStubConfig() {
      return { dev_id: "MSA-280520260806", language: "zh" };
    }

    static get styles() {
      return css`
        /* iOS-style layout, matching the control card: grouped blocks, inset
           hairlines instead of a full table grid, segmented controls and pill
           buttons. */
        :host { display: block; }
        ha-card { padding: 14px 16px 16px; }
        .wrap { color: var(--primary-text-color); }
        .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
                margin-bottom: 12px; }
        .head .title { font-size: 17px; font-weight: 600; }
        .head .sub { font-size: 12.5px; color: var(--secondary-text-color); }

        .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
               margin-bottom: 14px; }
        .chip { font-size: 12.5px; color: var(--secondary-text-color); }
        /* Non-TOU mode: the editor stays visible but read-only, so the plan can
           still be inspected. The banner is outside .locked and keeps working. */
        .notice { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
                  padding: 10px 14px; border-radius: 12px; margin-bottom: 12px;
                  background: var(--secondary-background-color, rgba(120,120,128,.12));
                  font-size: 13.5px; color: var(--secondary-text-color); }
        .notice span { flex: 1 1 auto; }
        .locked { opacity: .5; pointer-events: none;
                  -webkit-user-select: none; user-select: none; }

        /* rounded group, like an iOS settings section */
        .group { background: var(--secondary-background-color, rgba(120,120,128,.08));
                 border-radius: 14px; overflow: hidden; margin-bottom: 14px; }
        .group-title { font-size: 12.5px; font-weight: 500;
                       color: var(--secondary-text-color); padding: 0 6px 6px;
                       margin-top: 4px; }

        .tblwrap { overflow-x: auto; border-radius: 14px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: none; padding: 8px 4px; font-size: 13.5px;
                 text-align: left; vertical-align: middle; }
        thead th { font-size: 12px; font-weight: 500; padding-top: 10px;
                   padding-bottom: 6px;
                   color: var(--secondary-text-color); white-space: nowrap; }
        tbody tr + tr td { border-top: 1px solid var(--divider-color); }
        tbody td:first-child, thead th:first-child { padding-left: 12px; }
        tbody td:last-child, thead th:last-child { padding-right: 12px; }
        /* The card can be half the dashboard width (side by side with the control
           card), so the day-plan table has to fit ~620px. */
        .wplan { min-width: 0; }
        .dplan { min-width: 540px; }
        .dplan th, .dplan td { padding-left: 3px; padding-right: 3px; }
        .dplan td:first-child, .dplan th:first-child { padding-left: 12px; }
        .dplan td:last-child, .dplan th:last-child { padding-right: 12px; }
        .dplan select, .dplan input { padding: 5px 6px; font-size: 13px; }
        select, input { width: 100%; box-sizing: border-box; min-width: 0;
                        font: inherit; font-size: 13.5px; padding: 6px 9px;
                        border-radius: 9px; border: 1px solid transparent;
                        background: var(--card-background-color, #fff);
                        color: var(--primary-text-color); outline: none; }
        select:focus, input:focus { border-color: var(--primary-color); }
        .col-mode { width: 96px; } .col-time { width: 86px; }
        .col-num { width: 52px; } .col-btn { width: 30px; }

        /* segmented control (day 1..8) */
        .seg { display: inline-flex; padding: 2px; gap: 2px; max-width: 100%;
               overflow-x: auto;
               background: var(--secondary-background-color, rgba(120,120,128,.16));
               border-radius: 10px; }
        .seg .tab { border: none; background: none; font: inherit;
                    font-size: 13px; padding: 5px 12px; border-radius: 8px;
                    cursor: pointer; color: var(--primary-text-color);
                    white-space: nowrap;
                    transition: background .15s, box-shadow .15s; }
        .seg .tab.on { background: var(--card-background-color, #fff);
                       box-shadow: 0 1px 3px rgba(0,0,0,.14);
                       font-weight: 600; }

        /* pill buttons */
        .btn { font: inherit; font-size: 13.5px; font-weight: 500;
               padding: 8px 15px; border-radius: 10px; border: none;
               cursor: pointer;
               background: var(--secondary-background-color, rgba(120,120,128,.16));
               color: var(--primary-text-color); }
        .btn.primary { background: var(--primary-color); font-weight: 600;
                       color: var(--text-primary-color, #fff); }
        .btn.danger { background: none; color: var(--error-color);
                      padding: 8px 10px; }
        .btn:active { filter: brightness(.94); }

        .log { max-height: 140px; overflow-y: auto; font-size: 12px;
               white-space: pre-wrap; padding: 10px 14px; border-radius: 14px;
               background: var(--secondary-background-color, rgba(120,120,128,.08)); }
        .err { color: var(--error-color); } .ok { color: var(--success-color); }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-tou-editor: 'dev_id' is required");
      }
      this._config = { language: "en", ...config };
      this._resetDraft();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._draft) this._resetDraft();
      this.requestUpdate();
    }

    _resetDraft() {
      this._draft = { curDay: 1, week: Array(7).fill(0), days: {} };
      for (let i = 1; i <= 8; i++) this._draft.days[i] = [newSegment()];
      if (!this._log) this._log = [];
    }

    _t(en, zh) { return this._config && this._config.language === "zh" ? zh : en; }
    _dev() { return this._config.dev_id; }
    _weekLabel(day) { return this._t(day, WEEK_ZH[day]); }

    /**
     * Resolve an entity id for this device.
     * Tries, in order: exact conventional id, entity_id suffix match,
     * unique_id suffix match (used by the firmware discovery entities).
     */
    _resolveEntity({ domain, idSuffix, uniqueSuffix }) {
      const states = (this._hass && this._hass.states) || {};
      const entities = (this._hass && this._hass.entities) || {};
      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${idSuffix}`;

      if (states[conventional]) return conventional;

      const prefix = `${domain}.${dev}`;
      for (const entityId of Object.keys(states)) {
        if (entityId.startsWith(prefix) && entityId.endsWith(idSuffix)) return entityId;
      }

      if (uniqueSuffix) {
        for (const [entityId, entry] of Object.entries(entities)) {
          if (entry && entry.unique_id && entry.unique_id.endsWith(uniqueSuffix)) {
            return entityId;
          }
        }
      }

      return conventional;
    }

    _emsEntity() {
      return this._config.ems_entity
        || this._resolveEntity({
          domain: "select", idSuffix: "mqtt_select", uniqueSuffix: "_ems_mode",
        });
    }
    _statusEntity() {
      return this._config.status_entity
        || this._resolveEntity({ domain: "sensor", idSuffix: "tou_plan_status" });
    }
    _dayAckEntity() {
      return this._config.day_ack_entity
        || this._resolveEntity({ domain: "sensor", idSuffix: "tou_day_plan_ack" });
    }
    _weekAckEntity() {
      return this._config.week_ack_entity
        || this._resolveEntity({ domain: "sensor", idSuffix: "tou_week_plan_ack" });
    }

    _emsMode() {
      const state = this._hass && this._hass.states[this._emsEntity()];
      return state ? state.state : null;
    }

    _hasIntegration() {
      const services = (this._hass && this._hass.services) || {};
      return !!(services.hoymiles && services.hoymiles.set_tou_day_plan);
    }

    _logLine(cls, text) {
      const line = `${new Date().toLocaleTimeString()} ${text}`;
      this._log = [{ cls, line }, ...(this._log || [])].slice(0, 40);
    }

    async _publish(topic, payload) {
      await this._hass.callService("mqtt", "publish", {
        topic, payload: JSON.stringify(payload), qos: 1,
      });
    }

    async _setMode(mode) {
      try {
        if (this._hasIntegration()) {
          await this._hass.callService("hoymiles", "set_ems_mode", {
            dev_id: this._dev(), mode,
          });
        } else {
          const entity = this._emsEntity();
          if (this._hass.states[entity]) {
            await this._hass.callService("select", "select_option", { entity_id: entity, option: mode });
          } else {
            await this._publish(`homeassistant/select/${this._dev()}/ems_mode/command`, mode);
          }
        }
        this._logLine("ok", `EMS mode -> ${mode}`);
      } catch (err) {
        this._logLine("err", `set mode failed: ${err.message || err}`);
      }
    }

    async _sendDayPlan(dayIdx, segments) {
      if (this._hasIntegration()) {
        await this._hass.callService("hoymiles", "set_tou_day_plan", {
          dev_id: this._dev(), day_idx: dayIdx, day_plan: segments,
        });
      } else {
        await this._publish(`homeassistant/sensor/${this._dev()}/tou_day_plan/set`, {
          day_idx: dayIdx, day_plan: segments,
        });
      }
    }

    async _sendWeekPlan(weekPlan) {
      if (this._hasIntegration()) {
        await this._hass.callService("hoymiles", "set_tou_week_plan", {
          dev_id: this._dev(), week_plan: weekPlan,
        });
      } else {
        await this._publish(`homeassistant/sensor/${this._dev()}/tou_week_plan/set`, {
          week_plan: weekPlan,
        });
      }
    }

    async _getPlan(week) {
      try {
        const statusId = this._statusEntity();
        const before = this._hass.states[statusId];
        const beforeUpdate = before ? before.last_updated : null;

        if (this._hasIntegration()) {
          await this._hass.callService("hoymiles", "get_tou_plan", { dev_id: this._dev(), week });
        } else {
          await this._publish(`homeassistant/sensor/${this._dev()}/tou_plan/get`, { week });
        }

        // The device answers over MQTT with a variable latency (a few seconds),
        // so poll until the status entity is refreshed instead of a fixed wait.
        let state = null;
        for (let i = 0; i < 24; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          state = this._hass.states[statusId];
          if (state && state.last_updated !== beforeUpdate) break;
        }

        const attrs = (state && state.attributes) || {};
        if (Array.isArray(attrs.day_plan) && attrs.day_plan.length) {
          const dayIdx = Number(attrs.day_idx) || 1;
          this._draft = {
            ...this._draft,
            curDay: dayIdx,
            week: this._draft.week.map((v, i) => (WEEK[i] === attrs.week ? dayIdx : v)),
            days: { ...this._draft.days, [dayIdx]: attrs.day_plan.map((s) => ({ ...s })) },
          };
          this._logLine("ok", `${week} -> day${dayIdx} · ${attrs.day_plan.length} ${this._t("segments", "段")}`);
        } else {
          const reason = attrs.err_msg || (state ? state.state : "no status");
          this._logLine("err", `${week}: ${reason}`);
        }
      } catch (err) {
        this._logLine("err", `get plan failed: ${err.message || err}`);
      }
      this.requestUpdate();
    }

    async _saveAll() {
      try {
        for (let day = 1; day <= 8; day++) {
          const segments = this._draft.days[day] || [];
          if (!segments.length) continue;
          await this._sendDayPlan(day, segments);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const groups = {};
        this._draft.week.forEach((dayIdx, index) => {
          if (!dayIdx) return;
          groups[dayIdx] = groups[dayIdx] || [];
          groups[dayIdx].push(WEEK[index]);
        });
        const weekPlan = Object.entries(groups).map(([dayIdx, days]) => ({
          week: days, day_idx: Number(dayIdx),
        }));
        if (weekPlan.length) await this._sendWeekPlan(weekPlan);
        await this._setMode("tou_plan");
        const today = WEEK[(new Date().getDay() + 6) % 7];
        await this._getPlan(today);
        this._logLine("ok", this._t("saved and activated", "保存并激活完成"));
      } catch (err) {
        this._logLine("err", `save failed: ${err.message || err}`);
      }
      this.requestUpdate();
    }

    _setSegment(day, index, field, value) {
      const segments = this._draft.days[day].slice();
      segments[index] = { ...segments[index], [field]: value };
      this._draft = { ...this._draft, days: { ...this._draft.days, [day]: segments } };
      this.requestUpdate();
    }

    _addSegment(day) {
      const segments = this._draft.days[day] || [];
      if (segments.length >= 12) return;
      this._draft = {
        ...this._draft,
        days: { ...this._draft.days, [day]: [...segments, newSegment()] },
      };
      this.requestUpdate();
    }

    _removeSegment(day, index) {
      const segments = (this._draft.days[day] || []).filter((_, i) => i !== index);
      this._draft = { ...this._draft, days: { ...this._draft.days, [day]: segments } };
      this.requestUpdate();
    }

    render() {
      if (!this._draft) this._resetDraft();
      const mode = this._emsMode();
      /* The plan is only editable in tou_plan. Other modes keep the card visible
         but greyed out (read-only) instead of replacing it with a hint - the
         user asked to be able to look at the plan without switching modes. */
      const locked = this._config.require_tou_mode !== false
        && !!mode && mode !== "tou_plan";

      const day = this._draft.curDay;
      const segments = this._draft.days[day] || [];
      const statusState = this._hass.states[this._statusEntity()];

      return html`
        <ha-card>
          ${locked ? html`
            <div class="notice">
              <span>
                ${this._t("Read-only: EMS mode is ", "只读：EMS 模式为 ")}
                <b>${mode}</b>${this._t(", not tou_plan.", "，不是 tou_plan。")}
              </span>
              <button class="btn primary" @click=${() => this._setMode("tou_plan")}>
                ${this._t("Switch to tou_plan", "切换到 tou_plan")}
              </button>
            </div>` : ""}
          <div class="wrap ${locked ? "locked" : ""}"
               aria-disabled=${locked ? "true" : "false"}>
            <div class="head">
              <div class="title">${this._config.title || this._t("TOU plan", "分时计划")}</div>
              <div class="sub">${this._dev()} · EMS: ${mode || "?"}</div>
            </div>

            <div class="bar">
              <button class="btn" @click=${() => this._getPlan(WEEK[(new Date().getDay() + 6) % 7])}>
                ${this._t("Load today", "载入今天")}
              </button>
              <button class="btn" @click=${() => this._getPlan("Mon")}>${this._t("Load Mon", "载入周一")}</button>
              <button class="btn primary" @click=${() => this._saveAll()}>
                ${this._t("Save & Activate", "保存并激活")}
              </button>
            </div>

            <div class="group-title">${this._t("Week plan", "周计划")}</div>
            <div class="group">
              <div class="tblwrap">
                <table class="wplan">
                  <thead><tr><th>${this._t("Day", "星期")}</th><th>${this._t("Day plan", "日计划")}</th></tr></thead>
                  <tbody>
                    ${WEEK.map((name, index) => html`
                      <tr>
                        <td>${this._weekLabel(name)}</td>
                        <td>
                          <select @change=${(e) => {
                            const week = this._draft.week.slice();
                            week[index] = Number(e.target.value);
                            this._draft = { ...this._draft, week };
                          }}>
                            <option value="0" ?selected=${!this._draft.week[index]}>—</option>
                            ${[1, 2, 3, 4, 5, 6, 7, 8].map((idx) => html`
                              <option value=${idx} ?selected=${this._draft.week[index] === idx}>day${idx}</option>
                            `)}
                          </select>
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="group-title">${this._t("Day plan editor", "日计划编辑")}</div>
            <div class="seg" style="margin-bottom:10px">
              ${[1, 2, 3, 4, 5, 6, 7, 8].map((idx) => html`
                <button class="tab ${idx === day ? "on" : ""}" @click=${() => {
                  this._draft = { ...this._draft, curDay: idx };
                }}>day${idx}</button>
              `)}
            </div>

            <div class="group">
              <div class="tblwrap">
                <table class="dplan">
                <colgroup>
                  <col class="col-mode"/><col class="col-time"/><col class="col-time"/>
                  <col class="col-num"/><col class="col-num"/><col class="col-num"/>
                  <col class="col-num"/><col class="col-btn"/>
                </colgroup>
                <thead>
                  <tr>
                    <th>${this._t("Mode", "模式")}</th><th>${this._t("Start", "开始")}</th>
                    <th>${this._t("End", "结束")}</th><th>sh%</th><th>sl%</th>
                    <th>pc W</th><th>pd W</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${segments.map((seg, index) => html`
                    <tr>
                      <td>
                        <select @change=${(e) => this._setSegment(day, index, "mode", Number(e.target.value))}>
                          ${[1, 2, 4].map((m) => html`
                            <option value=${m} ?selected=${Number(seg.mode) === m}>
                              ${MODE_LABEL[m][this._config.language === "zh" ? "zh" : "en"]}
                            </option>
                          `)}
                        </select>
                      </td>
                      <td><input type="time" step="900" .value=${tsToTime(seg.ts)}
                        @change=${(e) => this._setSegment(day, index, "ts", timeToTs(e.target.value))}/></td>
                      <td><input type="time" step="900" .value=${tsToTime(seg.te)}
                        @change=${(e) => this._setSegment(day, index, "te", timeToTs(e.target.value))}/></td>
                      <td><input type="number" min="10" max="100" .value=${seg.sh}
                        @change=${(e) => this._setSegment(day, index, "sh", Number(e.target.value))}/></td>
                      <td><input type="number" min="10" max="100" .value=${seg.sl}
                        @change=${(e) => this._setSegment(day, index, "sl", Number(e.target.value))}/></td>
                      <td><input type="number" min="100" .value=${seg.pc}
                        @change=${(e) => this._setSegment(day, index, "pc", Number(e.target.value))}/></td>
                      <td><input type="number" min="100" .value=${seg.pd}
                        @change=${(e) => this._setSegment(day, index, "pd", Number(e.target.value))}/></td>
                      <td><button class="btn danger" @click=${() => this._removeSegment(day, index)}>✕</button></td>
                    </tr>
                  `)}
                </tbody>
                </table>
              </div>
            </div>
            <div class="bar" style="margin-top:8px">
              <button class="btn" @click=${() => this._addSegment(day)}>
                ${this._t("+ Add segment", "+ 添加时段")}
              </button>
            </div>

            <div class="group-title">${this._t("Status", "状态")}</div>
            <div class="group">
              <div class="log">
                <div class="chip">
                  ${this._t("status", "回显")}: ${statusState ? statusState.state : "-"} ·
                  ${this._t("day ack", "日应答")}: ${(this._hass.states[this._dayAckEntity()] || {}).state || "-"} ·
                  ${this._t("week ack", "周应答")}: ${(this._hass.states[this._weekAckEntity()] || {}).state || "-"}
                </div>
                ${(this._log || []).map((entry) => html`<div class=${entry.cls}>${entry.line}</div>`)}
              </div>
            </div>
          </div>
        </ha-card>
      `;
    }
  }

  class HoymilesTouEditorEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object } };
    }

    setConfig(config) {
      this._config = { language: "en", ...(config || {}) };
    }

    set hass(hass) {
      this._hass = hass;
    }

    _valueChanged(field) {
      return (event) => {
        const config = { ...(this._config || {}), [field]: event.target.value };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    render() {
      const config = this._config || {};
      return html`
        <div style="padding:8px">
          <ha-textfield label="dev_id" .value=${config.dev_id || ""}
            @change=${this._valueChanged("dev_id")} style="display:block"></ha-textfield>
          <ha-textfield label="title" .value=${config.title || ""}
            @change=${this._valueChanged("title")} style="display:block"></ha-textfield>
          <ha-textfield label="language (en|zh)" .value=${config.language || "en"}
            @change=${this._valueChanged("language")} style="display:block"></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-tou-editor-editor")) {
    customElements.define("hoymiles-tou-editor-editor", HoymilesTouEditorEditor);
  }
  if (!customElements.get("hoymiles-tou-editor")) {
    customElements.define("hoymiles-tou-editor", HoymilesTouEditor);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-tou-editor")) {
    window.customCards.push({
      type: "hoymiles-tou-editor",
      name: "Hoymiles TOU Editor",
      description: "Configure the time-of-use charge/discharge plan of a Hoymiles micro storage device.",
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmTouRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmTouRegister());
}
