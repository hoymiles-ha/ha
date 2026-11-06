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
 *   language: en                 # optional (en|zh|de); omit to follow Home Assistant
 *   ems_entity / status_entity / day_ack_entity / week_ack_entity  # optional
 * ========================================================================== */

/*
 * `litElement` is supplied by `window.__hmWhenLit(cb)` when the bootstrap
 * bundle is present. Reading the base class from `ha-panel-lovelace`
 * unconditionally threw `Object.getPrototypeOf(undefined)` on pages that do not
 * define that element (for example a `panel_custom` sidebar page), which
 * aborted registration and left the editor undefined.
 */
function _hmTouRegister(litElement) {
  let LitElement = litElement || null;
  if (!LitElement) {
    const base = customElements.get("ha-panel-lovelace");
    if (!base) return false;
    LitElement = Object.getPrototypeOf(base);
  }
  if (!LitElement || !LitElement.prototype || !LitElement.prototype.html) return false;
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
    "unsaved changes": "ungespeicherte Änderungen",
    "Loaded from the device": "Vom Gerät geladen",
    "Partly loaded": "Teilweise geladen",
    "Not read from the device yet": "Noch nicht vom Gerät gelesen",
    "Device has no plan yet": "Noch kein Plan am Gerät",
    "New plan - replaces the device's": "Neuer Plan – ersetzt den des Geräts",
    "refused": "abgelehnt",
    "Cannot read the plan": "Plan kann nicht gelesen werden",
    "rejects the read in any other mode.": "lehnt das Lesen in jedem anderen Modus ab.",
    "Reading TOU plan": "TOU-Plan wird gelesen",
    "not configured": "nicht konfiguriert",
    "that EMS is in tou_plan, then try again.": "dass das EMS im Modus tou_plan ist, und versuche es erneut.",
    "Switching to tou_plan": "Wechsel zu tou_plan",
    "Switch EMS mode": "EMS-Modus wechseln",
    "The EMS mode did not change. Check that the device is online.": "Der EMS-Modus hat sich nicht geändert. Prüfe, ob das Gerät online ist.",
    "letting the device apply it...": "das Gerät übernimmt sie...",
    "segments": "Segmente",
    "more than 12 segments": "mehr als 12 Segmente",
    "start/end is not a valid time": "Start/Ende ist keine gültige Zeit",
    "start/end outside 00:00-24:00": "Start/Ende außerhalb 00:00–24:00",
    "sh% must be 10-100 for a charging segment": "sh% muss bei einem Ladesegment 10–100 sein",
    "sl% must be 10-100 for a discharging segment": "sl% muss bei einem Entladesegment 10–100 sein",
    "pc must not be negative": "pc darf nicht negativ sein",
    "pd must not be negative": "pd darf nicht negativ sein",
    "Cannot save": "Speichern nicht möglich",
    "nothing was sent - fix these rows first:": "es wurde nichts gesendet – korrigiere zuerst diese Zeilen:",
    "Nothing was sent.": "Es wurde nichts gesendet.",
    "Pick a weekday above and press Add segment. Nothing was sent.": "Wähle oben einen Wochentag und drücke Segment hinzufügen. Es wurde nichts gesendet.",
    "Saving TOU plan": "TOU-Plan wird gespeichert",
    "Check the plan": "Plan prüfen",
    "Switch EMS to tou_plan": "EMS auf tou_plan stellen",
    "Send the week plan": "Wochenplan senden",
    "Verify the device holds the plan": "Prüfen, ob das Gerät den Plan übernommen hat",
    "waiting for the device...": "warte auf das Gerät...",
    "The EMS mode did not switch to tou_plan, so nothing was sent.": "Der EMS-Modus wurde nicht auf tou_plan umgestellt, daher wurde nichts gesendet.",
    "reading back all 7 weekdays, this takes a few seconds each...": "alle 7 Wochentage werden zurückgelesen, das dauert je ein paar Sekunden...",
    "Saved and verified - the device holds exactly this plan.": "Gespeichert und geprüft – das Gerät hat genau diesen Plan.",
    "Read-only: EMS mode is ": "Nur Lesen: EMS-Modus ist ",
    ", not tou_plan.": ", nicht tou_plan.",
    "Switch to tou_plan": "Auf tou_plan umstellen",
    "TOU plan": "TOU-Plan",
    "How the weekly schedule is set up": "So wird der Wochenplan eingestellt",
    "which is why they are drawn in the same colour.": "deshalb werden sie in derselben Farbe gezeichnet.",
    "segments can be added after it.": "Segmente lassen sich danach ergänzen.",
    "Discard & read": "Verwerfen & lesen",
    "Read": "Lesen",
    "Send": "Senden",
    "the device keeps whatever plan it already had.": "das Gerät behält den bisherigen Plan.",
    "it is NOT necessarily empty. Press \"Read\" and compare before sending.": "er ist NICHT zwangsläufig leer. Drücke „Lesen“ und vergleiche vor dem Senden.",
    "edit it, then press \"Send\".": "bearbeite ihn und drücke dann „Senden“.",
    "WEEKLY SCHEDULE": "WOCHENPLAN",
    "today": "heute",
    "nothing planned yet": "noch nichts geplant",
    "These weekdays have exactly the same segments, so the device stores one plan for all of them": "Diese Wochentage haben genau dieselben Segmente, das Gerät speichert einen Plan für alle",
    "shared with ": "geteilt mit ",
    "Copy from": "Kopieren von",
    "Fill this empty weekday with a copy of another day": "Diesen leeren Wochentag mit der Kopie eines anderen Tages füllen",
    "pick a weekday": "Wochentag wählen",
    "Force charge": "Zwangs laden",
    "PV charge": "PV-Laden",
    "Discharge": "Entladen",
    "Each row: ": "Jede Zeile: ",
    "charge to": "laden bis",
    "discharge to": "entladen bis",
    "is the battery level to stop at, ": "ist der Batteriestand zum Stoppen, ",
    "is the power limit.": "ist die Leistungsgrenze.",
    "Mode of this segment": "Modus dieses Segments",
    "Start": "Start",
    "End": "Ende",
    "Charge until the battery reaches this state of charge.": "Laden, bis die Batterie diesen Ladezustand erreicht.",
    "Charge to": "Laden bis",
    "Charging power for this segment.": "Ladeleistung für dieses Segment.",
    "Charge W": "Laden W",
    "Discharge until the battery reaches this state of charge.": "Entladen, bis die Batterie diesen Ladezustand erreicht.",
    "Discharge to": "Entladen bis",
    "Discharging power for this segment.": "Entladeleistung für dieses Segment.",
    "Discharge W": "Entladen W",
    "Remove this segment": "Dieses Segment entfernen",
    "This day already runs to 24:00": "Dieser Tag reicht bereits bis 24:00",
    "+ Add segment": "+ Segment hinzufügen",
    "working...": "läuft...",
    "Close": "Schließen",
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
   *     en: TOU plan
   *     zh: 分时计划
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

  const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WEEK_ZH = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };

  /* One colour per day plan, used as an identity and never as a meaning: the
     week tile, its pill and its segment cards all carry it, so "Wed runs day3"
     is readable at a glance. Charge / discharge keep their own colours on the
     timeline, which is where colour does mean something.
     Chosen to stay distinguishable next to each other and legible with white
     text on top (the active pill fills with the colour). */
  const DAY_COLORS = [
    "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b",
    "#10b981", "#06b6d4", "#f43f5e", "#65a30d",
  ];

  const MODE_LABEL = {
    1: { en: "Force charge", zh: "强制充电" },
    2: { en: "PV charge", zh: "光伏充电" },
    4: { en: "Discharge", zh: "放电" },
  };
  const TS_MAX = 96;

  /* Device ack codes (const.py TOU_DAY_ACK_STATUS / TOU_WEEK_ACK_STATUS). The
     card used to print the raw state ("9 - ts greater than te"), which says
     what broke but not what to change. */
  const DAY_ACK_TEXT = {
    0: { en: "success", zh: "成功" },
    1: { en: "general error", zh: "通用错误" },
    2: { en: "too many segments (max 12)", zh: "时段过多（最多 12 段）" },
    3: { en: "time ranges overlap", zh: "时间段重叠" },
    4: { en: "mode out of range", zh: "模式超出范围" },
    5: { en: "start/end out of range", zh: "开始/结束时间超出范围" },
    6: { en: "sh%/sl% out of range", zh: "sh%/sl% 超出范围" },
    7: { en: "pc/pd out of range", zh: "pc/pd 超出范围" },
    8: { en: "day_idx out of range", zh: "day_idx 超出范围" },
    9: { en: "end must be later than start", zh: "结束时间必须晚于开始时间" },
    10: { en: "EMS is not in tou_plan mode", zh: "EMS 不在 tou_plan 模式" },
  };
  const WEEK_ACK_TEXT = {
    0: { en: "success", zh: "成功" },
    1: { en: "general error", zh: "通用错误" },
    2: { en: "weekday name invalid", zh: "星期名称无效" },
    3: { en: "a weekday is mapped twice", zh: "同一个星期被重复映射" },
    4: { en: "day_idx out of range", zh: "day_idx 超出范围" },
    5: { en: "the mapped day plan is empty", zh: "映射到的日计划是空的" },
    6: { en: "EMS is not in tou_plan mode", zh: "EMS 不在 tou_plan 模式" },
  };

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  /**
   * One quarter-hour slot as a time label.
   *
   * Slot 96 is "24:00", deliberately not "00:00": the end of a day and its
   * start are different instants, and spelling the end as 00:00 is exactly what
   * made a saved plan look broken (stored te=96, read back as 00:00, saved
   * again as te=0, which the firmware rejects with ack 9).
   *
   * Times are picked from a `<select>` rather than `<input type="time">`
   * precisely so that 24:00 can be shown at all - the native control stops at
   * 23:59 and cannot represent it.
   */
  function slotToLabel(slot) {
    const s = Math.max(0, Math.min(TS_MAX, Number(slot) || 0));
    if (s === TS_MAX) return "24:00";
    const m = s * 15;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  /** A fresh segment: charge to 100 %, discharge to 10 %, 1000 W both ways. */
  function newSegment(ts, te) {
    return { mode: 1, ts, te, sh: 100, sl: 10, pc: 1000, pd: 1000 };
  }

  class HoymilesTouEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object }, _log: { type: Array } };
    }

    static getConfigElement() {
      return document.createElement("hoymiles-tou-editor-editor");
    }

    static getStubConfig() {
      return { dev_id: "MSA-280520260806" };
    }

    /**
     * Read / Send can also be triggered from `<hoymiles-control>`: the control
     * page keeps a single action bar, and the editor further down the view is
     * where the plan is edited. A window event keeps the two cards decoupled -
     * either one works on its own, and a card for another device ignores it.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
      this._touActionHandler = (ev) => {
        const detail = (ev && ev.detail) || {};
        if (detail.dev_id && detail.dev_id !== this._dev()) return;
        if (detail.action === "read") this._loadWeek(this._confirmDiscard);
        else if (detail.action === "send") this._saveAll();
      };
      window.addEventListener("hoymiles-tou-action", this._touActionHandler);
    }

    disconnectedCallback() {
      if (this._onLangChange) {
        window.removeEventListener(LANG_EVENT, this._onLangChange);
      }
      super.disconnectedCallback();
      if (this._touActionHandler) {
        window.removeEventListener("hoymiles-tou-action", this._touActionHandler);
        this._touActionHandler = null;
      }
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
        /* Section labels match the control card's card headers. */
        .group-title { display: flex; align-items: center; gap: 8px;
                       font-size: 11.5px; font-weight: 700; letter-spacing: .05em;
                       text-transform: uppercase;
                       color: var(--secondary-text-color);
                       padding: 0 2px 7px; margin-top: 4px; }
        .group-title .sp { flex: 1 1 auto; }
        .group-title .chip { font-size: 11.5px; font-weight: 500; letter-spacing: 0;
                             text-transform: none;
                             color: var(--primary-color); }

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
        /* Add segment greys out once the day is already planned to 24:00. */
        .btn:disabled { opacity: .42; cursor: not-allowed; }
        .btn:disabled:active { filter: none; }

        .log { max-height: 140px; overflow-y: auto; font-size: 12px;
               white-space: pre-wrap; padding: 10px 14px; border-radius: 14px;
               background: var(--secondary-background-color, rgba(120,120,128,.08)); }
        .err { color: var(--error-color); } .ok { color: var(--success-color); }

        /* ---------------------------- progress dialog ---------------------------- */
        /* Fixed to the viewport so it covers the whole dashboard: the work it
           reports on can take a minute, and a half-covered dialog invites the
           user to poke the tables underneath while a save is in flight. */
        .overlay { position: fixed; inset: 0; z-index: 9999;
                   display: flex; align-items: center; justify-content: center;
                   padding: 20px; box-sizing: border-box;
                   background: rgba(20, 22, 26, .46);
                   -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
        .modal { width: min(420px, 100%); box-sizing: border-box;
                 padding: 22px 22px 18px; border-radius: 18px;
                 background: var(--card-background-color, #fff);
                 color: var(--primary-text-color);
                 box-shadow: 0 18px 48px rgba(0, 0, 0, .34);
                 animation: pop .18s ease-out; }
        @keyframes pop { from { transform: scale(.96); opacity: 0; }
                         to { transform: scale(1); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .modal, .spinner { animation: none !important; }
        }

        .modal-title { font-size: 16px; font-weight: 600; margin-bottom: 14px; }
        .modal-row { display: flex; align-items: center; gap: 13px;
                     margin-bottom: 14px; min-height: 34px; }
        .modal-msg { flex: 1 1 auto; font-size: 13.5px; line-height: 1.45;
                     color: var(--secondary-text-color); }

        .spinner { width: 26px; height: 26px; flex: 0 0 auto;
                   border-radius: 50%;
                   border: 2.6px solid var(--divider-color, rgba(120,120,128,.3));
                   border-top-color: var(--primary-color);
                   animation: spin .85s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .mark { width: 26px; height: 26px; flex: 0 0 auto; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 15px; font-weight: 700; color: #fff; }
        .mark.ok { background: var(--success-color, #22c55e); }
        .mark.err { background: var(--error-color, #db4437); }

        .pbar { height: 6px; border-radius: 3px; overflow: hidden;
                background: var(--divider-color, rgba(120,120,128,.22));
                margin-bottom: 14px; }
        .pfill { height: 100%; border-radius: 3px; width: 0;
                 background: var(--primary-color);
                 transition: width .28s ease; }
        .pfill.ok { background: var(--success-color, #22c55e); }
        .pfill.error { background: var(--error-color, #db4437); }

        .steps { list-style: none; margin: 0 0 4px; padding: 0;
                 max-height: 210px; overflow-y: auto;
                 font-size: 12.5px; line-height: 1.5; }
        .steps li { display: flex; gap: 9px; padding: 3px 0;
                    color: var(--disabled-text-color, #9aa0a6); }
        .steps li.active { color: var(--primary-text-color); font-weight: 500; }
        .steps li.done { color: var(--secondary-text-color); }
        .steps li.failed { color: var(--error-color); font-weight: 600; }
        .steps .dot { flex: 0 0 14px; text-align: center; font-weight: 700; }
        .steps li.done .dot { color: var(--success-color, #22c55e); }
        .steps li.active .dot { color: var(--primary-color); }
        .steps li.failed .dot { color: var(--error-color); }

        .modal-foot { display: flex; justify-content: flex-end; margin-top: 14px; }

        /* Explains the two level model: day plans are reusable templates, the
           week plan is what actually schedules them. Without this line the
           empty week table reads as "already configured". */
        .hint { font-size: 12.5px; line-height: 1.5; padding: 0 2px 12px;
                color: var(--secondary-text-color); }
        .warn { font-size: 12.5px; line-height: 1.5; padding: 9px 12px;
                border-radius: 10px; margin-bottom: 12px;
                color: var(--error-color);
                background: rgba(var(--rgb-error-color, 219, 68, 55), .10); }
        /* The same box carries two different things: a warning (red, above) and
           a fact worth knowing (blue, here). It is text only - the buttons the
           user needs are already in the action bar above, and repeating them
           down here turned a hint into a second toolbar. */
        .warn.info { color: var(--primary-text-color);
                     background: rgba(var(--rgb-primary-color, 3, 169, 244), .10); }
        .empty { font-size: 13px; color: var(--secondary-text-color);
                 padding: 16px 12px; text-align: center; }

        /* ================================================================== *
         * Layout rework
         *
         * The old editor stacked a long explanation, a seven-row week table and
         * an eight-column day table in one column. On a dashboard card - often
         * a third of the screen - the tables scrolled sideways and the number
         * inputs were a few pixels wide. The structure below gives the time
         * range its own row, the four numbers a second row, and folds the
         * explanation into a summary the user opens only when they need it.
         * ================================================================== */

        /* read / send, the two actions that talk to the device.
         *
         * They used to sit under an explanatory subtitle, which made the pair
         * look like a titled feature of the control card. They belong to the
         * plan, so they sit at the top of the plan: one line, the state on the
         * left and the two buttons on the right. */
        .acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
                margin-bottom: 14px; padding-bottom: 12px;
                border-bottom: 1px solid var(--divider-color); }
        .acts .sp { flex: 1 1 auto; }
        .acts .astat { font-size: 12px; font-weight: 500;
                       color: var(--secondary-text-color); }
        .acts .astat.dirty { font-weight: 700;
                             color: var(--warning-color, #f59e0b); }

        /* ================================================================== *
         * Weekday picker
         *
         * The card used to show two levels at once: a seven row week table and
         * an eight pill day-plan row. That is the shape of the device's storage,
         * not the shape of the user's question - which is "what should Tuesday
         * do". So the weekday is the tab, and the day plan it runs is a single
         * dropdown on the line underneath, shown only for the weekday in view.
         *
         * The dot on each tab carries the colour of the plan behind it, so two
         * weekdays sharing a plan already look the same before any click.
         * ================================================================== */
        .wday { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
        .wday .wd { display: inline-flex; align-items: center; gap: 7px;
                    padding: 7px 14px; border: none; border-radius: 999px;
                    cursor: pointer; font: inherit; font-size: 13px;
                    font-weight: 600; white-space: nowrap;
                    background: var(--secondary-background-color, rgba(120,120,128,.10));
                    color: var(--primary-text-color);
                    transition: background .15s, color .15s, box-shadow .15s; }
        .wday .wd .d { flex: 0 0 8px; width: 8px; height: 8px;
                       border-radius: 50%;
                       background: var(--dc, var(--divider-color)); }
        /* An empty weekday stays clickable but reads as inactive: its dot is a
           hollow ring instead of a filled one. */
        .wday .wd.blank { color: var(--secondary-text-color); }
        .wday .wd.blank .d { background: transparent;
                             box-shadow: inset 0 0 0 2px var(--dc, var(--divider-color));
                             opacity: .55; }
        .wday .wd.blank.on { color: #fff; }
        .wday .wd.blank.on .d { background: #fff; box-shadow: none; opacity: .8; }
        .wday .wd .td { margin-left: 2px;
                        font-size: 9.5px; font-weight: 700; letter-spacing: .04em;
                        text-transform: uppercase; opacity: .65; }
        .wday .wd:hover { background: var(--dc, var(--primary-color)); color: #fff; }
        .wday .wd:hover .d { background: #fff; }
        .wday .wd.on { background: var(--dc, var(--primary-color)); color: #fff;
                       box-shadow: 0 4px 12px -3px var(--dc, var(--primary-color)); }
        .wday .wd.on .d { background: #fff; }

        /* "Tuesday runs [day3]  also runs on Thu, Sat" */
        .assign { display: flex; flex-wrap: wrap; align-items: center;
                  gap: 4px 7px; margin: 0 0 12px; font-size: 12.5px;
                  color: var(--secondary-text-color); }
        .assign .al { font-weight: 700; color: var(--primary-text-color); }
        .assign select { width: auto; min-width: 0; padding: 3px 8px;
                         border: 1px solid var(--divider-color);
                         border-radius: 8px;
                         background: var(--card-background-color, #fff);
                         font-size: 12.5px; font-weight: 600;
                         color: var(--primary-text-color); }
        .assign .sp { flex: 1 1 auto; }
        /* "shared with Tue, Fri" - the weekday colours already show it, this
           says it in words for the case where an edit is about to affect more
           than the day on screen. */
        .assign .share { font-size: 11.5px; padding: 1px 8px;
                         border-radius: 999px;
                         color: var(--secondary-text-color);
                         background: var(--secondary-background-color, rgba(120,120,128,.14)); }
        /* "Copy from [Mon]" - the only cross-weekday action in the card, so it
           sits quietly at the far right rather than beside the tab row. */
        .assign select.copy { min-width: 118px; margin-left: 2px; }

        .hd { display: none; }

        /* Colour key for the three modes, plus the one sentence that explains
           what the four numbers want. Without them the coloured bars and the
           boxes below are decoration with no meaning attached. */
        .legend { display: flex; flex-wrap: wrap; align-items: center;
                  gap: 4px 13px; margin: 0 0 10px; font-size: 11.5px;
                  color: var(--secondary-text-color); }
        .legend .lg { display: inline-flex; align-items: center; gap: 5px;
                      white-space: nowrap; }
        .legend .sw { width: 9px; height: 9px; border-radius: 3px; }
        .legend .sw.m1 { background: #ea580c; }
        .legend .sw.m2 { background: #16a34a; }
        .legend .sw.m4 { background: #2563eb; }
        .legend .sp { flex: 1 1 auto; }
        .legend .how { white-space: normal; }
        .legend .how b { font-weight: 700;
                         color: var(--primary-text-color); }

        /* ================================================================== *
         * The 24 h shape of the selected day
         *
         * A day plan is a shape as much as it is a list: the bar shows where the
         * charges and discharges sit. Gaps are drawn too - they are legal, and
         * they are exactly the part a table cannot show.
         * ================================================================== */
        .tl { display: flex; gap: 3px; height: 32px; }
        .tl .blk { min-width: 3px; border-radius: 8px;
                   display: flex; align-items: center; justify-content: center;
                   overflow: hidden; white-space: nowrap;
                   font-size: 11px; font-weight: 700; letter-spacing: .01em;
                   color: #fff; }
        .tl .blk.gap { background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        /* One colour per mode, everywhere: orange = force charge, green = PV
           charge, blue = discharge. Orange and blue sit at opposite ends of the
           hue circle, so "grid vs battery" is readable without reading text. */
        .tl .blk.m1 { background: linear-gradient(180deg, #fb923c, #ea580c); }
        .tl .blk.m2 { background: linear-gradient(180deg, #4ade80, #16a34a); }
        .tl .blk.m4 { background: linear-gradient(180deg, #60a5fa, #2563eb); }
        .tl-axis { display: flex; justify-content: space-between;
                   margin: 4px 1px 16px; font-size: 10px;
                   font-variant-numeric: tabular-nums;
                   color: var(--secondary-text-color); }

        /* ================================================================== *
         * One time segment = one row
         *
         * A day plan is a list, so it is drawn as a list. Repeating a two-row
         * card for every segment pushed the third segment below the fold and
         * made eight numbers look like eight unrelated settings; on one line a
         * plan reads like a schedule: when, how long, and at what limits.
         * The mode text and the left edge carry the mode colour, the rest stays
         * neutral so a long plan does not turn into a colour chart.
         * ================================================================== */
        .segs { display: flex; flex-direction: column; gap: 6px; }
        .seg-row { display: flex; flex-wrap: wrap; align-items: center;
                   gap: 4px 8px; padding: 5px 8px 5px 12px;
                   border-radius: 11px;
                   background: var(--secondary-background-color, rgba(120,120,128,.07));
                   box-shadow: inset 3px 0 0 var(--mc, var(--divider-color));
                   transition: box-shadow .15s; }
        .seg-row:hover { box-shadow: inset 3px 0 0 var(--mc, var(--divider-color)),
                                    0 1px 3px rgba(0, 0, 0, .08); }
        /* One select style for the whole row: no boxes, so the row reads as
           text until the pointer is on it. */
        .seg-row select { border: none; background: transparent;
                          border-radius: 8px; font-size: 13px; padding: 5px 6px;
                          color: var(--primary-text-color); }
        .seg-row select:hover { background: var(--card-background-color, rgba(255,255,255,.65)); }
        .seg-row select:focus { border-color: transparent;
                                outline: 2px solid var(--mc, var(--primary-color));
                                outline-offset: -1px; }
        .seg-row .smode { flex: 0 0 126px; width: 126px; font-weight: 700;
                          font-size: 13.5px;
                          color: var(--mc, var(--primary-text-color)); }
        /* start - end live in one tinted capsule: they are one answer. */
        .seg-row .stime { flex: 0 0 auto; display: inline-flex; align-items: center;
                          gap: 0; padding: 0 1px; border-radius: 9px;
                          background: var(--card-background-color, rgba(255,255,255,.6)); }
        .seg-row .stime select { width: 71px; padding: 5px 4px;
                                 text-align: center;
                                 font-size: 12.5px; font-weight: 600;
                                 font-variant-numeric: tabular-nums; }
        .seg-row .stime .dash { font-size: 11px; padding: 0 1px;
                                color: var(--secondary-text-color); }
        .seg-row .slen { flex: 0 0 auto; min-width: 40px;
                         font-size: 11.5px; font-weight: 700;
                         font-variant-numeric: tabular-nums;
                         white-space: nowrap;
                         color: var(--secondary-text-color); }
        /* The four limits, each with its own caption. The caption is what tells
           the user whether 100 means "100 %" or "100 W" and whether it belongs
           to charging or discharging - without it four equal boxes are
           indistinguishable. The caption sits above its box so the row is still
           one row per segment. */
        .seg-row .slim { flex: 0 1 auto; margin-left: auto;
                         display: flex; align-items: flex-end; gap: 9px; }
        .seg-row .nfl { display: flex; flex-direction: column; gap: 2px;
                        min-width: 0; }
        .seg-row .nfl > .cap { font-size: 9px; font-weight: 700;
                               letter-spacing: .05em; text-transform: uppercase;
                               white-space: nowrap;
                               color: var(--secondary-text-color); }
        .seg-row .nfl.ch > .cap { color: #c2410c; }
        .seg-row .nfl.dis > .cap { color: #1d4ed8; }
        .seg-row .nf { display: inline-flex; align-items: center;
                       border-radius: 8px; padding-right: 6px;
                       border: 1px solid var(--divider-color, rgba(120,120,128,.28));
                       background: var(--card-background-color, #fff); }
        .seg-row .nf:focus-within { border-color: var(--mc, var(--primary-color));
                                    box-shadow: 0 0 0 2px var(--mc, var(--primary-color)); }
        /* Wide enough for four digits: 40 px clipped "1000" into "10(", which
           is how a perfectly valid number looked like a typo. */
        .seg-row .nf input { width: 56px; padding: 5px 0 5px 7px;
                             border: none; background: transparent;
                             font-size: 13px; font-weight: 700;
                             text-align: right; outline: none;
                             font-variant-numeric: tabular-nums; }
        .seg-row .nf input:focus { outline: none; }
        .seg-row .nf b { font-size: 10px; font-weight: 700; padding-left: 2px;
                         color: var(--secondary-text-color); }
        @media (max-width: 700px) {
          .seg-row .slim { margin-left: 0; }
        }
        .icon-btn { flex: 0 0 auto; width: 26px; height: 26px; border: none;
                    border-radius: 8px; cursor: pointer; font-size: 12px;
                    line-height: 1; background: none;
                    color: var(--secondary-text-color); }
        .icon-btn:hover { color: var(--error-color);
                          background: rgba(219, 68, 55, .12); }
        .segs .empty { border-radius: 12px;
                       background: var(--secondary-background-color, rgba(120,120,128,.06)); }

        /* folded explanation */
        .help { margin-bottom: 14px; border-radius: 12px;
                background: var(--secondary-background-color, rgba(120,120,128,.06)); }
        .help > summary { cursor: pointer; font-size: 12.5px; font-weight: 500;
                          padding: 10px 13px; color: var(--secondary-text-color);
                          list-style: none; }
        .help > summary::-webkit-details-marker { display: none; }
        .help > summary::before { content: "? "; font-weight: 700; }
        .help[open] > summary { color: var(--primary-text-color); }
        .help .help-body { font-size: 12.5px; line-height: 1.55;
                           padding: 0 13px 12px;
                           color: var(--secondary-text-color); }
        .help .help-body p { margin: 0 0 8px; }
        .help .help-body p:last-child { margin-bottom: 0; }

        /* ===================== embedded in the control card ===================== */
        /* No card chrome, no second title, no second Read/Send bar: the host
           card renders all three already, and having two of each is exactly
           what made the plan look like a page bolted onto the control page. */
        .emb { padding-top: 2px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-tou-editor: 'dev_id' is required");
      }
      this._config = { ...config };
      this._resetDraft();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._draft) this._resetDraft();
      this.requestUpdate();
      /* Reading is an explicit action now.
       *
       * This used to fire `_loadWeek()` about a second after the card appeared
       * whenever the EMS mode was already `tou_plan`. Two things were wrong
       * with that: merely switching the mode on the control card started a
       * read the user did not ask for, and a read replaces the whole draft, so
       * any unsaved edit vanished while the user was still looking at another
       * card. The plan is loaded when "Read" is pressed and at no other time.
       *
       * `_weekState` still starts at "idle" and is explained in the UI as
       * "not read yet", which is the truth - it is not "nothing configured". */
    }

    _resetDraft() {
      /* `curWd` is the weekday being edited. `days` is keyed by weekday slot
         (1 = Monday ... 7 = Sunday) and is the only source of truth; the
         device's day plan numbers are derived by `_packDays()`. Keeping no
         `week` array here is deliberate - one copy of the truth cannot go out
         of step with itself. */
      this._draft = {
        curWd: (new Date().getDay() + 6) % 7, // Monday = 0, today by default
        days: {},
      };
      /* Every weekday starts empty. Seeding a template segment used to write
         "force charge 1000 W" into the plan on the first save, which the user
         never asked for - and clicking a tab to look at a day created one too.
         An empty schedule with an explicit "+ Add segment" button is honest. */
      for (let i = 1; i <= 7; i += 1) this._draft.days[i] = [];
      if (!this._log) this._log = [];
      this._weekAutoTried = false;
      this._weekState = "idle";
      this._dirty = false;
      this._confirmDiscard = false;
      /* Set when the user deliberately chooses to write a plan without reading
         the device first. It is not a small thing - it replaces whatever the
         device holds - so it is always an explicit press, never a default. */
      this._fromScratch = false;
    }

    /** Select the weekday whose schedule is on screen. */
    _selectWeekday(idx) {
      this._draft = { ...this._draft, curWd: idx };
      this.requestUpdate();
    }

    /**
     * One weekday's slot inside `_draft.days`.
     *
     * The draft is stored per weekday, not per day plan: "what should Wednesday
     * do" is the question the editor answers, and the device's day1..day8 are
     * derived from it by `_packDays()`. Keeping the draft weekday-shaped means
     * two weekdays that happen to be identical cannot drift apart, and it is
     * what makes the shared-plan detection automatic.
     */
    _curPlan() {
      return (Number(this._draft && this._draft.curWd) || 0) + 1;
    }

    /** Two schedules are the same plan when every field of every segment matches. */
    _samePlan(a, b) {
      if (a === b) return true;
      if (!a || !b || a.length !== b.length) return false;
      return a.every((s, i) => (
        Number(s.mode) === Number(b[i].mode)
        && Number(s.ts) === Number(b[i].ts)
        && Number(s.te) === Number(b[i].te)
        && Number(s.sh) === Number(b[i].sh)
        && Number(s.sl) === Number(b[i].sl)
        && Number(s.pc) === Number(b[i].pc)
        && Number(s.pd) === Number(b[i].pd)
      ));
    }

    /**
     * Pack the weekday schedules into the device's day plans.
     *
     * The device stores eight reusable plans and a week plan that points each
     * weekday at one of them. Users think in weekdays, so this is where the two
     * worlds meet:
     *
     *   - weekdays with an identical schedule share one day plan;
     *   - the first weekday (Monday first) with a new schedule takes the next
     *     free day number, in reading order: day1, day2, ...
     *   - a weekday with no segments is unmapped (0), which is also what stops
     *     the device rejecting a plan that points at an empty day.
     *
     * Packing rather than storing means the sharing cannot go stale: edit
     * Wednesday until it matches Monday and both collapse onto the same plan;
     * change one segment and it splits off again. Nothing to keep in sync.
     *
     * Returns `{ week, plans }` where `week[wd]` is the day number and
     * `plans` is `[{ idx, wds, segments }]` in day order.
     */
    _packDays(days) {
      const src = days || (this._draft && this._draft.days) || {};
      const week = Array(7).fill(0);
      const plans = [];
      for (let wd = 0; wd < 7; wd += 1) {
        const segments = src[wd + 1] || [];
        if (!segments.length) continue;
        const hit = plans.find((plan) => this._samePlan(plan.segments, segments));
        if (hit) {
          hit.wds.push(wd);
          week[wd] = hit.idx;
          continue;
        }
        if (plans.length >= 8) continue; // device only stores eight
        plans.push({ idx: plans.length + 1, wds: [wd], segments });
        week[wd] = plans.length;
      }
      return { week, plans };
    }

    /** True when a weekday already has at least one segment worth copying. */
    _hasPlan(wd) {
      return ((this._draft.days || {})[Number(wd) + 1] || []).length > 0;
    }

    /**
     * Copy one weekday's whole schedule onto the one on screen.
     *
     * A copy, not a shared reference: the segments are cloned one by one, so
     * editing the target afterwards splits it onto its own day plan instead of
     * silently rewriting the source. Because the copy is byte-identical, the
     * packer immediately points both weekdays at the same day plan.
     */
    _copyFrom(srcWd) {
      const from = Number(srcWd);
      if (!Number.isInteger(from) || from < 0 || from > 6) return;
      if (from === this._draft.curWd || !this._hasPlan(from)) return;
      const to = this._draft.days[this._draft.curWd + 1] || [];
      if (to.length) return; // never overwrite silently
      const clone = (this._draft.days[from + 1] || []).map((s) => ({ ...s }));
      this._draft = {
        ...this._draft,
        days: { ...this._draft.days, [this._draft.curWd + 1]: clone },
      };
      this._edited();
      this.requestUpdate();
    }

    /** The colour that marks a mode in the timeline and on the segment row. */
    _modeColor(mode) {
      const m = Number(mode);
      if (m === 1) return "#ea580c"; // force charge - orange
      if (m === 2) return "#16a34a"; // PV charge - green
      if (m === 4) return "#2563eb"; // discharge / self-use - blue
      return "var(--divider-color)";
    }

    /** The colour that marks a *day plan* everywhere it is mentioned. */
    _dayColor(idx) {
      const i = Number(idx) - 1;
      return DAY_COLORS[i] || "var(--divider-color)";
    }

    /** One line of state next to Read / Send. */
    _actsStateText() {
      if (this._dirty) return this._t("unsaved changes", "有未保存的修改");
      if (this._weekState === "ok") {
        return this._t("Loaded from the device", "已从设备读取");
      }
      if (this._weekState === "partial") {
        return this._t("Partly loaded", "仅部分读取");
      }
      if (this._weekState === "empty") {
        return this._t("Device has no plan yet", "设备上还没有计划");
      }
      if (this._fromScratch || this._weekState === "new") {
        return this._t("New plan - replaces the device's", "新计划——将覆盖设备内容");
      }
      return this._t("Not read from the device yet", "尚未从设备读取");
    }

    /**
     * Record that the user changed the draft.
     *
     * Editing is also what unlocks sending a plan that was never read: a
     * segment that exists because someone typed it in is a deliberate plan, so
     * `_weekState` moves to `new` and the action bar says the device's own plan
     * will be replaced. No extra button - the act of building the table is the
     * decision. `partial` is deliberately not promoted: there the table is
     * incomplete for a reason the user cannot see, so it must be read again.
     * `empty` is not promoted either - the device really has no plan, so the
     * banner should keep saying that instead of warning about a replacement.
     */
    _edited() {
      this._dirty = true;
      if (this._weekState === "idle" || this._weekState === "failed"
          || this._weekState === "unreadable") {
        this._weekState = "new";
        this._fromScratch = true;
      }
    }

    /**
     * The guidance between the Read / Send bar and the table.
     *
     * One short paragraph that says how much is actually known about the device
     * (nothing / a refusal / all seven weekdays) and what that means for the
     * buttons above. It deliberately carries no buttons of its own: the two the
     * user needs are already there, and duplicating them turned a hint into a
     * menu.
     */
    _planNotice(packed) {
      if (this._fromScratch || this._weekState === "new") {
        return html`
          <div class="warn">
            <span>${this._t(
              "New plan - it was not read from the device, so sending replaces the plan "
              + "the device holds now.",
              "新计划：内容没有从设备读取过，下发会替换设备上现有的分时计划。")}</span>
          </div>`;
      }

      if (this._weekState === "empty") {
        return html`
          <div class="warn info">
            <span>${this._t(
              "The device has no TOU plan yet - there was nothing to read, and every weekday "
              + "is free. Build the schedule below, then press Send.",
              "设备上还没有分时计划，本来就没有可读取的内容，每个星期都是空的。"
              + "直接在下面编辑，然后点「下发」。")}</span>
          </div>`;
      }

      if (this._weekState === "partial") {
        return html`
          <div class="warn">
            <span>${this._t(
              `Only part of the week plan could be read (${(this._weekUnknown || []).join(", ")} `
              + "did not answer). Those rows below look empty but are still mapped on the device, "
              + "so read again before sending - otherwise they will be cleared.",
              `周计划只读取到一部分（${(this._weekUnknown || []).join("、")} 没有应答）。`
              + "下面这些行看起来是空的，但设备上仍然有映射，请再读一次再下发——"
              + "否则它们会被清掉。")}</span>
          </div>`;
      }

      if (this._weekState === "ok") {
        /* Nothing known to be wrong: say something only when the table is
           empty, because an empty table after a successful read is a fact
           ("the device really has no plan") and not an error. */
        if (packed.week.some(Boolean)) return "";
        return html`
          <div class="warn info">
            <span>${this._t(
              "The device holds no plan: every weekday is free. Build the schedule below and "
              + "press Send - until at least one weekday points at a plan, the device keeps "
              + "whatever it was doing.",
              "设备上没有任何计划：每个星期都是空的。在下面排好表并点「下发」——"
              + "在有至少一个星期指向计划之前，设备会继续按原来的方式运行。")}</span>
          </div>`;
      }

      if (this._weekState === "unreadable") {
        const now = this._emsMode() || "?";
        return html`
          <div class="warn">
            <span>${this._t(
              `The device is in ${now}, and it only answers a plan read in tou_plan mode. `
              + "Switch and read, or edit here directly - Send switches the mode on its own.",
              `设备当前处于 ${now}，只有 tou_plan 模式才会回读计划。`
              + "可以先切换并读取，也可以直接在这里编辑——下发时会自动切换到 tou_plan。")}</span>
          </div>`;
      }

      /* `idle` (never asked) and `failed` (asked, no answer): the table is
         empty because nothing is known, not because the device is empty. */
      return html`
        <div class="warn">
          <span>${this._t(
            "The plan on the device is unknown - the table below is empty, which does not mean "
            + "the device is. Read it, or edit it directly and the result replaces the device's.",
            "设备上的计划内容未知——下面的表是空的，并不代表设备上也是空的。"
            + "可以先读取，也可以直接编辑，编好后下发会覆盖设备上的计划。")}</span>
        </div>`;
    }

    /** "2 h 30 m" / "45 m" for one segment's length. */
    _durationLabel(ts, te) {
      const mins = Math.max(0, (Number(te) || 0) - (Number(ts) || 0)) * 15;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h && m) return `${h} h ${m} m`;
      if (h) return `${h} h`;
      return `${m} m`;
    }

    /**
     * The day plan as a list of consecutive blocks.
     *
     * Gaps are part of the answer - the firmware allows them, and a table makes
     * them invisible - so they are returned as their own block. Each block
     * carries `slots`, which is used as the flex weight, so the bar is drawn to
     * scale without any geometry maths.
     */
    _timeline(segments) {
      const blocks = [];
      let at = 0;
      for (const seg of segments) {
        const ts = Math.max(0, Math.min(TS_MAX, Number(seg.ts) || 0));
        const te = Math.max(ts, Math.min(TS_MAX, Number(seg.te) || 0));
        if (ts > at) blocks.push({ gap: true, slots: ts - at, from: at, to: ts });
        if (te > ts) {
          blocks.push({
            gap: false, slots: te - ts, from: ts, to: te, mode: Number(seg.mode),
          });
        }
        at = Math.max(at, te);
      }
      if (at < TS_MAX) blocks.push({ gap: true, slots: TS_MAX - at, from: at, to: TS_MAX });
      return blocks;
    }

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
    }
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

    /* ------------------------------------------------------------------ *
     * Progress dialog
     *
     * Talking to this device is slow: a read-back costs 2-5 s and a full save
     * with verification takes about 50 s. A wall of log lines at the bottom of
     * the card could not tell "still working" apart from "stuck", so the work
     * runs behind a modal with a progress bar and one row per step. The dialog
     * reports what is happening, blocks double clicks, and stays open with the
     * reason when something fails.
     * ------------------------------------------------------------------ */

    _busyStart(title, steps) {
      this._busy = {
        title,
        steps: steps.map((text) => ({ text, state: "todo" })),
        state: "running",
        message: "",
      };
      this.requestUpdate();
    }

    /** Mark `index` as the current step, closing everything before it. */
    _busyStep(index, text, message) {
      if (!this._busy) return;
      const steps = this._busy.steps.map((step, i) => ({
        ...step,
        text: i === index && text ? text : step.text,
        state: i < index ? "done" : i === index ? "active" : "todo",
      }));
      this._busy = {
        ...this._busy,
        steps,
        message: message === undefined ? this._busy.message : message,
      };
      this.requestUpdate();
    }

    /** Close the dialog with a verdict. Success closes itself shortly after. */
    _busyFinish(message, isError) {
      if (!this._busy) return;
      this._busy = {
        ...this._busy,
        state: isError ? "error" : "ok",
        message: message || "",
        steps: this._busy.steps.map((step) => ({
          ...step,
          state: step.state === "active"
            ? (isError ? "failed" : "done")
            : step.state,
        })),
      };
      this.requestUpdate();
      if (!isError) {
        setTimeout(() => {
          if (this._busy && this._busy.state === "ok") this._busyClose();
        }, 1400);
      }
    }

    _busyClose() {
      this._busy = null;
      this.requestUpdate();
    }

    /** 0-100, from the steps behind us plus the one in flight. */
    _busyPercent() {
      if (!this._busy) return 0;
      if (this._busy.state === "ok") return 100;
      const total = this._busy.steps.length || 1;
      const done = this._busy.steps.filter((s) => s.state === "done").length;
      // An active step counts as half: the bar moves while work is happening
      // instead of jumping only when a step completes.
      const active = this._busy.steps.some((s) => s.state === "active") ? 0.5 : 0;
      return Math.round(((done + active) / total) * 100);
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
        return true;
      } catch (err) {
        this._logLine("err", `set mode failed: ${err.message || err}`);
        return false;
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

    /**
     * Ask the device for one weekday and wait for *that weekday's* reply.
     *
     * Returns the reply attributes, or null when nothing usable came back.
     *
     * The old loop broke out of the wait as soon as `last_updated` changed, and
     * only afterwards checked whether the reply was for the weekday it asked
     * about. A late answer to the *previous* question therefore aborted the
     * wait for the current one, which is why a reload could come back with the
     * first two weekdays mapped and the rest blank even though the device had
     * all seven. The wait now ignores replies for other weekdays and keeps
     * going until the matching one arrives.
     *
     * `allowStale` is for the read-only path: the entity may already hold the
     * answer for this weekday from an earlier read, and showing that is better
     * than showing nothing. A save-time verification passes `false`, because
     * there the point is to prove the device accepted the new payload.
     *
     * A refusal is answered too, and it has no `week` in it: protocol §23 says
     * `week`, `day_idx` and `day_plan` are omitted whenever `status` is not 0.
     * A device with no TOU plan therefore answers
     * `{"status":1,"err_msg":"tou plan not configured"}` - and the old
     * `seen.week !== week` filter threw every one of those away. Seven
     * weekdays times the 25 s timeout meant a read of an unconfigured device
     * ground for nearly three minutes and then reported "no reply" for all
     * seven, which reads as a broken card rather than as "there is no plan
     * yet". Queries are strictly serialised - the next weekday is only asked
     * after this one answered or timed out - so a fresh refusal that arrives
     * while this weekday is being waited for is this weekday's answer.
     */
    async _fetchPlan(week, { allowStale = false } = {}) {
      const statusId = this._statusEntity();
      const before = this._hass.states[statusId];
      const beforeUpdate = before ? before.last_updated : null;

      if (this._hasIntegration()) {
        await this._hass.callService("hoymiles", "get_tou_plan", { dev_id: this._dev(), week });
      } else {
        await this._publish(`homeassistant/sensor/${this._dev()}/tou_plan/get`, { week });
      }

      // Measured latency is 1 s .. 15 s, so wait 25 s: a false "no reply" is
      // worse than a slow one, because it makes a successful save look broken.
      let state = null;
      let fresh = false;
      let refused = false;
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        state = this._hass.states[statusId];
        if (!state) continue;
        const seen = state.attributes || {};
        const changed = state.last_updated !== beforeUpdate;
        // The normal answer, tagged with the weekday it belongs to.
        if (seen.week === week) {
          if (changed) { fresh = true; break; }
          continue;
        }
        // A refusal: no weekday in the payload, but a status that is not
        // "success". Only a *fresh* one may be attributed to this query; an
        // old one may describe a device that has since been configured.
        if (seen.week == null && seen.status != null && Number(seen.status) !== 0 && changed) {
          refused = true;
          fresh = true;
          break;
        }
      }

      const attrs = (state && state.attributes) || {};
      if (refused) {
        // `week` is filled in by us: the caller needs to know which weekday
        // this refusal answers, the payload never says.
        return { ...attrs, week, refused: true };
      }
      if (attrs.week !== week) return null;
      if (!fresh && !allowStale) return null;
      return attrs;
    }

    /**
     * Read the whole week plan off the device.
     *
     * This is what makes the card honest: `week_plan` is a separate payload on
     * the device, so a day plan that no weekday points at is stored but never
     * runs. Without this read the table started blank, the user concluded
     * "nothing is configured" and their edits silently changed nothing.
     *
     * Day plans are copied in as they come back too, so the editor shows what
     * is actually stored rather than a fresh template.
     */
    async _loadWeek(force) {
      if (this._weekLoading || this._busy) return;
      /* Reloading replaces the whole draft with what the device holds, so any
         edit that has not been saved yet is lost. Silent loss is exactly what
         makes a plan look like it "disappeared", so ask first: the button
         becomes "Discard & reload" until the draft is clean again. */
      if (this._dirty && !force) {
        this._confirmDiscard = true;
        this.requestUpdate();
        return;
      }
      this._confirmDiscard = false;
      if (this._emsMode() !== "tou_plan") {
        this._weekState = "unreadable";
        this._busyStart(this._t("Cannot read the plan", "无法读取计划"), []);
        this._busyFinish(this._t(
          "Reading needs EMS mode tou_plan. Switch to it first - the device "
          + "rejects the read in any other mode.",
          "读取需要 EMS 处于 tou_plan 模式，请先切换——其它模式下设备会直接拒绝回读。"), true);
        return;
      }
      this._weekLoading = true;
      this._weekState = "loading";
      this._dirty = false;
      /* A read is the opposite of composing: it replaces the draft with what
         the device holds, so the "new plan" flag is cleared by it. */
      this._fromScratch = false;
      this._busyStart(this._t("Reading TOU plan", "正在读取分时计划"),
        WEEK.map((name) => this._weekLabel(name)));

      /* Fresh, not merged: a weekday the device reports as unconfigured must be
         empty on screen. Merging into the old draft kept a segment there that
         the device does not have. */
      const days = {};
      for (let i = 1; i <= 7; i += 1) days[i] = [];
      let answered = 0;
      // "The device says this weekday has no plan" and "the device did not
      // answer" must not look the same: the first is a fact worth showing, the
      // second means the table is partially unknown and saving it would erase
      // the weekdays that were not read.
      const unknown = [];
      /* The device answers "no TOU plan configured" for the whole device, not
         per weekday, so the first refusal is the end of the question: there is
         nothing to read and all seven weekdays are free. */
      let noPlan = false;
      let silence = 0;

      for (let index = 0; index < WEEK.length; index += 1) {
        const name = WEEK[index];
        this._busyStep(index, null, this._t(
          `waiting for the device (${index + 1}/7)...`,
          `等待设备响应（${index + 1}/7）...`));
        let attrs = null;
        try {
          // allowStale: for display, the entity's previous answer for this
          // weekday is still better than an empty row.
          attrs = await this._fetchPlan(name, { allowStale: true });
        } catch (err) {
          this._busyStep(index, `${this._weekLabel(name)}: ${err.message || err}`);
          unknown.push(name);
          silence += 1;
          if (silence >= 2) break;
          continue;
        }
        if (!attrs) {
          this._busyStep(index, this._t(
            `${name}: no reply - unknown, not "unconfigured"`,
            `${this._weekLabel(name)}：无应答——状态未知，不等于「未配置」`));
          unknown.push(name);
          /* Two silences in a row mean the device is not answering at all, so
             grinding through the remaining weekdays only makes the user wait
             3 more times 25 s for the same answer. Three weekdays are enough
             to tell "asleep" from "one lost packet"; the rest are reported as
             unknown, which still blocks saving. */
          silence += 1;
          if (silence >= 2) {
            WEEK.slice(index + 1).forEach((rest) => unknown.push(rest));
            break;
          }
          continue;
        }
        silence = 0;
        if (attrs.refused) {
          const reason = String(attrs.err_msg || "").trim();
          this._busyStep(index, this._t(
            `${name}: ${reason || "the device refused the read"}`,
            `${this._weekLabel(name)}：${reason || "设备拒绝了读取"}`));
          /* Only "no plan configured" is good news. A refusal for any other
             reason (a bad weekday in the request, a general error) says
             nothing about what is stored, so it stays unknown and keeps the
             save blocked. */
          const absent = /not\s*(yet\s*)?(config|set)|未配置|未设置/i.test(reason);
          if (!absent) { unknown.push(name); continue; }
          /* A device with no plan answers this way for all seven weekdays, so
             there is nothing left to ask: stop here instead of waiting out
             six more timeouts. */
          if (!answered) {
            noPlan = true;
            break;
          }
          continue;
        }
        const dayIdx = Number(attrs.day_idx) || 0;
        const plan = Array.isArray(attrs.day_plan) ? attrs.day_plan : [];
        if (!dayIdx || !plan.length) {
          this._busyStep(index, `${this._weekLabel(name)}: ${attrs.err_msg
            || this._t("not configured", "未配置")}`);
          continue;
        }
        /* The device may point several weekdays at one day plan, or use day8.
           Both are storage details: the weekday is the unit here, so the
           segments land in the weekday's own slot and the day number is
           forgotten. `_packDays()` works the sharing out again on the way back
           - weekdays with identical segments collapse onto the same plan, and
           therefore get the same colour. */
        days[index + 1] = plan.map((s) => ({ ...s }));
        answered += 1;
        this._busyStep(index, this._t(
          `${name} · ${plan.length} segment${plan.length === 1 ? "" : "s"}`,
          `${this._weekLabel(name)} · ${plan.length} 个时段`));
      }

      this._weekUnknown = unknown;
      /* Land on today when it has a plan, otherwise on the first weekday that
         does: opening the editor on an empty weekday after a successful read
         would look like the read failed. */
      const today = (new Date().getDay() + 6) % 7;
      const first = WEEK.findIndex((_, i) => (days[i + 1] || []).length);
      const curWd = (days[today + 1] || []).length ? today : (first >= 0 ? first : today);
      this._draft = { ...this._draft, days, curWd };
      /* `ok` means every weekday answered; `partial` means some did and some
         did not, which is the state that must never be saved blindly - the
         weekdays that failed to read are still mapped on the device, and
         writing this table back would clear them.  `empty` is the one refusal
         that is good news: the device holds no plan at all, so there is
         nothing to preserve and the table is allowed to be built from
         scratch. */
      this._weekState = noPlan
        ? "empty"
        : (!answered ? "failed" : (unknown.length ? "partial" : "ok"));
      this._weekLoading = false;

      if (this._weekState === "empty") {
        this._busyFinish(this._t(
          "The device has no TOU plan yet, so there is nothing to read - every "
          + "weekday is free. Build the schedule below and press Send.",
          "设备上还没有分时计划，没有可读取的内容——每个星期都是空的。"
          + "直接在下面编辑，然后点「下发」即可。"), false);
      } else if (this._weekState === "ok") {
        this._busyFinish(this._t(
          `Read ${answered}/7 weekdays - the table now shows what the device holds.`,
          `已读取 ${answered}/7 个星期——表格现在是设备的真实内容。`), false);
      } else if (!answered) {
        this._busyFinish(this._t(
          "The device did not answer any weekday. Check that it is online and "
          + "that EMS is in tou_plan, then try again - or press Start from "
          + "scratch to compose a new plan and overwrite the device's.",
          "设备没有应答任何星期。请确认设备在线且 EMS 处于 tou_plan 模式后重试；"
          + "也可以点「直接编辑新计划」自己排一份，覆盖设备上的内容。"), true);
      } else {
        this._busyFinish(this._t(
          `Only ${answered}/7 weekdays answered (${unknown.join(", ")} did not). `
          + "Those weekdays are still mapped on the device, so saving is blocked "
          + "until a reload succeeds - try again.",
          `只读取到 ${answered}/7 个星期（${unknown.join("、")} 没有应答）。`
          + "这些星期在设备上仍然有映射，所以保存会被禁止——请重试一次。"), true);
      }
      this.requestUpdate();
    }

    /** Switch to tou_plan, then read the plan back - the device only answers
     *  tou_plan/get in that mode, so the banner button can do both at once. */
    async _activateAndLoad() {
      if (this._busy) return;
      this._busyStart(this._t("Switching to tou_plan", "正在切换到 tou_plan"), [
        this._t("Switch EMS mode", "切换 EMS 模式"),
      ]);
      const ok = await this._setMode("tou_plan");
      if (!ok) {
        this._busyFinish(this._t(
          "The EMS mode did not change. Check that the device is online.",
          "EMS 模式没有切换成功。请确认设备在线。"), true);
        return;
      }
      this._busyStep(0, this._t("Switch EMS mode", "切换 EMS 模式"),
        this._t("letting the device apply it...", "等待设备生效..."));
      // Let the device apply the mode before the first get arrives.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      this._weekState = "idle";
      this._busyClose();
      await this._loadWeek(true);
    }

    async _getPlan(week) {
      try {
        const attrs = await this._fetchPlan(week);

        // A stale entity still carries the *previous* plan. Reading it would
        // silently show old values and make a failed round trip look like a
        // successful one, so report the timeout instead of trusting the state.
        if (!attrs) {
          this._logLine("err", this._t(
            `${week}: no reply from the device, plan not refreshed`,
            `${week}：设备无响应，计划未刷新`));
          this.requestUpdate();
          return;
        }

        if (Array.isArray(attrs.day_plan) && attrs.day_plan.length) {
          const wd = Math.max(0, WEEK.indexOf(attrs.week || week));
          const days = { ...this._draft.days, [wd + 1]: attrs.day_plan.map((s) => ({ ...s })) };
          this._draft = { ...this._draft, days, curWd: wd };
          this._logLine("ok", `${week} · ${attrs.day_plan.length} ${this._t("segments", "段")}`);
        } else {
          const reason = attrs.err_msg || "no plan";
          this._logLine("err", `${week}: ${reason}`);
        }
      } catch (err) {
        this._logLine("err", `get plan failed: ${err.message || err}`);
      }
      this.requestUpdate();
    }

    /** Translate one ack entity state into `code · readable text`. */
    _ackSummary(entityId, table) {
      const state = this._hass.states[entityId];
      if (!state) return "-";
      const raw = String(state.state || "");
      const code = Number.parseInt(raw, 10);
      if (!Number.isFinite(code)) return raw;
      const entry = table[code];
      const english = hmLang(this._hass, this._config) !== "zh";
      const text = entry ? (english ? entry.en : entry.zh) : raw.replace(/^\d+\s*-\s*/, "");
      return `${code} · ${text}`;
    }

    /**
     * Check the draft against the rules the firmware actually enforces.
     *
     * Without this the first feedback is a raw ack code after a MQTT round trip
     * ("9 - ts greater than te"), which says what broke but not which row or
     * what to type. Everything checked here mirrors hm_mqtt.c:
     * `MqttTouDayPlanApplyCheck()`.
     */
    _validateDraft() {
      const problems = [];
      const add = (row, en, zh) => problems.push({ row, en, zh });
      /* Checked per packed day plan, not per weekday: the identical schedule of
         two weekdays would otherwise report every problem twice. Naming the
         row after the weekdays that share it keeps it findable ("Mon, Wed #2"). */
      for (const plan of this._packDays().plans) {
        const segments = plan.segments || [];
        if (!segments.length) continue;
        const dayName = plan.wds.map((wd) => this._weekLabel(WEEK[wd])).join(", ");
        if (segments.length > 12) {
          add(dayName, "more than 12 segments", "超过 12 个时段");
        }
        const taken = [];
        segments.forEach((seg, index) => {
          const row = `${dayName} #${index + 1}`;
          const ts = Number(seg.ts);
          const te = Number(seg.te);
          if (!Number.isFinite(ts) || !Number.isFinite(te)) {
            add(row, "start/end is not a valid time", "开始/结束时间无效");
            return;
          }
          if (ts < 0 || ts > TS_MAX || te < 0 || te > TS_MAX) {
            add(row, "start/end outside 00:00-24:00", "开始/结束时间超出 00:00-24:00");
            return;
          }
          if (ts >= te) {
            add(row, `end (${slotToLabel(te)}) must be later than start (${slotToLabel(ts)})`,
              `结束时间（${slotToLabel(te)}）必须晚于开始时间（${slotToLabel(ts)}）`);
            return;
          }
          const clash = taken.find((other) => ts < other.te && other.ts < te);
          if (clash) {
            add(row, `overlaps #${clash.index + 1} (${slotToLabel(clash.ts)}-${slotToLabel(clash.te)})`,
              `与第 ${clash.index + 1} 段重叠（${slotToLabel(clash.ts)}-${slotToLabel(clash.te)}）`);
          }
          taken.push({ ts, te, index });

          const mode = Number(seg.mode);
          const sh = Number(seg.sh);
          const sl = Number(seg.sl);
          if ((mode === 1 || mode === 2) && (sh < 10 || sh > 100)) {
            add(row, "sh% must be 10-100 for a charging segment", "充电段的 sh% 必须在 10-100");
          }
          if (mode === 4 && (sl < 10 || sl > 100)) {
            add(row, "sl% must be 10-100 for a discharging segment", "放电段的 sl% 必须在 10-100");
          }
          if (!Number.isFinite(Number(seg.pc)) || Number(seg.pc) < 0) {
            add(row, "pc must not be negative", "pc 不能为负数");
          }
          if (!Number.isFinite(Number(seg.pd)) || Number(seg.pd) < 0) {
            add(row, "pd must not be negative", "pd 不能为负数");
          }
        });
      }
      return problems;
    }

    async _saveAll() {
      if (this._busy) return;

      /* Pre-flight: everything below is instant, so the dialog is opened in its
         error state with the reason instead of flashing a spinner first. */
      const refuse = (message) => {
        this._busyStart(this._t("Cannot save", "无法保存"), []);
        this._busyFinish(message, true);
      };

      /* Reject bad rows here instead of letting the device answer with a raw
         code. Mirrors the firmware checks, so a draft that passes this cannot
         come back as ack 3 / 5 / 6 / 9. */
      const problems = this._validateDraft();
      if (problems.length) {
        const head = this._t(
          "nothing was sent - fix these rows first:", "未发送任何数据——请先修正以下内容：");
        refuse(`${head}\n${problems.slice(0, 6)
          .map((p) => `${p.row}: ${this._t(p.en, p.zh)}`).join("\n")}`);
        return;
      }

      /* The mapping is derived, not stored: weekdays with an identical schedule
         collapse onto one day plan, so the device only stores what differs.
         Nothing to keep in sync, so nothing can drift. */
      const packed = this._packDays();
      const mapped = packed.week;

      /* A partial read is worse than no read: the weekdays that did not
         answer look unconfigured in the table, so writing it back would send
         a week plan that silently unmaps them on the device. That is exactly
         how a working plan can disappear after a "reload then save". Refuse
         and ask for another reload.  A deliberate overwrite is different -
         see `_fromScratch` below - but a half answered read is not a decision
         the user made. */
      if (this._weekState === "partial") {
        refuse(this._t(
          `The week plan was not fully read (${(this._weekUnknown || []).join(", ")
            || "device did not answer"}). Read again from the device before saving - `
          + "otherwise the weekdays that failed to read would be unmapped. "
          + "Nothing was sent.",
          `周计划没有完整读回（${(this._weekUnknown || []).join("、") || "设备未应答"}）。`
          + "请先从设备重读一次再保存——否则读取失败的星期会被取消映射。未发送任何数据。"));
        return;
      }

      /* A failed or skipped read is not a reason to block for ever. Composing a
         plan by hand and writing it over the device is a legitimate thing to
         want - a brand new unit has no plan to read, and asking the user to
         press a button that can only report "nothing there" is a dead end.
         `_edited()` promotes the state to `new` as soon as a segment is added
         or changed, which is the explicit intent; a table nobody touched stays
         `idle` / `failed` and is still refused, so a blank table can never wipe
         a plan by accident. */
      const fromScratch = this._fromScratch || this._weekState === "new"
        || this._weekState === "empty";
      if ((this._weekState === "failed" || this._weekState === "unreadable")
          && !fromScratch) {
        refuse(this._t(
          "The plan was not read from the device, so sending now would replace "
          + "whatever is stored there. Press Read first, or build a schedule below "
          + "if you mean to overwrite it. Nothing was sent.",
          "还没有从设备读取计划，此时下发会直接替换设备上现有的内容。"
          + "请先点「读取」；如果确定要覆盖，请在下面排好时段再下发。未发送任何数据。"));
        return;
      }

      /* Nothing was ever read: the table below is a blank draft, not the
         device's state, so sending it would wipe whatever mapping is stored. */
      if (this._weekState === "idle" && !fromScratch) {
        refuse(this._t(
          "The week plan has not been loaded, so sending now would overwrite "
          + "the mapping stored on the device. Press Read first, or build a schedule "
          + "below if you mean to replace it. Nothing was sent.",
          "周计划尚未载入，此时下发会覆盖设备上现有的映射。"
          + "请先点「读取」；如果确定要替换，请在下面排好时段再下发。未发送任何数据。"));
        return;
      }

      if (!mapped.some(Boolean)) {
        refuse(this._t(
          "No weekday has any segment, so there is nothing to run. "
          + "Pick a weekday above and press Add segment. Nothing was sent.",
          "没有任何星期安排时段，计划不会执行。"
          + "请在上方选一个星期并点「添加时段」。未发送任何数据。"));
        return;
      }

      /* One entry per distinct schedule, not per weekday: five weekdays that
         share a plan send that plan once. */
      const sending = packed.plans.map((plan) => plan.idx);

      this._busyStart(this._t("Saving TOU plan", "正在下发分时计划"), [
        this._t("Check the plan", "检查计划"),
        this._t("Switch EMS to tou_plan", "切换 EMS 到 tou_plan"),
        this._t(`Send day plans (${sending.length})`, `下发日计划（${sending.length} 份）`),
        this._t("Send the week plan", "下发周计划"),
        this._t("Verify the device holds the plan", "回读校验设备内容"),
      ]);

      try {
        this._busyStep(1, null, this._t("waiting for the device...", "等待设备响应..."));

        // The device only accepts day/week plans while the EMS is already in
        // tou_plan mode (HmMqttIsTouConfigReady() == mqtt_ems_mode == TOU).
        // Sending the plans first makes the device answer ack 10 / ack 6
        // ("tou_plan not set") and silently drop everything, so switch first.
        const activated = await this._setMode("tou_plan");
        if (!activated) {
          this._busyFinish(this._t(
            "The EMS mode did not switch to tou_plan, so nothing was sent.",
            "EMS 模式未能切换到 tou_plan，未发送任何数据。"), true);
          return;
        }
        // Give the device a moment to apply the mode before the plans arrive.
        await new Promise((resolve) => setTimeout(resolve, 1200));

        /* Send every day plan back to back.
           Waiting for one acknowledgement before sending the next day cost up
           to 15 s per day - a seven day save took over two minutes, and a save
           that slow gets abandoned (tab closed, view switched), leaving the
           device holding only the first few days and the week plan still
           pointing at whatever was there before. Sending them all first and
           verifying afterwards is both faster and more accurate. */
        for (let n = 0; n < sending.length; n += 1) {
          const plan = packed.plans[n];
          const day = plan.idx;
          const who = plan.wds.map((wd) => this._weekLabel(WEEK[wd])).join(", ");
          this._busyStep(2, this._t(
            `Send day plans (${n + 1}/${sending.length}) - ${who}`,
            `下发日计划（${n + 1}/${sending.length}）— ${who}`));
          await this._sendDayPlan(day, plan.segments);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        this._busyStep(2, this._t(
          `Send day plans (${sending.length}/${sending.length})`,
          `下发日计划（${sending.length}/${sending.length}）`));

        const weekPlan = packed.plans.map((plan) => ({
          week: plan.wds.map((wd) => WEEK[wd]),
          day_idx: plan.idx,
        }));
        const readAck = (entityId, table) => {
          const state = this._hass.states[entityId];
          const code = state ? Number.parseInt(String(state.state || ""), 10) : NaN;
          if (!Number.isFinite(code)) return null;
          const entry = table[code];
          return { code, text: entry ? this._t(entry.en, entry.zh) : String(state.state) };
        };
        if (weekPlan.length) {
          this._busyStep(3, null, this._t("waiting for the device...", "等待设备响应..."));
          const before = this._hass.states[this._weekAckEntity()]?.last_updated;
          await this._sendWeekPlan(weekPlan);
          // A short wait only - the read-back verification below is the real
          // proof. This used to wait 15 s even when the device had answered
          // instantly, because an identical ack payload does not refresh
          // `last_updated`, so the loop never saw a change.
          for (let i = 0; i < 10; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const now = this._hass.states[this._weekAckEntity()];
            if (now && now.last_updated !== before) break;
          }
          const ack = readAck(this._weekAckEntity(), WEEK_ACK_TEXT);
          if (ack && ack.code !== 0) {
            this._busyFinish(this._t(
              `The device rejected the week plan: ${ack.code} · ${ack.text}. `
              + "The day plans were stored, but no weekday points at them yet.",
              `周计划被设备拒绝：${ack.code} · ${ack.text}。`
              + "日计划已保存，但还没有任何星期指向它们。"), true);
            return;
          }
        }

        this._busyStep(4, null, this._t(
          "reading back all 7 weekdays, this takes a few seconds each...",
          "正在回读 7 个星期，每个需要几秒..."));

        // Reading everything back is the only honest confirmation, and it also
        // refreshes the editor with what the device actually kept.
        const verdict = await this._verifySave(mapped, sending);
        if (verdict.error) { this._busyFinish(verdict.error, true); return; }
        if (verdict.warning) { this._busyFinish(verdict.warning, true); return; }

        this._weekState = "ok";
        this._dirty = false;
        this._confirmDiscard = false;
        this._fromScratch = false;
        this._busyFinish(this._t(
          "Saved and verified - the device holds exactly this plan.",
          "已保存并校验通过——设备上的内容与这里一致。"), false);
      } catch (err) {
        this._busyFinish(this._t(
          `Save failed: ${err.message || err}`,
          `保存失败：${err.message || err}`), true);
      }
      this.requestUpdate();
    }

    /**
     * Read the week plan back and compare it with what was just sent.
     *
     * An acknowledgement only proves the payload parsed - not that the mapping
     * that ended up stored is the one on screen. This closes the loop and also
     * refreshes the draft from the device, so the editor never shows something
     * the device does not hold.
     *
     * Returns `{}` on success, or `{ error }` / `{ warning }` with the text to
     * show in the progress dialog.
     */
    async _verifySave(expectedWeek, verifyDays) {
      const mismatches = [];
      const unread = [];
      /* Rebuilt per weekday, because that is how the draft is stored. A weekday
         the device reports as unconfigured must end up empty here, which is
         also what makes the packer drop it from the next save. */
      const days = {};
      for (let i = 1; i <= 7; i += 1) days[i] = [];
      // Only the day plans that were actually sent can disagree about content.
      const watch = new Set(verifyDays || []);

      for (let index = 0; index < WEEK.length; index += 1) {
        const name = WEEK[index];
        if (this._busy) {
          this._busyStep(4, this._t(
            `Verify the device holds the plan (${index + 1}/7 · ${name})`,
            `回读校验（${index + 1}/7 · ${name}）`));
        }
        let attrs = null;
        try {
          // Fresh read: right after a save, a cached answer proves nothing.
          attrs = await this._fetchPlan(name, { allowStale: false });
        } catch (err) {
          unread.push(name);
          continue;
        }
        if (!attrs) { unread.push(name); continue; }

        const got = Number(attrs.day_idx) || 0;
        const want = Number(expectedWeek[index] || 0);
        if (got !== want) {
          mismatches.push(want
            ? `${name}: sent a plan, the device reports none`
            : `${name}: sent an empty schedule, the device still has one`);
          continue;
        }
        if (!got) continue;

        const plan = Array.isArray(attrs.day_plan) ? attrs.day_plan : [];
        days[index + 1] = plan.map((s) => ({ ...s }));
        if (!watch.has(got)) continue;

        // Compare the segments too: two weekdays can share a day number and
        // still hold the wrong schedule, which is what "it says saved but the
        // device runs something else" looks like.
        const sent = this._draft.days[index + 1] || [];
        if (!this._samePlan(sent, plan)) {
          mismatches.push(`${name}: segments differ `
            + `(sent ${sent.length}, device ${plan.length})`);
        }
      }

      if (mismatches.length) {
        this._draft = { ...this._draft, days };
        return {
          error: this._t(
            `The device does not hold what was sent:\n${mismatches.join("\n")}\n`
            + "The editor now shows what the device really holds.",
            `设备上的内容与下发的不同：\n${mismatches.join("\n")}\n`
            + "编辑器现在显示的是设备的真实内容。"),
        };
      }
      if (unread.length) {
        return {
          warning: this._t(
            `Saved, but verification was incomplete: ${unread.join(", ")} did not answer. `
            + "Press Read to check.",
            `已保存，但校验未完成：${unread.join("、")} 没有应答。`
            + "请点「读取」核对。"),
        };
      }
      this._draft = { ...this._draft, days };
      return {};
    }

    _setSegment(day, index, field, value) {
      const segments = this._draft.days[day].slice();
      segments[index] = { ...segments[index], [field]: value };
      this._draft = { ...this._draft, days: { ...this._draft.days, [day]: segments } };
      this._dirty = true;
      this.requestUpdate();
    }

    /** Quarter-hour slots from `from` to `to`, inclusive. */
    _slotOptions(from, to) {
      const out = [];
      const start = Math.max(0, Math.min(TS_MAX, Number(from) || 0));
      for (let s = start; s <= to; s += 1) out.push(s);
      return out;
    }

    /**
     * Re-chain every segment after `index`.
     *
     * Each following segment starts where the previous one ends, so moving one
     * end drags the rest of the day along instead of leaving an overlap behind
     * (which the device answers with ack 3). A segment that would run past
     * midnight is dropped, because there is nowhere left for it to go.
     */
    _cascade(segments, index) {
      const out = segments.slice(0, index + 1);
      for (let i = index + 1; i < segments.length; i += 1) {
        const prevTe = Number(out[out.length - 1].te);
        if (prevTe >= TS_MAX) break;
        const duration = Math.max(1, Number(segments[i].te) - Number(segments[i].ts));
        out.push({ ...segments[i], ts: prevTe, te: Math.min(TS_MAX, prevTe + duration) });
      }
      return out;
    }

    /**
     * Apply one picked start time.
     *
     * The dropdown only offers slots at or after the previous segment's end, so
     * this can never produce the "start inside the previous segment" that the
     * device rejects. Picking a later start is still allowed and simply leaves
     * a gap, which is what a plan read back from the device is allowed to have.
     */
    _setStart(day, index, slot) {
      const segments = (this._draft.days[day] || []).slice();
      const prevTe = index > 0 ? Number(segments[index - 1].te) : 0;
      const ts = Math.max(prevTe, Math.min(TS_MAX - 1, Number(slot) || 0));
      const te = Math.min(TS_MAX, Math.max(ts + 1, Number(segments[index].te) || 0));
      segments[index] = { ...segments[index], ts, te };
      this._draft = {
        ...this._draft,
        days: { ...this._draft.days, [day]: this._cascade(segments, index) },
      };
      this._edited();
      this.requestUpdate();
    }

    /** Apply one picked end time and push the following starts along. */
    _setEnd(day, index, slot) {
      const segments = (this._draft.days[day] || []).slice();
      const ts = Number(segments[index].ts) || 0;
      const te = Math.min(TS_MAX, Math.max(ts + 1, Number(slot) || 0));
      segments[index] = { ...segments[index], te };
      this._draft = {
        ...this._draft,
        days: { ...this._draft.days, [day]: this._cascade(segments, index) },
      };
      this._edited();
      this.requestUpdate();
    }

    /**
     * True when the day cannot take another segment: either its last segment
     * already reaches 24:00, or it is at the firmware's twelve-segment cap.
     */
    _dayFull(day) {
      const segments = this._draft.days[day] || [];
      if (segments.length >= 12) return true;
      return segments.some((seg) => Number(seg.te) >= TS_MAX);
    }

    _addSegment(day) {
      const segments = this._draft.days[day] || [];
      if (this._dayFull(day)) return;
      // Continue where the last segment stopped, one hour long by default.
      const ts = segments.length ? Number(segments[segments.length - 1].te) : 0;
      const te = Math.min(TS_MAX, ts + 4);
      this._draft = {
        ...this._draft,
        days: { ...this._draft.days, [day]: [...segments, newSegment(ts, te)] },
      };
      this._edited();
      this.requestUpdate();
    }

    _removeSegment(day, index) {
      /* Only the segment goes. The ones after it keep their own times, which
         leaves a gap rather than silently rewriting times the user set; a gap
         is legal on the device, an overlap is not. */
      const kept = (this._draft.days[day] || []).filter((_, i) => i !== index);
      this._draft = {
        ...this._draft,
        days: { ...this._draft.days, [day]: kept },
      };
      this._edited();
      this.requestUpdate();
    }

    render() {
      if (!this._draft) this._resetDraft();
      const mode = this._emsMode();
      /* `embedded: true` means `<hoymiles-control>` hosts this editor inside its
         own EMS card: no <ha-card>, no second title, no second Read/Send bar.
         That is the whole point - the plan belongs to the EMS mode, not to a
         page of its own. */
      const embedded = this._config.embedded === true;

      /* The three EMS modes are alternatives. While the device is in general
         or mqtt_ctrl there is no schedule to edit, so the standalone card steps
         aside completely. `show_when_locked: true` brings the read-only view
         back. When embedded the host already decides when to show the editor. */
      const wrongMode = this._config.require_tou_mode !== false
        && !!mode && mode !== "tou_plan";
      if (!embedded && wrongMode && this._config.show_when_locked !== true) return html``;
      const locked = !embedded && wrongMode;

      const wd = this._draft.curWd || 0;
      const day = this._curPlan();
      const segments = this._draft.days[day] || [];
      const packed = this._packDays();

      return html`
        ${this._busyDialog()}
        ${embedded ? html`
          ${this._editorBody({ mode, embedded, locked, wd, day, segments, packed })}
        ` : html`
          <ha-card>
            ${locked ? html`
              <div class="notice">
                <span>
                  ${this._t("Read-only: EMS mode is ", "只读：EMS 模式为 ")}
                  <b>${mode}</b>${this._t(", not tou_plan.", "，不是 tou_plan。")}
                </span>
                <button class="btn primary" @click=${() => this._activateAndLoad()}>
                  ${this._t("Switch to tou_plan", "切换到 tou_plan")}
                </button>
              </div>` : ""}
            ${this._editorBody({ mode, embedded, locked, wd, day, segments, packed })}
          </ha-card>`}
      `;
    }

    /**
     * Everything below the (optional) card header.
     *
     * Split out of `render` because the same markup serves both hosts: the
     * standalone card and the EMS card of `<hoymiles-control>`. Only the
     * chrome differs, never the editor.
     */
    _editorBody({ mode, embedded, locked, wd, day, segments, packed }) {
      const wdName = WEEK[wd] || WEEK[0];
      /* Only weekdays that already have a schedule can be a copy source: an
         empty weekday would just replace one blank with another. The current
         weekday is excluded too, there is nothing to copy onto itself. */
      const copyFrom = WEEK
        .map((name, i) => ({ name, i }))
        .filter(({ i }) => i !== wd && this._hasPlan(i));
      return html`
        <div class="wrap ${embedded ? "emb" : ""} ${locked ? "locked" : ""}"
             aria-disabled=${locked ? "true" : "false"}>
          ${embedded ? "" : html`
            <div class="head">
              <div class="title">${this._text(this._config.title) || this._t("TOU plan", "分时计划")}</div>
              <div class="sub">${this._dev()} · EMS: ${mode || "?"}</div>
            </div>`}

          <details class="help">
            <summary>${this._t("How the weekly schedule is set up", "每周排程怎么设置")}</summary>
            <div class="help-body">
              <p>${this._t(
                "Every weekday (Mon to Sun) has a list of segments of its own. "
                + "Click a weekday above to see and edit that day.",
                "每个星期（周一至周日）各自有一份时段表。点上方的某一天，就能查看和编辑那一天的安排。")}</p>
              <p>${this._t(
                "A segment says what the battery should do during that time - force charge, "
                + "charge from PV, or discharge - and at what power. Each segment starts where "
                + "the previous one ends; a segment ending at 24:00 fills the day.",
                "每个时段说明这段时间电池做什么：强制充电、光伏充电或放电，以及功率上限。"
                + "每个时段的开始时间接在上一段结束之后；结束时间到 24:00 表示这一天已经排满。")}</p>
              <p>${this._t(
                "Weekdays with exactly the same segments share one plan on the device, which is "
                + "why they are drawn in the same colour - editing one of them changes all of them.",
                "时段完全相同的星期在设备上共用同一份计划，所以显示为同一种颜色——"
                + "改动其中一天，共用这份计划的其它星期会跟着变。")}</p>
              <p>${this._t(
                "Read fetches the plan the device is running; Send writes this table to the device "
                + "and reads it back to check. Reading first is not compulsory: if the device has no "
                + "plan yet, build one and send it.",
                "「读取」把设备上当前的计划取回来；「下发」把这张表写到设备，并自动回读校验。"
                + "不必须先读：设备上还没有计划时，直接排好表下发即可。")}</p>
            </div>
          </details>

          <div class="acts">
            <span class="astat ${this._dirty ? "dirty" : ""}">${this._actsStateText()}</span>
            <span class="sp"></span>
            <button class="btn ${this._confirmDiscard ? "danger" : ""}"
              @click=${() => this._loadWeek(this._confirmDiscard)}>
              ${this._confirmDiscard
                ? this._t("Discard & read", "丢弃并读取")
                : this._t("Read", "读取")}
            </button>
            <button class="btn primary" @click=${() => this._saveAll()}>
              ${this._t("Send", "下发")}
            </button>
          </div>

          ${this._planNotice(packed)}

          <div class="group-title">
            <span>${this._t("WEEKLY SCHEDULE", "每周排程")}</span>
          </div>

          <div class="wday">
            ${WEEK.map((name, i) => {
              /* The colour comes from the *packed* day plan, so weekdays that
                 share one plan are drawn in the same colour - that is the only
                 visual cue the sharing exists at all. */
              const filled = this._hasPlan(i);
              const dayIdx = packed.week[i] || 0;
              const today = (new Date().getDay() + 6) % 7 === i;
              return html`
                <button class="wd ${i === wd ? "on" : ""} ${filled ? "" : "blank"}"
                  style="--dc:${dayIdx ? this._dayColor(dayIdx) : "var(--divider-color)"}"
                  title=${filled
                    ? this._t(
                      `${name} · ${(this._draft.days[i + 1] || []).length} segments`,
                      `${WEEK_ZH[name]} · ${(this._draft.days[i + 1] || []).length} 个时段`)
                    : this._t(`${name} has no plan yet`, `${WEEK_ZH[name]} 还没有计划`)}
                  @click=${() => this._selectWeekday(i)}>
                  <span class="d"></span>${this._weekLabel(name)}${today
                    ? html`<span class="td">${this._t("today", "今天")}</span>` : ""}
                </button>`;
            })}
          </div>

          <div class="assign">
            <span class="al">${this._weekLabel(wdName)}</span>
            <span>${segments.length
              ? this._t(
                `${segments.length} segment${segments.length === 1 ? "" : "s"}`,
                `${segments.length} 个时段`)
              : this._t("nothing planned yet", "还没有安排")}</span>
            ${(() => {
              /* Say which other weekdays the plan is shared with: the colour
                 shows it, but a change here changes those days too, and that
                 must be readable without decoding a colour. */
              const mine = packed.week[wd] || 0;
              const others = mine
                ? WEEK.filter((_, i) => i !== wd && packed.week[i] === mine)
                : [];
              if (!others.length) return "";
              return html`<span class="share" title=${this._t(
                "These weekdays have exactly the same segments, so the device stores one plan for all of them",
                "这些星期的时段完全相同，设备上共用同一份计划")}>${this._t("shared with ", "共用：")}
                ${others.map((n) => this._weekLabel(n)).join(", ")}</span>`;
            })()}
            <span class="sp"></span>
            ${copyFrom.length && !segments.length ? html`
              <span>${this._t("Copy from", "复制自")}</span>
              <select class="copy" title=${this._t(
                "Fill this empty weekday with a copy of another day",
                "用另一个星期的计划填充这一天")}
                @change=${(e) => {
                  const v = e.target.value;
                  e.target.value = "";
                  if (v !== "") this._copyFrom(v);
                }}>
                <option value="">${this._t("pick a weekday", "选择星期")}</option>
                ${copyFrom.map(({ name, i }) => html`
                  <option value=${i}>${this._weekLabel(name)}</option>
                `)}
              </select>` : ""}
          </div>

          <div class="legend">
            <span class="lg"><i class="sw m1"></i>${this._t("Force charge", "强制充电")}</span>
            <span class="lg"><i class="sw m2"></i>${this._t("PV charge", "光伏充电")}</span>
            <span class="lg"><i class="sw m4"></i>${this._t("Discharge", "放电")}</span>
            <span class="sp"></span>
            <span class="how">${this._t("Each row: ", "每行：")}<b>${this._t("charge to", "充电至")}</b>
              / <b>${this._t("discharge to", "放电至")}</b>
              ${this._t("is the battery level to stop at, ", "是停止时到达的电量，")}
              <b>W</b> ${this._t("is the power limit.", "是功率上限。")}</span>
          </div>

          ${segments.length ? html`
            <div class="tl">
              ${this._timeline(segments).map((block) => html`
                <span class="blk ${block.gap ? "gap" : `m${block.mode}`}"
                  style="flex:${block.slots}"
                  title=${block.gap
                    ? this._t(
                      `Idle ${slotToLabel(block.from)} - ${slotToLabel(block.to)}`,
                      `空闲 ${slotToLabel(block.from)} - ${slotToLabel(block.to)}`)
                    : `${MODE_LABEL[block.mode] ? MODE_LABEL[block.mode].en : block.mode} · `
                      + `${this._durationLabel(block.from, block.to)}`}>
                  ${block.slots >= 5 ? this._durationLabel(block.from, block.to) : ""}
                </span>`)}
            </div>
            <div class="tl-axis">
              <span>00:00</span><span>06:00</span><span>12:00</span>
              <span>18:00</span><span>24:00</span>
            </div>` : ""}

          <div class="segs">
            ${segments.length ? segments.map((seg, index) => {
              const prevTe = index > 0 ? Number(segments[index - 1].te) : 0;
              const ts = Number(seg.ts) || 0;
              const te = Number(seg.te) || 0;
              /* Only times that are still available are offered: a start
                 cannot fall inside the previous segment, and an end has to be
                 later than its own start. */
              const startFrom = Math.min(prevTe, ts);
              const endFrom = te > ts ? ts + 1 : ts;
              return html`
              <div class="seg-row" style="--mc:${this._modeColor(seg.mode)}">
                <select class="smode"
                  title=${this._t("Mode of this segment", "该时段的模式")}
                  @change=${(e) => this._setSegment(day, index, "mode", Number(e.target.value))}>
                  ${[1, 2, 4].map((m) => html`
                    <option value=${m} ?selected=${Number(seg.mode) === m}>
                      ${MODE_LABEL[m][hmLang(this._hass, this._config)]}
                    </option>
                  `)}
                </select>
                <span class="stime">
                  <select title=${this._t("Start", "开始")}
                    @change=${(e) => this._setStart(day, index, Number(e.target.value))}>
                    ${this._slotOptions(startFrom, TS_MAX - 1).map((s) => html`
                      <option value=${s} ?selected=${s === ts}>${slotToLabel(s)}</option>
                    `)}
                  </select>
                  <span class="dash">→</span>
                  <select title=${this._t("End", "结束")}
                    @change=${(e) => this._setEnd(day, index, Number(e.target.value))}>
                    ${this._slotOptions(endFrom, TS_MAX).map((s) => html`
                      <option value=${s} ?selected=${s === te}>${slotToLabel(s)}</option>
                    `)}
                  </select>
                </span>
                <span class="slen">${this._durationLabel(ts, te)}</span>
                <span class="slim">
                  <label class="nfl ch" title=${this._t(
                    "Charge until the battery reaches this state of charge.",
                    "充电到该电量百分比为止。")}>
                    <span class="cap">${this._t("Charge to", "充电至")}</span>
                    <span class="nf">
                      <input type="number" min="10" max="100" step="1" .value=${seg.sh}
                        @change=${(e) => this._setSegment(day, index, "sh", Number(e.target.value))}/><b>%</b>
                    </span>
                  </label>
                  <label class="nfl ch" title=${this._t(
                    "Charging power for this segment.",
                    "该时段的充电功率。")}>
                    <span class="cap">${this._t("Charge W", "充电功率")}</span>
                    <span class="nf">
                      <input type="number" min="100" step="10" .value=${seg.pc}
                        @change=${(e) => this._setSegment(day, index, "pc", Number(e.target.value))}/><b>W</b>
                    </span>
                  </label>
                  <label class="nfl dis" title=${this._t(
                    "Discharge until the battery reaches this state of charge.",
                    "放电到该电量百分比为止。")}>
                    <span class="cap">${this._t("Discharge to", "放电至")}</span>
                    <span class="nf">
                      <input type="number" min="10" max="100" step="1" .value=${seg.sl}
                        @change=${(e) => this._setSegment(day, index, "sl", Number(e.target.value))}/><b>%</b>
                    </span>
                  </label>
                  <label class="nfl dis" title=${this._t(
                    "Discharging power for this segment.",
                    "该时段的放电功率。")}>
                    <span class="cap">${this._t("Discharge W", "放电功率")}</span>
                    <span class="nf">
                      <input type="number" min="100" step="10" .value=${seg.pd}
                        @change=${(e) => this._setSegment(day, index, "pd", Number(e.target.value))}/><b>W</b>
                    </span>
                  </label>
                </span>
                <button class="icon-btn" title=${this._t("Remove this segment", "删除该时段")}
                  @click=${() => this._removeSegment(day, index)}>✕</button>
              </div>
            `; }) : html`
              <div class="empty">
                ${this._t(
                  `Nothing planned for ${this._weekLabel(wdName)} yet. Add a segment to say what the battery should do.`,
                  `${this._weekLabel(wdName)} 还没有安排。添加一个时段，告诉电池要做什么。`)}
              </div>`}
          </div>

          <div class="bar" style="margin-top:12px">
            <button class="btn" ?disabled=${this._dayFull(day)}
              title=${this._dayFull(day)
                ? this._t("This day already runs to 24:00", "这一天已经排到 24:00")
                : ""}
              @click=${() => this._addSegment(day)}>
              ${this._t("+ Add segment", "+ 添加时段")}
            </button>
          </div>
        </div>`;
    }

    /**
     * The progress dialog.
     *
     * Rendered outside the `.wrap` that gets dimmed by the read-only state, and
     * outside any scrolling container: it is `position: fixed`, so it covers
     * the dashboard while a save or a reload talks to the device.
     */
    _busyDialog() {
      if (!this._busy) return "";
      const { state, steps, message, title } = this._busy;
      const pct = this._busyPercent();
      const running = state === "running";
      return html`
        <div class="overlay">
          <div class="modal" role="dialog" aria-modal="true">
            <div class="modal-title">${title}</div>
            <div class="modal-row">
              ${running
                ? html`<div class="spinner"></div>`
                : html`<div class="mark ${state === "ok" ? "ok" : "err"}">
                    ${state === "ok" ? "✓" : "!"}</div>`}
              <div class="modal-msg">${message || (running
                ? this._t("working...", "正在处理...")
                : "")}</div>
            </div>
            <div class="pbar">
              <div class="pfill ${state}" style="width:${running ? Math.max(pct, 4) : 100}%"></div>
            </div>
            ${steps.length ? html`
              <ol class="steps">
                ${steps.map((step) => html`
                  <li class=${step.state}>
                    <span class="dot">${step.state === "done" ? "✓"
                      : step.state === "failed" ? "✕"
                      : step.state === "active" ? "●" : "○"}</span>
                    <span>${step.text}</span>
                  </li>`)}
              </ol>` : ""}
            ${running ? "" : html`
              <div class="modal-foot">
                <button class="btn primary" @click=${() => this._busyClose()}>
                  ${this._t("Close", "关闭")}
                </button>
              </div>`}
          </div>
        </div>
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

/* Register on any page that has Lit. */
function _hmTouBoot() {
  if (window.__hmWhenLit) {
    window.__hmWhenLit((Lit) => _hmTouRegister(Lit));
    return;
  }
  if (customElements.get("ha-panel-lovelace")) {
    _hmTouRegister();
    return;
  }
  customElements.whenDefined("ha-panel-lovelace")
    .then(() => _hmTouRegister())
    .catch(() => {});
}

_hmTouBoot();
