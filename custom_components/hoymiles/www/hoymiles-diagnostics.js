/* ============================================================================
 * Hoymiles Micro Storage — Diagnostics card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-diagnostics`
 *
 * The MQTT log used to live inside <hoymiles-control>. It moved here so the
 * control page stays a page of controls: this card is the whole diagnostics
 * page, and the log is one switch in it.
 *
 * While the switch is on the card subscribes to the device's topic tree over
 * the Home Assistant websocket (the `mqtt/subscribe` command) and streams both
 * directions in one list:
 *
 *   homeassistant/<component>/<dev_id>/...   firmware + integration topics
 *   hoymiles/<dev_id>/...                    integration bookkeeping
 *
 * Direction is read off the topic: Home Assistant writes to the command side
 * (`/set`, `/command`, `/trigger`, `/get`), the device publishes everything
 * else. That is a heuristic, but a topic cannot be told apart from its payload,
 * and hard-coding every topic of the protocol would silently miss new ones.
 *
 * Nothing is subscribed - and nothing is shown - while the switch is off, so
 * the page costs nothing until it is needed. `mqtt/subscribe` is admin-only in
 * Home Assistant, so a non-admin user sees an explanation instead of a stream.
 *
 * Card config:
 *   type: custom:hoymiles-diagnostics
 *   dev_id: MSA-280520260806
 *   title: Diagnostics         # optional, default "Diagnostics"
 *   subtitle: true             # optional, default true; show the device id
 * ========================================================================== */

