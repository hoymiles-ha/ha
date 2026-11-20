/* ============================================================================
 * Hoymiles Micro Storage — Control panel card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-control`
 *
 * Every command from《禾迈微储MQTT协议开发指南》V0.5.1, as buttons / inputs:
 *
 *   §10 switch      homeassistant/switch/<dev_id>/set                 ON | OFF
 *   §11 reboot      homeassistant/button/<dev_id>/reboot/trigger      RESTART
 *   §12 ems mode    homeassistant/select/<dev_id>/ems_mode/command    general |
 *                                                                     mqtt_ctrl |
 *                                                                     tou_plan
 *                   Only the modes the firmware declares in the discovery
 *                   payload are rendered as buttons - a micro inverter offers
 *                   just `general` and `mqtt_ctrl`, so it shows no TOU button
 *                   at all rather than a disabled one.
 *   §13 power ctrl  homeassistant/number/<dev_id>/power_ctrl/set      float (W)
 *   §14 output pwr  homeassistant/number/<dev_id>/output_power/set    int (W)
 *   §15 phase pwr   homeassistant/number/<dev_id>/phase_output_power/set
 *                   {"phase_a":..,"phase_b":..,"phase_c":..}
 *   §20 tou get     homeassistant/sensor/<dev_id>/tou_plan/get        {"week":..}
 *                   Storage models only - a micro inverter declares no `tou_get`
 *                   capability and publishes no `tou_*` topic.
 *   §29 factory reset
 *                   homeassistant/button/<dev_id>/factory_reset/trigger RESET
 *                   Payload is fixed (`RESET`, qos 1, retain false). Declared by
 *                   the HiFlow / HiFlow Pro inverters; erases the device's own
 *                   configuration, so it asks for confirmation first.
 *   §31 ble pin reset
 *                   homeassistant/button/<dev_id>/reset_ble_pin_code/trigger
 *                                                                     RESET
 *                   Same shape and the same models as §29: payload fixed to
 *                   `RESET`, qos 1, retain false. Only the Bluetooth pairing PIN
 *                   is reset, the rest of the configuration is kept.
 *
 * Commands are published straight to those topics (qos 1, retain false), which
 * keeps the card working even when a discovery entity is missing or has a
 * narrower option list than the protocol allows. Current values are read back
 * from the matching entities when they exist.
 *
 * Card config:
 *   type: custom:hoymiles-g2-control
 *   dev_id: MSA-280520260806
 *   language: en                # optional (en|zh); omit to follow Home Assistant
 *   title: Device control
 *   show_phase: true            # optional, default true
 *   show_power_ctrl: true       # optional, default true
 *   show_ems: true              # optional; the EMS mode row. Omitted, it shows
 *                               # only while the unit is not a follower - the
 *                               # document lists `ems_mode` under 「主机和单机」,
 *                               # so a `slave` answers "not supported" to the
 *                               # command and gets no row (see below).
 *   show_tou: true              # optional; the TOU plan row. Omitted, it shows
 *                               # only when the device actually publishes
 *                               # `tou_plan_status` - a micro inverter has no
 *                               # TOU feature at all, so it gets no row.
 *   show_log: true              # optional, default true; the MQTT log row
 *   show_factory_reset: true    # optional; the factory-reset row. Omitted, it
 *                               # follows the product id: protocol §29 declares
 *                               # the command for HiFlow / HiFlow Pro only, so a
 *                               # storage unit gets no row rather than a dead
 *                               # button.
 *   show_ble_pin_reset: true    # optional; the BLE PIN reset row (protocol
 *                               # §31), decided the same way as the row above.
 *   show_topics: true           # optional, default false; show the MQTT topic
 *                               # of every row (engineering detail)
 *   subtitle: false             # optional; hide the grey line under the title
 *
 * Role gating (protocol §32 「状态事件」).  Once this unit's `system_role`
 * sensor reads `slave`, every row whose command topic the document limits to
 * 「主机和单机」 is dropped outright: EMS mode, the power-control lease, the
 * output limit, the per-phase limit and the TOU plan.  A follower answers
 * "not supported" to all of them, so the earlier behaviour - showing the whole
 * panel with nothing behind it - was five dead controls in a row.  Everything
 * marked 「不限」 stays: the power switch and its reboot / PIN / factory-reset
 * buttons work on any role.  An unread role (`unknown`, or the topic not heard
 * from yet) keeps every row, because "not heard yet" is not "follows a master"
 * - and a hard `show_*` override cannot bring a slave's dead row back either.
 *
 * The layout follows the iOS settings idiom: small grey section headers, one
 * rounded group per section, rows of icon + name + right-aligned control, and
 * hairline separators that stop short of the card edge. The MQTT topic paths
 * are hidden by default - they are useful while debugging but noisy in use.
 *
 * The last row of "Plan & maintenance" is an **MQTT log**, off by default. While
 * it is on the card subscribes to the device's topic tree over the Home
 * Assistant websocket (the `mqtt/subscribe` command) and streams both directions
 * in one list: what the device publishes (state topics, discovery configs, TOU
 * acknowledgements) and what Home Assistant sends to it (command topics).
 * Nothing is subscribed - and nothing is shown - while the switch is off, so the
 * card costs nothing until it is needed. `mqtt/subscribe` is an admin-only
 * command in Home Assistant, so a non-admin user sees an explanation instead of
 * a stream.
 * ========================================================================== */

