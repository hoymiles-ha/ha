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
 *   type: custom:hoymiles-g2-tou-editor
 *   dev_id: MSA-280520260806     # required
 *   title: TOU plan              # optional
 *   language: en                 # optional (en|zh); omit to follow Home Assistant
 *   ems_entity / status_entity / day_ack_entity / week_ack_entity  # optional
 * ========================================================================== */

function _hmTouRegister() {
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

  const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WEEK_ZH = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };
  const MODE_LABEL = {
    1: { en: "Force Charge", zh: "强制充电" },
    2: { en: "PV Charge", zh: "光伏充电" },
    4: { en: "Discharge", zh: "放电" },
  };
  const TS_MAX = 96;

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  /* Only letters and digits, so `MSA-280520260806`, `msa_280520260806` and the
   * user-renamed forms all collapse to the same string - the join used below to
   * find entities whose id no longer matches the conventional pattern. */
  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  /**
   * Drop the `_2` / `_3` … Home Assistant appends to a colliding entity id.
   *
   * HA does not fail a registration whose derived `entity_id` is taken; it
   * numbers it.  A unit whose serial was registered once before therefore has
   * every id one suffix away from the plain one this card derives, so the joins
   * and prefix tests below have to look past that number.  Only a trailing
   * `_<digits>` is removed, so a key that legitimately ends in digits
   * (`pv1_power`) is untouched.
   */
  function stripAuditSuffix(value) {
    const text = String(value == null ? "" : value);
    const at = text.lastIndexOf("_");
    if (at <= 0) return text;
    const tail = text.slice(at + 1);
    if (!/^[0-9]+$/.test(tail) || /^0+$/.test(tail)) return text;
    return text.slice(0, at);
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
      return document.createElement("hoymiles-g2-tou-editor-editor");
    }

    static getStubConfig() {
      return { dev_id: "MSA-280520260806" };
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
               flex-wrap: wrap;
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
        throw new Error("hoymiles-g2-tou-editor: 'dev_id' is required");
      }
      this._config = { ...config };
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
    _dev() { return this._config.dev_id; }
    _weekLabel(day) { return this._t(day, WEEK_ZH[day]); }

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

    /**
     * Resolve an entity id for this device.
     * Tries, in order: exact conventional id, entity_id suffix match, the same
     * with Home Assistant's `_2` disambiguation number stripped, a match on the
     * serial (for a renamed device), and finally the registry `name`.
     *
     * The numbered pass matters because HA does not fail a registration whose
     * derived `entity_id` is taken - it appends `_2`, `_3` … - so a unit
     * registered once before has every id one suffix away from the one this
     * card derives, and the editor showed an empty plan for such a device.
     */
    _resolveEntity({ domain, idSuffix, uniqueSuffix }) {
      const states = (this._hass && this._hass.states) || {};
      const entities = (this._hass && this._hass.entities) || {};
      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${idSuffix}`;

      if (states[conventional]) return conventional;

      const prefix = `${domain}.${dev}`;
      const wanted = norm(idSuffix);

      // 1. normalized exact match on the tail after `<domain>.<dev>_`.
      let found = null;
      for (const entityId of Object.keys(states)) {
        if (!entityId.startsWith(prefix)) continue;
        if (norm(entityId.slice(prefix.length + 1)) !== wanted) continue;
        if (!found || entityId.length < found.length) found = entityId;
      }
      if (found) return found;

      // 2. the same, tolerating the disambiguation number.
      for (const entityId of Object.keys(states)) {
        if (!entityId.startsWith(prefix)) continue;
        if (norm(stripAuditSuffix(entityId.slice(prefix.length + 1))) !== wanted) continue;
        if (!found || entityId.length < found.length) found = entityId;
      }
      if (found) return found;

      // 3. A renamed device: Home Assistant rewrites every entity id to the new
      //    name, so the `<slug(dev_id)>_` prefix above stops matching.  The
      //    serial never changes, so look for the suffix right after it.
      const marker = norm(this._dev());
      for (const entityId of Object.keys(states)) {
        const flat = norm(entityId);
        const at = marker ? flat.indexOf(marker) : -1;
        if (at < 0) continue;
        const tail = flat.slice(at + marker.length);
        if (tail !== wanted && norm(stripAuditSuffix(tail)) !== wanted) continue;
        if (!found || entityId.length < found.length) found = entityId;
      }
      if (found) return found;

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
          this._logLine("ok", `${week} -> day${dayIdx} · ${attrs.day_plan.length} ${this._t("Segments", "段")}`);
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
        this._logLine("ok", this._t("Saved and activated", "保存并激活完成"));
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
                ${this._t("Read-only: EMS Mode is ", "只读：EMS 模式为 ")}
                <b>${mode}</b>${this._t(", not tou_plan.", "，不是 tou_plan。")}
              </span>
              <button class="btn primary" @click=${() => this._setMode("tou_plan")}>
                ${this._t("Switch to tou_plan", "切换到 tou_plan")}
              </button>
            </div>` : ""}
          <div class="wrap ${locked ? "locked" : ""}"
               aria-disabled=${locked ? "true" : "false"}>
            <div class="head">
              <div class="title">${this._text(this._config.title) || this._t("TOU Plan", "分时计划")}</div>
              <div class="sub">${this._dev()} · EMS: ${mode || "?"}</div>
            </div>

            <div class="bar">
              <button class="btn" @click=${() => this._getPlan(WEEK[(new Date().getDay() + 6) % 7])}>
                ${this._t("Load Today", "载入今天")}
              </button>
              <button class="btn" @click=${() => this._getPlan("Mon")}>${this._t("Load Mon", "载入周一")}</button>
              <button class="btn primary" @click=${() => this._saveAll()}>
                ${this._t("Save & Activate", "保存并激活")}
              </button>
            </div>

            <div class="group-title">${this._t("Week Plan", "周计划")}</div>
            <div class="group">
              <div class="tblwrap">
                <table class="wplan">
                  <thead><tr><th>${this._t("Day", "星期")}</th><th>${this._t("Day Plan", "日计划")}</th></tr></thead>
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

            <div class="group-title">${this._t("Day Plan Editor", "日计划编辑")}</div>
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
                              ${this._t(MODE_LABEL[m].en, MODE_LABEL[m].zh)}
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
                ${this._t("+ Add Segment", "+ 添加时段")}
              </button>
            </div>

            <div class="group-title">${this._t("Status", "状态")}</div>
            <div class="group">
              <div class="log">
                <div class="chip">
                  ${this._t("Status", "回显")}: ${statusState ? statusState.state : "-"} ·
                  ${this._t("Day ack", "日应答")}: ${(this._hass.states[this._dayAckEntity()] || {}).state || "-"} ·
                  ${this._t("Week ack", "周应答")}: ${(this._hass.states[this._weekAckEntity()] || {}).state || "-"}
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
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._valueChanged("title")} style="display:block"></ha-textfield>
          <ha-textfield label="language (auto|en|zh, auto follows Home Assistant)"
            .value=${config.language || ""} @change=${this._valueChanged("language")} style="display:block"></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-g2-tou-editor-editor")) {
    customElements.define("hoymiles-g2-tou-editor-editor", HoymilesTouEditorEditor);
  }
  if (!customElements.get("hoymiles-g2-tou-editor")) {
    customElements.define("hoymiles-g2-tou-editor", HoymilesTouEditor);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-tou-editor")) {
    window.customCards.push({
      type: "hoymiles-g2-tou-editor",
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