function _hmDiagnosticsRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Language
   *
   * Three languages: English, Simplified Chinese and German.
   *
   * Resolution order, first hit wins:
   *   1. `language:` on the card - an explicit choice, and what an older
   *      dashboard may already carry;
   *   2. the Home Assistant user's language, so the cards follow the UI like
   *      every built-in one does;
   *   3. English.
   *
   * `zh-Hans` / `zh-Hant` / `zh-CN` all collapse to `zh`: the wording is the
   * same in either script, and the card has no Traditional translation to
   * offer.  `de-AT` / `de-CH` collapse to `de` for the same reason.
   * ------------------------------------------------------------------ */
  /* German wording, keyed by the English string.

     Keyed by English on purpose: the call sites pass English and Chinese
     only, so they needed no third argument when German was added, and a
     missing entry falls back to English instead of leaving a blank. */
  const T_DE = {
    "MQTT log": "MQTT-Protokoll",
    "Live traffic: what the device reports and what HA sends": "Live-Verkehr: was das Gerät meldet und was HA sendet",
    "Off. Turn on to watch what the device reports and what Home Assistant sends": "Aus. Einschalten, um zu sehen, was das Gerät meldet und was Home Assistant sendet",
    "Traffic": "Verkehr",
    "Clear": "Leeren",
    "Waiting for MQTT traffic…": "Warte auf MQTT-Verkehr…",
    "(empty)": "(leer)",
    "HA → device": "HA → Gerät",
    "device → HA": "Gerät → HA",
    "(Home Assistant restricts mqtt/subscribe).": "(Home Assistant beschränkt mqtt/subscribe).",
    "This Home Assistant has no mqtt/subscribe command - is the MQTT integration set up?": "Dieses Home Assistant kennt den Befehl mqtt/subscribe nicht – ist die MQTT-Integration eingerichtet?",
    "Subscribe failed": "Abonnieren fehlgeschlagen",
    "No Home Assistant websocket connection.": "Keine WebSocket-Verbindung zu Home Assistant.",
  };

  /** Map any Home Assistant language tag to one of the three card languages. */
  function hmNormalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  /* ------------------------------------------------------------------ *
   * The language the user picked
   *
   * The choice belongs to the viewer, not to the dashboard: it lives in one
   * localStorage key and is announced with one window event, so the dropdown
   * on any card switches every card on the page at once, and the choice
   * survives a reload.
   *
   * English is the default.  It deliberately does NOT follow the Home
   * Assistant UI language any more: a dashboard is often shared, and the point
   * of the dropdown is that the reader decides.
   * ------------------------------------------------------------------ */
  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";
  const LANG_CHOICES = [["en", "English"], ["zh", "\u4e2d\u6587"], ["de", "Deutsch"]];

  /** The stored choice, or "" when nothing has been picked (or no storage). */
  function hmStored() {
    try {
      return hmNormalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return ""; // private mode / storage disabled: fall back to the default
    }
  }

  /** Remember a choice and tell every card about it. */
  function hmSetLang(value) {
    const lang = hmNormalise(value) || "en";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      /* nothing to remember it with; the event still switches this page */
    }
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
  }

  function hmLang(hass, config) {
    return hmStored() || hmNormalise(config && config.language) || "en";
  }

  /**
   * One of the three wordings.
   *
   * German comes from the card's own dictionary, keyed by the English string -
   * that is why `_t()` call sites did not have to change when the third
   * language was added.  A missing entry falls back to English, so an
   * untranslated string shows English rather than nothing.
   */
  function hmPick(lang, en, zh) {
    if (lang === "zh") return zh;
    if (lang === "de") {
      const de = T_DE[en];
      return de == null ? en : de;
    }
    return en;
  }

  /* (hmLang defined above, with the dictionary.) */

  function hmText(value, lang) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const hit = value[lang];
      if (hit != null) return hit;
      if (value.en != null) return value.en;
      const first = Object.values(value)[0];
      return first == null ? "" : first;
    }
    return value;
  }

  const LOG_DOWNLINK = /\/(set|command|trigger|get)$/;
  const LOG_MAX = 200;          // entries kept (quick/state alone is one a second)
  const LOG_PAYLOAD_MAX = 1200; // characters shown per entry before truncating
  const LOG_QOS = 0;            // observing only: never add broker load

  class HoymilesDiagnostics extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _logOpen: { type: Boolean, state: true },
        _logCount: { type: Number, state: true },
        _logDropped: { type: Number, state: true },
        _logErr: { type: String, state: true },
      };
    }

    constructor() {
      super();
      this._config = null;
      this._hass = null;
      this._logOpen = false;
      this._logCount = 0;
      this._logDropped = 0;
      this._logErr = "";
      /* Rows are appended to the DOM by hand (see `_appendLogRow`), so they are
         kept out of Lit's reactivity on purpose: re-rendering the card for
         every message would be a lot of churn for a log. */
      this._entries = [];
      this._listEl = null;
      this._unsubs = [];
      this._gen = 0;
      this._pending = false;
    }

    /* ------------------------------ config ------------------------------ */

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-diagnostics: dev_id is required");
      }
      this._config = { ...config };
    }

    getCardSize() {
      return this._logOpen ? 10 : 3;
    }

    static getStubConfig() {
      return { dev_id: "MSA-000000000000" };
    }

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    _dev() {
      return (this._config && this._config.dev_id) || "";
    }

    _title() {
      return hmText(
        (this._config && this._config.title) || "Diagnostics",
        hmLang(this._hass, this._config),
      );
    }

    _subtitle() {
      if (this._config && this._config.subtitle === false) return "";
      return this._dev();
    }

    /* ------------------------------ hass ------------------------------ */

    set hass(hass) {
      this._hass = hass;
      /* The switch may have been turned on before the first `hass` arrived (or
         before the websocket was usable), so keep trying until a subscription
         is actually in place. Nothing else on this card depends on `hass`, so
         no re-render is needed - Home Assistant pushes constantly and the log
         keeps its own cadence. */
      if (this._logOpen && !this._unsubs.length && !this._pending) {
        this._subscribeLog();
      }
    }

    get hass() {
      return this._hass;
    }

    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
      if (this._logOpen && !this._unsubs.length && this._hass) this._subscribeLog();
    }

    disconnectedCallback() {
      if (this._onLangChange) {
        window.removeEventListener(LANG_EVENT, this._onLangChange);
      }
      super.disconnectedCallback();
      this._unsubscribeLog();
      this._listEl = null;
    }

    firstUpdated() {
      this._syncLogDom();
    }

    updated() {
      this._syncLogDom();
    }

    /* ---------------------------- rendering ---------------------------- */

    render() {
      if (!this._config) return html``;
      const open = this._logOpen === true;
      const sub = this._subtitle();
      const devId = this._dev();
      return html`
        <ha-card>
          <div class="head">
            <span class="ico">📋</span>
            <div class="ttl">${this._title()}
              ${sub ? html`<span class="sub">${sub}</span>` : ""}
            </div>
          </div>

          <div class="row">
            <div class="row-main">
              <div class="label">${this._t("MQTT log", "MQTT 日志")}</div>
              <div class="sub-line">${open
                ? this._t(
                  "Live traffic: what the device reports and what HA sends",
                  "实时数据：设备上报 + HA 下发",
                )
                : this._t(
                  "Off. Turn on to watch what the device reports and what Home Assistant sends",
                  "默认关闭。打开后显示设备上报与 HA 下发的数据",
                )}</div>
            </div>
            <ha-switch .checked=${open}
              @change=${(e) => this._toggleLog(e.target.checked)}></ha-switch>
          </div>

          ${open ? html`
            <div class="log-block">
              <div class="log-head">
                <span class="log-title">${this._t("Traffic", "通信记录")}</span>
                <span class="log-count">${this._countText()}</span>
                <button class="btn small"
                  @click=${() => this._clearLog()}>${this._t("Clear", "清空")}</button>
              </div>
              <div class="log-list" data-dev=${devId}></div>
              <div class="log-hint ${this._logErr ? "err" : ""}">${this._hintText()}</div>
            </div>` : ""}
        </ha-card>`;
    }

    _countText() {
      if (this._logErr) return "";
      const dropped = this._logDropped ? ` · ${this._logDropped} dropped` : "";
      return `${this._logCount} messages${dropped}`;
    }

    _hintText() {
      if (this._logErr) return this._logErr;
      if (this._logCount > 0 || !this._logOpen) return "";
      return this._t("Waiting for MQTT traffic…", "等待 MQTT 数据…");
    }

    /* ------------------------------- log ------------------------------- */

    /** The two wildcards that cover this device: its tree, and ours. */
    _logTopics() {
      const dev = this._dev();
      return [
        `homeassistant/+/${dev}/#`,
        `hoymiles/${dev}/#`,
      ];
    }

    _logDown(topic) {
      if (String(topic).startsWith("hoymiles/")) return true;
      return LOG_DOWNLINK.test(String(topic));
    }

    /**
     * The topic of one message, split so the device id can be dimmed: every
     * line carries it, and it is the least interesting part. The three pieces
     * are spans, not one string, but their text adds up to the topic exactly as
     * it goes over the wire, so selecting a row still copies the real thing.
     */
    _logTopic(topic, host) {
      const dev = this._dev();
      const at = String(topic).indexOf(`/${dev}/`);
      if (at < 0 || !dev) {
        host.textContent = String(topic);
        return;
      }
      const before = document.createElement("span");
      before.textContent = String(topic).slice(0, at + 1);
      const id = document.createElement("span");
      id.className = "log-dev";
      id.textContent = dev;
      const after = document.createElement("span");
      after.textContent = String(topic).slice(at + 1 + dev.length);
      host.append(before, id, after);
    }

    /**
     * The payload, on a single wrapped line when it is JSON, and capped.
     *
     * It used to be pretty printed, but that turned a `quick/state` (once a
     * second) into a sixty line block, and every long payload then needed its
     * own scrollbar inside the list's scrollbar.
     */
    _logPayload(payload) {
      const text = String(payload == null ? "" : payload);
      if (text.trim() === "") return this._t("(empty)", "（空）");
      let out = text;
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          out = JSON.stringify(JSON.parse(text));
        } catch (err) {
          out = text; // not valid JSON after all - show it raw
        }
      }
      if (out.length > LOG_PAYLOAD_MAX) {
        const rest = out.length - LOG_PAYLOAD_MAX;
        return `${out.slice(0, LOG_PAYLOAD_MAX)}… ${this._t(
          `(${rest} more characters)`, `（还有 ${rest} 个字符）`,
        )}`;
      }
      return out;
    }

    /** One entry, ready for the list. */
    _logEntry(msg) {
      const topic = String((msg && msg.topic) || "");
      const payload = (msg && msg.payload) != null ? String(msg.payload) : "";
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      return {
        topic,
        down: this._logDown(topic),
        text: this._logPayload(payload),
        clock: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      };
    }

    /**
     * One rendered row. Built with DOM calls and `textContent` rather than
     * markup: a payload is arbitrary text from the broker, and this way there
     * is nothing to escape.
     */
    _logRow(entry) {
      const row = document.createElement("div");
      row.className = `log-row ${entry.down ? "down" : "up"}`;

      const meta = document.createElement("div");
      meta.className = "log-meta";
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = entry.clock;
      const dir = document.createElement("span");
      dir.className = "log-dir";
      dir.textContent = entry.down
        ? this._t("HA → device", "HA 下发")
        : this._t("device → HA", "设备上报");
      const topic = document.createElement("span");
      topic.className = "log-topic";
      this._logTopic(entry.topic, topic);
      topic.title = entry.topic;
      meta.append(time, dir, topic);

      const body = document.createElement("pre");
      body.className = "log-payload";
      body.textContent = entry.text;

      row.append(meta, body);
      return row;
    }

    _onLogMessage(msg) {
      if (!this._logOpen || !msg) return;
      const entry = this._logEntry(msg);
      this._entries.push(entry);
      while (this._entries.length > LOG_MAX) {
        this._entries.shift();
        this._logDropped += 1;
      }
      this._logCount = this._entries.length;
      this._appendLogRow(entry);
      this.requestUpdate();
    }

    /**
     * Append one row, keeping the list bounded and scrolled to the newest
     * message - unless the user has scrolled up to read, in which case the view
     * is left where it is.
     */
    _appendLogRow(entry) {
      const list = this._listEl;
      if (!list) return; // the panel is not in the DOM yet; the buffer has it
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      list.appendChild(this._logRow(entry));
      while (list.children.length > LOG_MAX) list.removeChild(list.firstChild);
      if (atBottom) list.scrollTop = list.scrollHeight;
    }

    /**
     * Pick up the freshly rendered panel (or restore it after a re-render) and
     * refill it from the buffer.
     *
     * The list is filled by hand and deliberately not by Lit: the device pushes
     * once a second, and re-rendering the rows for every message would be a lot
     * of churn for a log. Lit leaves the children of an element it did not
     * create alone, so the rows survive a re-render.
     */
    _syncLogDom() {
      const root = this.renderRoot;
      const list = root && root.querySelector ? root.querySelector(".log-list") : null;
      if (!list) {
        this._listEl = null;
        return;
      }
      if (list !== this._listEl) {
        this._listEl = list;
        list.textContent = "";
        for (const entry of this._entries) list.appendChild(this._logRow(entry));
        list.scrollTop = list.scrollHeight;
      }
    }

    /** Turn a subscribe failure into something a user can act on. */
    _logSubscribeError(err) {
      const raw = String((err && err.message) || err || "");
      if (/unauthor|admin|forbidden|401|403/i.test(raw)) {
        return this._t(
          "Subscribing to MQTT needs an administrator account "
          + "(Home Assistant restricts mqtt/subscribe).",
          "订阅 MQTT 需要管理员账号（Home Assistant 限制 mqtt/subscribe 命令）。",
        );
      }
      if (/unknown command|unknown_command|not found|not_found/i.test(raw)) {
        return this._t(
          "This Home Assistant has no mqtt/subscribe command - is the MQTT integration set up?",
          "当前 Home Assistant 没有 mqtt/subscribe 命令——MQTT 集成是否已配置？",
        );
      }
      return `${this._t("Subscribe failed", "订阅失败")}: ${raw}`;
    }

    /**
     * Subscribe to the device's topics.
     *
     * `_gen` guards the await: a subscription that lands after the switch was
     * turned off again must be dropped instead of being stashed as a live one,
     * or the list would keep growing with messages nobody asked for.
     */
    async _subscribeLog() {
      this._logErr = "";
      const connection = this._hass && this._hass.connection;
      if (!connection || typeof connection.subscribeMessage !== "function") {
        this._logErr = this._t(
          "No Home Assistant websocket connection.",
          "没有 Home Assistant 的 WebSocket 连接。",
        );
        return;
      }

      this._pending = true;
      const gen = (this._gen += 1);
      for (const topic of this._logTopics()) {
        try {
          const unsub = await connection.subscribeMessage(
            (msg) => this._onLogMessage(msg),
            { type: "mqtt/subscribe", topic, qos: LOG_QOS },
          );
          if (gen !== this._gen) {
            if (typeof unsub === "function") unsub();
            continue;
          }
          if (typeof unsub === "function") this._unsubs.push(unsub);
        } catch (err) {
          if (gen !== this._gen) break;
          this._logErr = this._logSubscribeError(err);
        }
      }
      if (gen === this._gen) this._pending = false;
      this.requestUpdate();
    }

    _unsubscribeLog() {
      const subs = this._unsubs;
      this._unsubs = [];
      this._pending = false;
      this._gen += 1; // any in-flight subscribe is now stale
      for (const unsub of subs) {
        try {
          const result = unsub();
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch (err) {
          /* already gone - nothing to do */
        }
      }
    }

    _toggleLog(on) {
      if (on) {
        this._logOpen = true;
        this._resetLog();
        this._subscribeLog();
      } else {
        this._logOpen = false;
        this._unsubscribeLog();
        this._resetLog();
        this._logErr = "";
      }
    }

    /** Start clean: on the next subscribe the retained configs and last states
        arrive again, so keeping them would only show the same messages twice. */
    _resetLog() {
      this._entries = [];
      this._logCount = 0;
      this._logDropped = 0;
      this._listEl = null;
      if (this.renderRoot && this.renderRoot.querySelector) {
        const list = this.renderRoot.querySelector(".log-list");
        if (list) list.textContent = "";
      }
    }

    _clearLog() {
      this._entries = [];
      this._logCount = 0;
      this._logDropped = 0;
      if (this._listEl) this._listEl.textContent = "";
    }

    static get styles() {
      return css`
        :host { display: block; }

        ha-card { padding: 15px 17px 17px; border-radius: 16px; }

        .head { display: flex; align-items: center; gap: 9px; margin: 0 0 15px; }
        .head .ico { flex: 0 0 auto; display: inline-flex;
                     color: var(--secondary-text-color); }
        .head .ttl { font-size: 12.5px; font-weight: 600; line-height: 1.25;
                     letter-spacing: .05em; text-transform: uppercase;
                     color: var(--primary-text-color); }
        .head .ttl .sub { display: block; margin-top: 3px; font-size: 12px;
                          font-weight: 400; letter-spacing: 0; text-transform: none;
                          color: var(--secondary-text-color); }

        .row { display: flex; align-items: center; gap: 12px; }
        .row-main { flex: 1 1 auto; min-width: 0; }
        .row .label { font-size: 14px; line-height: 1.3;
                      color: var(--primary-text-color); }
        .row .sub-line { margin-top: 4px; font-size: 12px; line-height: 1.45;
                         color: var(--secondary-text-color); }

        .btn { font: inherit; font-size: 13px; padding: 7px 13px;
               border-radius: 9px; cursor: pointer;
               border: 1px solid var(--divider-color);
               background: var(--card-background-color, #fff);
               color: var(--primary-text-color); }
        .btn:hover { border-color: var(--primary-color); }
        .btn.small { padding: 5px 10px; font-size: 12.5px; }

        .log-block { margin-top: 14px; padding-top: 14px;
                     border-top: 1px solid var(--divider-color); }
        .log-head { display: flex; align-items: center; gap: 8px; padding: 0 0 8px; }
        .log-head .log-title { font-size: 12.5px; font-weight: 500;
                               color: var(--primary-text-color); }
        .log-head .log-count { font-size: 12px; margin-right: auto;
                               color: var(--secondary-text-color);
                               font-variant-numeric: tabular-nums; }
        .log-list { display: flex; flex-direction: column; gap: 6px;
                    max-height: 420px; overflow: auto; padding: 0 0 8px; }
        .log-row { font-size: 12px; border-radius: 10px; padding: 6px 8px;
                   background: var(--secondary-background-color, rgba(120,120,128,.10)); }
        .log-row .log-meta { display: flex; align-items: center; gap: 6px;
                             flex-wrap: wrap; }
        .log-row .log-time { color: var(--secondary-text-color);
                             font-variant-numeric: tabular-nums; }
        .log-row .log-dir { font-size: 11px; line-height: 1.5;
                            padding: 0 6px; border-radius: 999px;
                            background: rgba(120,120,128,.20);
                            color: var(--secondary-text-color); }
        .log-row.down .log-dir { background: rgba(3,169,244,.16);
                                 color: var(--primary-color); }
        .log-row .log-topic { font-family: ui-monospace, SFMono-Regular, Menlo,
                              Consolas, monospace; word-break: break-all;
                              color: var(--primary-text-color); }
        /* The device id repeats on every line; dimming it keeps the paths easy
           to scan. It is still part of the text, so a selection copies the
           real topic. */
        .log-row .log-topic .log-dev { color: var(--secondary-text-color); }
        .log-row pre.log-payload { margin: 4px 0 0; white-space: pre-wrap;
                                   word-break: break-all; line-height: 1.45;
                                   font-size: 11.5px;
                                   font-family: ui-monospace, SFMono-Regular, Menlo,
                                   Consolas, monospace;
                                   color: var(--secondary-text-color); }
        .log-hint { padding: 0 0 4px; font-size: 12px;
                    color: var(--secondary-text-color); }
        .log-hint.err { color: var(--error-color); }
      `;
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesDiagnosticsEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object } };
    }

    setConfig(config) {
      this._config = { ...config };
    }

    _field(key) {
      return (e) => {
        this._config = { ...this._config, [key]: e.target.value };
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: this._config },
          bubbles: true,
          composed: true,
        }));
      };
    }

    render() {
      if (!this._config) return html``;
      return html`
        <div class="form">
          <label>dev_id</label>
          <input .value=${this._config.dev_id || ""}
            @change=${this._field("dev_id")} />
          <label>title</label>
          <input .value=${typeof this._config.title === "string" ? this._config.title : ""}
            placeholder="Diagnostics"
            @change=${this._field("title")} />
        </div>`;
    }

    static get styles() {
      return css`
        .form { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
        label { font-size: 12px; color: var(--secondary-text-color); }
        input { font: inherit; font-size: 13px; padding: 8px 10px;
                border-radius: 9px;
                border: 1px solid var(--divider-color);
                background: var(--card-background-color, #fff);
                color: var(--primary-text-color); }
      `;
    }
  }

  if (!customElements.get("hoymiles-diagnostics-editor")) {
    customElements.define("hoymiles-diagnostics-editor", HoymilesDiagnosticsEditor);
  }
  if (!customElements.get("hoymiles-diagnostics")) {
    customElements.define("hoymiles-diagnostics", HoymilesDiagnostics);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "hoymiles-diagnostics")) {
    window.customCards.push({
      type: "hoymiles-diagnostics",
      name: "Hoymiles Diagnostics",
      description: "MQTT traffic log of a Hoymiles micro storage device.",
      preview: false,
    });
  }
}

/* `ha-panel-lovelace` only exists on Lovelace routes, and `panel_custom` pages
 * may load this module too - wait for it instead of dereferencing undefined. */
function _hmDiagnosticsBoot() {
  if (customElements.get("ha-panel-lovelace")) return _hmDiagnosticsRegister();
  customElements.whenDefined("ha-panel-lovelace")
    .then(() => _hmDiagnosticsRegister())
    .catch(() => {});
}

_hmDiagnosticsBoot();
