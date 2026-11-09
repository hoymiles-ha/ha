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
 *
 * The MQTT log used to live here; it is now its own card,
 * `custom:hoymiles-diagnostics`, which can be added to any dashboard by hand.
 * The generated dashboard no longer gives it a page of its own: a whole tab
 * holding one usually-off card read as an empty page in the sidebar.
 * ========================================================================== */

function _hmControlRegister() {
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
    "No Home Assistant connection.": "Keine Verbindung zu Home Assistant.",
    "The command failed.": "Der Befehl ist fehlgeschlagen.",
    "Yes": "Ja",
    "Cancel": "Abbrechen",
    "Publish the command to the broker": "Befehl an den Broker senden",
    "Wait for the device to confirm the new state": "Warten, bis das Gerät den neuen Zustand bestätigt",
    "The device does not report this state back": "Das Gerät meldet diesen Zustand nicht zurück",
    "Command sent.": "Befehl gesendet.",
    "It may still be switching - check the card again in a few seconds.": "Es schaltet eventuell noch um – schau in ein paar Sekunden noch einmal nach.",
    "The device confirmed the new state.": "Das Gerät hat den neuen Zustand bestätigt.",
    "EMS mode": "EMS-Modus",
    "Wait for the device to switch": "Warten, bis das Gerät umschaltet",
    "Invalid value": "Ungültiger Wert",
    "Target power": "Zielleistung",
    "Turn the timer off?": "Timer ausschalten?",
    "the charge and discharge power on its own within about 60 seconds.": "die Lade- und Entladeleistung innerhalb von etwa 60 Sekunden selbst.",
    "Turn it off": "Ausschalten",
    "Keep it on": "Eingeschaltet lassen",
    "Max output": "Max. Ausgabe",
    "Per-phase limit": "Grenze je Phase",
    "Reboot the device now?": "Gerät jetzt neu starten?",
    "Reboot": "Neustart",
    "Publish the reboot trigger": "Neustart auslösen",
    "Wait for the device to go offline": "Warten, bis das Gerät offline geht",
    "The device went offline": "Das Gerät ist offline gegangen",
    "No offline signal seen - the restart may still be running": "Kein Offline-Signal gesehen – der Neustart läuft eventuell noch",
    "The device is restarting. It is back in about a minute.": "Das Gerät startet neu. Es ist in etwa einer Minute wieder da.",
    "Power": "Leistung",
    "plan to follow a schedule.": "Plan nach Zeitprogramm.",
    "below change with the selected mode.": "unten ändern sich mit dem gewählten Modus.",
    "Please wait…": "Bitte warten…",
    "Close": "Schließen",
    "Awake - normal operation": "Wach – Normalbetrieb",
    "Asleep - press Awake to resume": "Schlafmodus – zum Fortsetzen „Wach“ drücken",
    "Sleep": "Schlafen",
    "Awake": "Wach",
    "Asleep": "Schlafmodus",
    "Not available while an on-grid micro inverter is present.": "Nicht verfügbar, solange ein netzgeführter Mikro-Wechselrichter vorhanden ist.",
    "+ discharge, − charge": "+ Entladen, − Laden",
    "switch EMS to mqtt_ctrl first": "zuerst EMS auf mqtt_ctrl stellen",
    "Send": "Senden",
    "Every": "Alle",
    "s": "s",
    "Send all": "Alle senden",
    "Takes about a minute": "Dauert etwa eine Minute",
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
   * That is what lets the text *you* write follow the language the reader
   * picked, instead of pinning a dashboard to one language. A map missing the current language
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

  /* Bounds of the repeat-interval input, in seconds. The firmware's power
     control has to be refreshed at least once a minute, so anything slower is
     allowed but 1 s is the floor - faster would flood both the broker and the
     device's command queue. */
  const REPEAT_MIN_S = 1;
  const REPEAT_MAX_S = 3600;
  const REPEAT_DEFAULT_S = 30;

  /* How often an open card re-reads the server state while nothing is running.
     The repeat lives in the integration, so another browser (or an automation)
     may have started one; a slow poll keeps the row from lying about it. */
  const REPEAT_IDLE_POLL_S = 30;

  /* Power on/off is slow: the firmware has to bring the PCS (and the packs)
     down or up again, so the card shows the requested state as pending until
     the device reports it (or gives up after this long). */
  const SWITCH_PENDING_MS = 5000;
  const SWITCH_CONFIRM_MS = 2500; // how long the tick after confirmation stays

  /* How long a command may take to come back from the device before the
     progress dialog reports it as failed. The firmware is not chatty: mode
     changes in particular can take several seconds. */
  const SWITCH_CONFIRM_TIMEOUT_MS = 15000;
  const EMS_CONFIRM_TIMEOUT_MS = 20000;
  const REBOOT_OFFLINE_TIMEOUT_MS = 45000;

  /* The icon set, as finished SVG markup.

     Lit cannot build these: a `<path>` written inside `${...}` is parsed in the
     HTML namespace and never paints. Injecting a complete SVG string with
     `_untrusted()` goes through the HTML parser instead, which does handle SVG
     foreign content - so gradients, fills and multi-colour shapes all work.

     Each entry receives a unique id prefix `u`, because several cards can be on
     the page at once and two gradients sharing an id would clash.

     The colours are the card's own vocabulary, so an icon says what the control
     beside it says: orange / green / blue are the three EMS modes, amber is
     power, indigo is sleep, teal is a limit, slate is a neutral part (a battery
     shell, a ceiling bar). */
  const ICON_SVG = {
    /* ---- power: a filled amber bolt ---- */
    bolt: (u) => `
      <defs><linearGradient id="${u}b" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <path fill="url(#${u}b)"
        d="M13.9 1.6 4.6 13.3a.7.7 0 0 0 .55 1.15h4.7l-1.4 7a.7.7 0 0 0 1.23.55
           l9.4-11.7a.7.7 0 0 0-.55-1.15h-4.75l1.35-6.9a.7.7 0 0 0-1.23-.55z"/>`,

    /* ---- EMS mode: three faders, one per control strategy ---- */
    faders: (u) => `
      <g stroke-linecap="round">
        <path d="M5.4 4.4v15.2" stroke="#e2e8f0" stroke-width="2.5"/>
        <path d="M12 4.4v15.2" stroke="#e2e8f0" stroke-width="2.5"/>
        <path d="M18.6 4.4v15.2" stroke="#e2e8f0" stroke-width="2.5"/>
      </g>
      <circle cx="5.4" cy="14.2" r="3.25" fill="#ea580c"/>
      <circle cx="5.4" cy="14.2" r="1.1" fill="#fff"/>
      <circle cx="12" cy="9.1" r="3.25" fill="#16a34a"/>
      <circle cx="12" cy="9.1" r="1.1" fill="#fff"/>
      <circle cx="18.6" cy="16.4" r="3.25" fill="#2563eb"/>
      <circle cx="18.6" cy="16.4" r="1.1" fill="#fff"/>`,

    /* ---- sleep: an indigo crescent with a small star ---- */
    moon: (u) => `
      <defs><linearGradient id="${u}m" x1=".2" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#a5b4fc"/><stop offset="1" stop-color="#4f46e5"/>
      </linearGradient></defs>
      <path fill="url(#${u}m)"
        d="M20.1 14.6A9 9 0 0 1 9.3 3.8a9.15 9.15 0 1 0 10.8 10.8z"/>
      <circle cx="17.4" cy="5.1" r="1.45" fill="#c7d2fe"/>
      <circle cx="20.6" cy="8.6" r=".95" fill="#c7d2fe"/>`,

    /* ---- target power: a battery beside an up / down arrow ----
       `power_ctrl` is signed - positive discharges, negative charges - so the
       arrow points both ways instead of suggesting a single direction. */
    target: (u) => `
      <rect x="2.2" y="6.6" width="8.2" height="11.6" rx="1.9" fill="none"
        stroke="#94a3b8" stroke-width="1.9"/>
      <rect x="4.6" y="3.9" width="3.4" height="2.9" rx=".9" fill="#94a3b8"/>
      <path d="M16.6 16.4V7.6" stroke="#94a3b8" stroke-width="2.2"
        stroke-linecap="round"/>
      <path fill="#16a34a" d="M16.6 2.9 12.3 8.2h8.6z"/>
      <path fill="#ea580c" d="M16.6 21.1 12.3 15.8h8.6z"/>`,

    /* ---- max output: an arrow rising until it meets a ceiling ----
       It is a limit, not a flow, so the arrow stops at the bar. */
    ceiling: (u) => `
      <defs><linearGradient id="${u}c" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/>
      </linearGradient></defs>
      <path d="M3.4 4.1h17.2" stroke="#0d9488" stroke-width="2.5"
        stroke-linecap="round"/>
      <path fill="url(#${u}c)"
        d="M12 7 7.1 12.9h3.3v7.4h3.2v-7.4h3.3z"/>`,

    /* ---- per-phase limit: three bars capped by one shared ceiling ----
       Kept close to the old three-bar icon on purpose: it is the same subject
       (the phases), now clearly bounded from above. */
    phaseLimit: (u) => `
      <path d="M3.4 4.1h17.2" stroke="#94a3b8" stroke-width="2.2"
        stroke-linecap="round"/>
      <g stroke-linecap="round">
        <path d="M6.2 20V10.4" stroke="#ea580c" stroke-width="3.1"/>
        <path d="M12 20V7.4" stroke="#16a34a" stroke-width="3.1"/>
        <path d="M17.8 20V13.2" stroke="#2563eb" stroke-width="3.1"/>
      </g>`,

    /* ---- reboot: a teal circular arrow ---- */
    reboot: (u) => `
      <defs><linearGradient id="${u}r" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#0d9488"/>
      </linearGradient></defs>
      <path fill="none" stroke="url(#${u}r)" stroke-width="2.5" stroke-linecap="round"
        d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4"/>
      <path fill="#0d9488" d="M13.4 4.1h6.2v6.2l-6.2-6.2z"/>`,

    dot: () => `<circle cx="12" cy="12" r="4" fill="currentColor"/>`,
  };


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
        _repeatOn: { type: Boolean },
        _repeatEvery: { type: String },
        _busy: { type: Object },
        _confirm: { type: Object },
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
      /* Periodic re-send of the power control value.

         The repeat itself runs in the integration, **not here**: ``power_ctrl``
         is a lease the firmware renews only while it keeps arriving, and a
         ``setTimeout`` inside this card died with the card on every page change
         (Lovelace destroys the view's elements), leaving the switch on screen
         saying "on" while nothing was being sent. ``hoymiles.set_power_ctrl``
         schedules the publish in Home Assistant instead, so navigation, a
         closed tab and a throttled background tab no longer matter.

         The card keeps three things: the switch position (the user's intent,
         ``_repeatOn``), the last state the server reported (``_repeatState``)
         and a display-only countdown derived from it. */
      this._repeatOn = true;
      this._repeatEvery = String(REPEAT_DEFAULT_S);
      this._repeatState = null; // {value, interval, nextIn, at} or null
      this._repeatSynced = false; // the restore query already ran for this instance
      this._repeatSeeded = false; // the inputs were filled from the server once
      this._repeatSyncTimer = null; // next resync, arrives with the server state
      this._repeatUiTimer = null; // once-a-second countdown refresh
      /* Last EMS mode this card rendered. Drives the "left / re-entered MQTT
         control" reset - see `_watchEmsMode`. */
      this._lastEmsMode = undefined;
      /* Power switch: the requested target while it is in flight, and the time
         the device confirmed it (drives the tick + spinner). */
      this._switchPending = null;
      this._switchConfirmedAt = 0;
      this._pendingTimer = null;
      /* Progress dialog. Every command that reaches the broker - or that the
         device has to answer - runs through it, so the user always sees which
         step is in flight instead of a banner that says "sent" after the fact. */
      this._busy = null;
      this._busyTimer = null;
      /* Yes/no question (currently: switching the timer off). */
      this._confirm = null;
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
                flex-wrap: wrap; margin-bottom: 12px; }
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
        /* The group clips its content (overflow: hidden), so a row that does not
           fit has to wrap instead of spilling: when the card is narrow the
           control moves to its own line below the label. Without this the
           segmented control was cut off once the dashboard column shrank. */
        .item:not(.stack) { flex-wrap: wrap; }
        .item + .item::before {
          content: ""; position: absolute; top: 0; left: 14px; right: 0;
          height: 1px; background: var(--divider-color); opacity: .7;
        }
        .item .ico { flex: 0 0 auto; width: 24px; text-align: center;
                     font-size: 16px; line-height: 1; }
        .item .nm { flex: 1 1 auto; min-width: 0; font-size: 15px;
                    color: var(--primary-text-color); line-height: 1.3; }
        /* Row layout only: giving the label a real basis keeps it readable and
           makes the control wrap first instead of squeezing the label to 0. */
        .item:not(.stack) .nm { flex: 1 1 7.5em; }
        .item .nm small { display: block; font-size: 12px; font-weight: 400;
                          color: var(--secondary-text-color); margin-top: 2px;
                          line-height: 1.35; }
        .item .nm code { font-size: 11px; color: var(--secondary-text-color);
                         word-break: break-all; }
        .item .ctrl { flex: 0 1 auto; display: flex; align-items: center;
                      gap: 8px; margin-left: auto;
                      flex-wrap: wrap; justify-content: flex-end;
                      max-width: 100%; }
        .item.stack { flex-direction: column; align-items: stretch; gap: 8px; }
        .item.stack .ctrl { margin-left: 0; flex: 0 0 auto;
                            flex-wrap: wrap; justify-content: flex-start; }
        .item .ctrl .unit { font-size: 13px; color: var(--secondary-text-color); }

        /* Periodic send, as a second line under the sliders. It is a plain row
           rather than another slider so it reads as a setting *of* the power
           control, and its switch lines up with "Send" above it. */
        .repeat-row { display: flex; align-items: center; gap: 7px;
                      width: 100%; margin-top: 6px; }
        .repeat-row .repeat-ico { display: inline-flex; flex: 0 0 auto;
                                  color: var(--secondary-text-color); }
        .repeat-row .cap { font-size: 12.5px;
                           color: var(--secondary-text-color);
                           white-space: nowrap; }
        .repeat-row input[type="number"] {
          width: 56px; flex: 0 0 auto; text-align: center;
          font-size: 13.5px; padding: 6px 4px; border-radius: 9px;
        }
        .repeat-row .spacer { flex: 1 1 auto; min-width: 4px; }
        .repeat-row ha-switch { flex: 0 0 auto; }
        /* While it runs, the row is tinted so "this is live" is visible without
           reading the countdown. */
        .repeat-row.on .cap { color: var(--primary-color); }
        .repeat-row.on .repeat-ico { color: var(--primary-color); }

        /* segmented control (the iOS signature control) */
        .seg { display: inline-flex; padding: 2px; gap: 2px;
               max-width: 100%; flex-wrap: wrap;
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
        /* The periodic send is running: the sub-line carries the countdown, so
           it is tinted to sit apart from a plain description. */
        .item .nm small.live { color: var(--primary-color); font-weight: 500; }
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
        /* The repeat toggle while it is running: red reads as "press to stop". */
        .btn.stop { background: var(--error-color);
                    color: var(--text-primary-color, #fff); font-weight: 600; }
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
        .slider { display: flex; align-items: center; gap: 10px;
                  width: 100%; flex-wrap: wrap; }
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

        .btn.small { padding: 5px 10px; font-size: 12.5px; }
        .toast { margin-top: 12px; font-size: 13px; padding: 10px 13px;
                 border-radius: 12px;
                 background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        .toast.err { color: var(--error-color); }

        /* ================================================================== *
         * Card grid (controls grouped by category)
         *
         * Every control family owns one card. The power card anchors the first
         * cell; the EMS card starts directly underneath it and owns everything
         * that depends on the active mode. A mode with more controls only makes
         * the EMS card wider and taller - the page never re-flows around it,
         * which is what keeps room for fan / heating / ... later on.
         * NOTE: never write a backtick inside this css template (not even in a
         * comment) - it would terminate the template string.
         * ================================================================== */
        .grid { display: grid; gap: 14px; align-items: start;
                grid-template-columns: repeat(3, minmax(0, 1fr)); }
        /* A fixed number of tracks keeps the two cards' widths predictable: with
           auto-fit the empty cells would collapse and make the power card jump
           between the collapsed and the expanded EMS card. */
        @media (max-width: 1100px) {
          .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 760px) {
          .grid { grid-template-columns: minmax(0, 1fr); }
        }
        .grid > .wide { grid-column: 1 / -1; }

        /* The power card: first cell of the first row. */
        .grid > .c.power { grid-column: 1; grid-row: 1; }
        /* The EMS card: below the power card, same left edge. */
        .grid > .c.ems { grid-column: 1; grid-row: 2; }
        /* A mode with several controls gets the whole row: it grows to the
           right and, because the content is taller, downwards too. */
        .grid > .c.ems.grow { grid-column: 1 / -1; }
        /* A single track cannot be grown any further. */
        @media (max-width: 760px) {
          .grid > .c.ems, .grid > .c.ems.grow { grid-column: 1 / -1; }
        }

        ha-card.c { padding: 15px 17px 17px; border-radius: 16px; }

        /* Separator between the mode picker and whatever the mode adds. */
        .sep { height: 1px; background: var(--divider-color); margin: 15px 0; }

        /* The embedded <hoymiles-tou-editor> is a card of its own everywhere
           else; here it is just the bottom half of this one, so it gets no
           extra background and no border of its own. */
        .tou-host { margin-top: 2px; }
        .tou-host hoymiles-tou-editor { display: block; }

        /* A mode that owns several controls lays them out side by side when the
           card is wide enough, and stacks them again on a phone. */
        .r-grid { display: grid; gap: 16px 26px;
                  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
        .r-grid > .r + .r { margin-top: 0; padding-top: 0; border-top: 0; }

        .c-head { display: flex; align-items: center; gap: 9px; margin: 0 0 15px; }
        .c-head .ci { flex: 0 0 auto; display: inline-flex;
                      align-items: center; justify-content: center;
                      line-height: 1; }
        .c-head .ct { font-size: 12.5px; font-weight: 600; line-height: 1.25;
                      letter-spacing: .05em; text-transform: uppercase;
                      color: var(--primary-text-color); }
        .c-head .cs { display: block; margin-top: 3px; font-size: 12px;
                      font-weight: 400; letter-spacing: 0; text-transform: none;
                      color: var(--secondary-text-color); }

        /* ================================================================== *
         * Icon set
         *
         * Filled, multicolour SVG. Not a nested lit template (a path written
         * inside an interpolation is parsed in the HTML namespace and paints
         * nothing), but a plain SVG string injected with _untrusted(), which
         * the HTML parser puts in the SVG namespace correctly.
         *
         * The colours are the card's own vocabulary, so an icon says the same
         * thing as the control next to it: orange / green / blue are the three
         * EMS modes, amber is power, indigo is sleep, teal is a setpoint.
         * ================================================================== */
        .ic { display: inline-flex; flex: 0 0 auto;
              align-items: center; justify-content: center; line-height: 1; }
        .ic svg { display: block; }
        .c-head .ci .ic { color: inherit; }
        .r-label .ri .ic { color: inherit; }

        .c-head .sp { flex: 1 1 auto; }
        .c-head .info { flex: 0 0 auto; display: inline-flex; cursor: help;
                        color: var(--secondary-text-color); opacity: .7; }

        /* one labelled control inside a card */
        .r + .r { margin-top: 14px; padding-top: 14px;
                  border-top: 1px solid var(--divider-color); }
        .r-main { min-width: 0; }
        .r-label { display: flex; align-items: center; gap: 8px;
                   font-size: 14px; line-height: 1.3;
                   color: var(--primary-text-color); }
        .r-label .ri { flex: 0 0 auto; display: inline-flex; justify-content: center;
                       align-items: center; line-height: 1;
                       color: var(--secondary-text-color); }
        .r-sub { margin: 4px 0 0 25px; font-size: 12px; line-height: 1.45;
                 color: var(--secondary-text-color); }
        .r-sub code { font-size: 11px; word-break: break-all; }
        .r-ctrl { margin-top: 10px; }
        .r.bare .r-ctrl { margin-top: 0; }
        .r.inline { display: flex; align-items: center; gap: 12px; }
        .r.inline .r-main { flex: 1 1 auto; }
        .r.inline .r-ctrl { flex: 0 0 auto; margin-top: 0; }

        .r-sub.busy { color: var(--primary-color);
                      animation: hm-pulse 1.3s ease-in-out infinite; }
        .r-sub.done { color: var(--success-color, #0da035); font-weight: 500; }
        .r-sub.live { color: var(--primary-color); font-weight: 500; }

        /* explanatory block used when a mode has nothing to configure */
        .note { font-size: 12.5px; line-height: 1.55;
                color: var(--secondary-text-color); padding: 11px 13px;
                border-radius: 12px;
                background: var(--secondary-background-color, rgba(120,120,128,.10)); }
        .note b { color: var(--primary-text-color); font-weight: 600; }
        .note + .note { margin-top: 10px; }

        .btn-row { display: flex; flex-wrap: wrap; gap: 8px; }

        /* Three phase sliders stack tightly; they are one control, not three. */
        .phase-rows { display: flex; flex-direction: column; gap: 6px; }

        /* The mode selector fills the card, so three long labels never spill. */
        .seg.fluid { display: flex; width: 100%; }
        .seg.fluid button { flex: 1 1 0; min-width: 0; text-align: center;
                            overflow: hidden; text-overflow: ellipsis; }

        /* ================================================================== *
         * Progress dialog
         *
         * Rendered outside the grid (fixed overlay) so it is never clipped by a
         * card and never affected by the card grid's layout. One step per thing
         * the command has to do; the dialog closes itself once every step is
         * done, and stays open with the reason when one fails.
         * ================================================================== */
        .overlay { position: fixed; inset: 0; z-index: 9999;
                   display: flex; align-items: center; justify-content: center;
                   padding: 20px; background: rgba(0,0,0,.34);
                   backdrop-filter: blur(3px);
                   -webkit-backdrop-filter: blur(3px); }
        .modal { width: min(430px, 100%); box-sizing: border-box;
                 padding: 20px 22px 18px; border-radius: 18px;
                 background: var(--card-background-color, #fff);
                 color: var(--primary-text-color);
                 box-shadow: 0 18px 48px rgba(0,0,0,.28); }
        .modal .m-title { display: flex; align-items: center; gap: 9px;
                          font-size: 15px; font-weight: 600; }
        .modal .m-sub { margin-top: 4px; font-size: 12.5px; line-height: 1.45;
                        color: var(--secondary-text-color); }
        .pbar { position: relative; height: 5px; margin: 14px 0 12px;
                border-radius: 999px; overflow: hidden;
                background: var(--secondary-background-color, rgba(120,120,128,.18)); }
        .pbar .pfill { height: 100%; width: 0; border-radius: 999px;
                       background: var(--primary-color);
                       transition: width .28s ease; }
        .modal.err .pbar .pfill { background: var(--error-color); }
        .modal.ok .pbar .pfill { background: var(--success-color, #0da035); }

        .steps { display: flex; flex-direction: column; gap: 7px;
                 font-size: 13px; line-height: 1.4; }
        .steps .st { display: flex; align-items: flex-start; gap: 9px;
                     color: var(--secondary-text-color); }
        .steps .st .mk { flex: 0 0 16px; display: inline-flex;
                         justify-content: center; font-size: 12px;
                         line-height: 1.5; }
        .steps .st.active { color: var(--primary-text-color); font-weight: 500; }
        .steps .st.done { color: var(--primary-text-color); }
        .steps .st.done .mk { color: var(--success-color, #0da035); }
        .steps .st.failed { color: var(--error-color); }
        .steps .st .spin { width: 12px; height: 12px; margin-top: 1px;
                           border-radius: 50%;
                           border: 2px solid var(--primary-color);
                           border-right-color: transparent;
                           animation: hm-spin .8s linear infinite; }

        .m-msg { margin-top: 14px; font-size: 12.5px; line-height: 1.5;
                 padding: 10px 12px; border-radius: 11px;
                 background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        .modal.err .m-msg { color: var(--error-color);
                            background: rgba(219, 68, 55, .12); }
        .m-foot { display: flex; justify-content: flex-end; gap: 8px;
                 margin-top: 14px; }
        /* A confirmation is not a progress dialog: no bar, just the question. */
        .modal.confirm .m-msg { margin-top: 10px; }

        @keyframes hm-spin { to { transform: rotate(360deg); } }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-control: 'dev_id' is required");
      }
      this._config = { ...config };
      /* A new config may point at another device, so the resolved entities have
         to be looked up again. */
      this._cache.clear();
      this._initialised = false;
      this._clearRepeatTimers();
      this._repeatSynced = false;
      this._repeatSeeded = false;
      this._repeatState = null;
      this._lastEmsMode = undefined;
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._initialised) this._seedInputs();
      /* Ask the integration whether a setpoint is still being re-published.
         This is what makes the card survive a page change: a fresh instance
         has no memory of its own, but the timer kept running on the server. */
      if (!this._repeatSynced) {
        this._repeatSynced = true;
        this._syncRepeat();
      }
      this._reconcileSwitch();
      this.requestUpdate();
    }

    getCardSize() {
      /* A grid of independent cards: roughly two columns of three rows on a
         desktop dashboard. Lovelace only uses this as a hint. */
      return 10;
    }

    /**
     * Language changes are announced on `window`; re-rendering is all a card
     * has to do, because the wording is chosen while it renders.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
      if (this._toastTimer) clearTimeout(this._toastTimer);
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
      if (this._busyTimer) clearTimeout(this._busyTimer);
      /* Only the local display timers are cleared here. The repeat runs in the
         integration and must outlive the card - that is the whole point. */
      this._clearRepeatTimers();
      this._repeatSynced = false;
    }

    updated() {
      /* The TOU editor is a real custom element hosted inside the EMS card, so
         it needs its config and the current `hass` handed over by hand: Lit
         binds properties, but this one is a Lovelace card with `setConfig`.
         Done here (not in render) because the element only exists after the
         template has been committed. */
      this._syncTouEditor();
      this._watchEmsMode();
      /* While a countdown is actually running, wake up once a second so the
         sub-line stays honest. One timer at a time; the timeout is what keeps a
         hidden tab from queuing thousands of frames. */
      if (this._repeatActive()) {
        if (this._repeatUiTimer) clearTimeout(this._repeatUiTimer);
        this._repeatUiTimer = setTimeout(() => {
          this._repeatUiTimer = null;
          if (this._repeatActive() && this.isConnected) this.requestUpdate();
        }, 1000);
      }
    }

    /**
     * Follow EMS mode changes and reset the setpoint accordingly.
     *
     * `mqtt_ctrl` is the only mode where a setpoint means anything, so leaving
     * it ends the repeat (the integration does that itself the moment the mode
     * is published - see `coordinator._async_stop_repeat_if_needed`). Coming
     * back therefore starts from a blank slate: keeping the previous draft
     * would look like the old setpoint was still in force and, worse, one press
     * of Send would silently resume it.
     */
    _watchEmsMode() {
      const mode = this._emsMode();
      const prev = this._lastEmsMode;
      if (mode === prev) return;
      this._lastEmsMode = mode;

      /* Only a real switch between two known modes counts. Before the select
         entity has a state the mode reads "" and then arrives as whatever the
         device reports - treating that as a return to MQTT control would reset
         the draft on every page reload. */
      if (prev !== "mqtt_ctrl" && prev !== "general" && prev !== "tou_plan") return;

      if (mode !== "mqtt_ctrl") {
        /* Leaving MQTT control. Drop the local mirror so the row cannot claim a
           countdown that the server no longer runs. */
        this._repeatState = null;
        this._clearRepeatTimers();
        this.requestUpdate();
        return;
      }

      /* Back in MQTT control: default draft, nothing running. */
      this._repeatState = null;
      this._repeatSeeded = false;
      this._repeatOn = true;
      this._powerCtrl = "0";
      this._repeatEvery = String(REPEAT_DEFAULT_S);
      /* Keep `_seedInputs` from putting the stale entity value back. */
      this._initialised = true;
      this._clearRepeatTimers();
      this._syncRepeat();
      this.requestUpdate();
    }

    /* ----------------------------- lookups ----------------------------- */

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
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

    /**
     * Publish one message and *throw* on failure.
     *
     * The explicit commands run through `_runAction`, which turns an exception
     * into the reason shown in the progress dialog. The automatic re-send calls
     * this directly and stays silent on purpose: a banner every few seconds
     * would be noise, and a failed tick is simply retried on the next one.
     */
    async _publishRaw(topic, payload) {
      if (!this._hass || typeof this._hass.callService !== "function") {
        throw new Error(this._t(
          "No Home Assistant connection.", "没有 Home Assistant 连接。",
        ));
      }
      await this._hass.callService("mqtt", "publish", {
        topic,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
        qos: 1,
        retain: false,
      });
    }

    /* -------------------------- progress dialog -------------------------- */

    /**
     * Start a dialog. `steps` is a list of plain strings; every step starts as
     * "todo" and is moved to active / done / failed by the action that owns it.
     */
    _busyStart(title, steps) {
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._busy = {
        title,
        steps: (steps || []).map((text) => ({ text, state: "todo" })),
        state: "running",
        message: "",
      };
      this.requestUpdate();
    }

    _busySet(index, state, text) {
      const busy = this._busy;
      if (!busy || !busy.steps[index]) return;
      busy.steps[index].state = state;
      if (text) busy.steps[index].text = text;
      this._busy = { ...busy };
      this.requestUpdate();
    }

    /** Mark every step done and close the dialog on its own. */
    _busyDone(message) {
      const busy = this._busy;
      if (!busy) return;
      for (const step of busy.steps) {
        if (step.state !== "failed") step.state = "done";
      }
      this._busy = { ...busy, state: "ok", message: message || "" };
      this.requestUpdate();
      this._busyTimer = setTimeout(() => {
        this._busyTimer = null;
        this._busy = null;
        this.requestUpdate();
      }, 1300);
    }

    /** Keep the dialog open and show why. The user closes it. */
    _busyFail(message) {
      const busy = this._busy;
      if (!busy) return;
      this._busy = {
        ...busy,
        state: "error",
        message: message || this._t("The command failed.", "命令执行失败。"),
      };
      this.requestUpdate();
    }

    _busyClose() {
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._busy = null;
      this.requestUpdate();
    }

    /**
     * Ask a yes/no question in the same overlay as the progress dialog.
     *
     * A promise rather than a callback: the caller reads like a normal `if`,
     * and `window.confirm` would look nothing like the rest of the card.
     */
    _askConfirm({ title, message, confirmText, cancelText }) {
      return new Promise((resolve) => {
        this._confirm = {
          title,
          message,
          confirmText: confirmText || this._t("Yes", "确定"),
          cancelText: cancelText || this._t("Cancel", "取消"),
          resolve,
        };
        this.requestUpdate();
      });
    }

    /** Answer the open question; the dialog closes either way. */
    _answerConfirm(ok) {
      const pending = this._confirm;
      if (!pending) return;
      this._confirm = null;
      this.requestUpdate();
      if (typeof pending.resolve === "function") pending.resolve(ok);
    }

    /**
     * Run one explicit command through the dialog.
     *
     * Every failure - a broker error, a device that never answers - ends up as
     * the message of a red dialog, so the user never has to guess whether the
     * command went through.
     */
    async _runAction({ title, steps, run }) {
      if (this._busy && this._busy.state === "running") return; // one at a time
      this._busyStart(title, steps);
      try {
        await run();
      } catch (err) {
        const busy = this._busy;
        if (busy) {
          const active = busy.steps.findIndex((s) => s.state === "active");
          if (active >= 0) this._busySet(active, "failed");
        }
        this._busyFail(String((err && err.message) || err || ""));
      }
    }

    /**
     * Poll `predicate` until it is true or the deadline passes.
     *
     * `hass` is pushed on every state change, but a poll is simpler than
     * registering a listener per command and it also works for values that are
     * only echoed once.
     */
    _waitFor(predicate, timeoutMs) {
      return new Promise((resolve) => {
        const started = this._now();
        const tick = () => {
          let hit = false;
          try {
            hit = Boolean(predicate());
          } catch (err) {
            hit = false;
          }
          if (hit) { resolve(true); return; }
          if (this._now() - started >= timeoutMs) { resolve(false); return; }
          setTimeout(tick, 300);
        };
        tick();
      });
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
      /* One command at a time: the other button of the dialog is still in
         flight. Nothing is marked pending either, so the card stays honest. */
      if (this._busy && this._busy.state === "running") return;
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

      this._runAction({
        title: this._t(on ? "Wake up" : "Sleep", on ? "唤醒" : "休眠"),
        steps: [
          this._t("Publish the command to the broker", "向 Broker 下发命令"),
          this._t("Wait for the device to confirm the new state", "等待设备确认新状态"),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("switch/<dev_id>/set"), on ? "ON" : "OFF");
          this._busySet(0, "done");
          this._busySet(1, "active");
          /* An optimistic entity can never confirm anything (the firmware does
             not publish a usable state for it), so the wait would always end in
             a false alarm. The requested state stays in force instead. */
          if (this._switchOptimistic()) {
            this._busySet(1, "done", this._t(
              "The device does not report this state back", "设备不上报该状态",
            ));
            this._busyDone(this._t("Command sent.", "命令已下发。"));
            return;
          }
          const confirmed = await this._waitFor(
            () => this._switchReal() === (target === "on"), SWITCH_CONFIRM_TIMEOUT_MS,
          );
          if (!confirmed) {
            throw new Error(this._t(
              "The device did not confirm the new state in time. "
              + "It may still be switching - check the card again in a few seconds.",
              "设备未在预期时间内确认新状态。可能仍在切换，请几秒后再看卡片状态。",
            ));
          }
          this._switchConfirmedAt = this._now();
          this._busySet(1, "done");
          this._busyDone(this._t(
            "The device confirmed the new state.", "设备已确认新状态。",
          ));
        },
      });
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
      if (mode === this._emsMode()) return; // already there
      this._optimistic.ems_mode = mode;
      this._runAction({
        title: this._t("EMS mode", "EMS 模式"),
        steps: [
          this._t(`Publish the mode command (${mode})`, `下发模式命令（${mode}）`),
          this._t("Wait for the device to switch", "等待设备切换"),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("select/<dev_id>/ems_mode/command"), mode);
          this._busySet(0, "done");
          this._busySet(1, "active");
          /* The firmware echoes the new mode on its own select entity; that
             echo is the only confirmation it gives, so it is worth waiting for.
             Switching away from TOU can take a few seconds. */
          const confirmed = await this._waitFor(
            () => {
              const state = this._state("ems_mode", "select");
              return Boolean(state) && String(state.state) === mode;
            },
            EMS_CONFIRM_TIMEOUT_MS,
          );
          if (!confirmed) {
            throw new Error(this._t(
              `The device still reports ${this._emsMode() || "an unknown mode"} `
              + `after ${Math.round(EMS_CONFIRM_TIMEOUT_MS / 1000)} s. `
              + "Some modes are refused while an on-grid micro inverter is present.",
              `设备在 ${Math.round(EMS_CONFIRM_TIMEOUT_MS / 1000)} s 后仍上报 `
              + `${this._emsMode() || "未知模式"}。并网口存在微逆时，部分模式会被拒绝。`,
            ));
          }
          this._busySet(1, "done");
          this._busyDone(this._t(
            `The device switched to ${mode}.`, `设备已切换到 ${mode}。`,
          ));
        },
      });
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
      /* `_repeatValue` rather than `Number(...)`: an empty box parses to 0, and
         publishing 0 W because the field was blank is not what anyone means. */
      const value = this._repeatValue();
      if (value === null) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      const every = this._repeatInterval();
      this._runAction({
        title: this._t("Target power", "目标功率"),
        steps: [
          this._t(`Publish ${value} W to the broker`, `向 Broker 下发 ${value} W`),
        ],
        run: async () => {
          this._busySet(0, "active");
          if (this._repeatOn) {
            /* The integration publishes this value and keeps publishing it. The
               slider is only a draft from here on: moving it must not silently
               change what the device is being told. */
            await this._callService("set_power_ctrl", { value, interval: every });
          } else {
            await this._publishRaw(this._topic("number/<dev_id>/power_ctrl/set"), String(value));
          }
          this._busySet(0, "done");
          await this._syncRepeat();
          this._busyDone(this._repeatOn
            ? this._t(
              `Setpoint ${value} W sent. Home Assistant re-sends it every ${every} s, `
              + "even after you leave this page.",
              `设定值 ${value} W 已下发。Home Assistant 会每 ${every} s 重发一次，`
              + "离开本页也照常进行。",
            )
            : this._t(
              `Setpoint ${value} W sent. The timer is off, so it will not be `
              + `repeated - the device drops it after about a minute.`,
              `设定值 ${value} W 已下发。定时已关闭，不会重发——约一分钟后设备会丢弃该设定值。`,
            ));
        },
      });
    }

    /* -------------------- periodic power control send -------------------- */

    /**
     * Call one of the integration's own services; throws on failure.
     *
     * `_publishRaw` cannot be used for this: the repeat has to be scheduled in
     * Home Assistant, because a timer in this card dies with the card.
     */
    async _callService(service, data) {
      if (!this._hass || typeof this._hass.callService !== "function") {
        throw new Error(this._t(
          "No Home Assistant connection.", "没有 Home Assistant 连接。",
        ));
      }
      return this._hass.callService("hoymiles", service, {
        dev_id: this._dev(),
        ...(data || {}),
      });
    }

    /**
     * Read back the re-publish job that Home Assistant is running.
     *
     * This is the piece that makes a page change harmless: a brand-new card has
     * no memory of its own, but the server still knows the value, the interval
     * and when the next send is due.
     */
    async _syncRepeat() {
      if (!this._hass || typeof this._hass.callService !== "function") return;
      if (!this._config) return;
      const dev = this._dev();
      if (!dev) return;
      let payload = null;
      try {
        const out = await this._hass.callService(
          "hoymiles", "get_power_ctrl", { dev_id: dev }, undefined, true, true,
        );
        payload = out && out.response ? out.response : out;
      } catch (err) {
        /* A failed query is not worth a banner, but it must be retried: the
           usual cause is a Home Assistant that is still starting up. */
        this._scheduleResync(REPEAT_IDLE_POLL_S);
        return;
      }
      if (!this.isConnected) return;
      this._applyRepeatState(payload);
      this.requestUpdate();
    }

    _applyRepeatState(payload) {
      /* The integration stops the job as soon as the EMS mode leaves
         `mqtt_ctrl`, but a query issued just before that can still come back
         "active". Ignoring it here keeps the row from showing a countdown for a
         setpoint the device has already been released from. */
      const mode = this._emsMode();
      if (mode === "general" || mode === "tou_plan") {
        if (payload && payload.active === true) {
          this._scheduleResync(REPEAT_IDLE_POLL_S);
          return;
        }
      }

      if (!payload || payload.active !== true) {
        this._repeatState = null;
        // Keep looking: a setpoint may be started from another browser, or the
        // one that was running may have gone away with a Home Assistant restart.
        this._scheduleResync(REPEAT_IDLE_POLL_S);
        return;
      }

      const value = Number(payload.value);
      const interval = Number(payload.interval);
      const nextIn = Number(payload.next_in);
      this._repeatState = {
        value: Number.isFinite(value) ? value : null,
        interval: Number.isFinite(interval) && interval > 0 ? interval : REPEAT_DEFAULT_S,
        nextIn: Number.isFinite(nextIn) ? Math.max(0, nextIn) : 0,
        at: Date.now(),
      };

      /* A running setpoint is the value in force, so on the first sync it wins
         over whatever the number entity happens to echo. Only on the first one:
         overwriting the inputs on every resync would wipe what the user is
         typing. */
      if (!this._repeatSeeded && this._repeatState.value !== null) {
        this._repeatSeeded = true;
        this._powerCtrl = String(this._repeatState.value);
        this._repeatEvery = String(this._repeatState.interval);
        this._initialised = true; // keep `_seedInputs` from overwriting it
      }
      this._repeatOn = true;
      this._scheduleResync(this._repeatState.nextIn + 1);
    }

    /** Ask the server again after `seconds`; one timer, always replaced. */
    _scheduleResync(seconds) {
      if (this._repeatSyncTimer) clearTimeout(this._repeatSyncTimer);
      const secs = Number.isFinite(Number(seconds)) ? Number(seconds) : REPEAT_IDLE_POLL_S;
      this._repeatSyncTimer = setTimeout(() => {
        this._repeatSyncTimer = null;
        if (this.isConnected) this._syncRepeat();
      }, Math.max(1, secs) * 1000 + 800);
    }

    /** The interval in effect: the draft, clamped to sane bounds. */
    _repeatInterval() {
      const v = Math.round(num(this._repeatEvery));
      if (!Number.isFinite(v)) return REPEAT_DEFAULT_S;
      return Math.min(Math.max(v, REPEAT_MIN_S), REPEAT_MAX_S);
    }

    /** The value that would be sent, or null when it cannot be read. */
    _repeatValue() {
      const v = Number(this._powerCtrl);
      return Number.isFinite(v) && this._powerCtrl !== "" ? v : null;
    }

    /** True while Home Assistant is really re-publishing a setpoint. */
    _repeatActive() {
      return Boolean(this._repeatState);
    }

    _clearRepeatTimers() {
      if (this._repeatSyncTimer) clearTimeout(this._repeatSyncTimer);
      this._repeatSyncTimer = null;
      if (this._repeatUiTimer) clearTimeout(this._repeatUiTimer);
      this._repeatUiTimer = null;
    }

    /** Countdown to the next automatic send, or null when it is not running. */
    _repeatNextIn() {
      const state = this._repeatState;
      if (!state) return null;
      const elapsed = (Date.now() - state.at) / 1000;
      return Math.max(0, Math.ceil(state.nextIn - elapsed));
    }

    /**
     * Restart the lease with a new interval.
     *
     * The server owns the schedule, so changing the number in the box only takes
     * effect once it is told - otherwise the row would promise "every 5 s" while
     * the job still ran at 30 s.
     */
    async _applyRepeatInterval() {
      const state = this._repeatState;
      if (!state || state.value === null) return;
      try {
        await this._callService("set_power_ctrl", {
          value: state.value,
          interval: this._repeatInterval(),
        });
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      await this._syncRepeat();
    }


    /**
     * Hand the config and `hass` to the embedded TOU editor.
     *
     * `setConfig` runs once: re-running it would reset the draft (and the
     * user's unsaved edits) on every Home Assistant state push. `hass` is the
     * live feed the editor needs to resolve its entities, so that one is passed
     * on whenever the reference changed.
     */
    _syncTouEditor() {
      const root = this.renderRoot;
      const el = root && root.querySelector ? root.querySelector("hoymiles-tou-editor") : null;
      if (!el) return;
      if (el._hmEmbedded !== true) {
        el._hmEmbedded = true;
        if (typeof el.setConfig === "function") {
          el.setConfig({ dev_id: this._dev(), embedded: true });
        }
      }
      const hass = this._hass;
      if (hass && el._hass !== hass) el.hass = hass;
    }

    /**
     * The timer switch.
     *
     * Off -> on with nothing running only records the intent: the first message
     * is always the one the user asked for with Send. Off -> on *while a job is
     * running* restarts the lease, i.e. it re-anchors the countdown at "now".
     *
     * On -> off asks first, because the setpoint dies about a minute later and
     * the device silently goes back to regulating on its own.
     *
     * Returns whether the switch really moved, so the caller can put the knob
     * back when the question is declined.
     */
    async _setRepeat(on) {
      if (on === (this._repeatOn === true)) return true;

      if (on) {
        this._repeatOn = true;
        this.requestUpdate();
        const state = this._repeatState;
        if (state && state.value !== null) {
          try {
            await this._callService("set_power_ctrl", {
              value: state.value,
              interval: this._repeatInterval(),
            });
          } catch (err) {
            this._showToast(String(err && err.message ? err.message : err), true);
          }
          await this._syncRepeat();
        }
        return true;
      }

      // Turning it off: ask, because this loses the setpoint. With nothing
      // running there is nothing to lose, so there is nothing to ask about.
      const ok = !this._repeatActive() || await this._askConfirm({
        title: this._t("Turn the timer off?", "关闭定时下发？"),
        message: this._t(
          "The device drops an MQTT setpoint unless it is refreshed at least "
          + "once a minute. With the timer off, it goes back to controlling "
          + "the charge and discharge power on its own within about 60 seconds.",
          "设备要求至少每分钟刷新一次 MQTT 功率设定值。关闭定时后，约 60 秒内设备会"
          + "丢弃该设定值，恢复为自行控制充放电功率。",
        ),
        confirmText: this._t("Turn it off", "关闭定时"),
        cancelText: this._t("Keep it on", "保持开启"),
      });
      if (!ok) return false;

      this._repeatOn = false;
      try {
        /* Stop it in Home Assistant, not just here: leaving the server job alive
           would keep the device pinned to the setpoint with no way to see it. */
        await this._callService("stop_power_ctrl", {});
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      await this._syncRepeat();
      this.requestUpdate();
      return true;
    }

    _sendOutputPower() {
      const value = Number(this._outputPower);
      if (!Number.isFinite(value)) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      this._runAction({
        title: this._t("Max output", "最大输出"),
        steps: [
          this._t(`Publish ${value} W to the broker`, `向 Broker 下发 ${value} W`),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("number/<dev_id>/output_power/set"), String(value));
          this._busySet(0, "done");
          this._busyDone(this._t(
            `Output ceiling ${value} W sent.`, `最大输出上限 ${value} W 已下发。`,
          ));
        },
      });
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
      const label = `${payload.phase_a} / ${payload.phase_b} / ${payload.phase_c} W`;
      this._runAction({
        title: this._t("Per-phase limit", "分相输出上限"),
        steps: [
          this._t(`Publish ${label} to the broker`, `向 Broker 下发 ${label}`),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(
            this._topic("number/<dev_id>/phase_output_power/set"), payload,
          );
          this._busySet(0, "done");
          this._busyDone(this._t(
            `Phase limits ${label} sent.`, `分相上限 ${label} 已下发。`,
          ));
        },
      });
    }

    _reboot() {
      const ok = window.confirm(this._t(
        "Reboot the device now?", "确认立即重启设备？",
      ));
      if (!ok) return;
      this._runAction({
        title: this._t("Reboot", "重启"),
        steps: [
          this._t("Publish the reboot trigger", "下发重启指令"),
          this._t("Wait for the device to go offline", "等待设备离线"),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("button/<dev_id>/reboot/trigger"), "RESTART");
          this._busySet(0, "done");
          this._busySet(1, "active");
          /* The restart is only visible in the availability topics: the switch
             entity turns unavailable once the firmware is down. Not every
             deployment exposes them, so a missing signal is reported as a note
             rather than as a failure. */
          const wentOffline = await this._waitFor(
            () => !this._state("mqtt_switch", "switch") && !this._state("config", "switch"),
            REBOOT_OFFLINE_TIMEOUT_MS,
          );
          this._busySet(1, "done", wentOffline
            ? this._t("The device went offline", "设备已离线")
            : this._t("No offline signal seen - the restart may still be running",
              "未检测到离线信号，重启可能仍在进行"));
          this._busyDone(this._t(
            "The device is restarting. It is back in about a minute.",
            "设备正在重启，约一分钟后恢复。",
          ));
        },
      });
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const mode = this._emsMode();

      /* Two cards only: the power card, and the EMS card underneath it that
         carries the mode picker plus whatever that mode needs. Diagnostics
         (the MQTT log) is its own card on its own dashboard page. */
      return html`
        <div class="grid">
          ${this._powerCard()}
          ${this._modeCard(mode)}
        </div>
        ${this._busyDialog()}
        ${this._confirmDialog()}
        ${this._toast === "" ? "" : html`
          <div class="toast ${this._toastError ? "err" : ""}">${this._toast}</div>`}
      `;
    }

    /* ------------------------------ cards ------------------------------ */

    /**
     * One card: header (icon + title + optional description + tooltip) and the
     * rows underneath. `rows` may contain empty strings, which are dropped - it
     * keeps the call sites readable when a row is conditional.
     */
    _card({ icon, title, sub, info, rows, wide, cls }) {
      const body = (rows || []).filter((row) => row !== "" && row != null);
      return html`
        <ha-card class="c ${wide ? "wide" : ""} ${cls || ""}">
          <div class="c-head">
            <span class="ci">${icon}</span>
            <span class="ct">${title}${sub ? html`<span class="cs">${sub}</span>` : ""}</span>
            <span class="sp"></span>
            ${info ? html`<span class="info" title=${info}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                   stroke="currentColor" stroke-width="1.9">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 11v5" stroke-linecap="round"/>
                <circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none"/>
              </svg></span>` : ""}
          </div>
          ${body}
        </ha-card>`;
    }

    /**
     * One labelled control. `inline` keeps a small control (a switch, a pair of
     * buttons) on the same line as its label; everything wider - sliders,
     * segmented pickers - gets its own line underneath, which is what keeps the
     * cards readable at a third of the dashboard width.
     */
    _row({ icon, label, sub, subClass, topic, ctrl, inline, bare }) {
      const showTopics = this._config.show_topics === true;
      return html`
        <div class="r ${inline ? "inline" : ""} ${bare ? "bare" : ""}">
          ${bare ? "" : html`
            <div class="r-main">
              <div class="r-label">
                ${icon ? html`<span class="ri">${icon}</span>` : ""}<span>${label}</span>
              </div>
              ${sub ? html`<div class="r-sub ${subClass || ""}">${sub}</div>` : ""}
              ${showTopics && topic ? html`<div class="r-sub"><code>${topic}</code></div>` : ""}
            </div>`}
          ${bare && showTopics && topic
            ? html`<div class="r-sub"><code>${topic}</code></div>` : ""}
          <div class="r-ctrl">${ctrl}</div>
        </div>`;
    }

    /* ------------------------------ power ------------------------------ */

    /**
     * One icon from the set, as an SVG element.
     *
     * Built as a string and injected with `_untrusted()` on purpose: a nested
     * lit template would parse its `<path>` in the HTML namespace and paint
     * nothing at all. The id prefix is per call so two cards on one page never
     * share a gradient id.
     */
    _icon(name, size = 18) {
      const build = ICON_SVG[name] || ICON_SVG.dot;
      const uid = "hmi" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-";
      const body = build(uid);
      /* fill="none" on the root: the shapes that need a fill set it themselves,
         and the stroke-only ones must not inherit the default black. */
      const svg = "<svg viewBox=\"0 0 24 24\" width=\"" + size + "\" height=\""
        + size + "\" fill=\"none\" aria-hidden=\"true\" focusable=\"false\">"
        + body + "</svg>";
      return html`<span class="ic">${this._untrusted(svg)}</span>`;
    }

    /** Power on/off and the reboot command: both take the unit up or down. */
    _powerCard() {
      return this._card({
        icon: this._icon("bolt"),
        title: this._t("Power", "电源"),
        cls: "power",
        rows: [this._switchRow(), this._rebootRow()],
      });
    }

    /**
     * The EMS card: the mode picker plus whatever the active mode needs.
     *
     * The three modes are alternatives, not layers: in `general` the device
     * regulates on its own, `mqtt_ctrl` takes a setpoint from MQTT, and
     * `tou_plan` derives the setpoint from the schedule. Showing all three at
     * once would suggest the device reads them together, which it does not.
     *
     * It is one card on purpose: switching the mode never moves the user to a
     * different part of the page. `mqtt_ctrl` simply makes the card wider and
     * taller (see the `.grow` class), which is where fan / heating controls can
     * be added later without another re-layout.
     */
    _modeCard(mode) {
      const rows = [this._emsRow()];

      if (mode === "mqtt_ctrl") {
        const controls = [];
        if (this._config.show_power_ctrl !== false) controls.push(this._powerCtrlRow());
        controls.push(this._outputRow());
        if (this._config.show_phase !== false) controls.push(this._phaseRow());
        rows.push(html`<div class="sep"></div>`);
        rows.push(html`<div class="r-grid">${controls}</div>`);
      } else if (mode === "tou_plan") {
        rows.push(html`<div class="sep"></div>`);
        /* The plan itself, in the same card. `embedded: true` strips the
           editor's own card chrome, title and heading - all of them are already
           on this card. Read / Send belong to the plan and are rendered by the
           editor itself, directly above the week plan. */
        rows.push(html`
          <div class="tou-host"><hoymiles-tou-editor></hoymiles-tou-editor></div>`);
      } else {
        rows.push(html`<div class="sep"></div>`);
        rows.push(html`<div class="note">${this._t(
          "Self-consumption: the device decides the charge and discharge power on "
          + "its own. Switch the mode to MQTT ctrl to send a setpoint, or to TOU "
          + "plan to follow a schedule.",
          "自发自用：设备自行决定充放电功率。如需下发功率值请切到 MQTT 功率控制，"
          + "如需按时段运行请切到分时计划。",
        )}</div>`);
      }

      return this._card({
        /* A battery icon said "this is the battery" - but the card is not about
           the battery, it is about HOW the device decides the charge and
           discharge power. Three faders say "control scheme". */
        icon: this._icon("faders"),
        title: this._t("EMS mode", "EMS 模式"),
        sub: mode || "",
        cls: `ems ${mode === "mqtt_ctrl" || mode === "tou_plan" ? "grow" : ""}`,
        info: this._t(
          "How the device decides the charge and discharge power. The controls "
          + "below change with the selected mode.",
          "设备如何决定充放电功率。下方控件随所选模式变化。",
        ),
        rows,
      });
    }

    /* --------------------------- dialog render --------------------------- */

    /** The progress dialog; empty string while nothing is running. */
    _busyDialog() {
      const busy = this._busy;
      if (!busy) return "";
      const steps = busy.steps || [];
      const total = steps.length || 1;
      const done = steps.filter((s) => s.state === "done").length;
      const running = steps.some((s) => s.state === "active") ? 0.5 : 0;
      const pct = busy.state === "ok"
        ? 100
        : Math.min(100, Math.round(((done + running) / total) * 100));
      const failed = busy.state === "error";
      const ok = busy.state === "ok";
      return html`
        <div class="overlay" role="dialog" aria-live="polite">
          <div class="modal ${failed ? "err" : ""} ${ok ? "ok" : ""}">
            <div class="m-title">
              ${failed
                ? html`<span style="color:var(--error-color)">✕</span>`
                : ok
                  ? html`<span style="color:var(--success-color, #0da035)">✓</span>`
                  : html`<span class="spin"></span>`}
              <span>${busy.title}</span>
            </div>

            <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>

            <div class="steps">
              ${steps.map((step) => html`
                <div class="st ${step.state}">
                  <span class="mk">${step.state === "done"
                    ? "✓"
                    : step.state === "failed"
                      ? "✕"
                      : step.state === "active"
                        ? html`<span class="spin"></span>`
                        : "○"}</span>
                  <span>${step.text}</span>
                </div>`)}
            </div>

            ${busy.message ? html`<div class="m-msg">${busy.message}</div>` : ""}

            ${failed || ok ? "" : html`<div class="m-foot">
              <span class="r-sub">${this._t("Please wait…", "请稍候…")}</span>
            </div>`}
            ${failed ? html`<div class="m-foot">
              <button class="btn" @click=${() => this._busyClose()}>
                ${this._t("Close", "关闭")}
              </button>
            </div>` : ""}
          </div>
        </div>`;
    }

    /**
     * The yes/no dialog. No progress bar and no spinner: nothing is running,
     * the card is waiting for an answer.
     */
    _confirmDialog() {
      const ask = this._confirm;
      if (!ask) return "";
      return html`
        <div class="overlay" role="dialog" aria-modal="true">
          <div class="modal confirm">
            <div class="m-title"><span>⚠️</span><span>${ask.title}</span></div>
            <div class="m-msg">${ask.message}</div>
            <div class="m-foot">
              <button class="btn" @click=${() => this._answerConfirm(false)}>
                ${ask.cancelText}
              </button>
              <button class="btn danger" @click=${() => this._answerConfirm(true)}>
                ${ask.confirmText}
              </button>
            </div>
          </div>
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

    _switchRow() {
      const view = this._switchView();
      /* This switch is NOT a power cut: `ON` wakes the unit and `OFF` puts it
         into standby (firmware `switch` command). Calling it "Power / On / Off"
         suggested a hard power switch and made "standby" look like a fault, so
         the row now says exactly what it does - sleep - and the two buttons
         name the two states instead of On/Off.

         The icon is an inline SVG rather than `⏻` (U+23FB): that code point is
         missing from most system fonts and rendered as an empty box. */
      const sub = view.pending
        ? this._t(
          view.pending === "on" ? "Waking the device…" : "Putting it to sleep…",
          view.pending === "on" ? "正在唤醒…" : "正在进入休眠…",
        )
        : view.confirmed
          ? this._t(
            view.on ? "Awake ✓" : "Asleep ✓",
            view.on ? "已唤醒 ✓" : "已休眠 ✓",
          )
          : view.on
            ? this._t("Awake - normal operation", "运行中——正常工作")
            : this._t("Asleep - press Awake to resume", "已休眠——点「唤醒」恢复");
      const subClass = view.pending ? "busy" : view.confirmed ? "done" : "";
      return this._row({
        icon: this._icon("moon"),
        inline: true,
        label: this._t("Sleep", "休眠"),
        sub,
        subClass,
        topic: this._topic("switch/<dev_id>/set"),
        ctrl: this._segment(
          [
            { id: "on", label: this._t("Awake", "唤醒"),
              pending: view.pending === "on" },
            { id: "off", label: this._t("Asleep", "休眠"),
              pending: view.pending === "off" },
          ],
          view.on ? "on" : "off",
          (id) => this._setSwitch(id === "on"),
        ),
      });
    }

    _emsRow() {
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
      /* No label and no subtitle: the card header already reads "EMS mode" and
         repeats the active mode right next to it, so a second heading was three
         lines of the same information stacked on top of a picker that says it
         all by itself. */
      return this._row({
        bare: true,
        topic: this._topic("select/<dev_id>/ems_mode/command"),
        ctrl: this._segment(options, current, (id) => this._setEmsMode(id), "fluid"),
      });
    }

    _powerCtrlRow() {
      const ready = this._emsMode() === "mqtt_ctrl";
      const { lo, hi } = this._bounds("power_ctrl", -1000, 1000);
      const nextIn = this._repeatNextIn();
      /* While a job is running the server owns the interval; the draft in the box
         only applies once it has been sent there again. */
      const every = this._repeatActive()
        ? this._repeatState.interval
        : this._repeatInterval();
      /* The sign is the whole point of this row and the protocol never says it:
         positive discharges, negative charges. Without it the slider looks like
         a plain 0 ~ N W control and nobody tries the negative half. */
      const sign = this._t("+ discharge, − charge", "+ 放电，− 充电");
      /* The repeat runs in Home Assistant, so it keeps going when the EMS mode is
         switched away (the device then ignores the commands). The row must not
         invite edits that do nothing, so the switch and the interval follow
         `ready` too. */
      const sub = !ready
        ? this._t("switch EMS to mqtt_ctrl first", "需先切到 mqtt_ctrl")
        : !this._repeatOn
          ? this._t(
            `${lo} ~ ${hi} W · ${sign} · timer off: the device reverts to its own `
            + "control about a minute after the last send",
            `${lo} ~ ${hi} W · ${sign} · 定时已关闭：最后一次下发约一分钟后，设备恢复自行控制`,
          )
          : nextIn == null
            ? this._t(
              `${lo} ~ ${hi} W · ${sign} · press Send to start the ${every} s re-send`,
              `${lo} ~ ${hi} W · ${sign} · 点「下发」后开始每 ${every} s 重发`,
            )
            : this._t(
              `${lo} ~ ${hi} W · ${sign} · re-sent every ${every} s by Home `
              + `Assistant, next in ${nextIn} s`,
              `${lo} ~ ${hi} W · ${sign} · 由 Home Assistant 每 ${every} s 重发，`
              + `${nextIn} s 后发送`,
            );
      return this._row({
        icon: this._icon("target"),
        label: this._t("Target power", "目标功率"),
        sub,
        subClass: this._repeatActive() ? "live" : "",
        topic: this._topic("number/<dev_id>/power_ctrl/set"),
        ctrl: html`
          ${this._slider({
            value: this._powerCtrl,
            min: lo,
            max: hi,
            step: 0.1,
            unit: "W",
            disabled: !ready,
            sendLabel: this._t("Send", "下发"),
            onInput: (v) => { this._powerCtrl = v; },
            onSend: () => this._sendPowerCtrl(),
          })}
          <div class="repeat-row ${this._repeatActive() ? "on" : ""}">
            <span class="repeat-ico">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="2.2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/>
                <path d="M20.5 3.5v4.2h-4.2"/>
              </svg>
            </span>
            <span class="cap">${this._t("Every", "每隔")}</span>
            <input type="number" min=${REPEAT_MIN_S} max=${REPEAT_MAX_S} step="1"
              .value=${this._repeatEvery}
              ?disabled=${!ready || !this._repeatOn}
              @change=${(e) => {
                this._repeatEvery = e.target.value;
                this._applyRepeatInterval();
              }} />
            <span class="cap">${this._t("s", "秒")}</span>
            <span class="spacer"></span>
            <ha-switch .checked=${this._repeatOn} ?disabled=${!ready}
              @change=${(e) => this._onRepeatSwitch(e)}></ha-switch>
          </div>`,
      });
    }

    /**
     * The switch is bound one way, so a declined question has to be undone by
     * hand: Lit only writes `checked` when the property changed, and here the
     * model never moved (it stayed on).
     */
    async _onRepeatSwitch(event) {
      const knob = event.currentTarget;
      const wanted = knob.checked === true;
      const applied = await this._setRepeat(wanted);
      if (!applied) knob.checked = this._repeatOn;
    }

    _outputRow() {
      const { lo, hi } = this._bounds("output_power", 100, 2000);
      return this._row({
        icon: this._icon("ceiling"),
        label: this._t("Max output", "最大输出"),
        sub: this._t(
          `Ceiling ${lo} ~ ${hi} W. It caps the output, it does not change the power now.`,
          `上限 ${lo} ~ ${hi} W。只改上限，不影响当前功率。`,
        ),
        topic: this._topic("number/<dev_id>/output_power/set"),
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

    _phaseRow() {
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
      return this._row({
        icon: this._icon("phaseLimit"),
        label: this._t("Per-phase limit", "分相输出上限"),
        sub: this._t(
          `${lo} ~ ${hi} W per phase (A / B / C), sent as {phase_a, phase_b, phase_c}.`,
          `每相 ${lo} ~ ${hi} W（A / B / C），按 {phase_a, phase_b, phase_c} 下发。`,
        ),
        topic: this._topic("number/<dev_id>/phase_output_power/set"),
        ctrl: html`
          <div class="phase-rows">${row("a", "A")}${row("b", "B")}${row("c", "C")}</div>
          <div class="slider end">
            <button class="btn primary"
              @click=${() => this._sendPhase()}>${this._t("Send all", "全部下发")}</button>
          </div>`,
      });
    }

    _rebootRow() {
      return this._row({
        icon: this._icon("reboot"),
        inline: true,
        label: this._t("Reboot", "重启设备"),
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
