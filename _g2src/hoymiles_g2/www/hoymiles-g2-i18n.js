/* ============================================================================
 * Hoymiles Micro Storage — shared language module
 * ----------------------------------------------------------------------------
 * Loaded before every other card script (see `FRONTEND_ASSETS` in `const.py`).
 *
 * Why this file exists
 * --------------------
 * The Hoymiles integration family ships its **own** language switch in the
 * toolbar (English / 中文 / Deutsch).  That switch does *not* touch
 * `hass.language`: it writes `localStorage["hoymiles.language"]` and fires a
 * `hoymiles-language` event on `window`.  A card that only reads
 * `hass.language` therefore keeps the language Home Assistant itself was
 * configured with and ignores the user's choice - which is exactly what these
 * cards used to do.
 *
 * The contract below is a byte-for-byte mirror of the official
 * `custom_components/hoymiles/www/hoymiles-lang.js`, so both integrations share
 * one preference and one event name:
 *
 *   storage key     hoymiles.language
 *   event name      hoymiles-language      (detail: "en" | "zh" | "de")
 *   normalisation   zh* -> zh, de* -> de, en* -> en
 *   resolution      stored || config.language || hass.locale.language || "en"
 *
 * German is held in a dictionary **keyed by the English string**, so the 140+
 * `_t(en, zh)` call sites across the cards keep working untouched: `hmPick()`
 * looks the English text up in `T_DE`, and a miss falls back to English rather
 * than to an empty string.
 *
 * Nothing here is a custom element; it is a plain `window` global so the cards
 * can stay independent modules.
 * ========================================================================== */