function _hmControlRegister() {
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

  const EMS_MODES = [
    { id: "general", en: "General", zh: "自发自用" },
    { id: "mqtt_ctrl", en: "MQTT ctrl", zh: "MQTT 功率控制" },
    { id: "tou_plan", en: "TOU Plan", zh: "分时计划" },
  ];
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /* Order in which the firmware publishes its `number` discovery configs. HA
   * decorates the duplicate entity ids with `_2`, `_3`, ... so this order is
   * what maps `number.<dev>_2` back to a protocol key.
   *
   * Measured, the order is NOT stable across firmware: `power_ctrl` is the base
   * entity on a storage unit and on a single-input HiFlow, but `_2` on a
   * two-input HiFlow Pro. `_resolve()` therefore tests the declared `min` first
   * and only falls back to this index, so treat this as a last resort. */
  const NUMBER_ORDER = ["power_ctrl", "output_power", "phase_output_power"];

  /* Domains where the firmware publishes exactly one entity, so "the only one on
   * this device" is a sound answer. The number domain is excluded on purpose:
   * it has several entities and a wrong pick would show - and send - the value
   * of a different setting. */
  const SINGLE_ENTITY_DOMAINS = ["select", "switch"];

  /* Rated AC output of **one unit**, in watts, by product id.
   *
   * This is only the **fallback** for the power set-point range (see
   * `_powerRange`): whatever `power_ctrl` itself declares wins, and this table
   * is what is left when the device declares nothing at all.  It matters
   * because a range with no upper bound cannot be drawn - the slider needs a
   * number before the first `power_ctrl/config` arrives.
   *
   * It is worth knowing what "one unit" means, because a *master* can declare
   * the **whole installation's** capability: measured,
   * `RMI-4161A0209FF6/power_ctrl/config` declares `min 0 / max 3000` while the
   * *same* serial declares `0 / 1000` under the `MI-` prefix it used before,
   * because a `master` adds its `slave`'s share.  Values measured off
   * `output_power/config` while each unit ran stand-alone:
   *
   *   1650  HiFlow           800 W
   *   4161  HiFlow Pro 2-in-1 1000 W
   *   4162  HiFlow Pro 4-in-1 2000 W
   *
   * `4160` is deliberately absent: no unit was measured, and trusting the
   * device's own declaration is better than inventing a number. */
  const RATED_W_BY_PID = {
    1650: 800,
    4161: 1000,
    4162: 2000,
  };

  const PING_MS = 8000; // how long the "sent" confirmation stays visible

  /* Power control is a *lease*, not a setting: the firmware remembers the last
   * `power_ctrl` for about a minute and then falls back to `output_power`. A
   * single send therefore produces a burst that matches the requested wattage
   * and then silently jumps back to the output-power ceiling, which reads as
   * "the value jitters and the device ignores me". Re-publishing on a period is
   * the only way to hold it.
   *
   * That beat runs in the integration (`keepalive.py`), not here: a browser
   * timer dies the moment the dashboard is closed, which is exactly when the
   * lease still needs holding. This card only starts and stops the service and
   * reads its retained state back, so a reload shows the truth and leaving the
   * page changes nothing.
   */
  const TIMER_MIN_S = 5;
  /* 60 s is both the ceiling and the reason the timer exists: the firmware only
     holds a `power_ctrl` value for about a minute (`TIMER_LEASE_S`), so a longer
     period leaves the tail of every cycle uncontrolled. Asking for more is
     therefore meaningless, and the input clamps it back to 60 instead of
     accepting a value the device cannot honour. */
  const TIMER_MAX_S = 60;
  const TIMER_DEFAULT_S = 30;
  const TIMER_LEASE_S = 60; // the firmware's own hold time, for the hint text

  /* ------------------------------------------------------------------ *
   * MQTT log
   *
   * One wildcard subscription covers the whole topic tree of this device, so a
   * single stream carries both directions:
   *
   *   homeassistant/<component>/<dev_id>/...   firmware + integration topics
   *   hoymiles/<dev_id>/...                    integration bookkeeping
   *                                            (availability, EMS mode echo)
   *
   * Direction is read off the topic: Home Assistant writes to the command side
   * (`/set`, `/command`, `/trigger`, `/get`), the device publishes everything
   * else. The `hoymiles/` family is the integration's own, so it counts as
   * downlink too. This is a heuristic, but a topic cannot be told apart from
   * its payload, and the alternative (hard-coding every topic of the protocol)
   * would silently miss new ones.
   * ------------------------------------------------------------------ */
  const LOG_DOWNLINK = /\/(set|command|trigger|get)$/;
  const LOG_MAX = 200;          // entries kept (quick/state alone is one a second)
  const LOG_PAYLOAD_MAX = 1200; // characters shown per entry before truncating
  const LOG_QOS = 0;            // observing only: never add broker load

  /* Power on/off is slow: the firmware has to bring the PCS (and the packs)
     down or up again, so the card shows the requested state as pending until
     the device reports it (or gives up after this long). */
  const SWITCH_PENDING_MS = 5000;
  const SWITCH_CONFIRM_MS = 2500; // how long the tick after confirmation stays

  /* ------------------------------------------------------------------ *
   * Remembering the last command
   *
   * Three controls on this card are write-only by design: `power_ctrl`,
   * `output_power` and the power switch all publish to a `command_topic` and the
   * firmware declares no `state_topic` for any of them. Home Assistant therefore
   * has nothing to restore - those entities read `unknown` after every restart -
   * so the card used to come back blank on every visit and the whole set-up
   * (wake the unit, output power, power control, timer) had to be typed in
   * again before anything was under control.
   *
   * What the user expects to find is *what they last sent*, not what the device
   * reports, because it reports nothing. That set is remembered per device in
   * `localStorage` and restored before anything is seeded from an entity.
   *
   * The keep-alive is the one exception honoured over the cache: it runs in the
   * integration, so its `enabled` / `power` / `period` are server-side truth and
   * win over anything remembered here - see `_applyKeepalive`.
   * ------------------------------------------------------------------ */
  const STORE_PREFIX = "hoymiles-g2-control:";

  /** `localStorage` read, guarded: private-mode browsing and quotas both throw. */
  function storeGet(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  /** `localStorage` write, guarded: a full or disabled store only means the card
   * forgets, which must never break the controls. */
  function storeSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* Deliberately silent - the toast area is for command failures. */
    }
  }

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  /* Protocol keys and the names Home Assistant derives entity ids from do not
   * always agree on abbreviations: the protocol says `power_ctrl`, the entity is
   * called "Power Control Keep-alive". Folding `ctrl` into `control` before
   * comparing lets both spellings match without an alias table. */
  function normKey(name) {
    return norm(name).replace(/ctrl/g, "control");
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

  /* ------------------------------ icons ------------------------------
   *
   * The same 24-grid glyph set the vendor's own control card draws, so the
   * Control tab and the app read as one product instead of emoji next to SVG.
   * Every glyph is a function of a per-call id prefix `u`: two cards on one page
   * would otherwise share gradient ids and the second one would paint the
   * first one's colours.
   *
   * The colour vocabulary is the vendor's, and it is consistent across glyphs:
   * amber is power, green is "in" / up, teal is a limit, indigo is sleep, slate
   * is a neutral part (a battery shell, a ceiling bar).
   *
   * The first block is copied glyph for glyph from the official card; the second
   * block adds the four rows this integration has and the official one does not
   * (the re-send timer, the TOU plan, the BLE PIN and the log), drawn in the same
   * language so they do not stand out as borrowed emoji. */
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

    /* ---- power controls: a bolt above a fader ---- */
    powerLimit: (u) => `
      <defs><linearGradient id="${u}p" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <path fill="url(#${u}p)"
        d="M12.6 1.7 6.4 8.9 H12.0 L11.4 13.7 17.6 6.5 H12.0 Z"/>
      <path d="M4.4 19.4h15.2" stroke="#cbd5e1" stroke-width="2.4"
        stroke-linecap="round"/>
      <circle cx="14.9" cy="19.4" r="3.05" fill="#0d9488"/>
      <circle cx="14.9" cy="19.4" r="1.05" fill="#fff"/>`,

    /* ---- max output: an arrow rising until it meets a ceiling ---- */
    ceiling: (u) => `
      <defs><linearGradient id="${u}c" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/>
      </linearGradient></defs>
      <path d="M3.4 4.1h17.2" stroke="#0d9488" stroke-width="2.5"
        stroke-linecap="round"/>
      <path fill="url(#${u}c)"
        d="M12 7 7.1 12.9h3.3v7.4h3.2v-7.4h3.3z"/>`,

    /* ---- per-phase limit: three bars capped by one shared ceiling ---- */
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

    /* ---- sleep: an indigo crescent with a small star ---- */
    moon: (u) => `
      <defs><linearGradient id="${u}m" x1=".2" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#a5b4fc"/><stop offset="1" stop-color="#4f46e5"/>
      </linearGradient></defs>
      <path fill="url(#${u}m)"
        d="M20.1 14.6A9 9 0 0 1 9.3 3.8a9.15 9.15 0 1 0 10.8 10.8z"/>
      <circle cx="17.4" cy="5.1" r="1.45" fill="#c7d2fe"/>
      <circle cx="20.6" cy="8.6" r=".95" fill="#c7d2fe"/>`,

    /* ---- target power: a battery beside an up / down arrow ---- */
    target: (u) => `
      <rect x="2.2" y="6.6" width="8.2" height="11.6" rx="1.9" fill="none"
        stroke="#94a3b8" stroke-width="1.9"/>
      <rect x="4.6" y="3.9" width="3.4" height="2.9" rx=".9" fill="#94a3b8"/>
      <path d="M16.6 16.4V7.6" stroke="#94a3b8" stroke-width="2.2"
        stroke-linecap="round"/>
      <path fill="#16a34a" d="M16.6 2.9 12.3 8.2h8.6z"/>
      <path fill="#ea580c" d="M16.6 21.1 12.3 15.8h8.6z"/>`,

    /* ---- input limit: an arrow coming down onto a floor ---- */
    plug: (u) => `
      <defs><linearGradient id="${u}i" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#0284c7"/>
      </linearGradient></defs>
      <path d="M12 3.1v9.4" stroke="url(#${u}i)" stroke-width="2.6"
        stroke-linecap="round"/>
      <path fill="url(#${u}i)" d="M12 17.6 6.9 12.4h3.4V9.8h3.4v2.6h3.4z"/>
      <path d="M4.1 20.6h15.8" stroke="#94a3b8" stroke-width="2.4"
        stroke-linecap="round"/>`,

    /* ---- heating: an amber flame ---- */
    heat: (u) => `
      <defs><linearGradient id="${u}h" x1=".2" y1="0" x2=".9" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#ea580c"/>
      </linearGradient></defs>
      <path fill="url(#${u}h)"
        d="M12.6 2.4c3 3.4 5.6 6 5.6 9.4a6.2 6.2 0 1 1-12.4 0c0-2 .9-3.6 2.4-4.9.3 1.7 1.2 2.9 2.5 3.3-.6-2.7-.3-5 1.9-7.8z"/>
      <path fill="#fde68a"
        d="M12.1 12.4c1.4 1.5 2.4 2.6 2.4 4a2.6 2.6 0 1 1-5.2 0c0-1.4 1.4-2.7 2.8-4z"/>`,

    /* ---- the card's own badge: a battery beside the two limit arrows ---- */
    socBattery: (u) => `
      <rect x="5.75" y="2.2" width="4.5" height="2.6" rx="1" fill="#94a3b8"/>
      <rect x="2.4" y="4.6" width="11.2" height="16.2" rx="2.6" fill="none"
        stroke="#94a3b8" stroke-width="1.7"/>
      <rect x="4.7" y="15.9" width="6.6" height="3.9" rx="1.1" fill="#16a34a"/>
      <rect x="4.7" y="11.5" width="6.6" height="3.9" rx="1.1" fill="#22c55e"/>
      <rect x="4.7" y="7.1" width="6.6" height="3.9" rx="1.1" fill="#cbd5e1"/>
      <path d="M19.3 10.9V6.4" stroke="#16a34a" stroke-width="1.9"
        stroke-linecap="round"/>
      <path fill="#16a34a" d="M19.3 3.4 16.6 7.4h5.4z"/>
      <path d="M19.3 13.1v4.5" stroke="#f59e0b" stroke-width="1.9"
        stroke-linecap="round"/>
      <path fill="#f59e0b" d="M19.3 20.6 16.6 16.6h5.4z"/>`,

    /* ---- cut-off SOC: the two batteries of the dual-handle slider ---- */
    batteryOut: (u) => `
      <rect x="9.7" y="2.4" width="4.6" height="2.8" rx="1.1" fill="#f59e0b"/>
      <rect x="6.3" y="5" width="11.4" height="16.6" rx="2.8" fill="none"
        stroke="#f59e0b" stroke-width="1.9"/>
      <rect x="8.6" y="15.9" width="6.8" height="4" rx="1.1" fill="#f59e0b"/>`,

    batteryIn: (u) => `
      <rect x="9.7" y="2.4" width="4.6" height="2.8" rx="1.1" fill="#16a34a"/>
      <rect x="6.3" y="5" width="11.4" height="16.6" rx="2.8" fill="none"
        stroke="#16a34a" stroke-width="1.9"/>
      <rect x="8.6" y="15.9" width="6.8" height="4" rx="1.1" fill="#16a34a"/>
      <rect x="8.6" y="11.4" width="6.8" height="4" rx="1.1" fill="#16a34a"/>`,

    /* ---- re-send timer: a clock, because the row is about *when* ----
       Drawn as a bare ring rather than the usual ticked face: at 18 px the
       hour marks turn into grit, and the two hands alone already say "time".
       The green hand is the one that moves, the teal stub is the hub. */
    timer: (u) => `
      <path d="M9.2 2.7h5.6" stroke="#94a3b8" stroke-width="2"
        stroke-linecap="round"/>
      <circle cx="12" cy="13.1" r="7.9" fill="none" stroke="#94a3b8"
        stroke-width="2"/>
      <path d="M12 13.1V8.3" stroke="#16a34a" stroke-width="2.2"
        stroke-linecap="round"/>
      <path d="m12 13.1 4 2.9" stroke="#0d9488" stroke-width="2.2"
        stroke-linecap="round"/>
      <circle cx="12" cy="13.1" r="1.2" fill="#0d9488"/>`,

    /* ---- TOU plan: a calendar with one filled day ---- */
    schedule: (u) => `
      <rect x="2.9" y="5.3" width="18.2" height="15.5" rx="2.8" fill="none"
        stroke="#94a3b8" stroke-width="1.9"/>
      <path d="M2.9 9.7h18.2" stroke="#94a3b8" stroke-width="1.9"/>
      <path d="M7.7 3.1v3.7M16.3 3.1v3.7" stroke="#0d9488" stroke-width="2"
        stroke-linecap="round"/>
      <rect x="6.4" y="12.2" width="3.7" height="3.3" rx=".9" fill="#16a34a"/>
      <rect x="13.9" y="12.2" width="3.7" height="3.3" rx=".9" fill="#cbd5e1"/>`,

    /* ---- BLE PIN: a key, indigo to match the "credential" idea ---- */
    pin: (u) => `
      <circle cx="8.2" cy="15.7" r="4.4" fill="none" stroke="#6366f1"
        stroke-width="2"/>
      <path d="M11.4 12.5 20 3.9" stroke="#6366f1" stroke-width="2.2"
        stroke-linecap="round"/>
      <path d="m16.7 7.2 2.1 2.1M19 4.9l2.1 2.1" stroke="#6366f1" stroke-width="2"
        stroke-linecap="round"/>`,

    /* ---- factory reset: two counter-clockwise arrows, in warning orange ---- */
    factory: (u) => `
      <defs><linearGradient id="${u}f" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fdba74"/><stop offset="1" stop-color="#ea580c"/>
      </linearGradient></defs>
      <path fill="none" stroke="url(#${u}f)" stroke-width="2.3" stroke-linecap="round"
        d="M19.4 9.1A7.6 7.6 0 0 0 6.2 7.2"/>
      <path fill="#ea580c" d="M5.1 3.3 6 8.9l5.4-2z"/>
      <path fill="none" stroke="url(#${u}f)" stroke-width="2.3" stroke-linecap="round"
        d="M4.6 14.9A7.6 7.6 0 0 0 17.8 16.8"/>
      <path fill="#ea580c" d="M18.9 20.7 18 15.1l-5.4 2z"/>`,

    /* ---- log: three slanted lines of text ---- */
    log: (u) => `
      <g stroke-linecap="round">
        <path d="M3.8 6.2h11.6" stroke="#0d9488" stroke-width="2.1"/>
        <path d="M3.8 11.7h16.4" stroke="#94a3b8" stroke-width="2.1"/>
        <path d="M3.8 17.2h13.2" stroke="#94a3b8" stroke-width="2.1"/>
      </g>
      <circle cx="19.1" cy="6.2" r="1.5" fill="#16a34a"/>`,

    dot: () => `<circle cx="12" cy="12" r="4" fill="currentColor"/>`,
  };

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
        _logOpen: { type: Boolean },
        _timerOn: { type: Boolean },
        _timerPeriod: { type: String },
        _timerCount: { type: Number },
        _timerLastAt: { type: Number },
        _timerError: { type: String },
        _timerBusy: { type: Boolean },
        /* The wattage the running beat is holding. Kept separately from
           `_powerCtrl` because the slider is an input in flight, not a
           statement of what the device is doing. */
        _timerPower: { type: Number },
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
      /* When the EMS mode was last commanded from this card.  Needed because the
         select's state topic is event driven and never echoes a command, so the
         row has to trust the user's pick (see `_emsMode`). */
      this._emsCommandAt = 0;
      /* MQTT log. The entries live in `_log` (the source of truth) and are
         appended to the DOM by hand - see `_syncLogDom` for why. */
      this._logOpen = false;
      this._log = [];
      this._logDropped = 0;
      this._logErr = "";
      this._logList = null;
      this._logUnsubs = [];
      this._logGen = 0;
      /* Periodic re-send of the power-control lease, mirrored from the
         integration. The card never owns the beat: it starts the service and
         then follows the retained state topic, so the switch stays correct after
         a reload and leaving the dashboard stops nothing. */
      this._timerOn = false;
      this._timerPeriod = String(TIMER_DEFAULT_S);
      this._timerCount = 0;
      this._timerLastAt = 0;
      this._timerError = "";
      this._timerBusy = false;
      this._timerPower = NaN;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-g2-control-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        /* Card grid, the same vocabulary the micro storage page uses: every
           control family owns its own <ha-card>, the header is a small
           uppercase label, and the rows inside are separated by hairlines
           instead of being boxed in a grey block.  The two cards therefore
           read as one system, whichever device the page belongs to. */
        :host { display: block; }
        .grid { display: grid; gap: 14px; align-items: start;
                grid-template-columns: repeat(2, minmax(0, 1fr)); }
        @media (max-width: 760px) {
          .grid { grid-template-columns: minmax(0, 1fr); }
        }
        .grid > .wide { grid-column: 1 / -1; }

        ha-card { padding: 15px 17px 17px; border-radius: 16px; }

        /* Only drawn when the card was given an explicit title; the generated
           dashboard leaves it out, so the page header is the only title. */
        .head { display: flex; align-items: baseline; gap: 10px;
                flex-wrap: wrap; margin-bottom: 14px; }
        .head:only-child { margin-bottom: 0; }
        .head .title { font-size: 17px; font-weight: 600;
                       color: var(--primary-text-color); }
        .head .sub { font-size: 12.5px; color: var(--secondary-text-color); }

        .c-head { display: flex; align-items: center; gap: 9px; margin: 0 0 2px; }
        .c-head .ct { font-size: 12.5px; font-weight: 600; line-height: 1.25;
                      letter-spacing: .05em; text-transform: uppercase;
                      color: var(--primary-text-color); }

        .item { display: flex; align-items: center; gap: 12px;
                padding: 11px 0; min-height: 52px;
                box-sizing: border-box; position: relative; }
        /* The card is narrow once the two-column grid splits, so a row that does
           not fit has to wrap instead of spilling: the control moves to its own
           line below the label. Without this the segmented control was cut off
           once the dashboard column shrank. */
        .item:not(.stack) { flex-wrap: wrap; }
        /* Separators run the full card width now that the rows are not sitting
           inside a padded grey box. */
        .item + .item::before {
          content: ""; position: absolute; top: 0; left: 0; right: 0;
          height: 1px; background: var(--divider-color); opacity: .7;
        }
        .item .ico { flex: 0 0 auto; width: 24px; text-align: center;
                     font-size: 16px; line-height: 1; }
        /* The glyph set draws itself on a 24 grid, so the box is 24 px wide and
           the SVG inside is centred on both axes; without the flex centring an
           inline SVG sits on the text baseline and every icon rides too high. */
        .item .ico .ic { display: inline-flex; align-items: center;
                         justify-content: center; line-height: 1; color: inherit; }
        .item .ico .ic svg { display: block; }
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

        /* MQTT log. It sits inside the "Plan & maintenance" group, directly
           under its own row, and grows downwards - the panel itself is the
           scroll container so the card never jumps. */
        .log-block { border-top: 1px solid var(--divider-color); }
        .log-head { display: flex; align-items: center; gap: 8px;
                    flex-wrap: wrap; padding: 10px 0 6px; }
        .log-head .log-title { font-size: 12.5px; font-weight: 500;
                               color: var(--primary-text-color); }
        .log-head .log-count { font-size: 12px; margin-right: auto;
                               color: var(--secondary-text-color);
                               font-variant-numeric: tabular-nums; }
        .log-list { display: flex; flex-direction: column; gap: 6px;
                    max-height: 340px; overflow: auto; padding: 0 0 8px; }
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
        /* A retained message is the broker's stored copy, not a live frame - it
           gets a dashed, neutral badge so it cannot be read as an up-to-date
           report from the device. */
        .log-row .log-dir.retained { background: transparent;
                                     color: var(--secondary-text-color);
                                     border: 1px dashed var(--divider-color);
                                     font-style: italic; }
        .log-row .log-time.cached { font-style: italic; opacity: .7; }
        .log-row .log-topic { font-family: ui-monospace, SFMono-Regular, Menlo,
                              Consolas, monospace; word-break: break-all;
                              color: var(--primary-text-color); }
        /* The device id repeats on every line; dimming it keeps the paths easy
           to scan. It is still part of the text, so a selection copies the
           real topic. */
        .log-row .log-topic .log-dev { color: var(--secondary-text-color); }
        /* No max-height, no overflow: the payload grows the row and the list is
           the single scroll region. The old inner scrollbar meant two nested
           scrollbars whenever a payload was long. */
        .log-row pre.log-payload { margin: 4px 0 0; white-space: pre-wrap;
                                   word-break: break-all; line-height: 1.45;
                                   font-size: 11.5px;
                                   font-family: ui-monospace, SFMono-Regular, Menlo,
                                   Consolas, monospace;
                                   color: var(--secondary-text-color); }
        .log-hint { padding: 0 0 10px; font-size: 12px;
                    color: var(--secondary-text-color); }
        .log-hint.err { color: var(--error-color); }
        .btn.small { padding: 5px 10px; font-size: 12.5px; }
        .toast { margin-top: 12px; font-size: 13px; padding: 10px 13px;
                 border-radius: 12px;
                 background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        .toast.err { color: var(--error-color); }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-g2-control: 'dev_id' is required");
      }
      const changed = this._config && this._config.dev_id !== config.dev_id;
      this._config = { ...config };
      this._cache.clear();
      this._initialised = false;
      /* A different device means different topics, so the open log has to let
         go of the old ones. Closing it is friendlier than silently subscribing
         to the new device: the user asked for that view. */
      if (changed && this._logOpen) this._closeLog();
      /* A different device means different topics. The keep-alive belongs to the
         old device and must not be stopped for it (the user may still want it
         running), so this only drops the local mirror and re-reads the new
         device's own state. */
      if (changed) {
        this._timerOn = false;
        this._timerCount = 0;
        this._timerLastAt = 0;
        this._timerError = "";
        this._timerPower = NaN;
        this._timerPeriod = String(TIMER_DEFAULT_S);
        /* The saved set is per device, so switching device must also drop the
           restored switch / EMS command - they belonged to the previous unit. */
        delete this._optimistic.switch;
        delete this._optimistic.ems_mode;
        this._emsCommandAt = 0;
      }
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._initialised) this._seedInputs();
      this._reconcileSwitch();
      /* The beat runs in the integration, so its running state arrives as an
         entity state - reading it here means every update re-syncs the row for
         free, and a card opened after the fact shows the truth immediately. */
      this._syncKeepalive();
      this.requestUpdate();
    }

    getCardSize() {
      /* A grid of independent cards, the same estimate the storage page uses:
         roughly two columns of three rows on a desktop dashboard. Lovelace only
         uses this as a hint. */
      return 10;
    }

    connectedCallback() {
      super.connectedCallback();
      /* The toolbar language switch only writes localStorage and fires
         `hoymiles-language`; it never touches `hass.language`, so the card has
         to re-render itself when it changes. */
      I18N.watch(this);
      /* Dashboards disconnect cards when a view is left; coming back with the
         log still switched on must resume the stream. The guard also keeps a
         re-connect from subscribing twice. */
      if (this._logOpen && !this._logUnsubs.length) this._subscribeLog();
    }

    disconnectedCallback() {
      I18N.unwatch(this);
      super.disconnectedCallback();
      if (this._toastTimer) clearTimeout(this._toastTimer);
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
      this._unsubscribeLog();
      /* Deliberately nothing here stops the keep-alive: the whole point of
         moving it into the integration is that leaving the dashboard (or
         closing the browser) must not drop the power limit. Stop it from the
         row's own Off button, the stop service, or an automation. */
    }

    updated() {
      this._syncLogDom();
    }

    /* ----------------------------- lookups ----------------------------- */

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
    /**
     * Entity ids the card config pins to some *other* protocol key.
     *
     * `power_ctrl` and `output_power` are both plain `number` entities of the
     * same device, so every heuristic below can hand the same entity to both.
     * A config that pins `output_power: number.<dev>` therefore made the
     * `power_ctrl` row read that very entity - showing the output power's
     * range and step on the power control row, and (worse) letting one row's
     * declared bounds describe the other's setting. An explicit pin is the
     * one authoritative signal the frontend actually gets, so an entity
     * claimed by another key is excluded from every guess here.
     */
    _claimedByOther(key) {
      const overrides = this._config.entities || {};
      const claimed = new Set();
      for (const [other, entityId] of Object.entries(overrides)) {
        if (other === key) continue;
        if (typeof entityId !== "string" || !entityId) continue;
        // A pin that contradicts its own key (`_pinFits`) names the setting
        // this call is looking for, so it must not reserve it.
        if (!this._pinFits(other, entityId)) continue;
        claimed.add(entityId);
      }
      claimed.delete(overrides[key]);
      return claimed;
    }

    /* Is a pinned entity actually able to be `key`?
     *
     * Entity ids are slugified from the *name*, and the firmware names all
     * three `number` entities after the device, so the base id `number.<dev>`
     * is merely whichever one was created first: `output_power` on a two-input
     * HiFlow Pro (declared `100 ~ 3000`), `power_ctrl` on a single-input
     * HiFlow (declared `0 ~ 132`). A dashboard generated for one model and
     * copied to the other therefore pins the *wrong* setting - measured, that
     * made the power-control row offer `100 ~ 800` while the output-power row
     * offered `0 ~ 132`, i.e. both rows showed each other's range.
     *
     * The declared floor separates the two on every model measured:
     * `power_ctrl` can curtail to nothing (and below, on a storage unit), while
     * `output_power` starts at the hardware minimum of 100 W. So a pin that
     * contradicts its key is ignored and the resolution below decides. When the
     * entity carries no declared `min` there is nothing to judge it by, and the
     * config stays authoritative.
     */
    _pinFits(key, entityId) {
      if (!entityId) return false;
      if (key !== "power_ctrl" && key !== "output_power") return true;
      const hass = this._hass;
      const state = hass && hass.states ? hass.states[entityId] : null;
      const declared = state && state.attributes ? state.attributes.min : null;
      if (declared == null) return true;
      const lo = num(declared);
      return key === "power_ctrl" ? lo <= 0 : lo > 0;
    }

    _resolve(key, domain = "number") {
      const overrides = this._config.entities || {};
      if (overrides[key] && this._pinFits(key, overrides[key])) {
        return overrides[key];
      }

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const claimed = this._claimedByOther(key);
      const cacheKey = `${domain}:${key}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached] && !claimed.has(cached)) return cached;

      let found = null;
      const wantUid = new Set([
        `${this._dev()}_${key}`,
        `hoymiles_${this._dev()}_${key}`,
      ]);
      for (const [entityId, entry] of Object.entries(hass.entities || {})) {
        if (!entry || !entityId.startsWith(`${domain}.`)) continue;
        if (claimed.has(entityId)) continue;
        if (wantUid.has(entry.unique_id)) { found = entityId; break; }
      }

      if (!found) {
        const prefix = `${domain}.${slug(this._dev())}`;
        const wanted = norm(key);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          if (claimed.has(entityId)) continue;
          const tail = norm(entityId.slice(prefix.length + 1));
          if (tail !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      /* Device-scoped tail match: "the entity of this device whose id ends with
       * the protocol key". This is what survives a renamed entity - the id may
       * pick up an area prefix (`wo_shi_...`) or spell `ctrl` out as `control`,
       * but the tail still names the setting. Scoped to the device, so a match
       * can never cross over to another inverter. */
      if (!found) {
        const wanted = normKey(key);
        const scoped = this._deviceEntityIds(domain)
          .filter((entityId) => !claimed.has(entityId))
          .filter((entityId) => normKey(entityId).endsWith(wanted));
        if (scoped.length === 1) found = scoped[0];
        else if (scoped.length > 1) {
          // Prefer the shortest id: a rename adds prefixes, it does not shorten.
          scoped.sort((a, b) => a.length - b.length || a.localeCompare(b));
          found = scoped[0];
        }
      }

      /* The discovery object's own `name` reaches the frontend even when the
       * entity id does not: `hass.entities[id].name` is what the firmware
       * published ("Factory Reset", "Reset BLE PIN Code", "Power Control"),
       * while the entity id collapses to `button.<dev>`, `button.<dev>_2`, ...
       * because the discovery payload names every object after the device.
       * `normKey` folds `ctrl` into `control`, so "Power Control" and
       * `power_ctrl` compare equal.
       *
       * This is what makes the three maintenance buttons resolvable at all:
       * unlike the numbers they have no declared range to separate them and no
       * telling id tail, so without the published name `factory_reset` and
       * `reboot` are indistinguishable - which used to hide both rows even
       * though the device really did publish both /config topics. */
      if (!found) {
        const wanted = normKey(key);
        const byName = this._deviceEntityIds(domain).filter((entityId) => {
          if (claimed.has(entityId)) return false;
          const entry = hass.entities ? hass.entities[entityId] : null;
          const name = entry && entry.name;
          return !!name && normKey(name) === wanted;
        });
        if (byName.length === 1) [found] = byName;
        else if (byName.length > 1) {
          byName.sort((a, b) => a.length - b.length || a.localeCompare(b));
          [found] = byName;
        }
      }

      // The firmware's own number entities are unhelpfully named: the MQTT
      // discovery topics carry the object id (power_ctrl / output_power /
      // phase_output_power) but HA names all three after the device, so their
      // entity ids collapse to `number.<dev>`, `number.<dev>_2`, `_3 ...` and
      // neither the friendly name nor the registry snapshot distinguishes them
      // (HA does not expose unique_id to the frontend).
      //
      // The duplicate suffix order is *not* stable across firmware: measured,
      // `power_ctrl` is the base entity on a storage unit (min -2500, step 0.1)
      // and on a single-input HiFlow (min 0, cap 132), but `_2` on a two-input
      // HiFlow Pro (min 0, step 0.1) - whose base is `output_power` (min 100).
      // So a fixed index picks the wrong entity on two of the three models.
      //
      // What *is* stable is the declared range: the firmware gives `power_ctrl`
      // a floor at or below zero (it can curtail to nothing, and on a storage
      // unit also charge/export negative), while `output_power` starts at the
      // hardware minimum, 100 W on every model measured. Resolve by bounds when
      // exactly one candidate fits and only fall back to the index otherwise.
      // `entities` in the card config overrides all of this.
      if (!found && domain === "number") {
        const index = NUMBER_ORDER.indexOf(key);
        if (index >= 0) {
          const base = `${domain}.${slug(this._dev())}`;
          // `number.<dev>`, `number.<dev>_2`, `number.<dev>_3`, ...
          // The device SN is numeric too, so the duplicate suffix must be short
          // (`_2`), never the SN itself (`number.<dev>_280520260806`).
          const numbered = Object.keys(hass.states).filter((entityId) => {
            if (claimed.has(entityId)) return false;
            if (entityId === base) return true;
            return new RegExp(`^${base.replace(/\./g, "\\.")}_\\d{1,2}$`).test(entityId);
          });
          const order = (entityId) => {
            if (entityId === base) return 0;
            const m = entityId.match(/_(\d+)$/);
            return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
          };
          numbered.sort((a, b) => order(a) - order(b));

          const declaredMin = (entityId) => {
            const state = hass.states[entityId];
            const value = state && state.attributes ? state.attributes.min : null;
            return value == null ? null : num(value);
          };
          /* Does the firmware's own declared floor prove this entity is the
           * *other* setting? `power_ctrl` can curtail to nothing, `output_power`
           * starts at the hardware minimum of 100 W. Returns false when there is
           * no declared `min` to judge by, so an unknown range never vetoes. */
          const contradicted = (entityId) => {
            const lo = declaredMin(entityId);
            if (lo == null || !Number.isFinite(lo)) return false;
            return key === "power_ctrl" ? lo > 0 : lo <= 0;
          };
          let picked = null;
          if (key === "power_ctrl") {
            // `min <= 0` is `power_ctrl` and nothing else.
            const zeroFloor = numbered.filter((entityId) => {
              const lo = declaredMin(entityId);
              return lo != null && Number.isFinite(lo) && lo <= 0;
            });
            if (zeroFloor.length === 1) [picked] = zeroFloor;
          } else if (key === "output_power") {
            // `min > 0` narrows it down to the rated-output entities, which at
            // least removes `power_ctrl` from the pool.
            const ratedFloor = numbered.filter((entityId) => {
              const lo = declaredMin(entityId);
              return lo != null && Number.isFinite(lo) && lo > 0;
            });
            if (ratedFloor.length === 1) [picked] = ratedFloor;
          }
          /* The index is only trustworthy when the declared ranges cannot
           * separate the two settings at all. Falling back to it regardless is
           * how a device that retained **only** `output_power/config` still got
           * a power-control row: its single `number` entity occupies slot 0, and
           * slot 0 is `power_ctrl`. A candidate the firmware positively
           * contradicts is the other setting, so no row at all is the honest
           * answer - better than a slider that silently writes the wrong topic. */
          if (!picked && numbered[index] && !contradicted(numbered[index])) {
            picked = numbered[index];
          }
          if (picked) found = picked;
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

    /* Declared attributes survive an unusable state, the value does not.
     *
     * `min` / `max` / `step` / `options` are part of the entity's declaration and
     * are present even while its state reads `unknown` - which is exactly the
     * situation right after setup, before the device has accepted a command (a
     * number entity whose firmware publishes no state topic stays `unknown`
     * indefinitely). Reading them through `_state()` therefore threw the range
     * away and every consumer fell back to the protocol default, so a HiFlow Pro
     * whose firmware declares `100 ~ 1000 W` offered `100 ~ 2000 W` - a range the
     * device rejects. The value lookup keeps the strict filter, because a stale
     * number is worse than no number.
     */
    _attr(key, domain, name) {
      const entityId = this._resolve(key, domain);
      if (!entityId || !this._hass || !this._hass.states) return null;
      const state = this._hass.states[entityId];
      if (!state || !state.attributes) return null;
      const value = state.attributes[name];
      return value === undefined ? null : value;
    }

    /** True when this device actually has that entity.
     *
     * The integration only creates the entities a model implements (it gates on
     * the capabilities the firmware declares), so a missing entity is a reliable
     * "this device has no such feature" signal - much better than guessing from
     * the model name. Rows backed by a missing entity are dropped instead of
     * being rendered as controls that quietly do nothing.
     */
    _hasEntity(key, domain) {
      return this._resolve(key, domain) != null;
    }

    /** This unit's role in the installation: `single` / `master` / `slave`.
     *
     * Protocol §32 `event/state` is the only carrier of the role, and the
     * integration mirrors it as the `system_role` sensor (see `_role_value()` in
     * `sensor.py`, which already normalises the `servant` spelling).  Reading it
     * from the state machine rather than from the attributes of that sensor's
     * payload means the value is available on any dashboard the card is placed
     * on, not just on the generated one.
     *
     * `null` means "not known": the topic has not arrived yet, the sensor is
     * `unknown`, or its state is a spelling this card does not recognise.  Every
     * caller treats that as "do not hide anything", so a slow MQTT connect can
     * never blank the panel out.
     */
    _role() {
      const state = this._state("system_role", "sensor");
      if (!state) return null;
      const value = String(state.state).trim().toLowerCase();
      if (value === "servant") return "slave";
      return value === "single" || value === "master" || value === "slave"
        ? value
        : null;
    }

    /** Entity ids the registry attributes to *this* device.
     *
     * `hass.entities` does expose `device_id`, and `hass.devices` carries the
     * device's identifiers, so the device can be found from the configured
     * `dev_id` even when the entity was renamed. That matters: a user-renamed
     * entity keeps its `unique_id` but gets a new entity id, and the frontend
     * registry snapshot does not ship `unique_id` at all - so neither guessing
     * the id nor matching on unique_id works after a rename. The device link is
     * the only stable join.
     */
    _deviceEntityIds(domain) {
      const hass = this._hass;
      if (!hass || !hass.entities || !hass.devices) return [];

      /* One unit, two devices. This integration registers
       * `hoymiles` -> `RMI-4161A0209FF6`; MQTT discovery registers
       * `mqtt` -> `4161A0209FF6` (no model prefix) for the same serial. The
       * control objects - switch, select, number, button - arrive over MQTT
       * discovery, so they hang off the *second* device. Looking only at the
       * first matched a device with no control entities at all and scoped every
       * name lookup to an empty set, which is why the reboot / factory-reset
       * rows stayed hidden while the device really had published them. */
      const dev = String(this._dev()).toLowerCase();
      const bare = dev.replace(/^[a-z]{1,3}-/, "");
      const deviceIds = new Set();
      for (const [id, device] of Object.entries(hass.devices)) {
        const ids = (device && device.identifiers) || [];
        for (const pair of ids) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const scope = String(pair[0]).toLowerCase();
          if (scope !== "hoymiles" && scope !== "mqtt") continue;
          const value = String(pair[1]).toLowerCase();
          if (value === dev || value === bare) { deviceIds.add(id); break; }
        }
      }
      if (!deviceIds.size) return [];

      const out = [];
      for (const [entityId, entry] of Object.entries(hass.entities)) {
        if (!entry || !deviceIds.has(entry.device_id)) continue;
        if (domain && !entityId.startsWith(`${domain}.`)) continue;
        if (!hass.states || !hass.states[entityId]) continue;
        out.push(entityId);
      }
      return out;
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
     *
     * Order matters and is the whole point of the persisted cache:
     *
     * 1. what this browser last sent (`_restore`) - the write-only controls have
     *    no entity value to speak of, so this is normally the only source;
     * 2. what the entity reports, when it has a usable value;
     * 3. the clamp against the entity's declared bounds either way.
     *
     * The earlier version returned early unless the entity had a value, and with
     * both `number` entities permanently `unknown` that meant nothing was ever
     * seeded and the sliders stayed at their defaults - the exact "I have to set
     * everything again" complaint.
     */
    _seedInputs() {
      if (!this._hass || !this._hass.states) return;
      const saved = this._restore();
      const pc = this._number("power_ctrl");
      const op = this._number("output_power");
      let any = false;
      const pick = (live, remembered) => {
        if (live != null) return { value: live, from: "live" };
        if (Number.isFinite(remembered)) return { value: remembered, from: "saved" };
        return null;
      };
      const pcPick = pick(pc, saved.power_ctrl);
      if (pcPick) {
        const { lo, hi } = this._powerRange();
        this._powerCtrl = String(this._clamp(pcPick.value, lo, hi));
        any = true;
      }
      const opPick = pick(op, saved.output_power);
      if (opPick) {
        const b = this._bounds("output_power", 100, 2000);
        this._outputPower = String(this._clamp(opPick.value, b.lo, b.hi));
        any = true;
      } else {
        /* Neither live nor remembered: leave the box genuinely empty (rendered
           with a placeholder, not as "0"). The slider still parks at the low
           bound, which is the only value the device is certain to accept, but
           that is a drawing position and is never published on its own. */
        this._outputPower = "";
      }
      /* Nothing was ever sent for power control: start it at the output power,
         which is the wattage the device already holds by default. Leaving the
         slider empty made the row read "0 W" on a unit that was producing, and
         it is never a value anyone wants to keep. */
      if (!pcPick && opPick) {
        const { lo, hi } = this._powerRange();
        this._powerCtrl = String(this._clamp(opPick.value, lo, hi));
      }
      const phases = ["a", "b", "c"];
      let anyPhase = false;
      for (const p of phases) {
        const live = this._number(`phase_${p}_output_power`)
          ?? this._number("phase_output_power");
        const remembered = saved.phase ? Number(saved.phase[p]) : NaN;
        const use = live != null ? live : remembered;
        if (Number.isFinite(use)) {
          const b = this._bounds("phase_a_output_power", 100, 2500);
          this._phase[p] = String(this._clamp(use, b.lo, b.hi));
          anyPhase = true;
        }
      }
      any = any || anyPhase;
      /* The switch command is remembered even though the user cannot see it on
         an entity: restoring it makes the segment show 开机 / 关机 as chosen
         instead of falling back to "no command sent yet". */
      if (saved.switch === "on" || saved.switch === "off") {
        this._optimistic.switch = saved.switch;
        any = true;
      }
      if (saved.ems_mode) {
        this._optimistic.ems_mode = saved.ems_mode;
        /* The remembered record carries the moment it was written; without it a
           reload would make our own pick look eternally fresher than the
           device's reports and the row would stop following the hardware. */
        this._emsCommandAt = Number(this._remembered().at) || 0;
        any = true;
      }
      if (Number.isFinite(saved.timer_period)) {
        this._timerPeriod = String(this._clampPeriod(saved.timer_period));
        any = true;
      }
      if (!any) return; // nothing to seed yet
      this._initialised = true;
    }

    /** The remembered command set for this device, or `{}`. */
    _remembered() {
      const raw = storeGet(`${STORE_PREFIX}${this._dev()}`);
      return raw && typeof raw === "object" ? raw : {};
    }

    /**
     * Load the remembered set into the fields this card controls.
     *
     * Returns only the numeric values: the date stamp and the switch value are
     * handled separately, because the switch must not be restored as an
     * "in-flight" command (it was sent long ago and is not awaiting anything).
     */
    _restore() {
      const raw = this._remembered();
      const out = {
        power_ctrl: Number(raw.power_ctrl),
        output_power: Number(raw.output_power),
        timer_period: Number(raw.timer_period),
        switch: raw.switch,
        ems_mode: raw.ems_mode,
        phase: raw.phase && typeof raw.phase === "object" ? raw.phase : null,
      };
      /* A remembered value outside the entity's present bounds is dropped rather
         than clamped: the range can shrink after a firmware update, and silently
         pinning a stale 700 W to a device now capped at 132 W would be a lie
         about what was sent. `_seedInputs` clamps whatever survives. */
      return out;
    }

    /**
     * Persist the last command of one control.
     *
     * Called from the send paths, never from the render path: a slider drag is
     * an input in flight, and remembering it would make the card reopen on a
     * value that was never sent.
     */
    _remember(patch) {
      const key = `${STORE_PREFIX}${this._dev()}`;
      const prev = this._remembered();
      storeSet(key, { ...prev, ...patch, at: Date.now() });
    }

    /* ------------------------------ sending ------------------------------ */

    async _publish(topic, payload, label, opts) {
      if (!this._hass || typeof this._hass.callService !== "function") return;
      /* `quiet` suppresses the success toast only. The timer repeats the same
         command every few seconds, and a toast each time would cover the card
         permanently - its progress lives on the row's own sub-line instead. A
         failure is still reported, because that is exactly what must not pass
         unnoticed. */
      const quiet = Boolean(opts && opts.quiet);
      try {
        await this._hass.callService("mqtt", "publish", {
          topic,
          payload: typeof payload === "string" ? payload : JSON.stringify(payload),
          qos: 1,
          retain: false,
        });
        if (!quiet) this._showToast(`${this._t("Sent", "已下发")} ${label} → ${topic}`);
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
      /* Remembered so a reload shows 开机 / 关机 as chosen: the switch entity is
         optimistic and no state topic exists, so there is nothing else to
         restore from. */
      this._remember({ switch: target });
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

    /** { on, pending, justConfirmed, optimistic, commanded } for the switch row. */
    _switchView() {
      const target = this._switchTarget();
      /* `optimistic` and `commanded` travel with the view because the row has to
         word itself differently in the two cases: "已休眠" is a claim about the
         device, and for an optimistic entity nothing about the device is known. */
      if (target) {
        return {
          on: target === "on", pending: target, confirmed: false,
          optimistic: this._switchOptimistic(), commanded: true,
        };
      }
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
      return {
        on, pending: null, confirmed: justConfirmed,
        optimistic: this._switchOptimistic(), commanded,
      };
    }

    _setEmsMode(mode) {
      this._optimistic.ems_mode = mode;
      this._emsCommandAt = this._now();
      this._remember({ ems_mode: mode });
      /* Repaint now: the row must show the new selection on the click itself and
         not wait for the next state push to arrive. */
      this.requestUpdate();
      /* Leaving mqtt_ctrl makes the lease meaningless: the firmware ignores
         `power_ctrl` in every other mode, so re-sending it would only add
         broker traffic. The switch reflects that instead of staying on while
         doing nothing. */
      if (mode !== "mqtt_ctrl" && this._timerOn) this._setTimer(false);
      this._publish(this._topic("select/<dev_id>/ems_mode/command"), mode,
        `${this._t("EMS Mode", "EMS 模式")} → ${mode}`);
    }

    /** The mode the device itself reports, or "" when it is not known.
     *
     * Kept apart from `_emsMode()` because the two answer different questions:
     * the select tells you what was *asked for*, this tells you what the
     * hardware is *doing*.  `sensor.<dev>_ems_mode_(device)` is the
     * integration's own sensor, fed from the device's `device/state` /
     * `system/state` report - the only place the true current mode exists.
     */
    _emsDeviceMode() {
      /* Two names for one thing: `sensor.py` calls the key `ems_mode_running`
         but names the entity "EMS Mode (Device)", so the entity id ends in
         `_ems_mode_device`. Both are tried because `_resolve` matches on
         normalised tails and only one of them will ever line up. */
      const state = this._state("ems_mode_device", "sensor")
        || this._state("ems_mode_running", "sensor");
      return state ? String(state.state) : "";
    }

    /**
     * The mode the EMS row highlights, and the one the power rows gate on.
     *
     * A command sent from this card wins over the entity, because the select is
     * not a reliable echo. The firmware publishes its state on an **event**
     * topic (`homeassistant/sensor/<dev>/event/state`); it only changes when the
     * device decides to, and it never reflects a command that was just sent.
     * The integration used to rewrite that topic to its own and echo every
     * command onto it, which is why clicking used to work; a firmware update
     * added a `value_template`, and `discovery_override` deliberately leaves
     * such a payload alone, so the echo is gone.
     *
     * Without this override the row snapped back to the old mode the instant it
     * re-rendered, and every gated control (power control, re-send timer) stayed
     * disabled - a select that ignores its own input looks broken, whatever the
     * device is doing.
     *
     * The device still gets the last word: when it reports a *different* mode
     * after the command was sent, that report is newer than our request and is
     * what the row shows.
     */
    _emsMode() {
      const state = this._state("ems_mode", "select");
      const reported = state ? String(state.state) : "";
      const mine = this._optimistic.ems_mode || "";
      if (!mine) return reported;
      if (!reported || reported === mine) return mine;
      const changedAt = state && state.last_changed
        ? Date.parse(state.last_changed)
        : NaN;
      if (
        Number.isFinite(changedAt)
        && this._emsCommandAt > 0
        && changedAt > this._emsCommandAt
      ) {
        return reported;
      }
      return mine;
    }

    _emsOptions() {
      const options = this._attr("ems_mode", "select", "options");
      if (Array.isArray(options) && options.length) return options;
      /* No discovery payload to read.  Returning every known mode would put the
       * TOU button back on a device that has no such feature, so the fallback is
       * the two modes every firmware in this family implements.  `_emsItem()`
       * drops `tou_plan` even when the declared list above does contain it, so
       * both paths agree. */
      return EMS_MODES.filter((m) => m.id !== "tou_plan").map((m) => m.id);
    }

    _sendPowerCtrl(opts) {
      const value = this._draftNumber(this._powerCtrl);
      if (value === null) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      /* Remembered before the send, so a failed publish still leaves the card
         showing what was attempted - that is more useful than silently going
         back to an older value the user has since replaced. */
      this._remember({ power_ctrl: value });
      /* While the beat is running it re-publishes its own value, so a plain
         send would be silently overwritten one period later - "I sent 200 W"
         then looks ignored a minute later, which is exactly the symptom this
         timer exists to cure. Retuning the beat publishes the new target
         immediately and keeps holding it, so it is the whole operation. */
      if (this._timerOn) {
        this._showToast(
          this._t(
            `Power control ${value} W (timer retuned)`,
            `功率控制 ${value} W（已同步定时下发）`,
          ),
          false,
        );
        this._keepaliveStart(value);
        return;
      }
      this._publish(this._topic("number/<dev_id>/power_ctrl/set"), String(value),
        `${this._t("Power Control", "功率控制")} ${value} W`, opts);
    }

    /* ---------------------------- re-send timer ---------------------------- */

    /**
     * The period actually used, clamped into the supported window. A blank or
     * unparsable field falls back to the default rather than stopping the beat:
     * letting the lease lapse because someone cleared the input mid-edit would
     * be the worst possible outcome.
     */
    _timerPeriodValue() {
      return this._clampPeriod(this._timerPeriod);
    }

    /** `num()` maps anything unparsable to 0, so a blank field has to be caught
     * before the clamp or clearing the input would mean "every 5 s". */
    _clampPeriod(raw) {
      if (String(raw == null ? "" : raw).trim() === "") return TIMER_DEFAULT_S;
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n) || n <= 0) return TIMER_DEFAULT_S;
      return Math.min(Math.max(n, TIMER_MIN_S), TIMER_MAX_S);
    }

    _setTimer(on) {
      if (this._timerBusy) return;
      const want = on === true;
      /* Off must always be possible, even mid-send or when this element's
         mirror disagrees with the integration: leaving the device holding a
         power limit because the UI was out of step is far worse than a
         redundant stop call (which the service treats as a no-op). */
      if (!want) { this._keepaliveStop(); return; }
      if (this._timerOn === true) return;
      /* `power_ctrl` is only honoured in mqtt_ctrl mode, so arming the timer in
         any other mode would publish into the void. The row disables its
         buttons there; this guard covers the programmatic paths too. */
      if (this._emsMode() !== "mqtt_ctrl") return;
      /* Same blank-is-not-zero rule as the sliders: arming the beat on an empty
         field used to start it holding 0 W, which stops the unit producing. */
      const value = this._draftNumber(this._powerCtrl);
      if (value === null) {
        this._showToast(this._t("Invalid value", "数值无效"), true);
        return;
      }
      this._keepaliveStart(value);
    }

    /**
     * Start (or retune) the server-side beat.
     *
     * The value is sent by the integration, so the card does not re-publish it
     * here - a second publish would only duplicate the first beat.
     */
    async _keepaliveStart(power) {
      this._timerBusy = true;
      this.requestUpdate();
      try {
        await this._hass.callService("hoymiles", "start_power_ctrl_keepalive", {
          dev_id: this._dev(),
          power,
          period: this._timerPeriodValue(),
        });
        // The state topic carries the authoritative count, so read it back
        // instead of assuming the call did what was asked.
        this._syncKeepalive();
      } catch (err) {
        this._showToast(this._t(
          `Could not start the timer: ${err.message || err}`,
          `无法开启定时下发：${err.message || err}`,
        ), true);
      } finally {
        this._timerBusy = false;
        this.requestUpdate();
      }
    }

    async _keepaliveStop() {
      this._timerBusy = true;
      this.requestUpdate();
      try {
        await this._hass.callService("hoymiles", "stop_power_ctrl_keepalive", {
          dev_id: this._dev(),
        });
        this._syncKeepalive();
      } catch (err) {
        this._showToast(this._t(
          `Could not stop the timer: ${err.message || err}`,
          `无法关闭定时下发：${err.message || err}`,
        ), true);
      } finally {
        this._timerBusy = false;
        this.requestUpdate();
      }
    }

    /**
     * Read the integration's running state from its entity.
     *
     * The keep-alive publishes a retained topic, but a card must not depend on
     * having received it - right after a page load the retained message may not
     * have arrived yet. The integration mirrors the same payload into an
     * entity's attributes, which `hass.states` always has, so the row is
     * correct the moment it renders.
     */
    _syncKeepalive() {
      const state = this._state("power_ctrl_keepalive", "sensor");
      this._applyKeepalive(state ? state.attributes : null);
    }

    /**
     * Mirror the integration's state onto the row.
     *
     * `set hass` runs for every state change in the whole system, so the
     * re-render is skipped unless something actually differs - otherwise the
     * card would redraw continuously for no reason.
     */
    _applyKeepalive(payload) {
      if (!payload || typeof payload !== "object") return;
      const on = payload.enabled === true;
      /* The sensor always reports the period of the *last* beat, even when no
         beat is running - and an idle sensor answers with the built-in default,
         which would silently undo a period the user had chosen earlier. The
         stored period is only authoritative while a beat is actually running. */
      const period = on && payload.period != null
        ? String(this._clampPeriod(payload.period))
        : this._timerPeriod;
      const count = typeof payload.count === "number" ? payload.count : 0;
      const lastAt = typeof payload.last_at === "number" ? payload.last_at : 0;
      const power = typeof payload.power === "number" ? payload.power : NaN;
      /* An error is only worth showing while stopped: a beat that is running
         has already recovered by definition, and a stale message would sit
         there contradicting the "re-sending every N s" line right above it. */
      const error = !on && payload.error ? String(payload.error) : "";
      if (on === this._timerOn && period === this._timerPeriod
        && count === this._timerCount && lastAt === this._timerLastAt
        && error === this._timerError && power === this._timerPower) {
        return;
      }
      const previousPower = this._timerPower;
      const powerMoved = Number.isFinite(power) && power !== previousPower;
      this._timerOn = on;
      this._timerPeriod = period;
      this._timerCount = count;
      this._timerLastAt = lastAt;
      this._timerError = error;
      this._timerPower = power;
      /* A running beat holds a specific wattage in the integration, which is
         server-side truth and therefore outranks whatever this browser
         remembered. Mirror it into the slider so a page opened while 200 W is
         being held shows 200 W - the value the user "sent" in the first place.

         Only on a *transition* of the held power, and only when the slider
         still shows the old held value: applying it on every push would fight
         the user, snapping a drag back before they could press 下发. */
      if (on && powerMoved) {
        const untouched = this._powerCtrl === "" || Number.isNaN(previousPower)
          || num(this._powerCtrl) === power || num(this._powerCtrl) === previousPower;
        if (untouched) this._powerCtrl = String(power);
        /* Persist the server's value too: it is what the device is actually
           holding, so it is the best thing to restore on the next visit. */
        this._remember({ power_ctrl: power, timer_period: this._clampPeriod(period) });
      }
      this.requestUpdate();
    }

    /** Turn a keep-alive error into a sentence the user can act on.
     *
     * The integration reports English diagnostics meant for the log. Two of them
     * have a real user-facing meaning, and one is actively misleading without
     * context: the EMS select can read `mqtt_ctrl` while the device is actually
     * in another mode, because the select's state topic is a retained value the
     * firmware only refreshes every few minutes. Saying just "not mqtt_ctrl"
     * next to a row that visibly *does* say mqtt_ctrl looks like a bug.
     */
    _timerErrorText(err) {
      const text = String(err || "");
      const ems = text.match(/EMS mode is (\w+), not (\w+)/i);
      if (ems) {
        return this._t(
          `The device reports ${ems[1]}, so it ignores power control - the EMS mode shown above may be stale. `
            + `Switch to ${ems[2]} and try again.`,
          `设备实际处于 ${ems[1]}，会忽略功率控制（上方的 EMS 模式显示可能是旧值）。`
            + `请切到 ${ems[2]} 后重试。`,
        );
      }
      if (/integration unloaded/i.test(text)) {
        return this._t("The integration was reloaded - turn this on again.",
          "集成已重新加载，请重新开启。");
      }
      return text;
    }

    async _setTimerPeriod(raw, input) {
      const clamped = this._clampPeriod(raw);
      this._timerPeriod = String(clamped);
      /* The period is part of the remembered set even while the beat is off: the
         user picks 15 s once and expects to find it next time, not to retype it
         before every start. */
      this._remember({ timer_period: clamped });
      /* Write the clamped value back to the field by hand.
       *
       * Lit only rewrites a bound property when the *previous committed value*
       * differs, so typing 120 into a field already holding 60 leaves "120" on
       * screen after the clamp - the value silently became 60 while the box
       * kept showing the rejected number. Overwriting here is what makes the
       * 60 s ceiling visible instead of merely effective. */
      if (input && String(input.value) !== String(clamped)) {
        input.value = String(clamped);
      }
      this.requestUpdate();
      /* A new period must reach the integration, not just this element: the
         beat is scheduled server side. Restarting retunes it so the change
         takes effect immediately.

         The power comes from what the beat is already holding, not from the
         slider: the slider may show an unsent value, and editing the period
         must not silently push that value onto the device. */
      if (!this._timerOn) return;
      if (!Number.isFinite(this._timerPower)) return;
      await this._keepaliveStart(this._timerPower);
    }

    _sendOutputPower() {
      const value = this._draftNumber(this._outputPower);
      if (value === null) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      this._remember({ output_power: value });
      this._publish(this._topic("number/<dev_id>/output_power/set"), String(value),
        `${this._t("Output Power", "输出功率")} ${value} W`);
    }

    /**
     * A drafted value from an input box, or `null` when there is nothing usable.
     *
     * `Number("")` is `0` and `Number.isFinite(0)` is true, so the plain
     * `Number()` + `isFinite` guard this replaces let an emptied field through as
     * a genuine zero - pressing send then published `output_power = 0` and the
     * device dutifully went quiet. Blank is therefore tested on the raw string,
     * before any coercion, and treated as "no value" rather than "zero".
     */
    _draftNumber(raw) {
      const text = String(raw == null ? "" : raw).trim();
      if (text === "") return null;
      const value = Number(text);
      return Number.isFinite(value) ? value : null;
    }

    _sendPhase() {
      /* Per-phase boxes go through the same blank-is-not-zero rule: a phase the
         user never filled must not be published as 0 W. */
      const parts = ["a", "b", "c"].map((p) => this._draftNumber(this._phase[p]));
      if (parts.some((v) => v === null)) {
        this._showToast(this._t("Invalid value", "数值无效"), true);
        return;
      }
      const payload = { phase_a: parts[0], phase_b: parts[1], phase_c: parts[2] };
      this._remember({ phase: { a: payload.phase_a, b: payload.phase_b, c: payload.phase_c } });
      this._publish(this._topic("number/<dev_id>/phase_output_power/set"), payload,
        `${this._t("Phase Output", "多相输出")} ${payload.phase_a}/${payload.phase_b}/${payload.phase_c} W`);
    }

    _sendTouGet() {
      this._publish(this._topic("sensor/<dev_id>/tou_plan/get"), { week: this._week },
        `${this._t("Get TOU Plan", "获取 TOU 计划")} ${this._week}`);
    }

    _reboot() {
      const ok = window.confirm(this._t(
        "Reboot the device now?", "确认立即重启设备？",
      ));
      if (!ok) return;
      this._publish(this._topic("button/<dev_id>/reboot/trigger"), "RESTART",
        this._t("Reboot", "重启"));
    }

    /* Protocol §31. Same fixed `RESET` payload as §29 but a far smaller blast
       radius: only the Bluetooth pairing PIN goes back to its default, the rest
       of the configuration survives. A confirmation is still worth it - the PIN
       is what a phone app needs to pair again - but the wording can be plain. */
    _resetBlePin() {
      const ok = window.confirm(this._t(
        "Reset the Bluetooth PIN to its default? The device keeps the rest of its configuration.",
        "确认重置蓝牙 PIN 码？设备其它配置会保留。",
      ));
      if (!ok) return;
      this._publish(this._topic("button/<dev_id>/reset_ble_pin_code/trigger"), "RESET",
        this._t("Reset BLE PIN", "重置蓝牙 PIN"));
    }

    /* Protocol §29. The payload is a fixed `RESET` - the firmware accepts nothing
       else - and the device drops every setting it was given, including the MQTT
       client prefix, so a stray click costs a re-provisioning session. Hence the
       confirmation, and the slightly fuller wording than the reboot prompt. */
    _factoryReset() {
      const ok = window.confirm(this._t(
        "Restore the device to its factory settings? This erases its whole configuration,"
          + " including the MQTT prefix.",
        "确认恢复出厂设置？设备上的全部配置（含 MQTT 前缀）都会被清除。",
      ));
      if (!ok) return;
      this._publish(this._topic("button/<dev_id>/factory_reset/trigger"), "RESET",
        this._t("Factory Reset", "恢复出厂"));
    }

    /* ------------------------------- log ------------------------------- */

    /** The two wildcards that cover this device: its tree, and ours. */
    _logTopics() {
      return [this._topic("+/<dev_id>/#"), `hoymiles/${this._dev()}/#`];
    }

    /**
     * Which way does a message go? Home Assistant writes to the command side of
     * a topic (`/set`, `/command`, `/trigger`, `/get`); everything else on the
     * device's tree is published by the device itself. The `hoymiles/` family
     * belongs to the integration, which is also this end of the link.
     */
    _logDown(topic) {
      if (String(topic).startsWith("hoymiles/")) return true;
      return LOG_DOWNLINK.test(String(topic));
    }

    /**
     * The topic of one message, split so the device id can be dimmed: every
     * line carries it, and it is the least interesting part. The three pieces
     * are spans, not one string, but their text adds up to the topic exactly as
     * it goes over the wire, so selecting a row still copies the real thing.
     *
     * The full path is shown on purpose: `sensor/quick/state` is shorter, but it
     * is not the topic - the user has to be able to read (and copy) what was
     * actually published.
     */
    _logTopic(topic, host) {
      const dev = this._dev();
      const at = String(topic).indexOf(`/${dev}/`);
      if (at < 0) {
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
     * own scrollbar inside the list's scrollbar. Compact keeps a row readable,
     * keeps the list the only thing that scrolls, and still shows every value -
     * the user asked for exactly that ("one scrollbar is enough").
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
      const down = this._logDown(topic);
      /* Retained: the broker replays one stored copy the moment anything
         subscribes. It carries no timestamp of its own, so the only honest
         clock is none at all - `new Date()` here would date the *receipt* of a
         message the device published days ago, which on an offline unit made
         the log look freshly updated every time it was opened. Marked, not
         dropped: the `attributes` capability list only ever arrives retained,
         and throwing it away would leave blank payloads in the log. */
      const retain = Boolean(msg && msg.retain);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      /* The receipt clock is read in the *device's* region, the same clock the
         rest of the dashboard uses: a log stamped in the browser's zone would
         disagree with the alarm list beside it on a laptop that travels. */
      const clock = this._clockOf(now);
      return {
        topic,
        down,
        retain,
        text: this._logPayload(payload),
        clock: retain ? "—" : `${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}`,
      };
    }

    /** `HH:MM:SS` parts of one instant, in the configured region. */
    _clockOf(when) {
      const api = window.HoymilesG2Region;
      if (api && typeof api.partsIn === "function") {
        const parts = api.partsIn(when, api.zone());
        if (parts) {
          return { hour: parts.hour, minute: parts.minute, second: parts.second };
        }
      }
      return { hour: when.getHours(), minute: when.getMinutes(), second: when.getSeconds() };
    }

    /**
     * One rendered row. Built with DOM calls and `textContent` rather than
     * markup: a payload is arbitrary text from the broker, and this way there is
     * nothing to escape.
     */
    _logRow(entry) {
      const row = document.createElement("div");
      row.className = `log-row ${entry.down ? "down" : "up"}`;

      const meta = document.createElement("div");
      meta.className = "log-meta";
      const time = document.createElement("span");
      time.className = `log-time${entry.retain ? " cached" : ""}`;
      time.textContent = entry.clock;
      const dir = document.createElement("span");
      dir.className = `log-dir${entry.retain ? " retained" : ""}`;
      dir.textContent = entry.retain
        ? this._t("Retained · Cached", "缓存（非实时）")
        : entry.down
          ? this._t("HA → Device", "HA 下发")
          : this._t("Device → HA", "设备上报");
      if (entry.retain) {
        dir.title = this._t(
          "Retained message: the broker replayed its last stored copy when the log opened."
            + " The clock is unknown - this is not a live report.",
          "保留消息：打开日志时由服务端补发的最后一份缓存，非实时上报，具体时间未知。",
        );
      }
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
      this._log.push(entry);
      while (this._log.length > LOG_MAX) {
        this._log.shift();
        this._logDropped += 1;
      }
      this._appendLogRow(entry);
    }

    /**
     * Append one row, keeping the list bounded and scrolled to the newest
     * message - unless the user has scrolled up to read, in which case the view
     * is left where it is.
     */
    _appendLogRow(entry) {
      const list = this._logList;
      if (!list) return; // the panel is not in the DOM yet; the buffer has it
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      list.appendChild(this._logRow(entry));
      while (list.children.length > LOG_MAX) list.removeChild(list.firstChild);
      if (atBottom) list.scrollTop = list.scrollHeight;
      this._syncLogFoot();
    }

    /**
     * Pick up the freshly rendered panel (or restore it after a re-render) and
     * refill it from the buffer.
     *
     * The list is filled by hand and deliberately not by Lit: the device pushes
     * once a second, and re-rendering the card - sliders, segments and all -
     * for every message would be a lot of churn for a log. Lit leaves the
     * children of an element it did not create alone, so the rows survive.
     */
    _syncLogDom() {
      const root = this.renderRoot;
      const list = root && root.querySelector ? root.querySelector(".log-list") : null;
      if (!list) {
        this._logList = null;
        return;
      }
      if (list !== this._logList) {
        this._logList = list;
        list.textContent = "";
        for (const entry of this._log) list.appendChild(this._logRow(entry));
        list.scrollTop = list.scrollHeight;
      }
      this._syncLogFoot();
    }

    /** The counter and the hint line, which also live outside Lit. */
    _syncLogFoot() {
      const root = this.renderRoot;
      if (!root || !root.querySelector) return;
      const open = this._config && this._config.show_log !== false;
      const count = root.querySelector(".log-count");
      if (count) {
        const dropped = this._logDropped
          ? this._t(` · ${this._logDropped} dropped`, ` · 已丢弃较早的 ${this._logDropped} 条`)
          : "";
        count.textContent = this._logErr
          ? ""
          : this._t(`${this._log.length} messages`, `${this._log.length} 条`) + dropped;
      }
      const hint = root.querySelector(".log-hint");
      if (hint) {
        hint.textContent = this._logErr
          ? this._logErr
          : (this._log.length || !open
            ? ""
            : this._t("Waiting for MQTT traffic…", "等待 MQTT 数据…"));
        hint.className = `log-hint ${this._logErr ? "err" : ""}`;
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
     * `_logGen` guards the await: a subscription that lands after the switch was
     * turned off again (or the card moved to another device) must be dropped
     * instead of being stashed as a live one, or the list would keep growing
     * with messages nobody asked for.
     */
    async _subscribeLog() {
      this._logErr = "";
      this._syncLogFoot();
      const connection = this._hass && this._hass.connection;
      if (!connection || typeof connection.subscribeMessage !== "function") {
        this._logErr = this._t(
          "No Home Assistant websocket connection.",
          "没有 Home Assistant 的 WebSocket 连接。",
        );
        this._syncLogFoot();
        this.requestUpdate();
        return;
      }

      const gen = (this._logGen += 1);
      for (const topic of this._logTopics()) {
        try {
          const unsub = await connection.subscribeMessage(
            (msg) => this._onLogMessage(msg),
            { type: "mqtt/subscribe", topic, qos: LOG_QOS },
          );
          if (gen !== this._logGen) {
            if (typeof unsub === "function") unsub();
            continue;
          }
          if (typeof unsub === "function") this._logUnsubs.push(unsub);
        } catch (err) {
          if (gen !== this._logGen) break;
          this._logErr = this._logSubscribeError(err);
        }
      }
      this._syncLogFoot();
      this.requestUpdate();
    }

    _unsubscribeLog() {
      const subs = this._logUnsubs;
      this._logUnsubs = [];
      this._logGen += 1; // any in-flight subscribe is now stale
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
        this._log = [];
        this._logDropped = 0;
        this._logList = null;
        this.requestUpdate();
        this._subscribeLog();
      } else {
        this._closeLog();
      }
    }

    _closeLog() {
      this._logOpen = false;
      this._unsubscribeLog();
      /* Start clean next time: the retained configs and the last states arrive
         again on the next subscribe anyway, so keeping them would only show the
         same messages twice. */
      this._log = [];
      this._logDropped = 0;
      this._logErr = "";
      this._logList = null;
      this.requestUpdate();
    }

    _clearLog() {
      this._log = [];
      this._logDropped = 0;
      if (this._logList) this._logList.textContent = "";
      this._syncLogFoot();
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      // A missing entity means the device does not implement that feature, so
      // the row is dropped rather than shown as a control that does nothing.
      // The explicit `show_*` config still wins, for users who want it back.
      //
      // The role is the second, harder gate.  Protocol §32 is the only place the
      // firmware says whether this unit heads an installation or follows one,
      // and a follower answers "not supported" to every 「主机和单机」 command:
      // `ems_mode`, `power_ctrl`, `output_power`, `phase_output_power` and the
      // whole `tou_*` family.  Rendering those rows on a slave was the reported
      // problem - a full panel of controls that the device refuses.  An unknown
      // role keeps every row, so a unit whose `event/state` has not arrived yet
      // is never stripped down to the power switch.
      const slave = this._role() === "slave";
      const showPhase = !slave && (this._config.show_phase !== undefined
        ? this._config.show_phase !== false
        : this._hasEntity("phase_a_output_power", "number"));
      const showPowerCtrl = !slave && (this._config.show_power_ctrl !== undefined
        ? this._config.show_power_ctrl !== false
        : this._hasEntity("power_ctrl", "number"));
      const showEms = !slave && (this._config.show_ems !== undefined
        ? this._config.show_ems !== false
        : this._hasEntity("ems_mode", "select"));
      const showOutput = !slave && (this._config.show_output !== undefined
        ? this._config.show_output !== false
        : this._hasEntity("output_power", "number"));
      const showTou = !slave && (this._config.show_tou !== undefined
        ? this._config.show_tou !== false
        : this._hasEntity("tou_plan_status", "sensor"));
      const showLog = this._config.show_log !== false;
      const showFactoryReset = this._config.show_factory_reset !== undefined
        ? this._config.show_factory_reset !== false
        : this._hasEntity("factory_reset", "button");
      const showBlePinReset = this._config.show_ble_pin_reset !== undefined
        ? this._config.show_ble_pin_reset !== false
        : this._hasEntity("reset_ble_pin_code", "button");
      const showReboot = this._config.show_reboot !== undefined
        ? this._config.show_reboot !== false
        : this._hasEntity("reboot", "button");
      const showSwitch = this._config.show_switch !== undefined
        ? this._config.show_switch !== false
        : this._hasEntity("switch", "switch");

      /* Layout, the same one the micro storage page uses: a grid of cards, one
         per control family, instead of a single card holding grey blocks.  A
         device that answers some of these families simply has fewer cards.
         `|| ""` on the title: a config without one resolves to undefined, and
         an undefined title would still emit an empty card on top of the grid. */
      const title = this._text(this._config.title) || "";
      const subtitle = this._config.subtitle === false ? "" : this._t(
        "Commands are sent straight to the device",
        "指令直接下发到设备",
      );
      const cards = [
        this._group(
          this._t("Power & Mode", "电源与模式"),
          [
            showSwitch ? this._switchItem() : "",
            showEms ? this._emsItem() : "",
          ],
          "",
        ),
        this._group(
          this._t("Power Settings", "功率设置"),
          [
            showPowerCtrl ? this._powerCtrlItem() : "",
            showPowerCtrl ? this._timerItem() : "",
            showOutput ? this._outputItem() : "",
            showPhase ? this._phaseItem() : "",
          ],
          "",
        ),
        this._group(
          this._t("Plan & Maintenance", "计划与维护"),
          [
            showTou ? this._touItem() : "",
            showReboot ? this._rebootItem() : "",
            showBlePinReset ? this._blePinResetItem() : "",
            showFactoryReset ? this._factoryResetItem() : "",
            showLog ? html`${this._logItem()}${this._logOpen ? this._logPanel() : ""}` : "",
          ],
          "wide",
        ),
      ].filter((card) => card !== "");

      return html`
        <div class="grid">
          ${title === ""
            ? ""
            : html`
              <ha-card class="wide">
                <div class="head">
                  <div class="title">${title}</div>
                  ${subtitle === "" ? "" : html`<div class="sub">${subtitle}</div>`}
                </div>
              </ha-card>`}
          ${cards}
        </div>
        ${this._toast === "" ? "" : html`
          <div class="toast ${this._toastError ? "err" : ""}">${this._toast}</div>`}
      `;
    }

    /** One card per control family, the way the storage page groups its rows.
     *
     * A family whose every row was dropped draws nothing at all.  The role gate
     * above can empty a whole family - a follower has no "Power Settings" left -
     * and an empty card with its header still in place reads as a broken page
     * rather than as "this unit has no such feature".
     */
    _group(title, items, cls) {
      const rows = (items || []).filter(
        (item) => item !== "" && item !== null && item !== undefined,
      );
      if (!rows.length) return "";
      return html`
        <ha-card class=${cls || ""}>
          ${title ? html`<div class="c-head"><span class="ct">${title}</span></div>` : ""}
          ${rows}
        </ha-card>`;
    }

    /**
     * One icon from the set above, as an SVG element.
     *
     * Built as a string and injected with `_untrusted()` on purpose: a nested
     * lit template would parse its `<path>` in the HTML namespace and paint
     * nothing at all. The id prefix is per call so two cards on one page never
     * share a gradient id.
     */
    _icon(name, size = 18) {
      const build = ICON_SVG[name] || ICON_SVG.dot;
      const uid = "hmci" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-";
      /* fill="none" on the root: the shapes that need a fill set it themselves,
         and the stroke-only ones must not inherit the default black. */
      const svg = `<svg viewBox="0 0 24 24" width="${size}" height="${size}"
        fill="none" aria-hidden="true" focusable="false">${build(uid)}</svg>`;
      return html`<span class="ic">${this._untrusted(svg)}</span>`;
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
     *
     * Both inputs stay inside `[lo, hi]`. The draft value may legitimately sit
     * outside the range for a moment - `_seedInputs` reads a live entity whose
     * bounds the firmware rewrites underneath us - and letting it through would
     * put a number in the read-out that the slider cannot represent and that a
     * press of the send button would publish as-is.
     */
    _slider({ value, min, max, step, unit, tag, disabled, onInput, onSend, sendLabel }) {
      const lo = num(min);
      const hi = num(max);
      /* `Number("")` is `0`, and `Number.isFinite(0)` is true, so an untouched
         or cleared field used to render as "0" - a real-looking value the
         device would be happy to accept. Blankness is therefore detected on the
         raw string, before `num()` gets a chance to lie, and the number box is
         left genuinely empty. The range input still needs a position, so it
         falls back to the low bound; that is a drawing decision only and is
         never read back as the user's value. */
      const blank = String(value == null ? "" : value).trim() === "";
      const current = blank ? NaN : num(value);
      const inRange = Number.isFinite(current)
        ? Math.min(Math.max(current, lo), hi)
        : lo;
      const span = hi - lo;
      const pct = span > 0 ? ((inRange - lo) / span) * 100 : 0;
      const shown = Number.isFinite(current) ? String(current) : "";

      return html`
        <div class="slider">
          ${tag ? html`<span class="tag">${tag}</span>` : ""}
          <input type="range" min=${lo} max=${hi} step=${step}
            .value=${String(inRange)} ?disabled=${disabled}
            style="--pct:${pct.toFixed(1)}%"
            @input=${(e) => onInput(e.target.value)} />
          <input type="number" min=${lo} max=${hi} step=${step}
            .value=${shown}
            placeholder=${this._t("Not set", "未设置")}
            ?disabled=${disabled}
            @input=${(e) => onInput(e.target.value)}
            @change=${(e) => {
              // Typing is free-form; leaving the field is not. Snap a value the
              // entity cannot hold back into range so the read-out, the track
              // and the value that gets published never disagree. The DOM value
              // is rewritten here as well - the draft alone would not show until
              // the next `hass` push, i.e. up to a second later.
              // A field left empty stays empty: there is no "nearest" number to
              // snap it to, and inventing one would silently re-arm a send.
              if (String(e.target.value).trim() === "") return;
              const typed = num(e.target.value);
              const fixed = Number.isFinite(typed)
                ? Math.min(Math.max(typed, lo), hi)
                : inRange;
              if (fixed !== typed) {
                e.target.value = String(fixed);
                onInput(String(fixed));
              }
            }} />
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

    /** Step for a numeric entity, falling back to the protocol default.
     *
     * `step` is part of the entity's own declaration and a wrong value is not
     * harmless: a slider whose step is finer than the device accepts sends
     * values it rejects, and one that is coarser makes fine control impossible.
     */
    _step(key, fallback) {
      const raw = this._attr(key, "number", "step");
      const step = raw != null ? num(raw) : NaN;
      return Number.isFinite(step) && step > 0 ? step : fallback;
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
         instant it is pressed, and this explains the wait / confirms it.

         An optimistic switch is a different story. The firmware publishes no
         readable ON/OFF (its discovery state topic is a nested JSON document),
         so Home Assistant only remembers the last command *it* sent - which is
         why the row said "已休眠" on a device that was plainly producing. Saying
         "last commanded" instead of claiming a device state is the honest
         wording, and the power read-out row below is what actually shows the
         device is alive. */
      const sub = view.pending
        ? this._t(
          `Powering ${view.pending === "on" ? "up" : "down"}…`,
          `${view.pending === "on" ? "正在开机" : "正在关机"}…`,
        )
        : view.optimistic
          ? (view.commanded
            ? this._t(
              `Last command: ${view.on ? "on" : "off"} (the device does not report its switch state)`,
              `上次下发：${view.on ? "开机" : "关机"}（设备不上报开关状态）`,
            )
            : this._t(
              "No command sent yet - the device does not report its switch state.",
              "尚未下发指令——设备不上报开关状态。",
            ))
          : view.confirmed
            ? this._t(
              view.on ? "Powered on ✓" : "Powered off ✓",
              view.on ? "已开机 ✓" : "已关机 ✓",
            )
            : view.on
              ? this._t("Running", "运行中")
              : this._t("Standby", "已休眠");
      const subClass = view.pending ? "busy" : view.confirmed ? "done" : "";
      return this._item({
        icon: this._icon("bolt"),
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
      /* Only the modes the firmware actually offers are rendered.  Drawing an
       * unsupported mode as a greyed-out button was tried and is wrong: a micro
       * inverter's `ems_mode` discovery payload declares just
       * `["general", "mqtt_ctrl"]`, so it grew a permanently disabled
       * "分时计划 / TOU plan" button next to two working ones - a control the
       * user can see, cannot press, and has no way to remove.  A feature the
       * hardware does not have should not appear at all.
       *
       * `tou_plan` is never offered from this row, whatever the firmware
       * declares and whatever mode the device currently reports.  The plan has
       * its own editor further down this card (and its own `tou_plan/status`
       * reply), so a third button here only duplicated the entry point and, on
       * units whose select does advertise `tou_plan`, it kept coming back.
       *
       * The current mode is kept even when the firmware does not list it: the
       * state topic can report a mode the device was switched to by other
       * means, and hiding the active option would leave the row with no
       * highlighted entry and no explanation why.  That rule applies to the
       * modes this row actually offers, not to `tou_plan`. */
      const options = EMS_MODES
        .filter((mode) => mode.id !== "tou_plan")
        .filter((mode) => supported.includes(mode.id) || mode.id === current)
        .map((mode) => ({
          id: mode.id,
          label: this._t(mode.en, mode.zh),
          enabled: true,
          title: mode.id,
        }));
      return this._item({
        icon: this._icon("faders"),
        name: this._t("EMS Mode", "EMS 模式"),
        sub: this._emsSub(current),
        topic: this._topic("select/<dev_id>/ems_mode/command"),
        ctrl: this._segment(options, current, (id) => this._setEmsMode(id)),
      });
    }

    /** Rated output of *one* unit in watts, or `null` when the model is unknown.
     *
     * The product id is the four digits of the serial body - the same key the PV
     * count uses, and the only part of the id that survives a user-changed
     * client prefix. */
    _ratedWatts() {
      const pid = String(this._dev() || "").split("-").pop().slice(0, 4);
      const rated = RATED_W_BY_PID[pid];
      return Number.isFinite(rated) ? rated : null;
    }

    /** The range the power-control slider offers for **this one unit**.
     *
     * Both bounds are `power_ctrl`'s own declaration, and nothing else.  That is
     * the entity the row writes to, so its `min` / `max` is by definition the
     * range the firmware will accept for that write - the slider can neither
     * offer a value the device would clamp away nor hide one it would take.
     *
     * The lower bound is meaningful: `0` on an inverter, which curtails to
     * nothing; negative on a storage unit, which charges.
     *
     * `output_power` is deliberately **not** consulted any more.  It is a
     * different setting (the installation-level output ceiling, which a `master`
     * publishes on behalf of the whole set) and its declared `max` is `6000` on
     * a `master` - five to six times what one box can deliver.  Dragging the
     * power slider to the far end then sent a set-point the unit cannot hold, so
     * the row looked broken instead of look useful.  `_outputItem` still shows,
     * and writes, `output_power`'s own range - the two rows are separate
     * settings and are now drawn from separate declarations.
     *
     * The fallback only applies when the entity is genuinely absent - before its
     * first discovery, or on a device that publishes no `power_ctrl` object -
     * and it has to be the right shape for the model: a micro inverter curtails
     * to `0` and never goes negative, whereas a storage unit charges below zero.
     */
    _powerRange() {
      const rated = this._ratedWatts();
      return this._bounds(
        "power_ctrl",
        rated === null ? -1000 : 0,
        rated === null ? 2000 : rated,
      );
    }

    /** Sub-line of the EMS row: the mode shown, plus the device's own report when
     * the two disagree.
     *
     * The disagreement is the whole point of showing it. The hardware can accept
     * a mode command and keep running the old one - measured on micro inverter
     * `RMI-4161A0209FF6` firmware `01.05.00`, which acknowledges `mqtt_ctrl` and
     * still reports `general` (and in `general` ignores the power set-point).
     * Saying so is honest; silently reverting the selection is not.
     */
    _emsSub(current) {
      if (current === "") return "—";
      const device = this._emsDeviceMode();
      if (!device || device === current) return current;
      return `${current} · ${this._t("Device", "设备")} ${device}`;
    }

    _powerCtrlItem() {
      const ready = this._emsMode() === "mqtt_ctrl";
      const { lo, hi } = this._powerRange();
      // The firmware declares the granularity itself and it differs per model
      // (0.1 W on a storage unit, 1 W on a micro inverter), so the slider must
      // follow the entity rather than assume the finer one.
      const step = this._step("power_ctrl", 0.1);
      const sub = !ready
        ? this._t("Switch EMS to mqtt_ctrl first", "需先切到 mqtt_ctrl")
        : this._t(
          `${lo} ~ ${hi} W, re-send at least once a minute`,
          `${lo} ~ ${hi} W，需至少每分钟下发一次`,
        );
      return this._item({
        icon: this._icon("powerLimit"),
        name: this._t("Power Control", "功率控制"),
        sub,
        topic: this._topic("number/<dev_id>/power_ctrl/set"),
        stack: true,
        ctrl: this._slider({
          value: this._powerCtrl,
          min: lo,
          max: hi,
          step,
          unit: "W",
          disabled: !ready,
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._powerCtrl = v; },
          onSend: () => this._sendPowerCtrl(),
        }),
      });
    }

    /**
     * The re-send timer, directly under the slider it applies to.
     *
     * `power_ctrl` is a lease that the firmware drops after about a minute (it
     * falls back to `output_power`), which is why a single send looks like the
     * device "ignores" the value after a short while. Re-publishing on a period
     * holds it; this row is the switch for that.
     *
     * The beat is run by the integration, not by this element. An earlier
     * version used a browser `setTimeout`, which fired once and then died the
     * moment the dashboard was left - navigation, reload, or closing the tab
     * cleared it, and the device reverted a minute later with no visible cause.
     * Living in Home Assistant means the value is held whether or not any
     * dashboard is open, and this row is only a remote control for it - which
     * is why it reads its state back from the entity instead of trusting a
     * local flag.
     */
    _timerItem() {
      const ready = this._emsMode() === "mqtt_ctrl";
      const on = this._timerOn === true && ready;
      const period = this._timerPeriodValue();
      /* While the beat runs the row says nothing: the segment already shows On,
         the box shows the period and the device is being held. The old counter
         ("every 30 s · 12 sent · last 10:04:11") was pure noise that pushed the
         row taller to restate something the controls already express. Only the
         two cases that need a word keep one: not armed, or failed. */
      const sub = !ready
        ? this._t("Switch EMS to mqtt_ctrl first", "需先切到 mqtt_ctrl")
        : this._timerError
          ? this._timerErrorText(this._timerError)
          : on
            ? ""
            : this._t(
              `Off. The device drops power control after ~${TIMER_LEASE_S} s - `
                + "turn this on and Home Assistant keeps sending it, even with no dashboard open.",
              `已关闭。设备约 ${TIMER_LEASE_S} 秒后自动失效——`
                + "打开后由 Home Assistant 持续下发，关闭页面也不受影响。",
            );
      return this._item({
        icon: this._icon("timer"),
        name: this._t("Re-send Timer", "定时下发"),
        sub,
        /* The row is stacked for the same reason the two sliders are: the
           segment plus the number box plus the unit do not fit beside the name
           at every width. Unstacked they wrapped onto a second line and the
           control ended up squeezed against a one-line name. */
        stack: true,
        ctrl: html`
          ${this._segment(
            [
              { id: "on", label: this._t("On", "开启"), enabled: ready && !this._timerBusy },
              { id: "off", label: this._t("Off", "关闭"), enabled: ready && !this._timerBusy },
            ],
            on ? "on" : "off",
            (id) => this._setTimer(id === "on"),
          )}
          <input type="number" class="narrow" min=${TIMER_MIN_S} max=${TIMER_MAX_S}
            step="1" .value=${String(period)} ?disabled=${!ready || this._timerBusy}
            @change=${(e) => this._setTimerPeriod(e.target.value, e.target)} />
          <span class="state">${this._t("s", "秒")}</span>`,
      });
    }

    _outputItem() {
      /* Deliberately the *declared* range, unlike `_powerRange()` above. On a
         `master` this row really does address the whole installation - that is
         what the 3000 W on `RMI-4161A0209FF6` means - so narrowing it to the
         unit's own rating would take away the only way to set the system total.
         The power-control slider below is the opposite case: it is a per-unit
         lease, so it must never inherit that aggregate. */
      const { lo, hi } = this._bounds("output_power", 100, 2000);
      return this._item({
        icon: this._icon("ceiling"),
        name: this._t("Output Power", "输出功率"),
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
        icon: this._icon("phaseLimit"),
        name: this._t("Phase Output", "多相输出功率"),
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
        icon: this._icon("schedule"),
        name: this._t("Get TOU Plan", "获取 TOU 计划"),
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
        icon: this._icon("reboot"),
        name: this._t("Reboot", "重启设备"),
        sub: this._t("Takes about a minute", "约需一分钟"),
        topic: this._topic("button/<dev_id>/reboot/trigger"),
        ctrl: html`
          <button class="btn danger"
            @click=${() => this._reboot()}>${this._t("Reboot", "重启")}</button>`,
      });
    }

    /* Protocol §31: the BLE PIN reset. Same shape as the reboot row, and the
       smallest consequence in the group, so the sub-line names what is kept. */
    _blePinResetItem() {
      return this._item({
        icon: this._icon("pin"),
        name: this._t("Reset BLE PIN", "重置蓝牙 PIN 码"),
        sub: this._t(
          "Back to the default PIN; other settings are kept",
          "PIN 恢复为默认值，其它配置保留",
        ),
        topic: this._topic("button/<dev_id>/reset_ble_pin_code/trigger"),
        ctrl: html`
          <button class="btn danger"
            @click=${() => this._resetBlePin()}>${this._t("Reset", "重置")}</button>`,
      });
    }

    /* Protocol §29: shares the reboot row's shape, but the consequence is larger,
       so the sub-line says what is lost rather than how long it takes. */
    _factoryResetItem() {
      return this._item({
        icon: this._icon("factory"),
        name: this._t("Factory Reset", "恢复出厂设置"),
        sub: this._t(
          "Erases the device configuration, including the MQTT prefix",
          "清除设备配置，含 MQTT 前缀",
        ),
        topic: this._topic("button/<dev_id>/factory_reset/trigger"),
        ctrl: html`
          <button class="btn danger"
            @click=${() => this._factoryReset()}>${this._t("Reset", "恢复")}</button>`,
      });
    }

    /**
     * The MQTT log switch. Off by default: nothing is subscribed - and nothing
     * is shown - until it is turned on, so the card costs nothing in normal use.
     */
    _logItem() {
      const open = this._logOpen === true;
      return this._item({
        icon: this._icon("log"),
        name: this._t("MQTT Log", "MQTT 日志"),
        sub: open
          ? this._t(
            "Live traffic: what the device reports and what HA sends. Rows marked retained"
              + " are the broker's stored copy, not a new report.",
            "实时数据：设备上报 + HA 下发。标记为「缓存」的行来自服务端保留消息，不是新上报。",
          )
          : this._t(
            "Off. Turn on to watch what the device reports and what Home Assistant sends",
            "默认关闭。打开后显示设备上报与 HA 下发的数据",
          ),
        ctrl: html`
          <ha-switch .checked=${open}
            @change=${(e) => this._toggleLog(e.target.checked)}></ha-switch>`,
      });
    }

    /**
     * The panel: a toolbar (counter + clear) and an empty list. Rows are added
     * by `_syncLogDom` / `_appendLogRow`, not by Lit - see `_syncLogDom`.
     */
    _logPanel() {
      return html`
        <div class="log-block">
          <div class="log-head">
            <span class="log-title">${this._t("Traffic", "通信记录")}</span>
            <span class="log-count"></span>
            <button class="btn small"
              @click=${() => this._clearLog()}>${this._t("Clear", "清空")}</button>
          </div>
          <div class="log-list"></div>
          <div class="log-hint"></div>
        </div>`;
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
          <label class="sw">
            <ha-switch .checked=${config.show_log !== false}
              @change=${this._toggle("show_log")}></ha-switch>
            <span>show_log (MQTT log row in Plan &amp; maintenance, off until switched on)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-g2-control-editor")) {
    customElements.define("hoymiles-g2-control-editor", HoymilesControlEditor);
  }
  if (!customElements.get("hoymiles-g2-control")) {
    customElements.define("hoymiles-g2-control", HoymilesControl);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-control")) {
    window.customCards.push({
      type: "hoymiles-g2-control",
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
