/* ============================================================================
 * Hoymiles MS-G2 — Alarms card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-alarm`
 *
 * Protocol §27: the device publishes the complete list of alarms that have not
 * ended yet on `alarm/state`, at most 20 of them, and republishes the whole list
 * whenever it changes.  The integration turns that into the `Active Alarms`
 * sensor: the state is the count and `attributes.alarms` is the list, already
 * decoded from code to text and already newest-first.
 *
 * This card only draws that list.  It deliberately has no acknowledge button -
 * the protocol has no way to acknowledge an alarm, so a button could only lie.
 *
 * Three states, and the difference between the last two matters:
 *
 *   unavailable  no such entity on this device (a storage unit never declares
 *                the `alarm_state` topic at all)
 *   no data      the entity exists but has never reported - `alarm/state` is not
 *                retained, so a freshly restarted unit stays silent until the
 *                next alarm; claiming "no alarms" here would be a lie
 *   ok / list    the device really did report, and either listed nothing or
 *                listed the alarms shown below
 *
 * Card config:
 *   type: custom:hoymiles-g2-alarm
 *   entity: sensor.x_active_alarms   # required
 *   title: 设备告警                   # optional, accepts an en/zh map
 *   max: 5                           # optional, at most N rows (hard cap 20)
 * ========================================================================== */