(function () {
  if (window.HoymilesG2I18n) return;

  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";
  const LANG_CHOICES = [
    ["en", "English"],
    ["zh", "中文"],
    ["de", "Deutsch"],
  ];

  /* ------------------------------------------------------------------ *
   * German, keyed by the English string
   *
   * Keys are the *exact* `en` argument of a `_t(en, zh)` call, or the `en`
   * field of a `{ en, zh }` table entry.  A missing key renders English, so
   * adding a card string without a translation degrades gracefully instead of
   * showing an empty label.
   * ------------------------------------------------------------------ */
  const T_DE = {
    /* ---- language-independent fragments ---- */
    "(empty)": "(leer)",
    "Not set": "nicht gesetzt",
    "s": "s",
    "Weak": "schwach",
    "Fair": "mäßig",
    "Good": "gut",
    "Excellent": "sehr gut",
    "Status": "Status",
    "Standby": "Standby",
    "Running": "läuft",
    "On": "Ein",
    "Off": "Aus",
    "Start": "Start",
    "End": "Ende",
    "Next": "Weiter",
    "Previous": "Zurück",
    "Get": "Abrufen",
    "Send": "Senden",
    "Sent": "Gesendet",
    "Clear": "Leeren",
    "Reset": "Zurücksetzen",
    "Refresh": "Aktualisieren",
    "Reboot": "Neustart",
    "Mode": "Modus",
    "Status ": "Status ",

    /* ---- units of time ---- */
    "Day": "Tag",
    "Month": "Monat",
    "Year": "Jahr",
    "Total": "Gesamt",
    "Today": "Heute",
    "7 days": "7 Tage",
    "30 days": "30 Tage",
    "This month": "Dieser Monat",
    "Mon": "Mo",
    "Tue": "Di",
    "Wed": "Mi",
    "Thu": "Do",
    "Fri": "Fr",
    "Sat": "Sa",
    "Sun": "So",

    /* ---- energy-flow nodes ---- */
    "PV": "PV",
    "PV Input": "PV-Eingang",
    "Grid In": "Netzbezug",
    "Grid Out": "Netzeinspeisung",
    "Plug In": "Steckdose ein",
    "Plug Out": "Steckdose aus",
    "EPS In": "EPS-Eingang",
    "EPS Out": "EPS-Ausgang",
    "Battery In": "Batterie lädt",
    "Battery Out": "Batterie entlädt",
    "Unmetered": "Ungemessen",
    "Loss / Other": "Verlust / Sonstiges",
    "Grid Port": "Netzanschluss",
    "Off-Grid Port": "Off-Grid-Anschluss",
    "Load": "Last",
    "Battery": "Batterie",
    "Battery ": "Batterie ",
    "Packs": "Pakete",
    "Battery Packs": "Batteriepakete",

    /* ---- battery state ---- */
    "Charging": "Laden",
    "Discharging": "Entladen",
    "Locked": "Gesperrt",
    "Charged": "Geladen",
    "Discharged": "Entladen",

    /* ---- EMS modes ---- */
    "General": "Eigenverbrauch",
    "MQTT ctrl": "MQTT-Regelung",
    "TOU Plan": "TOU-Plan",

    /* ---- dashboard titles / series names ---- */
    "My Home": "Mein Zuhause",
    "PV Power": "PV-Leistung",
    "PV Power by Port": "PV-Leistung je Anschluss",
    "Grid Output [+]/Input [-]": "Netzausgang [+]/Eingang [-]",
    "Grid Output": "Netzausgang",
    "Grid Voltage": "Netzspannung",
    "PV Today": "PV heute",
    "Energy Today": "Energie heute",
    "Charge Today": "Laden heute",
    "Discharge Today": "Entladen heute",
    "Battery SOC": "Batterieladestand",
    "PV Total": "PV gesamt",
    "Power": "Leistung",
    "Energy Flow": "Energiefluss",
    "History": "Verlauf",
    "Alarms": "Warnungen",
    "Control": "Steuerung",
    "Load Today": "Heute laden",

    /* ---- alarms ---- */
    "Active alarms": "Aktive Warnungen",
    "Alarm data unavailable": "Alarmdaten nicht verfügbar",
    "No alarm data yet": "Noch keine Alarmdaten",
    "No active alarms": "Keine aktiven Warnungen",

    /* ---- control card ---- */
    "Power & Mode": "Leistung & Modus",
    "Power Settings": "Leistungseinstellungen",
    "Power Control": "Leistungsregelung",
    "Output Power": "Ausgangsleistung",
    "Phase Output": "Phasenausgang",
    "EMS Mode": "EMS-Modus",
    "Plan & Maintenance": "Plan & Wartung",
    "Commands are sent straight to the device": "Befehle werden direkt an das Gerät gesendet",
    "Switch EMS to mqtt_ctrl first": "Zuerst EMS auf mqtt_ctrl schalten",
    "Switch to tou_plan": "Auf tou_plan umschalten",
    "Read-only: EMS Mode is ": "Nur lesen: EMS-Modus ist ",
    "Invalid value": "Ungültiger Wert",
    "Re-send Timer": "Timer erneut senden",
    "Takes about a minute": "Dauert etwa eine Minute",
    "MQTT Log": "MQTT-Protokoll",
    "Traffic": "Verkehr",
    "Waiting for MQTT traffic…": "Warten auf MQTT-Verkehr…",
    "Off. Turn on to watch what the device reports and what Home Assistant sends":
      "Aus. Einschalten, um zu sehen, was das Gerät meldet und was Home Assistant sendet",
    "No command sent yet - the device does not report its switch state.":
      "Noch kein Befehl gesendet – das Gerät meldet seinen Schaltzustand nicht.",
    "The integration was reloaded - turn this on again.":
      "Die Integration wurde neu geladen – bitte erneut einschalten.",
    "This Home Assistant has no mqtt/subscribe command - is the MQTT integration set up?":
      "Dieses Home Assistant hat kein mqtt/subscribe – ist die MQTT-Integration eingerichtet?",
    "No Home Assistant websocket connection.": "Keine WebSocket-Verbindung zu Home Assistant.",
    "Home Assistant is not connected.": "Home Assistant ist nicht verbunden.",
    "Subscribe failed": "Abonnieren fehlgeschlagen",
    "Subscribing to MQTT needs an administrator account (Home Assistant restricts mqtt/subscribe).":
      "MQTT abonnieren erfordert ein Administratorkonto (Home Assistant beschränkt mqtt/subscribe).",
    "Live traffic: what the device reports and what HA sends. Rows marked retained are the broker's stored copy, not a new report.":
      "Live-Verkehr: was das Gerät meldet und was HA sendet. Als retained markierte Zeilen sind die gespeicherte Kopie des Brokers, kein neuer Bericht.",
    "Retained message: the broker replayed its last stored copy when the log opened. The clock is unknown - this is not a live report.":
      "Retained-Nachricht: Der Broker hat beim Öffnen des Protokolls seine letzte gespeicherte Kopie erneut gesendet. Die Uhrzeit ist unbekannt – das ist kein Live-Bericht.",
    "Factory Reset": "Werkseinstellungen",
    "Restore the device to its factory settings? This erases its whole configuration, including the MQTT prefix.":
      "Gerät auf Werkseinstellungen zurücksetzen? Die gesamte Konfiguration einschließlich des MQTT-Präfix wird gelöscht.",
    "Erases the device configuration, including the MQTT prefix":
      "Löscht die Gerätekonfiguration einschließlich des MQTT-Präfix",
    "Reboot the device now?": "Gerät jetzt neu starten?",
    "Reset BLE PIN": "BLE-PIN zurücksetzen",
    "Reset the Bluetooth PIN to its default? The device keeps the rest of its configuration.":
      "Bluetooth-PIN auf den Standardwert zurücksetzen? Die übrige Konfiguration bleibt erhalten.",
    "Back to the default PIN; other settings are kept":
      "Zurück zur Standard-PIN; andere Einstellungen bleiben erhalten",
    "Host": "Master",
    "Master": "Master",
    "Slave": "Slave",
    "This unit carries the system meter": "Dieses Gerät trägt den Systemzähler",
    "Follows the master; its own ports are drawn on the device tab":
      "Folgt dem Master; die eigenen Anschlüsse werden auf der Geräte-Registerkarte gezeichnet",
    "Load Mon": "Mo laden",
    "Wi-Fi Signal": "WLAN-Signal",

    /* ---- TOU editor ---- */
    "Day Plan Editor": "Tagesplan-Editor",
    "Day Plan": "Tagesplan",
    "Week Plan": "Wochenplan",
    "Day ack": "Tagesbestätigung",
    "Week ack": "Wochenbestätigung",
    "Segments": "Abschnitte",
    "Get TOU Plan": "TOU-Plan abrufen",
    "Save & Activate": "Speichern & Aktivieren",
    "Saved and activated": "gespeichert und aktiviert",
    "Reply arrives on tou_plan/status; edited below":
      "Antwort kommt auf tou_plan/status; unten bearbeitet",
    "+ Add Segment": "+ Abschnitt hinzufügen",
    ", not tou_plan.": ", nicht tou_plan.",
    "Force Charge": "Zwangsladen",
    "PV Charge": "PV-Laden",
    "Discharge": "Entladen",

    /* ---- statistics / recorder messages ---- */
    "Reading statistics…": "Statistik wird gelesen…",
    "Loading…": "Wird geladen…",
    "Failed to read statistics": "Statistik konnte nicht gelesen werden",
    "Failed": "Fehlgeschlagen",
    "No data yet.": "Noch keine Daten.",
    "No pack data": "Keine Paketdaten",
    "No energy was recorded in the selected period.":
      "Im gewählten Zeitraum wurde keine Energie aufgezeichnet.",
    "No statistics recorded for this period.":
      "Für diesen Zeitraum wurden keine Statistiken aufgezeichnet.",
    "No statistics recorded for this range (the recorder must be enabled).":
      "Für diesen Zeitraum wurden keine Statistiken aufgezeichnet (der Recorder muss aktiviert sein).",
    "No statistics source found for this device.":
      "Für dieses Gerät wurde keine Statistikquelle gefunden.",
    "No energy sensor of this device was found. Check that the integration is set up and the device is online.":
      "Kein Energiesensor dieses Geräts gefunden. Prüfen, ob die Integration eingerichtet und das Gerät online ist.",
    "Statistics are unavailable — is the recorder enabled?":
      "Statistiken sind nicht verfügbar – ist der Recorder aktiviert?",
    "The recorder integration is unavailable, so long-term statistics cannot be read.":
      "Die Recorder-Integration ist nicht verfügbar, daher können Langzeitstatistiken nicht gelesen werden.",

    /* ---- sankey chrome ---- */
    "Click to Highlight": "Zum Hervorheben klicken",
    "Click again to clear.": "Zum Leeren erneut klicken.",
    "Tip: click a ribbon or a node box to highlight that part of the flow.":
      "Tipp: Auf ein Band oder einen Knoten klicken, um diesen Teil des Flusses hervorzuheben.",
    "Ports are metered independently, so a balance line is shown for conversion losses and unmeasured flows.":
      "Die Anschlüsse werden getrennt gemessen, daher zeigt eine Ausgleichslinie Umwandlungsverluste und ungemessene Flüsse.",
    "Retained · Cached": "retained · zwischengespeichert",
    "Device": "Gerät",
    "Device → HA": "Gerät → HA",
    "HA → Device": "HA → Gerät",
  };

  /* Interpolated strings cannot be dictionary keys, so they are translated by
   * replacing the English *pattern* with a German one.  `{0}`, `{1}`, ...
   * stand for the captured numbers, which keeps the sentence order free. */
  const P_DE = [
    [/^Power control (.+) W \(timer retuned\)$/, "Leistungsregelung $1 W (Timer nachgestellt)"],
    [/^Range (.+) ~ (.+) W\.$/, "Bereich $1 ~ $2 W."],
    [/^Range (.+) ~ (.+) W, sent as \{phase_a, phase_b, phase_c\}\.$/,
      "Bereich $1 ~ $2 W, gesendet als {phase_a, phase_b, phase_c}."],
    [/^(.+) ~ (.+) W, re-send at least once a minute$/,
      "$1 ~ $2 W, mindestens einmal pro Minute erneut senden"],
    [/^(\d+) messages$/, "$1 Nachrichten"],
    [/^ · (\d+) dropped$/, " · $1 verworfen"],
    [/^\((.+) more characters\)$/, "($1 weitere Zeichen)"],
    [/^Powering up…$/, "Wird hochgefahren…"],
    [/^Powering down…$/, "Wird heruntergefahren…"],
    [/^Last command: on \(the device does not report its switch state\)$/,
      "Letzter Befehl: Ein (das Gerät meldet seinen Schaltzustand nicht)"],
    [/^Last command: off \(the device does not report its switch state\)$/,
      "Letzter Befehl: Aus (das Gerät meldet seinen Schaltzustand nicht)"],
    [/^The device reports (.+), so it ignores power control - the EMS mode shown above may be stale\. Switch to (.+) and try again\.$/,
      "Das Gerät meldet $1 und ignoriert daher die Leistungsregelung - der oben angezeigte EMS-Modus ist womöglich veraltet. Auf $2 umschalten und erneut versuchen."],
    [/^Off\. The device drops power control after ~(.+) s - turn this on and Home Assistant keeps sending it, even with no dashboard open\.$/,
      "Aus. Das Gerät verwirft die Leistungsregelung nach ~$1 s - einschalten und Home Assistant sendet sie weiter, auch ohne geöffnetes Dashboard."],
    [/^No entity found for: (.+)$/, "Keine Entität gefunden für: $1"],
    [/^No statistics yet for: (.+)$/, "Noch keine Statistiken für: $1"],
    [/^Could not start the timer: (.+)$/, "Timer konnte nicht gestartet werden: $1"],
    [/^Could not stop the timer: (.+)$/, "Timer konnte nicht gestoppt werden: $1"],
  ];

  /* ------------------------------------------------------------------ *
   * Language primitives
   * ------------------------------------------------------------------ */

  /** Collapse any language tag to the three the family supports. */
  function normalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  /** The user's explicit choice, or "" when they never made one. */
  function stored() {
    try {
      return normalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return "";
    }
  }

  /** Persist a choice and tell every open card about it. */
  function setLang(value) {
    const lang = normalise(value);
    if (!lang) return "";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      /* Private mode: the choice simply does not survive a reload. */
    }
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
    return lang;
  }

  /**
   * Which language the cards should render in.
   *
   * Order is the official contract: an explicit choice beats a per-card
   * `language:`, which beats the Home Assistant user's own language.
   */
  function lang(hass, config) {
    const locale = hass && hass.locale;
    const ui = (locale && locale.language) || (hass && hass.language);
    return stored() || normalise(config && config.language) || normalise(ui) || "en";
  }

  /** Pick one of the two strings every card already carries, or its German. */
  function pick(current, en, zh) {
    if (current === "zh") return zh;
    if (current === "de") {
      const de = T_DE[en];
      if (de != null) return de;
      return dePattern(en);
    }
    return en;
  }

  /** German for an interpolated English string, or the English itself. */
  function dePattern(en) {
    const text = String(en == null ? "" : en);
    for (let i = 0; i < P_DE.length; i += 1) {
      const hit = P_DE[i][0].exec(text);
      if (!hit) continue;
      let out = P_DE[i][1];
      for (let g = hit.length - 1; g >= 1; g -= 1) {
        out = out.split("$" + g).join(hit[g]);
      }
      return out;
    }
    return en;
  }

  /**
   * Resolve one user-supplied config value.
   *
   * A value may be a plain string (used as-is) or a language map
   * `{ en, zh }` as written by the integration's dashboard generator.  A map
   * without the current language falls back to the German dictionary keyed by
   * its `en` entry, then to `en`, then to whichever entry exists - which is
   * what lets the stored dashboards keep their two-key maps and still render
   * German.
   */
  function text(value, current) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const hit = value[current];
      if (hit != null) return hit;
      if (current === "de" && value.en != null) {
        const de = T_DE[value.en];
        if (de != null) return de;
        const patterned = dePattern(value.en);
        if (patterned !== value.en) return patterned;
      }
      if (value.en != null) return value.en;
      const first = Object.values(value)[0];
      return first == null ? "" : first;
    }
    return value;
  }

  /** A text field can only hold a plain string, so a language map shows empty. */
  function field(value) {
    return typeof value === "string" ? value : "";
  }

  /* ------------------------------------------------------------------ *
   * Live updates
   *
   * The toolbar switch changes the preference without reloading anything, so
   * a card has to re-render on its own.  `watch()` wires both the in-page
   * event (the switch) and the cross-tab `storage` event (a second browser
   * tab), and returns an unsubscribe function.
   * ------------------------------------------------------------------ */
  function watch(host, onChange) {
    if (!host) return function () {};
    if (host.__hmLangOff) return host.__hmLangOff;

    const redraw = () => {
      if (typeof onChange === "function") onChange();
      if (typeof host.requestUpdate === "function") host.requestUpdate();
    };
    const onStorage = (event) => {
      if (event && event.key && event.key !== LANG_KEY) return;
      redraw();
    };

    window.addEventListener(LANG_EVENT, redraw);
    window.addEventListener("storage", onStorage);

    const off = () => {
      window.removeEventListener(LANG_EVENT, redraw);
      window.removeEventListener("storage", onStorage);
      host.__hmLangOff = null;
    };
    host.__hmLangOff = off;
    return off;
  }

  function unwatch(host) {
    if (host && typeof host.__hmLangOff === "function") host.__hmLangOff();
  }

  window.HoymilesG2I18n = {
    LANG_KEY: LANG_KEY,
    LANG_EVENT: LANG_EVENT,
    LANG_CHOICES: LANG_CHOICES,
    T_DE: T_DE,
    normalise: normalise,
    stored: stored,
    setLang: setLang,
    lang: lang,
    pick: pick,
    text: text,
    field: field,
    watch: watch,
    unwatch: unwatch,
  };
})();
