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
 *   language: en                # optional (en|zh); omit to follow Home Assistant
 *   title: Device control
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

  /* ------------------------------------------------------------------ *
   * Language
   *
   * An explicit `language:` in the card config wins. When it is absent the
   * card follows the Home Assistant user's language (`hass.language`), so a
   * dashboard matches the UI without per-card configuration. Any Chinese
   * variant counts as Chinese - Home Assistant reports `zh-Hans` / `zh-Hant`
   * and may carry a region suffix such as `zh-Hans-CN`.
   * ------------------------------------------------------------------ */
  function hmLang(hass, config) {
    const wanted = config && config.language;
    if (wanted) return String(wanted).toLowerCase().startsWith("zh") ? "zh" : "en";
    const ui = hass && hass.language;
    return ui && String(ui).toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  /* ------------------------------------------------------------------ *
   * Localised config strings
   *
   * A config value may be a plain string (used as-is, so every existing
   * dashboard keeps working) or a language map:
   *
   *   title:
   *     en: Device control
   *     zh: 设备控制
   *
   * That is what lets the text *you* write follow the UI language too, instead
   * of pinning a dashboard to one language. A map missing the current language
   * falls back to `en`, then to whichever entry exists.
   * ------------------------------------------------------------------ */
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

  /** A text field can only hold a plain string, so a language map shows empty. */
  function hmField(value) {
    return typeof value === "string" ? value : "";
  }

  const EMS_MODES = [
    { id: "general", en: "General", zh: "自发自用" },
    { id: "mqtt_ctrl", en: "MQTT ctrl", zh: "MQTT 功率控制" },
    { id: "tou_plan", en: "TOU plan", zh: "分时计划" },
  ];
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /* Order in which the firmware publishes its `number` discovery configs. HA
   * decorates the duplicate entity ids with `_2`, `_3`, ... so this order is
   * what maps `number.<dev>_2` back to `output_power`. */
  const NUMBER_ORDER = ["power_ctrl", "output_power", "phase_output_power"];

  /* Domains where the firmware publishes exactly one entity, so "the only one on
   * this device" is a sound answer. The number domain is excluded on purpose:
   * it has several entities and a wrong pick would show - and send - the value
   * of a different setting. */
  const SINGLE_ENTITY_DOMAINS = ["select", "switch"];

  const PING_MS = 8000; // how long the "sent" confirmation stays visible

  /* Power on/off is slow: the firmware has to bring the PCS (and the packs)
     down or up again, so the card shows the requested state as pending until
     the device reports it (or gives up after this long). */
  const SWITCH_PENDING_MS = 5000;
  const SWITCH_CONFIRM_MS = 2500; // how long the tick after confirmation stays

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
      /* Power switch: the requested target while it is in flight, and the time
         the device confirmed it (drives the tick + spinner). */
      this._switchPending = null;
      this._switchConfirmedAt = 0;
      this._pendingTimer = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-control-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
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

        /* In-flight power on/off: the pressed option spins a ring until the
           device reports the new state. The spinner lives in the button's own
           ::after, so no extra markup is needed over the segment. */
        .seg button.pending { padding-right: 24px; position: relative; }
        .seg button.pending::after {
          content: ""; position: absolute; top: 50%; right: 7px;
          width: 9px; height: 9px; margin-top: -5.5px; border-radius: 50%;
          border: 2px solid currentColor; border-top-color: transparent;
          opacity: .75; animation: hm-spin .7s linear infinite;
        }
        @keyframes hm-spin { to { transform: rotate(360deg); } }

        /* The sub-line carries the progress, so a slow power cycle still has
           visible feedback right where the user is looking. */
        .item .nm small.busy { color: var(--primary-color);
                               animation: hm-pulse 1.3s ease-in-out infinite; }
        .item .nm small.done { color: var(--success-color, #0da035);
                               font-weight: 500; }
        @keyframes hm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

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

        /* editable read-out next to a slider */
        input[type="number"] {
          font: inherit; font-size: 15px; width: 78px; text-align: right;
          padding: 7px 10px; border-radius: 10px;
          border: 1px solid transparent;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none;
          font-variant-numeric: tabular-nums;
        }
        input[type="number"]:focus { border-color: var(--primary-color); }
        input[type="number"].narrow { width: 58px; }

        /* iOS slider: hairline track with a tinted fill and a white round knob.
           The --pct custom property is set inline from the value, so the fill
           follows the knob without needing a second element.
           NOTE: never write a backtick inside this css template (not even in a
           comment) - it would terminate the template string. */
        .slider { display: flex; align-items: center; gap: 10px; width: 100%; }
        .slider.end { justify-content: flex-end; }
        .slider .tag { flex: 0 0 auto; width: 12px; font-size: 13px;
                       color: var(--secondary-text-color); }
        input[type="range"] {
          -webkit-appearance: none;
          appearance: none;
          flex: 1 1 auto; min-width: 90px; height: 4px; margin: 0;
          border-radius: 2px; outline: none; cursor: pointer;
          background: linear-gradient(90deg,
            var(--primary-color) 0 var(--pct, 0%),
            var(--divider-color) var(--pct, 0%) 100%);
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 22px; height: 22px; border-radius: 50%;
          background: #fff; border: none; cursor: grab;
          box-shadow: 0 1px 4px rgba(0,0,0,.25), 0 0 0 .5px rgba(0,0,0,.08);
        }
        input[type="range"]::-webkit-slider-thumb:active { cursor: grabbing; }
        input[type="range"]::-moz-range-thumb {
          width: 22px; height: 22px; border-radius: 50%;
          background: #fff; border: none;
          box-shadow: 0 1px 4px rgba(0,0,0,.25);
        }
        input[type="range"]:disabled { opacity: .45; cursor: not-allowed; }
        input[type="range"]:disabled::-webkit-slider-thumb { cursor: not-allowed; }
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
      this._reconcileSwitch();
      this.requestUpdate();
    }

    getCardSize() {
      return 13;
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      if (this._toastTimer) clearTimeout(this._toastTimer);
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
    }

    /* ----------------------------- lookups ----------------------------- */

    _t(en, zh) {
      return hmLang(this._hass, this._config) === "zh" ? zh : en;
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
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

      // The firmware's own number entities are unhelpfully named: the MQTT
      // discovery topics carry the object id (power_ctrl / output_power /
      // phase_output_power) but HA names all three after the device, so their
      // entity ids collapse to `number.<dev>`, `number.<dev>_2`, `_3 ...` and
      // neither the friendly name nor the registry snapshot distinguishes them
      // (HA does not expose unique_id to the frontend). They are published in a
      // fixed order, so fall back to the index. `entities` in the card config
      // overrides this when a deployment ever differs.
      if (!found && domain === "number") {
        const index = NUMBER_ORDER.indexOf(key);
        if (index >= 0) {
          const base = `${domain}.${slug(this._dev())}`;
          // `number.<dev>`, `number.<dev>_2`, `number.<dev>_3`, ...
          // The device SN is numeric too, so the duplicate suffix must be short
          // (`_2`), never the SN itself (`number.<dev>_280520260806`).
          const numbered = Object.keys(hass.states).filter((entityId) => {
            if (entityId === base) return true;
            return new RegExp(`^${base.replace(/\./g, "\\.")}_\\d{1,2}$`).test(entityId);
          });
          const order = (entityId) => {
            if (entityId === base) return 0;
            const m = entityId.match(/_(\d+)$/);
            return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
          };
          numbered.sort((a, b) => order(a) - order(b));
          if (numbered[index]) found = numbered[index];
        }
      }

      // Last resort for the single-instance domains: the discovery name does not
      // always map back to the protocol key (`ems_mode` is published as
      // `select.<dev>_mqtt_select`, and the switch as `<dev>_mqtt_switch`). Those
      // domains carry exactly one entity per device, so there is nothing to guess.
      // `number` is deliberately excluded - it has several entities and a wrong
      // pick would display (and send) a different setting's value.
      if (!found && SINGLE_ENTITY_DOMAINS.includes(domain)) {
        const prefix = `${domain}.${slug(this._dev())}`;
        const candidates = Object.keys(hass.states)
          .filter((entityId) => entityId.startsWith(prefix));
        if (candidates.length === 1) found = candidates[0];
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

    /** Pre-fill the inputs from the device the first time we see it.
     *
     * Values are clamped to the entity's own range: an unconfigured entity often
     * reports `0`, which is outside e.g. output_power's `100 ~ 2000 W`. Without
     * the clamp the slider would sit at its minimum while the read-out showed the
     * out-of-range number, and the two would disagree.
     */
    _seedInputs() {
      if (!this._hass || !this._hass.states) return;
      const pc = this._number("power_ctrl");
      const op = this._number("output_power");
      if (pc != null) {
        const b = this._bounds("power_ctrl", -1000, 1000);
        this._powerCtrl = String(this._clamp(pc, b.lo, b.hi));
      }
      if (op != null) {
        const b = this._bounds("output_power", 100, 2000);
        this._outputPower = String(this._clamp(op, b.lo, b.hi));
      }
      const phases = ["a", "b", "c"];
      let any = false;
      for (const p of phases) {
        const value = this._number(`phase_${p}_output_power`)
          ?? this._number("phase_output_power");
        if (value != null) {
          const b = this._bounds("phase_a_output_power", 100, 2500);
          this._phase[p] = String(this._clamp(value, b.lo, b.hi));
          any = true;
        }
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

    /** Clock seam, so the harness can drive the pending timeouts. */
    _now() {
      return Date.now();
    }

    _setSwitch(on) {
      const target = on ? "on" : "off";
      if (this._switchTarget() === target) return; // already on the way there
      this._optimistic.switch = target;
      this._switchPending = { target, at: this._now() };
      this._switchConfirmedAt = 0;
      // Wake up once the wait is over, so the UI falls back to the real state
      // even when the device never answers (no hass push would do it for us).
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        this.requestUpdate();
      }, SWITCH_PENDING_MS + 100);
      this.requestUpdate();
      this._publish(this._topic("switch/<dev_id>/set"), on ? "ON" : "OFF",
        this._t(on ? "Power on" : "Power off", on ? "开机" : "关机"));
    }

    /** The requested target while the command is still in flight. */
    _switchTarget() {
      const pending = this._switchPending;
      if (!pending) return null;
      if (this._now() - pending.at >= SWITCH_PENDING_MS) return null;
      return pending.target;
    }

    /** The device's own state, or null when it does not report one. */
    _switchReal() {
      const state = this._state("mqtt_switch", "switch") || this._state("config", "switch");
      const value = state ? String(state.state) : null;
      if (value === "on" || value === "off") return value === "on";
      return null;
    }

    /**
     * True when the entity cannot confirm its own state.
     *
     * The firmware's discovery switch is patched into an optimistic entity
     * (`assumed_state`, no `state_topic`), because its original state topic is a
     * nested JSON blob that never equals ON/OFF. HA then only remembers the last
     * command *it* sent - it never learns what the device actually did. Waiting
     * for a confirmation would always time out, and falling back to HA's value
     * after the timeout would snap the button back to the previous state, which
     * reads as "the command failed".
     */
    _switchOptimistic() {
      const state = this._state("mqtt_switch", "switch") || this._state("config", "switch");
      return Boolean(state && state.attributes && state.attributes.assumed_state);
    }

    /**
     * Drop the pending marker once the device agrees (or the wait expires).
     *
     * Called from the `hass` setter, i.e. on every push, which is what makes the
     * spinner turn into a tick as soon as the firmware confirms the new state.
     */
    _reconcileSwitch() {
      const pending = this._switchPending;
      if (!pending) return;
      if (this._now() - pending.at >= SWITCH_PENDING_MS) {
        this._switchPending = null;
        return;
      }
      // An optimistic entity cannot confirm anything, so only the timeout ends
      // the pending state (the requested value then simply stays in force).
      if (this._switchOptimistic()) return;
      const real = this._switchReal();
      if (real !== null && real === (pending.target === "on")) {
        this._switchPending = null;
        this._switchConfirmedAt = this._now();
        if (this._pendingTimer) {
          clearTimeout(this._pendingTimer);
          this._pendingTimer = null;
        }
        // Fade the tick away on its own.
        this._pendingTimer = setTimeout(() => {
          this._pendingTimer = null;
          this.requestUpdate();
        }, SWITCH_CONFIRM_MS + 100);
      }
    }

    /** { on, pending, justConfirmed } for the switch row. */
    _switchView() {
      const target = this._switchTarget();
      if (target) return { on: target === "on", pending: target, confirmed: false };
      const real = this._switchReal();
      /* A command issued from this card is authoritative for an optimistic
         entity: HA only remembers the commands it sent itself, so waiting for
         (or falling back to) that value would snap the button back. Before any
         such command the entity's value is still the best thing we have, and for
         a real entity the device always wins. */
      const mine = this._optimistic.switch;
      const commanded = mine === "on" || mine === "off";
      const on = this._switchOptimistic() && commanded
        ? mine === "on"
        : real !== null
          ? real
          : mine === "on";
      const justConfirmed = this._switchConfirmedAt > 0
        && this._now() - this._switchConfirmedAt < SWITCH_CONFIRM_MS;
      if (!justConfirmed) this._switchConfirmedAt = 0;
      return { on, pending: null, confirmed: justConfirmed };
    }

    _isSwitchOn() {
      return this._switchView().on;
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
            <div class="title">${this._text(this._config.title) || this._t("Control", "控制")}</div>
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
    _item({ icon, name, sub, subClass, topic, ctrl, stack }) {
      const showTopics = this._config.show_topics === true;
      return html`
        <div class="item ${stack ? "stack" : ""}">
          ${icon ? html`<span class="ico">${icon}</span>` : ""}
          <div class="nm">${name}
            ${sub ? html`<small class=${subClass || ""}>${sub}</small>` : ""}
            ${showTopics && topic ? html`<small><code>${topic}</code></small>` : ""}
          </div>
          <div class="ctrl">${ctrl}</div>
        </div>`;
    }

    /** iOS segmented control. `options` = [{id, label, enabled, title, pending}] */
    _segment(options, current, onPick, extraClass = "") {
      return html`
        <div class="seg ${extraClass}">
          ${options.map((opt) => html`
            <button class=${[
              opt.id === current ? "on" : "",
              opt.pending ? "pending" : "",
            ].filter(Boolean).join(" ")}
              ?disabled=${opt.enabled === false}
              title=${opt.title || ""}
              @click=${() => onPick(opt.id)}>${opt.label}</button>`)}
        </div>`;
    }

    /**
     * iOS slider row: track on the left, editable read-out on the right.
     *
     * The track keeps `--pct` in sync with the value so the tinted fill follows
     * the knob without a second element. Dragging only updates the draft value;
     * nothing is published until the send button is pressed (the power values
     * have to be re-sent every minute, so publishing on every input event would
     * flood the broker).
     */
    _slider({ value, min, max, step, unit, tag, disabled, onInput, onSend, sendLabel }) {
      const lo = num(min);
      const hi = num(max);
      const current = Number(value);
      const safe = Number.isFinite(current) ? current : lo;
      const span = hi - lo;
      // Clamp only the tinted fill; the read-out keeps whatever was typed.
      const pct = span > 0 ? Math.min(Math.max((safe - lo) / span, 0), 1) * 100 : 0;
      const decimals = step != null && Number(step) < 1 ? 1 : 0;

      return html`
        <div class="slider">
          ${tag ? html`<span class="tag">${tag}</span>` : ""}
          <input type="range" min=${lo} max=${hi} step=${step}
            .value=${String(safe)} ?disabled=${disabled}
            style="--pct:${pct.toFixed(1)}%"
            @input=${(e) => onInput(e.target.value)} />
          <input type="number" min=${lo} max=${hi} step=${step}
            .value=${String(Number.isFinite(current) ? current : "")}
            ?disabled=${disabled}
            @input=${(e) => onInput(e.target.value)} />
          <span class="unit">${unit}</span>
          ${onSend ? html`
            <button class="btn primary" ?disabled=${disabled}
              @click=${onSend}>${sendLabel}</button>` : ""}
        </div>`;
    }

    /** Slider bounds for a numeric entity, with the protocol defaults. */
    _bounds(key, fallbackLo, fallbackHi) {
      const rawLo = this._attr(key, "number", "min");
      const rawHi = this._attr(key, "number", "max");
      const lo = rawLo != null ? num(rawLo) : fallbackLo;
      const hi = rawHi != null ? num(rawHi) : fallbackHi;
      // A degenerate range would divide by zero in the fill calculation.
      return hi > lo ? { lo, hi } : { lo: fallbackLo, hi: fallbackHi };
    }

    /** Keep a value inside a range (invalid input falls back to the low bound). */
    _clamp(value, lo, hi) {
      const v = num(value);
      if (!Number.isFinite(v)) return lo;
      return Math.min(Math.max(v, lo), hi);
    }

    _switchItem() {
      const view = this._switchView();
      /* The sub-line is where the feedback lands: the button already flips the
         instant it is pressed, and this explains the wait / confirms it. */
      const sub = view.pending
        ? this._t(
          `Powering ${view.pending === "on" ? "up" : "down"}…`,
          `${view.pending === "on" ? "正在开机" : "正在关机"}…`,
        )
        : view.confirmed
          ? this._t(
            view.on ? "Powered on ✓" : "Powered off ✓",
            view.on ? "已开机 ✓" : "已关机 ✓",
          )
          : view.on
            ? this._t("running", "运行中")
            : this._t("standby", "已休眠");
      const subClass = view.pending ? "busy" : view.confirmed ? "done" : "";
      return this._item({
        icon: "⚡",
        name: this._t("Power", "设备开关"),
        sub,
        subClass,
        topic: this._topic("switch/<dev_id>/set"),
        ctrl: this._segment(
          [
            { id: "on", label: this._t("On", "开机"),
              pending: view.pending === "on" },
            { id: "off", label: this._t("Off", "关机"),
              pending: view.pending === "off" },
          ],
          view.on ? "on" : "off",
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
      const { lo, hi } = this._bounds("power_ctrl", -1000, 1000);
      return this._item({
        icon: "🎛",
        name: this._t("Power control", "功率控制"),
        sub: ready
          ? this._t(
            `${lo} ~ ${hi} W, re-send at least once a minute`,
            `${lo} ~ ${hi} W，需至少每分钟下发一次`,
          )
          : this._t("switch EMS to mqtt_ctrl first", "需先切到 mqtt_ctrl"),
        topic: this._topic("number/<dev_id>/power_ctrl/set"),
        stack: true,
        ctrl: this._slider({
          value: this._powerCtrl,
          min: lo,
          max: hi,
          step: 0.1,
          unit: "W",
          disabled: !ready,
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._powerCtrl = v; },
          onSend: () => this._sendPowerCtrl(),
        }),
      });
    }

    _outputItem() {
      const { lo, hi } = this._bounds("output_power", 100, 2000);
      return this._item({
        icon: "📤",
        name: this._t("Output power", "输出功率"),
        sub: this._t(`Range ${lo} ~ ${hi} W.`, `范围 ${lo} ~ ${hi} W。`),
        topic: this._topic("number/<dev_id>/output_power/set"),
        stack: true,
        ctrl: this._slider({
          value: this._outputPower,
          min: lo,
          max: hi,
          step: 1,
          unit: "W",
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._outputPower = v; },
          onSend: () => this._sendOutputPower(),
        }),
      });
    }

    _phaseItem() {
      const { lo, hi } = this._bounds("phase_a_output_power", 100, 2500);
      const row = (key, label) => this._slider({
        tag: label,
        value: this._phase[key],
        min: lo,
        max: hi,
        step: 1,
        unit: "W",
        onInput: (v) => { this._phase = { ...this._phase, [key]: v }; },
      });
      return this._item({
        icon: "🔌",
        name: this._t("Phase output", "多相输出功率"),
        sub: this._t(
          `Range ${lo} ~ ${hi} W, sent as {phase_a, phase_b, phase_c}.`,
          `范围 ${lo} ~ ${hi} W，按 {phase_a, phase_b, phase_c} 下发。`,
        ),
        topic: this._topic("number/<dev_id>/phase_output_power/set"),
        stack: true,
        ctrl: html`
          ${row("a", "A")}${row("b", "B")}${row("c", "C")}
          <div class="slider end">
            <button class="btn primary"
              @click=${() => this._sendPhase()}>${this._t("Send", "下发")}</button>
          </div>`,
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
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="language (auto|en|zh, auto follows Home Assistant)"
            .value=${config.language || ""} @change=${this._changed("language")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_topics === true}
              @change=${this._toggle("show_topics")}></ha-switch>
            <span>show_topics (show the MQTT topic of every row, for debugging)</span>
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