function _hmAlarmRegister() {
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
   * Language
   *
   * Resolved by the shared `hoymiles-g2-i18n.js` module, which mirrors the
   * official integration's toolbar switch: an explicit choice stored under
   * `hoymiles.language` wins, then a per-card `language:`, then the Home
   * Assistant user's own language.  `en`, `zh` and `de` are supported.
   * ------------------------------------------------------------------ */
  const hmLang = (hass, config) => I18N.lang(hass, config);

  const hmText = (value, lang) => I18N.text(value, lang);

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /** Protocol §27 sends at most 20 alarms; more than that would not arrive. */
  const ALARM_MAX = 20;

  /* ------------------------------------------------------------------ *
   * Alarm time
   *
   * The firmware sends `26-01-01 20:20` - two-digit year, no seconds.  The card
   * shows `2026-01-01 20:20`, because a two-digit year in a list of events is a
   * riddle rather than a date.  Anything else is passed through unchanged, so a
   * format change on the device cannot blank the column.
   * ------------------------------------------------------------------ */
  const STAMP = /^(\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

  function hmStamp(value) {
    const text = String(value == null ? "" : value).trim();
    const hit = STAMP.exec(text);
    if (!hit) return text;
    return `20${hit[1]}-${hit[2]}-${hit[3]} ${hit[4]}:${hit[5]}`;
  }

  class HoymilesAlarm extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object } };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-g2-alarm-editor");
    }

    static getStubConfig() {
      return { entity: "" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; height: 100%; box-sizing: border-box; }
        .head { display: flex; align-items: center; gap: 8px;
                color: var(--primary-text-color); margin-bottom: 10px; }
        .name { font-size: 15px; font-weight: 500; line-height: 1.3; }
        .count { font-size: 12.5px; font-weight: 500; margin-left: auto;
                 color: var(--secondary-text-color); }
        .none { font-size: 12.5px; color: var(--secondary-text-color); }
        .list { display: flex; flex-direction: column; gap: 8px;
                overflow-y: auto; max-height: var(--hm-alarm-max-height, 260px); }
        .row { display: grid; grid-template-columns: auto 1fr;
               gap: 2px 10px; align-items: baseline; }
        .code { font-size: 11.5px; font-variant-numeric: tabular-nums;
                padding: 1px 6px; border-radius: 9px;
                color: var(--error-color, #db4437);
                background: rgba(219, 68, 55, 0.12);
                border: 1px solid rgba(219, 68, 55, 0.35); }
        .nm { font-size: 13px; color: var(--primary-text-color);
              overflow-wrap: anywhere; }
        /* 智能设备离线 names the device it is about, so the serial is the only
           actionable part of that row.  It sits under the alarm name in the
           same secondary colour the timestamp uses, and is set in the
           tabular-numeric stack so two serials line up digit for digit. */
        .sn { grid-column: 2; font-size: 11.5px;
              color: var(--secondary-text-color);
              font-variant-numeric: tabular-nums;
              letter-spacing: 0.02em; overflow-wrap: anywhere; }
        .time { grid-column: 2; font-size: 11.5px;
                color: var(--secondary-text-color);
                font-variant-numeric: tabular-nums; }
      `;
    }

    setConfig(config) {
      if (!config || !config.entity) {
        throw new Error("hoymiles-g2-alarm: 'entity' is required");
      }
      this._config = { ...config };
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
      const alarms = this._alarms();
      /* A self-hiding card has no height at all while it is hidden, and the
         dashboard sizes the row from these numbers, so reporting the list
         height unconditionally would leave a gap where the card used to be. */
      if (this._config && this._config.only_when_alarm === true) {
        if (!alarms || alarms.length === 0) return 0;
      }
      return 2 + (alarms == null ? 0 : Math.min(this._limit(), alarms.length));
    }

    /** One of the two strings the card carries, in the current language. */
    _t(en, zh) {
      return I18N.pick(this._lang(), en, zh);
    }

    /** The language this card should render in (`en` | `zh` | `de`). */
    _lang() {
      return hmLang(this._hass, this._config);
    }

    _limit() {
      const asked = Number(this._config && this._config.max);
      if (!Number.isFinite(asked) || asked <= 0) return ALARM_MAX;
      return Math.min(Math.floor(asked), ALARM_MAX);
    }

    _state() {
      const hass = this._hass;
      const entityId = this._config && this._config.entity;
      if (!hass || !hass.states || !entityId) return null;
      return hass.states[entityId] || null;
    }

    /**
     * The decoded alarm list.
     *
     * `null` means "this device says nothing about alarms" - either the entity
     * does not exist, or it exists but has never reported (an unretained topic
     * and a fresh restart).  Both are reported as unknown rather than as
     * "nothing is wrong", because the card cannot know.
     */
    _alarms() {
      const state = this._state();
      if (!state) return null;
      const items = state.attributes && state.attributes.alarms;
      if (!Array.isArray(items)) return null;
      return items.slice(0, this._limit());
    }

    render() {
      if (!this._config) return html``;
      const title = hmText(this._config.title, hmLang(this._hass, this._config))
        || this._t("Alarms", "设备告警");

      const state = this._state();
      const alarms = this._alarms();

      /* ``only_when_alarm: true`` makes the card disappear whenever there is
         nothing to report.  The power flow beside it then takes the whole row,
         which is what the Device tab wants: a permanent "no alarms" panel
         spends a quarter of the width saying nothing.

         A device that has *never* reported is hidden too, and deliberately: the
         card cannot tell "healthy" from "silent", so the schematic carries the
         badge instead (only a real zero earns the green tick).  Leaving an
         empty panel on screen would claim a state the card does not know. */
      if (this._config.only_when_alarm === true) {
        if (!state || !alarms || alarms.length === 0) return html``;
      }

      const head = html`
        <div class="head">
          <div class="name">${esc(title)}</div>
          ${alarms && alarms.length
            ? html`<span class="count">${alarms.length}</span>` : ""}
        </div>`;

      // No entity at all: this device does not declare the topic.
      if (!state) {
        return html`
          <ha-card>
            ${head}
            <div class="none">${this._t("Alarm data unavailable", "告警数据不可用")}</div>
          </ha-card>
        `;
      }

      // The entity exists but has never reported.
      if (alarms == null) {
        return html`
          <ha-card>
            ${head}
            <div class="none">${this._t("No alarm data yet", "尚未收到告警数据")}</div>
          </ha-card>
        `;
      }

      /* One name, in the language the dashboard selector is set to.

         `name_en` / `name_zh` come from this integration.  `name` is the
         protocol's own English text and is what an older build shipped, so it
         is the last resort for both - a card running against a sensor from
         before the bilingual table existed still prints something.

         The other language is deliberately *not* printed underneath any more:
         the table is only ever read to identify the alarm, and a second dimmed
         line in a language the user did not pick doubled the height of every
         row.  German has no name column of its own - the protocol's alarm table
         is English and Chinese only - so it reads the English wording. */
      const lang = this._lang();
      const zh = lang === "zh";
      const rows = alarms.map((item) => {
        const code = item && item.code != null ? String(item.code) : "";
        const fallback = (item && item.name) || "—";
        const en = (item && (item.name_en || item.name)) || fallback;
        const cn = (item && (item.name_zh || item.name)) || fallback;
        const name = zh ? cn : en;
        const time = hmStamp(item && item.time);
        /* ``sn`` is the serial of the device the alarm is about.  It is the
           whole point of a 「智能设备离线」 report - the gateway raises that code
           on behalf of a subordinate, and the serial is the only thing that
           says which one - so it is printed whenever the payload carries it and
           skipped entirely when it does not.  An older firmware that omits the
           field therefore renders exactly the row it always did. */
        const sn = item && typeof item.sn === "string" ? item.sn.trim() : "";
        return html`
          <div class="row">
            ${code ? html`<span class="code">${esc(code)}</span>` : html`<span></span>`}
            <span class="nm">${esc(name)}</span>
            ${sn ? html`<span class="sn">${esc(sn)}</span>` : ""}
            ${time ? html`<span class="time">${esc(time)}</span>` : ""}
          </div>`;
      });

      return html`
        <ha-card>
          ${head}
          ${alarms.length === 0
            ? html`<div class="none">${this._t("No active alarms", "当前无告警")}</div>`
            : html`<div class="list">${rows}</div>`}
        </ha-card>
      `;
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesAlarmEditor extends LitElement {
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

    /** A checkbox writes a boolean, not a string, so `_changed` cannot be reused. */
    _toggled(field) {
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
        .switch { display: flex; align-items: center; gap: 10px;
                  font-size: 14px; margin-top: 4px; }
        .hint { font-size: 12px; color: var(--secondary-text-color);
                margin: 2px 0 0 2px; }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="entity (required)" .value=${config.entity || ""}
            @change=${this._changed("entity")}></ha-textfield>
          <ha-textfield label="title (accepts an en/zh map)"
            .value=${typeof config.title === "string" ? config.title : ""}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="max rows (default 20)" .value=${config.max || ""}
            @change=${this._changed("max")}></ha-textfield>
          <label class="switch">
            <ha-switch .checked=${config.only_when_alarm === true}
              @change=${this._toggled("only_when_alarm")}></ha-switch>
            <span>only_when_alarm</span>
          </label>
          <div class="hint">
            Hide the whole card while the device reports no alarms.
          </div>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-g2-alarm-editor")) {
    customElements.define("hoymiles-g2-alarm-editor", HoymilesAlarmEditor);
  }
  if (!customElements.get("hoymiles-g2-alarm")) {
    customElements.define("hoymiles-g2-alarm", HoymilesAlarm);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-alarm")) {
    window.customCards.push({
      type: "hoymiles-g2-alarm",
      name: "Hoymiles Alarms",
      description: "The alarms a Hoymiles inverter has not cleared yet (protocol §27).",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmAlarmRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmAlarmRegister());
}
