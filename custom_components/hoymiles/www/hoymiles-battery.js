/* ============================================================================
 * Hoymiles Micro Storage — Battery (HiBattery X) card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-battery`
 *
 * Renders the physical battery stack of a Hoymiles micro storage device the
 * way the vendor app does:
 *
 *   - the stack is drawn module by module, so the picture always matches how
 *     many battery packs are actually installed (1 – 4, driven by the
 *     `pack_count` sensor and cross-checked against `packN_soc`);
 *   - every module gets a callout with its own SOC and temperature, the
 *     callouts alternate left / right like in the app;
 *   - the unit itself is drawn like the product photos: one body with a
 *     single light-to-dark gradient, thin seams between the modules, and a
 *     dark head carrying the status display (signal, battery, SOC);
 *   - the dark head module (the BMS / PCS "host" unit) is the host
 *     temperature — the average of the installed packs, because the head has
 *     no temperature sensor of its own;
 *   - PV / grid-on / battery / grid-off powers frame the picture;
 *   - an optional history section plots the pack SOC and the charged /
 *     discharged energy for 日 / 月 / 年 / 总 (from long term statistics).
 *
 * Everything is hand-rolled SVG (no chart library, no CDN).
 *
 * Card config:
 *   type: custom:hoymiles-battery
 *   dev_id: MSA-280520260806     # required
 *   title: HiBattery X           # optional, overrides the detected model
 *   show_title: false            # optional, hide the header title
 *   language: en                 # optional (en|zh|de); omit to follow Home Assistant
 *   show_history: true           # optional (default true)
 *   show_host_temp: false        # optional, hide the head unit temperature
 *   max_width: 560               # optional px for the illustration
 *   alarm_entity: binary_sensor.x # optional, shows a bell when "on"
 *   entities:                    # optional entity id overrides
 *     pack_count: sensor.my_pack_count
 *     pv: sensor.my_pv_power
 *     grid_on: sensor.my_grid_on_power
 *     grid_off: sensor.my_grid_off_power
 *     battery: sensor.my_battery_power
 *     battery_status: sensor.my_battery_status
 *     soc: sensor.my_soc
 *     pack1_soc: sensor.my_pack1_soc
 *     pack1_temperature: sensor.my_pack1_temperature
 *     battery_temperature: sensor.my_battery_temperature
 * ========================================================================== */

function _hmBatteryRegister() {
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
    "Battery": "Batterie",
    "Battery ": "Batterie ",
    "Host": "Hauptgerät",
    "PV": "PV",
    "Grid port": "Netzanschluss",
    "Off-grid port": "Inselanschluss",
    "Loading…": "Wird geladen…",
    "No statistics recorded for this range (the recorder must be enabled).": "Für diesen Zeitraum keine Statistiken aufgezeichnet (der Recorder muss aktiviert sein).",
    "Charged": "Geladen",
    "Discharged": "Entladen",
    "Packs": "Pakete",
    "History": "Verlauf",
    "No statistics source found for this device.": "Keine Statistikquelle für dieses Gerät gefunden.",
    "Statistics are unavailable — is the recorder enabled?": "Statistiken sind nicht verfügbar – ist der Recorder aktiviert?",
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
   *     en: HiBattery X
   *     zh: 电池组
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

  /* ------------------------------------------------------------------ *
   * Drawing constants
   * ------------------------------------------------------------------ */
  const VB_W = 620;
  const PACK_MAX = 4;

  const TOP_H = 66;      // dark head module (BMS / PCS)
  const MOD_H = 158;     // one battery module
  const HEAD_TOP = 96;   // y of the top of the stack
  const FRONT_W = 300;   // front face width
  const FRONT_X = 130;   // x of the left edge of the front face
  const CALLOUT_W = 140;
  const CALLOUT_H = 54;
  const LEFT_BOX_X = 2;
  /* Right edge of a right hand callout.  Inset from the viewBox edge so the
     off-grid connector's vertical (at VB_W - 30) can run past the labels
     instead of through them - without the inset the line had to duck below
     the lowest label, which put its start halfway down the body. */
  const RIGHT_BOX_X = VB_W - 42;
  const LEFT_DOT_X = FRONT_X + FRONT_W * 0.40;
  const RIGHT_DOT_X = FRONT_X + FRONT_W * 0.62;
  const DOT_COLOR = "#22c55e";

  /* Energy flow on the branch connectors.  The battery is drawn inside the
   * unit, so only PV, the on-grid port and the off-grid port get a line.
   *
   * The connector keeps its own grey colour; what travels along it is **one**
   * streak of light, sent from one end to the other.  Its dash gap is several
   * times the branch, so only one can be on the line at a time - a repeating
   * pattern put two or three of them on a long connector, which reads as
   * decoration rather than as something being sent.
   *
   * The streak is drawn as a run of **slices** with a colour and an opacity each,
   * which is what makes the fade smooth: white and opaque at the head, the flow
   * colour and nearly nothing at the tail.  Stacking four strokes of different
   * length instead (the previous attempt) gave a stepped tail, because a
   * gradient cannot be built out of a handful of nested outlines.
   *
   * The streak is a CSS animation of `stroke-dashoffset`, which is also what
   * fixed the freeze: the old dots were moved by a requestAnimationFrame loop,
   * and a card that had been detached and re-attached (switching dashboard tabs
   * does that) was never re-rendered, so nothing restarted the loop and the dots
   * stood still.
   *
   * The three keyframe stops are handed to the CSS as variables, because they
   * depend on the length of the connector.  A negative `animation-delay` puts a
   * rebuilt path back at the phase it had reached.
   */
  const FLOW_COLOR = "#22c55e";
  const FLOW_IDLE_W = 5;         // below this a branch carries nothing
  const FLOW_SHARE = 0.34;       // streak length, as a fraction of the branch
  const FLOW_MIN = 30;           // units; below this a short stub barely reads
  const FLOW_MAX = 80;           // units; a long branch must not carry a bar
  const FLOW_SLICES = 14;        // how many steps the fade is cut into
  const FLOW_WIDTH = 3.6;        // width at the head, in user units
  const FLOW_TIP = 2.1;          // width at the tail
  /* Share of the cycle spent travelling.  The rest is the pause after the streak
     has left, and it **must match the 72% stop in the keyframes**. */
  const FLOW_TRAVEL = 0.72;
  const FLOW_SPEED_MIN = 55;     // units/s just above the threshold
  const FLOW_SPEED_RANGE = 175;  // extra units/s at FLOW_SPEED_FULL_W
  const FLOW_SPEED_FULL_W = 1500;

  /* Battery corner icon: the drawing follows the state, the way the vendor app
   * does it - a battery that fills while charging, the two-arrow cycle while
   * discharging, a muted hourglass when idle. */
  const CHARGE_COLOR = "#22c55e";
  const DISCHARGE_COLOR = "#4a90d9";
  const IDLE_COLOR = "#9aa4af";
  // Material "sync": two arrows chasing each other round a circle.
  const SYNC_PATH = "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8"
    + "l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6"
    + " 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z";
  // Material "hourglass_empty"
  const HOURGLASS_PATH = "M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16"
    + "l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z";

  /* The PV and port corners, drawn rather than pasted in.
   *
   * The PV corner used to be the ☀️ emoji, which sat next to flat single-colour
   * status glyphs and looked like it came from another app; it is now the same
   * sun, but drawn as one colour with round-capped rays, so it belongs to the
   * same family.  The port keeps the plate-and-plug drawing it always had -
   * it was simply too small to read, so its optical size went up instead of
   * its shape changing.
   *
   * Each builder draws inside a 24 x 24 box; `_cornerGlyph` scales and centres
   * it on the readout. */
  const CORNER_GLYPH = {
    /* A sun: solid disc, eight round-capped rays.
     *
     * Ray geometry, so the numbers stay checkable: the disc is r 4.6, the rays
     * run from r 7 to r 10, which leaves 2.4 units between the disc and the
     * ray tips - enough that the eight arms stay separate at 28 units wide
     * instead of merging into a blob. */
    sun: (c) => `
      <g stroke="${c}" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 2v3"/><path d="M12 19v3"/>
        <path d="M2 12h3"/><path d="M19 12h3"/>
        <path d="M4.93 4.93 7.05 7.05"/><path d="M16.95 16.95 19.07 19.07"/>
        <path d="M19.07 4.93 16.95 7.05"/><path d="M7.05 16.95 4.93 19.07"/>
      </g>
      <circle cx="12" cy="12" r="4.6" fill="${c}"/>`,

    /* The plate-and-plug drawing, unchanged: a light rounded square with the
     * dark body and stem on it.  Kept in its own two colours on purpose - it is
     * the one glyph that reads as hardware rather than as a symbol. */
    socket: () => `
      <rect x="0" y="0" width="24" height="24" rx="6" fill="#cfd4da"/>
      <circle cx="12" cy="10" r="4.2" fill="#3b4149"/>
      <rect x="10" y="14" width="4" height="7" rx="2" fill="#3b4149"/>`,
  };

  /* Colour and optical size per corner icon.  Sizes are the side of the box in
     viewBox units - the port is deliberately larger than the sun because its
     plate and stem have to stay apart at the size the card actually draws. */
  const CORNER_COLORS = {
    sun: "#f5a623",
    socket: "#cfd4da",
  };
  const CORNER_SIZE = {
    sun: 31,
    socket: 36,
  };

  /* Vertical nudge per corner icon, in viewBox units.
   *
   * The sun is a disc with rays all the way round, so its ink is symmetric but
   * its optical weight sits high: beside a 24 px figure whose baseline the row
   * uses, a perfectly centred sun looks like it is floating.  Two and a half
   * units down puts it on the same visual line as the number.  The socket needs
   * nothing - it is a solid square, so geometric centring already reads right. */
  const CORNER_DY = {
    sun: 2.5,
    socket: 0,
  };

  const HEADER_GAP = 84;   // space between the stack and the bottom row
  const TAIL_GAP = 30;

  const RANGES = [
    { id: "day", en: "Day", zh: "日", period: "hour", days: 1 },
    { id: "month", en: "Month", zh: "月", period: "day", days: 30 },
    { id: "year", en: "Year", zh: "年", period: "month", days: 365 },
    { id: "total", en: "Total", zh: "总", period: "month", days: 365 * 6 },
  ];
  const HIST_TTL_MS = 5 * 60 * 1000;

  const STATUS = {
    charge: { cls: "ok", en: "Charging", zh: "充电" },
    discharge: { cls: "warn", en: "Discharging", zh: "放电" },
    lock: { cls: "warn", en: "Locked", zh: "锁定" },
    standby: { cls: "", en: "Standby", zh: "待机" },
  };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /**
   * Collapse a name to its alphanumeric characters so `pack_1_soc` and
   * `pack1_soc` compare equal.  The integration's entity ids slugify the
   * entity *name* (`Pack 1 SOC` -> `pack_1_soc`), which does not match the
   * raw description key, so suffix matching is done normalized.
   */
  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clampNum(value, lo, hi) {
    if (!Number.isFinite(value)) return lo;
    return Math.min(Math.max(value, lo), hi);
  }

  /** "#rrggbb" (or "#rgb") -> [r, g, b], 0..255. */
  function hexRgb(hex) {
    const raw = String(hex).replace("#", "");
    const full = raw.length === 3
      ? raw.split("").map((ch) => ch + ch).join("")
      : raw;
    const value = parseInt(full, 16);
    if (!Number.isFinite(value)) return [0, 0, 0];
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  /**
   * Blend two colours, `t` = 0 gives `from` and `t` = 1 gives `to`.
   *
   * Used to walk the streak from white at its head to the flow colour at its
   * tail.  Interpolating in sRGB is not colour correct, but the two ends are
   * close enough in lightness that the difference is invisible here - and it
   * needs no colour space machinery.
   */
  function mixHex(from, to, t) {
    const a = hexRgb(from);
    const b = hexRgb(to);
    const k = clampNum(t, 0, 1);
    const parts = a.map((v, i) => Math.round(v + (b[i] - v) * k));
    return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
  }

  /**
   * Length of one of the branch paths, in user units.
   *
   * The branch connectors are plain `M / L` polylines, so summing the segments
   * is enough - and doing that here keeps the streak animation from having to
   * call `getTotalLength()` on a live element, which would force a layout on
   * every render.
   *
   * `M` is a *move*, not a segment: it places the pen and contributes nothing.
   * Treating it as a line from (0, 0) made every branch look several hundred
   * units long, which in turn stretched the streak cycle to its ten second cap.
   */
  function pathLen(d) {
    const tokens = String(d).match(/[MLHV]|-?\d*\.?\d+/gi) || [];
    let x = 0;
    let y = 0;
    let cmd = "";
    let i = 0;
    let total = 0;
    const next = () => num(tokens[i++]);
    while (i < tokens.length) {
      if (/^[MLHV]$/i.test(tokens[i])) {
        cmd = tokens[i].toUpperCase();
        i += 1;
      }
      if (i >= tokens.length) break;
      if (cmd === "M") {
        x = next();
        y = next();
      } else if (cmd === "L") {
        const nx = next();
        const ny = next();
        total += Math.hypot(nx - x, ny - y);
        x = nx;
        y = ny;
      } else if (cmd === "H") {
        const nx = next();
        total += Math.abs(nx - x);
        x = nx;
      } else if (cmd === "V") {
        const ny = next();
        total += Math.abs(ny - y);
        y = ny;
      } else {
        break;
      }
    }
    return total;
  }

  /**
   * The same polyline walked the other way, so a reverse flow can reuse the
   * forward animation.
   *
   * The branch connectors are written corner first and unit last, so a negative
   * reading has to travel from the unit back to the corner.  Animating that by
   * negating the dash offset does not work: on a reverse trip the leading edge is
   * the dash's *start*, so each slice's "further back" shift moved it *forward*
   * instead - the streak ran tail first, with the faded end in front.  Reversing
   * the points keeps a single set of keyframe values for both directions.
   *
   * Only `M` / `L` appear in these paths, which is all this handles; anything
   * else is returned untouched.
   */
  function reversePoly(d) {
    const tokens = String(d).match(/[MLHV]|-?\d*\.?\d+/gi) || [];
    const pts = [];
    let cmd = "";
    let i = 0;
    let x = 0;
    let y = 0;
    const next = () => num(tokens[i++]);
    while (i < tokens.length) {
      if (/^[MLHV]$/i.test(tokens[i])) {
        cmd = tokens[i].toUpperCase();
        i += 1;
      }
      if (i >= tokens.length) break;
      if (cmd === "M" || cmd === "L") {
        x = next();
        y = next();
        pts.push({ x, y });
      } else if (cmd === "H") {
        x = next();
        pts.push({ x, y });
      } else if (cmd === "V") {
        y = next();
        pts.push({ x, y });
      } else {
        return d;
      }
    }
    if (pts.length < 2) return d;
    const back = pts.slice().reverse();
    return `M${back[0].x} ${back[0].y}`
      + back.slice(1).map((p) => ` L${p.x} ${p.y}`).join("");
  }

  function group(value) {
    const parts = String(value).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  function fmtW(value) {
    const abs = Math.abs(num(value));
    const text = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    return `${group(text)} W`;
  }

  function fmtEnergy(kwh) {
    const v = num(kwh);
    const abs = Math.abs(v);
    if (abs >= 1000) return `${(v / 1000).toFixed(2)} MWh`;
    if (abs >= 1) return `${v.toFixed(2)} kWh`;
    return `${(v * 1000).toFixed(0)} Wh`;
  }

  function dayStart(date, offsetDays = 0) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offsetDays);
    return d;
  }

  /* ------------------------------------------------------------------ *
   * The head module's status display
   *
   * The hardware's display bar, keeping only the five readings that matter on
   * a dashboard: the power symbol, the PV reading with its SOLAR caption, the
   * SOC between two chevrons, and the battery reading with its BATTERY
   * caption.  The hardware's small status icon cluster and the Wi-Fi / eco
   * symbols are deliberately left out - they carry no dashboard information
   * and only made the bar busy.
   *
   * The readings are plain (zero padded, monospaced) text rather than literal
   * seven-segment strokes: at this size stroked digits read as scratchy, while
   * text keeps the panel legible and matches the callout style used elsewhere
   * in the card.
   * ------------------------------------------------------------------ */

  /* The readings sit a shade below pure white: on the near black panel a full
   * white figure glares and fights the body gradient. */
  const PANEL_INK = "#c9d1d9";
  const PANEL_DIM = "rgba(201,209,217,0.55)";
  /* The direction arrow is lit in plain white - it is the one element that has
   * to read at a glance, so it sits above the (deliberately dimmer) figures. */
  const PANEL_ARROW = "#ffffff";
  const PANEL_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const PANEL_MIN_W = 5;                  // below this the battery is idle

  /**
   * A watt reading as the hardware would show it: the real value, no zero
   * padding, clamped to what four digits can hold.
   */
  function watt(value) {
    return String(Math.min(9999, Math.round(Math.abs(num(value)))));
  }

  /**
   * The status display on the head module.  `pv` and `battery` are watts and
   * `soc` a percentage; both readings are the *device's own* values, because
   * the head depicts this unit rather than the whole system.
   *
   * Layout: the SOC owns the middle of the panel - it and its two arrows are
   * centred on the panel's own centre line - and the two watt groups mirror
   * outwards from it (the power symbol, with no counterpart on the right, hangs
   * off the left end).  Every element on the top line shares one horizontal
   * centre, and each watt reading carries its `W` as a subscript at its bottom
   * right.
   *
   * All of it is derived from the panel centre, so changing a font size or the
   * number of digits only means re-checking the few widths above.
   */
  function headDisplay(pv, battery, soc) {
    const ink = PANEL_INK;
    const dim = PANEL_DIM;
    // The head band is HEAD_TOP..HEAD_TOP+TOP_H (96..162), so 129 is its middle.
    const cy = HEAD_TOP + 33;
    // Baselines that put each font's *glyph box* on `cy`: the digits of a 13px
    // value sit 4.4 above their baseline, an 18px SOC 6.0.
    const valueY = cy + 4.4;
    const unitY = valueY + 3.6;           // the W, tucked into the bottom right
    const capY = cy + 14;                 // SOLAR / BATTERY captions

    const mid = FRONT_X + FRONT_W / 2;    // 280 - the panel's centre line
    const socHalf = 14.9;                 // half of the widest SOC ("100", 18px)
    const arrowGap = 9;
    const arrowW = 5;
    const groupGap = 10;
    const unitW = 8;                      // the "W" at 8px
    const unitGap = 2;
    // Width of one mono digit at 13px with the letter spacing used below; the
    // readings are NOT zero padded, so their width follows the value.
    const digitW = 7.45;
    const maxValueW = 4 * digitW;         // 29.8 - what four digits occupy
    // Distance from the centre line out to the inner edge of each watt value.
    // The readings are right aligned, so their inner edge is what is fixed -
    // a shorter number simply leaves more room towards the arrow.
    const inner = socHalf + arrowGap + arrowW + groupGap + unitW + unitGap;

    const pvText = watt(pv);
    const batText = watt(battery);

    const pvValueRight = mid - inner;               // 231.1
    const pvUnit = pvValueRight + unitGap;          // 233.1 - its own bottom right
    const pvCaption = pvValueRight - pvText.length * digitW / 2;
    // The battery group is the *mirror* of the PV group, so that reading keeps
    // its W at its bottom right too - which, on this side, is the outer edge.
    // (Putting the W on the inner edge there would have parked it left of the
    // number.)
    const batGroupRight = mid + inner + maxValueW;  // 368.4
    const batUnit = batGroupRight - unitW;          // 360.4
    const batValueRight = batUnit - unitGap;        // 358.4
    const batCaption = batValueRight - batText.length * digitW / 2;
    // The power symbol has no counterpart on the right, so it stays put: it is
    // anchored to where the widest battery/PV number would reach, not to the
    // current digits (otherwise it would jitter as the reading changes).
    const powerCx = pvValueRight - maxValueW - 14 - 6.5;  // 180.8

    const parts = [];
    const charging = num(battery) < -PANEL_MIN_W;
    const discharging = num(battery) > PANEL_MIN_W;

    // power symbol: the ring opens at the top, the stem drops through the gap
    parts.push(`<path d="M${(powerCx - 4.43).toFixed(2)} ${(cy - 4.76).toFixed(2)}
        A6.5 6.5 0 1 0 ${(powerCx + 4.43).toFixed(2)} ${(cy - 4.76).toFixed(2)}"
        fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="${powerCx.toFixed(2)}" y1="${cy - 7}" x2="${powerCx.toFixed(2)}" y2="${cy + 1}"
        stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>`);

    // PV reading (right aligned so the "W" never moves) + its caption
    parts.push(`<text x="${pvValueRight.toFixed(1)}" y="${valueY}" text-anchor="end" font-size="13"
        font-weight="600" letter-spacing="0.3" font-family="${PANEL_MONO}"
        fill="${ink}">${pvText}</text>
      <text x="${pvUnit.toFixed(1)}" y="${unitY}" font-size="8" font-weight="600"
        fill="${dim}">W</text>
      <text x="${pvCaption.toFixed(1)}" y="${capY}" text-anchor="middle" font-size="6.5"
        letter-spacing="1" fill="${dim}">SOLAR</text>`);

    // SOC dead centre, flanked by whichever direction arrow applies
    const socText = soc == null
      ? "--"
      : String(Math.max(0, Math.min(100, Math.round(soc))));
    parts.push(`<text x="${mid}" y="${cy + 6}" text-anchor="middle" font-size="18"
        font-weight="600" font-family="${PANEL_MONO}"
        fill="${ink}">${socText}</text>`);
    if (charging) {
      parts.push(`<path d="M${(mid - socHalf - arrowGap).toFixed(1)} ${cy - 6}
        l-${arrowW} 6 ${arrowW} 6" fill="none"
        stroke="${PANEL_ARROW}" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round"/>`);
    } else if (discharging) {
      parts.push(`<path d="M${(mid + socHalf + arrowGap).toFixed(1)} ${cy - 6}
        l${arrowW} 6 -${arrowW} 6" fill="none"
        stroke="${PANEL_ARROW}" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round"/>`);
    }

    // battery reading + its caption
    parts.push(`<text x="${batValueRight.toFixed(1)}" y="${valueY}" text-anchor="end" font-size="13"
        font-weight="600" letter-spacing="0.3" font-family="${PANEL_MONO}"
        fill="${ink}">${batText}</text>
      <text x="${batUnit.toFixed(1)}" y="${unitY}" font-size="8" font-weight="600"
        fill="${dim}">W</text>
      <text x="${batCaption.toFixed(1)}" y="${capY}" text-anchor="middle" font-size="6.5"
        letter-spacing="1" fill="${dim}">BATTERY</text>`);

    return parts.join("");
  }

  /* ------------------------------------------------------------------ *
   * The stack itself
   *
   * Drawn the way the product photo looks: one tall body, a single gradient
   * that runs light at the top to almost black at the foot, thin seams marking
   * the modules, a dark head carrying the status display, and a small
   * connector tab on the head's right shoulder.  There is deliberately no
   * full-height side panel: the real unit is a flat front face.
   * ------------------------------------------------------------------ */
  function stackMarkup(packs, active, hostTemp, hostLabel, soc, pv, battery) {
    const count = Math.max(packs, 1);
    const stackH = TOP_H + count * MOD_H;
    const bottom = HEAD_TOP + stackH;
    const bodyTop = HEAD_TOP + TOP_H;
    const cx = FRONT_X + FRONT_W / 2;

    const parts = [];

    // The whole unit in one piece, painted with a single top-to-bottom
    // gradient (`hm-bat-body` is a userSpaceOnUse gradient built from the same
    // `bodyTop` / `bottom`, so it scales with the pack count).  The modules are
    // marked by thin seams only - not by shading each one separately.
    parts.push(`<rect x="${FRONT_X}" y="${HEAD_TOP}" width="${FRONT_W}"
        height="${stackH}" rx="7" fill="url(#hm-bat-body)"/>`);

    // seams + the wordmark at the foot of every module
    for (let i = 0; i < count; i += 1) {
      const y = bodyTop + i * MOD_H;
      if (i > 0) {
        parts.push(`<rect x="${FRONT_X}" y="${(y - 1.2).toFixed(1)}" width="${FRONT_W}"
          height="1.6" fill="rgba(255,255,255,0.30)"/>
        <rect x="${FRONT_X}" y="${(y + 0.6).toFixed(1)}" width="${FRONT_W}"
          height="1" fill="rgba(0,0,0,0.20)"/>`);
      }
      parts.push(`<text x="${FRONT_X + 16}" y="${y + MOD_H - 14}"
          font-size="12" letter-spacing="0.4"
          fill="rgba(255,255,255,0.55)">Hoymiles</text>`);
    }

    // The brand badge sits on the first module - the head carries the status
    // display instead of a logo, exactly like the hardware.
    const badgeCy = bodyTop + MOD_H / 2;
    parts.push(`<circle cx="${cx}" cy="${badgeCy}" r="25" fill="none"
        stroke="rgba(255,255,255,0.7)" stroke-width="1.8"/>
      <text x="${cx}" y="${badgeCy + 9}" text-anchor="middle" font-size="26"
        font-weight="600" fill="rgba(255,255,255,0.8)">H</text>
      <text x="${cx}" y="${badgeCy + 48}" text-anchor="middle" font-size="13"
        letter-spacing="0.6" fill="rgba(255,255,255,0.78)">Hoymiles</text>`);

    // dark head module on top
    parts.push(`<path d="M${FRONT_X + 7} ${HEAD_TOP} h${FRONT_W - 14}
        a7 7 0 0 1 7 7 v${TOP_H - 7} h-${FRONT_W} v-${TOP_H - 7}
        a7 7 0 0 1 7 -7 z" fill="url(#hm-bat-top)"/>`);

    // status display, and the shadow line where the head meets the body.
    // A faint highlight along the top edge keeps the panel reading as glass.
    parts.push(`<line x1="137" y1="96.7" x2="423" y2="96.7"
        stroke="rgba(255,255,255,0.10)" stroke-width="1.4"/>`);
    parts.push(headDisplay(pv, battery, soc));
    parts.push(`<rect x="${FRONT_X}" y="${bodyTop - 3}" width="${FRONT_W}"
        height="3" fill="rgba(0,0,0,0.35)"/>`);

    // Module callouts: strictly alternating left / right down the stack, like
    // the vendor app.  The alternation has to *start on the side opposite the
    // host callout*: the host is pinned to the left, so starting the packs on
    // the left too gave "left, left, right, left" with three packs - which is
    // exactly what the user saw.
    const hostOnLeft = hostTemp != null;
    for (let i = 0; i < count; i += 1) {
      const cy = bodyTop + i * MOD_H + MOD_H / 2;
      const onLeft = hostOnLeft ? i % 2 === 1 : i % 2 === 0;
      const dotX = onLeft ? LEFT_DOT_X : RIGHT_DOT_X;
      const boxX = onLeft ? LEFT_BOX_X : RIGHT_BOX_X - CALLOUT_W;
      const edgeX = onLeft ? LEFT_BOX_X + CALLOUT_W : RIGHT_BOX_X - CALLOUT_W;

      const soc = i < active.length ? active[i].soc : null;
      const temp = i < active.length ? active[i].temp : null;

      parts.push(`<line x1="${edgeX}" y1="${cy}" x2="${dotX}" y2="${cy}"
        stroke="${DOT_COLOR}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${dotX}" cy="${cy}" r="5" fill="${DOT_COLOR}"
        stroke="#fff" stroke-width="1.6"/>`);
      parts.push(`<g class="bat-call">
        <rect x="${boxX}" y="${cy - CALLOUT_H / 2}" width="${CALLOUT_W}"
          height="${CALLOUT_H}" rx="11" fill="rgba(56,61,70,0.88)"/>
        <text x="${boxX + 14}" y="${cy - 6}" class="bat-call-t">${esc(active[i].label)}</text>
        <text x="${boxX + 14}" y="${cy + 15}" class="bat-call-v">${soc == null ? "--" : `${soc.toFixed(2)}%`}<tspan
          class="bat-call-temp" dx="9">${temp == null ? "--" : `${temp.toFixed(1)}°C`}</tspan></text>
      </g>`);
    }

    // Head-unit temperature, drawn as one more callout so it looks exactly like
    // the pack callouts above it (same box, same connector dot and line).  The
    // head module on top of the stack is the BMS / PCS unit and has no
    // temperature sensor of its own, so the reading is the average of the
    // installed packs (see `_hostTemp`).
    //
    // It sits on the LEFT: the right hand side belongs to the off-grid
    // connector, which comes straight out of the body just under the on-grid
    // line and runs down the outer edge.  Its dot shares x with the first
    // pack's, so the two left hand callouts line up in one column.
    if (hostTemp != null) {
      const cy = HEAD_TOP + TOP_H - 5;
      const boxX = LEFT_BOX_X;
      const edgeX = boxX + CALLOUT_W;
      const dotX = LEFT_DOT_X;

      parts.push(`<line x1="${edgeX}" y1="${cy}" x2="${dotX}" y2="${cy}"
        stroke="${DOT_COLOR}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${dotX}" cy="${cy}" r="5" fill="${DOT_COLOR}"
        stroke="#fff" stroke-width="1.6"/>`);
      parts.push(`<g class="bat-call">
        <rect x="${boxX}" y="${cy - CALLOUT_H / 2}" width="${CALLOUT_W}"
          height="${CALLOUT_H}" rx="11" fill="rgba(56,61,70,0.88)"/>
        <text x="${boxX + 14}" y="${cy - 6}" class="bat-call-t">${esc(hostLabel)}</text>
        <text x="${boxX + 14}" y="${cy + 15}" class="bat-call-v">${hostTemp.toFixed(1)}°C</text>
      </g>`);
    }

    return { markup: parts.join(""), bodyTop, bottom };
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesBattery extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _range: { type: String },
        _history: { type: Object },
        _histLoading: { type: Boolean },
        _histError: { type: String },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
      this._range = RANGES[0].id;
      this._history = null;
      this._histLoading = false;
      this._histError = null;
      this._histFetchedAt = 0;
      this._histToken = 0;
      // Flow animation state.  The phases are keyed by branch name rather than
      // by element: the SVG is rebuilt whenever a reading changes, and starting
      // every streak over from the near end each second reads as a stutter.
      this._flowPhase = new Map();
      this._flowClock = 0;
      this._spinEl = null;
      this._pulseEls = [];
      this._flowRaf = 0;
      this._flowLast = 0;
      this._spinDeg = 0;
      this._pulsePhase = 0;
      this._flowTick = this._flowTick.bind(this);
    }

    /**
     * Collect the parts that a requestAnimationFrame loop drives.
     *
     * Only the status glyph is left in that loop - the spinning ring and the
     * segments that fill while charging.  The branch flow is a CSS animation and
     * needs nothing here.
     */
    _syncAnimation() {
      const root = this.renderRoot;
      if (!root) return;
      this._spinEl = root.querySelector("[data-hm-spin]");
      this._pulseEls = Array.from(root.querySelectorAll("[data-hm-pulse]"));
      if (!this._flowRaf && (this._spinEl || this._pulseEls.length)) {
        this._flowLast = 0;
        this._flowRaf = requestAnimationFrame(this._flowTick);
      }
    }

    updated() {
      this._syncAnimation();
    }

    /**
     * Language changes are announced on `window`; re-rendering is all a card
     * has to do, because the wording is chosen while it renders.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
      /* Lit does not re-render when an element is re-attached, so the glyph
         would stay frozen after a tab switch: restart its loop here.  The flow
         pulse is a CSS animation and takes care of itself.  The clock is
         forgotten so the first render after coming back does not add the whole
         time away to the phase. */
      this._flowClock = 0;
      this._syncAnimation();
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
      if (this._flowRaf) cancelAnimationFrame(this._flowRaf);
      this._flowRaf = 0;
      this._flowLast = 0;
      this._flowClock = 0;
    }

    /** Advance the status glyph.  The branch flow is CSS and not driven here. */
    _flowTick(ts) {
      if (!this._spinEl && !this._pulseEls.length) {
        this._flowRaf = 0;
        return;
      }
      if (!this._flowLast) this._flowLast = ts;
      const dt = Math.min(80, ts - this._flowLast);
      this._flowLast = ts;

      // Discharging: the two arrows chase each other round the ring.
      if (this._spinEl) {
        this._spinDeg = (this._spinDeg + dt * 0.16) % 360;
        const cx = this._spinEl.getAttribute("data-cx");
        const cy = this._spinEl.getAttribute("data-cy");
        this._spinEl.setAttribute(
          "transform", `rotate(${this._spinDeg.toFixed(1)} ${cx} ${cy})`,
        );
      }

      // Charging: the battery fills one segment at a time.
      if (this._pulseEls.length) {
        this._pulsePhase = (this._pulsePhase + dt) % 1320;
        const level = Math.floor(this._pulsePhase / 440);
        for (const el of this._pulseEls) {
          const index = Number(el.getAttribute("data-hm-pulse"));
          el.style.opacity = index <= level ? "1" : "0.24";
        }
      }

      this._flowRaf = requestAnimationFrame(this._flowTick);
    }

    static getConfigElement() {
      return document.createElement("hoymiles-battery-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 10px;
                justify-content: space-between; }
        .htitle { flex: 1; text-align: center; font-size: 19px;
                  font-weight: 600; color: var(--primary-text-color); }
        .hstat { display: flex; align-items: center; gap: 10px; min-width: 40px;
                 justify-content: flex-end; }
        .hstat svg { display: block; }
        .bell { color: var(--error-color); font-size: 17px; line-height: 1; }
        .wrap { display: flex; justify-content: center;
                /* max_width caps the illustration, and the dashboard column is
                   usually wider than that - without auto margins the leftover
                   space piles up on the right and the unit looks shoved left. */
                margin: 0 auto; }
        .wrap svg { display: block; width: 100%; height: auto; }

        .bat-v { font-size: 24px; font-weight: 600;
                 fill: var(--primary-text-color); }
        .bat-c { font-size: 13px; fill: var(--secondary-text-color); }
        .bat-call-t { font-size: 11px; fill: rgba(255,255,255,0.66); }
        .bat-call-v { font-size: 17.8px; font-weight: 600; fill: #ffffff; }
        .bat-call-temp { font-size: 13.5px; font-weight: 500;
                         fill: rgba(255,255,255,0.82); }

        /* The branch flow is one streak of light sent along the connector.  The
           three stops are CSS variables because they depend on the length of the
           branch, which the keyframes cannot know: a custom property inside a
           keyframe is substituted per element, so this is how every path gets
           its own travel distance while all of them share one animation.  The
           72% stop must stay in step with FLOW_TRAVEL.

           The distance is in px, which inside an SVG is user units; a bare
           number is not valid in a CSS declaration, only in a presentation
           attribute. */
        .hm-beam path {
          pointer-events: none;
          animation-name: hm-flow-run;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        @keyframes hm-flow-run {
          0% { stroke-dashoffset: var(--hm-a, 40px); }
          72% { stroke-dashoffset: var(--hm-b, 0px); }
          100% { stroke-dashoffset: var(--hm-c, -40px); }
        }

        .hist { margin-top: 10px; border-top: 1px solid var(--divider-color);
                padding-top: 10px; }
        .hhead { display: flex; flex-wrap: wrap; gap: 6px 12px;
                 align-items: center; justify-content: space-between; }
        .hlabel { font-size: 15px; font-weight: 600;
                  color: var(--primary-text-color); }
        .pills { display: flex; gap: 4px; }
        .pill { padding: 3px 14px; border-radius: 999px; font-size: 12.5px;
                cursor: pointer; border: 1px solid transparent;
                background: var(--secondary-background-color, rgba(127,127,127,0.12));
                color: var(--secondary-text-color); }
        .pill.on { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .chart { margin-top: 6px; }
        .chart svg { display: block; width: 100%; height: auto; }
        .soc-axis { font-size: 11px; fill: var(--secondary-text-color); }
        .soc-line { fill: none; stroke: var(--primary-color); stroke-width: 2.2;
                    stroke-linejoin: round; stroke-linecap: round; }
        .soc-last { font-size: 12.5px; font-weight: 600;
                    fill: var(--primary-text-color); }
        .summary { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px;
                   color: var(--secondary-text-color); margin-top: 4px;
                   font-variant-numeric: tabular-nums; }
        .summary b { color: var(--primary-text-color); font-weight: 600; }
        .msg { font-size: 12.5px; color: var(--secondary-text-color);
               padding: 10px 0 2px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-battery: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
      if (config.range) this._range = config.range;
      this._history = null;
      this._histFetchedAt = 0;
      // `hass` may already be set when the dashboard is edited in place.
      this._maybeFetchHistory();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first) this._maybeFetchHistory();
      this.requestUpdate();
    }

    getCardSize() {
      return 12;
    }

    /**
     * Only re-render when something the drawing depends on changed. The device
     * pushes state every second, and the illustration is a few hundred SVG
     * nodes — no reason to rebuild it when the numbers are identical.
     */
    shouldUpdate() {
      if (!this._config || !this._hass) return true;
      const signature = this._signature();
      if (signature === this._signatureCache) return false;
      this._signatureCache = signature;
      return true;
    }

    _signature() {
      const packs = [];
      for (let i = 1; i <= PACK_MAX; i += 1) {
        packs.push(`${this._read(`pack${i}_soc`, null)}:${this._read(`pack${i}_temperature`, null)}`);
      }
      return [
        hmLang(this._hass, this._config),
        this._config.max_width, this._title(),
        this._config.show_title, this._config.alarm_entity, this._range,
        // The model arrives with the device registry, which can load after the
        // first render, so it has to be part of what triggers a rebuild.
        this._title(),
        this._read("rssi", null), this._alarmOn(),
        this._read("pv_power", 0), this._read("grid_on_power", 0),
        this._read("grid_off_power", 0),
        // The head display and the bottom-left readout use the system level
        // values when they exist, so both have to be in the signature or the
        // drawing would go stale while the device is grouped.
        this._read("system_pv_power", null), this._read("system_battery_power", null),
        this._read("bat_power", null),
        this._packCount(), packs.join(","),
        this._readText("battery_status"), this._readText("bat_sts"),
        this._showHostTemp() ? this._hostTemp() : null,
        this._read("soc", null),
        this._history ? `${this._history.soc.length}:${this._history.charge}:${this._history.discharge}` : "none",
        this._histError || "",
      ].join("\u0001");
    }

    _alarmOn() {
      const entityId = this._config.alarm_entity;
      if (!entityId || !this._hass) return false;
      const state = (this._hass.states || {})[entityId];
      return !!state && state.state === "on";
    }

    /* ----------------------------- lookup ----------------------------- */

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
     * The device the card is looking at, from the device registry.
     *
     * `dev_id` is the integration/DNS identifier the firmware publishes, which
     * is exactly what the device's `identifiers` carry, so no entity lookup is
     * needed.  A device may be registered more than once (the MQTT discovery
     * device and the integration's own), and only some of those entries know
     * the model, so prefer whichever one has it.
     */
    _device() {
      const hass = this._hass;
      if (!hass || !hass.devices) return null;
      const wanted = String(this._dev() || "").toLowerCase();
      if (!wanted) return null;

      let fallback = null;
      for (const device of Object.values(hass.devices)) {
        if (!device) continue;
        const hit = (device.identifiers || []).some(
          (pair) => pair && String(pair[1] || "").toLowerCase() === wanted);
        if (!hit) continue;
        if (device.model) return device;
        if (!fallback) fallback = device;
      }
      if (fallback) return fallback;

      // No identifier matched (renamed by hand, unusual setup): fall back to
      // the device one of our own entities belongs to.
      const entityId = this._resolveEntity("soc") || this._resolveEntity("bat_power");
      const entry = entityId && hass.entities ? hass.entities[entityId] : null;
      return entry && entry.device_id ? (hass.devices[entry.device_id] || null) : null;
    }

    /** Model as reported by the device ("HiBattery 4020 X"), or null. */
    _model() {
      const device = this._device();
      return device && device.model ? String(device.model) : null;
    }

    /**
     * Header title: explicit config wins, then what the device says it is, and
     * only then a generic placeholder — a hard-coded name goes stale as soon as
     * the hardware changes.
     */
    _title() {
      const configured = this._text(this._config && this._config.title);
      if (typeof configured === "string" && configured) return configured;
      return this._model() || "HiBattery X";
    }

    _showTitle() {
      const config = this._config || {};
      return config.show_title !== false && config.title !== false;
    }

    _resolveEntity(suffix, domain = "sensor") {
      const overrides = (this._config.entities || {});
      if (overrides[suffix]) return overrides[suffix];

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cacheKey = `${domain}:${suffix}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${suffix}`;
      let found = hass.states[conventional] ? conventional : null;

      if (!found) {
        // Normalized exact match on the part after `<domain>.<dev>_`, so both
        // `pack1_soc` and the slugified `pack_1_soc` resolve.
        const prefix = `${domain}.${dev}`;
        const wanted = norm(suffix);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          if (norm(entityId.slice(prefix.length + 1)) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found && hass.entities) {
        const uniqueSuffix = `hoymiles_${this._dev()}_${suffix}`;
        for (const [entityId, entry] of Object.entries(hass.entities)) {
          if (entry && entry.unique_id === uniqueSuffix) {
            found = entityId;
            break;
          }
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    _stateOf(suffix, domain = "sensor") {
      const entityId = this._resolveEntity(suffix, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unavailable" || value === "unknown") return null;
      return state;
    }

    _read(suffix, fallback = 0, domain = "sensor") {
      const state = this._stateOf(suffix, domain);
      if (!state) return fallback;
      const value = Number(state.state);
      return Number.isFinite(value) ? value : fallback;
    }

    _readText(suffix) {
      const state = this._stateOf(suffix);
      return state ? String(state.state) : "";
    }

    /* ---------------------------- the data ---------------------------- */

    /**
     * How many battery modules to draw.
     *
     * `pack_count` is authoritative, but it is a diagnostic entity and may be
     * hidden or missing on older firmware, so the count of packs that actually
     * report a SOC is used as a cross-check (and as the fallback).
     */
    _packCount() {
      let reported = 0;
      for (let i = 1; i <= PACK_MAX; i += 1) {
        if (this._stateOf(`pack${i}_soc`)) reported = i;
      }

      const declared = Math.round(this._read("pack_count", 0));
      const count = declared > 0 ? declared : reported;
      return Math.max(1, Math.min(count, PACK_MAX));
    }

    /** `show_host_temp: false` (also accepts the editor's "false") hides it. */
    _showHostTemp() {
      const value = (this._config || {}).show_host_temp;
      return !(value === false || value === "false");
    }

    /**
     * Head-unit ("主机") temperature.
     *
     * The head module on top of the stack is the BMS / PCS unit; it has no
     * temperature sensor of its own, so the vendor app shows the average of the
     * installed packs.  Only the packs the card actually draws are averaged,
     * and a pack that reports no temperature is skipped rather than counted as
     * zero.  If none of them report one, the firmware's own
     * `battery_temperature` (`device/state` → `bat_temp`, itself an average) is
     * used as a fallback; `null` leaves the readout off the drawing.
     */
    _hostTemp() {
      const count = this._packCount();
      const temps = [];
      for (let i = 1; i <= count; i += 1) {
        const temp = this._read(`pack${i}_temperature`, null);
        if (temp !== null) temps.push(temp);
      }
      if (temps.length) {
        return temps.reduce((sum, value) => sum + value, 0) / temps.length;
      }
      return this._read("battery_temperature", null);
    }

    _batteryStatus(battery) {
      const raw = (this._readText("battery_status") || this._readText("bat_sts"))
        .toLowerCase();
      let key = raw;
      if (!STATUS[key]) {
        if (Math.abs(battery) < 5) key = "standby";
        else key = battery < 0 ? "charge" : "discharge";
      }
      const entry = STATUS[key] || STATUS.standby;
      return { key, cls: entry.cls, text: this._t(entry.en, entry.zh) };
    }

    /* ----------------------------- render ----------------------------- */

    render() {
      if (!this._config) return html``;

      let battery = this._read("system_battery_power", 0);
      if (!this._resolveEntity("system_battery_power")) {
        battery = this._read("bat_power", 0);
      }
      let pv = this._read("system_pv_power", 0);
      if (!this._resolveEntity("system_pv_power")) pv = this._read("pv_power", 0);

      const gridOn = this._read("grid_on_power", 0);
      const gridOff = this._read("grid_off_power", 0);
      const status = this._batteryStatus(battery);

      const count = this._packCount();
      const packs = [];
      for (let i = 0; i < PACK_MAX; i += 1) {
        packs.push({
          label: `${this._t("Battery", "电池")} ${i + 1}`,
          soc: this._read(`pack${i + 1}_soc`, null),
          temp: this._read(`pack${i + 1}_temperature`, null),
        });
      }
      const batteryCaption = this._t("Battery ", "电池") + status.text;
      const hostTemp = this._showHostTemp() ? this._hostTemp() : null;
      // The head's status display shows the device level SOC (1 s), the same
      // reading the power flow card and the SOC gauges use, plus this unit's
      // own PV and battery power.
      const soc = this._read("soc", null);
      const pvDev = this._read("pv_power", 0);
      const batDev = this._read("bat_power", 0);

      return html`
        <ha-card>
          <div class="head">
            <div class="hstat">${this._alarm()}</div>
            ${this._showTitle()
              ? html`<div class="htitle">${esc(this._title())}</div>`
              : html`<div class="htitle"></div>`}
            <div class="hstat">${this._untrusted(this._signal())}</div>
          </div>
          <div class="wrap" style=${this._wrapStyle()}>
            ${this._untrusted(this._svg({
              count, packs, pv, gridOn, gridOff, battery, status, batteryCaption,
              hostTemp, soc, pvDev, batDev,
            }))}
          </div>
          ${this._config.show_history === false ? "" : this._historySection()}
        </ha-card>
      `;
    }

    _wrapStyle() {
      const width = num(this._config.max_width);
      return width > 0 ? `max-width:${width}px` : "max-width:560px";
    }

    _alarm() {
      return this._alarmOn() ? html`<span class="bell">🔔</span>` : "";
    }

    /** Wi-Fi style signal bars derived from the device's `rssi` sensor. */
    _signal() {
      const rssi = this._read("rssi", null);
      let bars = 0;
      if (rssi !== null) {
        if (rssi >= -55) bars = 4;
        else if (rssi >= -65) bars = 3;
        else if (rssi >= -75) bars = 2;
        else bars = 1;
      }
      const color = bars === 0
        ? "var(--disabled-text-color, #b6bcc4)"
        : "var(--primary-color)";
      let out = `<svg width="22" height="18" viewBox="0 0 22 18">`;
      for (let i = 0; i < 4; i += 1) {
        const h = 4 + i * 3.4;
        out += `<rect x="${1 + i * 5}" y="${16 - h}" width="3.4" height="${h}" rx="1.4"
          fill="${i < bars ? color : "var(--divider-color, #dcdfe4)"}"/>`;
      }
      out += "</svg>";
      return out;
    }

    /* --------------------------- the diagram --------------------------- */

    _svg(d) {
      // The head shows this unit's own readings, the corner callouts the system
      // level ones - the panel draws the device itself, not the whole system.
      const { markup, bodyTop, bottom } = stackMarkup(
        d.count, d.packs, d.hostTemp, this._t("Host", "主机"),
        d.soc, d.pvDev, d.batDev,
      );
      const bottomY = bottom + HEADER_GAP;
      const totalH = bottomY + TAIL_GAP;

      return `<svg viewBox="0 0 ${VB_W} ${totalH}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <linearGradient id="hm-bat-top" x1="0" y1="0" x2="0.25" y2="1">
            <stop offset="0" stop-color="#333a42"/>
            <stop offset="1" stop-color="#14181c"/>
          </linearGradient>
          <linearGradient id="hm-bat-body" x1="0" y1="${bodyTop}" x2="0" y2="${bottom}"
              gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#d2d7dc"/>
            <stop offset="0.32" stop-color="#bcc2c9"/>
            <stop offset="0.58" stop-color="#949ba3"/>
            <stop offset="0.82" stop-color="#4a5058"/>
            <stop offset="1" stop-color="#16181b"/>
          </linearGradient>
        </defs>
        ${this._flowPaths(d, bottom, bottomY)}
        ${markup}
        ${this._row(30, 62, "sun", fmtW(d.pv), this._t("PV", "光伏"), "start")}
        ${this._row(VB_W - 30, VB_W - 58, "socket", fmtW(d.gridOn),
          this._t("Grid port", "并网端口"), "end")}
        ${this._row(30, 62, `status:${d.status.key}`, fmtW(d.battery),
          d.batteryCaption, "start", bottomY)}
        ${this._row(VB_W - 24, VB_W - 58, "dot", fmtW(d.gridOff),
          this._t("Off-grid port", "离网端口"), "end", bottomY)}
      </svg>`;
    }

    /**
     * The three branch connectors, and the flow that runs along them.
     *
     * Only PV, the on-grid port and the off-grid port get one.  The battery
     * lives inside the unit, so its corner is a readout rather than a port -
     * a line there would suggest energy leaving the box, which it does not.
     *
     * Every branch is drawn once in its own grey, and a branch that carries
     * power gets one streak of light sent along it: a white head with a tail
     * that fades out behind it.  The streak is a CSS animation, so the flow keeps
     * running across a detach / re-attach of the card; the phase it has already
     * reached is carried in `_flowPhase` and handed to the new elements through a
     * negative `animation-delay`, which is why a rebuild (about once a second)
     * does not restart it.  The path is written corner first, unit last, so
     * `into` decides the direction rather than the geometry.
     *
     * These are emitted *before* the unit in `_svg`, so the housing paints over
     * them.  Each connector therefore runs `BURY` units past the face it plugs
     * into: the tail disappears behind the body and the line reads as going
     * under the housing.  Drawn the other way round, the round line cap sat on
     * top of the dark head and the connection looked like it floated above the
     * device instead of entering it.
     */
    _flowPaths(d, bottom, bottomY) {
      const headRight = FRONT_X + FRONT_W;   // 430, the body's right face
      const portX = VB_W - 30;               // 590, shared by both right ports
      const topY = 60;                       // just under the top readouts
      const BURY = 12;                       // how far a connector hides in the body

      // The off-grid line always leaves the head, 12 units below the on-grid
      // line that enters the body at 108, so the two right hand ports read as
      // one column split in two - with a deliberate gap, because they are
      // different ports.
      //
      // It used to duck below the lowest right hand callout instead, which
      // meant that with more than one pack the line started halfway down the
      // body instead of at the PCS.  The callouts are now inset from the right
      // edge (RIGHT_BOX_X) so the vertical at `portX` runs past them, and the
      // branch can stay where it belongs whatever the pack count is.
      const offY = 120;

      const branches = [
        {
          key: "pv",
          // down from the sun, then right, behind the head's left face
          path: `M30 ${topY} L30 112 L${FRONT_X + BURY} 112`,
          value: d.pv,
          // PV can only ever feed the unit
          intoWhenPositive: true,
        },
        {
          key: "gridOn",
          // down from the socket, then left, behind the head's right face
          path: `M${portX} ${topY} L${portX} 108 L${headRight - BURY} 108`,
          value: d.gridOn,
          // positive: the port is delivering to the load / grid
          intoWhenPositive: false,
        },
        {
          key: "gridOff",
          // from behind the head, right, then straight down to its own dot.  The
          // vertical shares the grid port's x so the two read as one column,
          // with a deliberate gap between them: they are different ports.
          path: `M${headRight - BURY} ${offY} L${portX} ${offY}`
            + ` L${portX} ${bottomY - 33}`,
          value: d.gridOff,
          // positive: the backup port is feeding its load
          intoWhenPositive: false,
        },
      ];

      /* How far each streak has got, 0..1 of one trip.  Advanced here because
         the speed depends on the power, which is only known while the branches
         are being built; the CSS animation carries it from this phase to the
         phase of the next render. */
      const now = (typeof performance !== "undefined"
        && typeof performance.now === "function")
        ? performance.now()
        : Date.now();
      const last = this._flowClock || now;
      this._flowClock = now;
      const dt = Math.min(Math.max((now - last) / 1000, 0), 5);

      return branches
        .map(({ key, path, value, intoWhenPositive }) => {
          const base = `<path d="${path}" fill="none" stroke="#cfd4da"
            stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
          const magnitude = Math.abs(num(value));
          if (magnitude < FLOW_IDLE_W) return base;

          const into = value > 0 === intoWhenPositive;
          /* Travel along the geometry in its own direction instead of animating
             the original path backwards; see `reversePoly`. */
          const travel = into ? path : reversePoly(path);
          const len = pathLen(travel);
          if (!(len > 0)) return base;

          /* `flowSpeed` is the speed while travelling; a trip also has to get
             off the far end, and the cycle ends with a short pause. */
          const speed = FLOW_SPEED_MIN
            + Math.min(1, magnitude / FLOW_SPEED_FULL_W) * FLOW_SPEED_RANGE;
          const duration = clampNum(len / (speed * FLOW_TRAVEL), 0.8, 10);
          const known = this._flowPhase.get(key);
          const phase = dt > 0 && Number.isFinite(known)
            ? (known + dt / duration) % 1
            : (Number.isFinite(known) ? known : 0);
          this._flowPhase.set(key, phase);

          const streak = clampNum(len * FLOW_SHARE, FLOW_MIN, Math.min(FLOW_MAX, len));
          const delay = (-phase * duration).toFixed(2);
          const slice = streak / FLOW_SLICES;
          /* Wide enough that the pattern cannot repeat on the branch: exactly
             one streak is ever on the wire. */
          const gap = 2 * len + slice;

          /* A run of slices with a colour and an opacity each - that is what
             makes the fade smooth.  Slice `i` sits `i * slice` further back than
             the head, and because the geometry has already been turned to face
             the direction of travel, "back" is simply a larger offset for both
             directions: `dashoffset = size - front`. */
          let band = "";
          for (let i = 0; i < FLOW_SLICES; i += 1) {
            /* 0 at the head, 1 at the tail. */
            const t = i / (FLOW_SLICES - 1);
            const shift = i * slice;
            const vars = `--hm-a:${(slice + shift).toFixed(2)}px;`
              + `--hm-b:${(slice - len + shift).toFixed(2)}px;`
              + `--hm-c:${(slice - len - streak + shift).toFixed(2)}px;`;
            const width = (FLOW_WIDTH - (FLOW_WIDTH - FLOW_TIP) * t).toFixed(2);
            const opacity = (1 - 0.94 * t).toFixed(3);
            const colour = mixHex("#ffffff", FLOW_COLOR, Math.min(1, t * 1.7));
            band += `<path d="${travel}" fill="none" stroke="${colour}"
              stroke-width="${width}" stroke-opacity="${opacity}"
              stroke-linecap="${i === 0 ? "round" : "butt"}"
              stroke-linejoin="round"
              stroke-dasharray="${slice.toFixed(2)} ${gap.toFixed(2)}"
              style="${vars}`
              + `animation-duration:${duration.toFixed(2)}s;`
              + `animation-delay:${delay}s"/>`;
          }

          return `${base}<g class="hm-beam">${band}</g>`;
        })
        .join("");
    }

    /**
     * The battery corner icon, which doubles as the state indicator.
     *
     * One fixed drawing would leave the animation with nothing to say, so the
     * glyph follows the state the way the vendor app does: a battery whose
     * segments fill one after another while charging, the two-arrow cycle
     * while discharging, and a muted hourglass while idle.
     *
     * The moving parts are animated by `_flowTick` rather than CSS, because the
     * illustration is rebuilt whenever a reading changes - a CSS animation
     * would restart every second.
     */
    _statusGlyph(iconX, y, key) {
      // The three drawings share one optical size: a battery 30 wide, the
      // arrow ring 28 across, the hourglass 26.  All of them are centred on
      // the readout's power figure, which is 24px tall.
      const cx = iconX + 1;
      const cy = y - 30;

      if (key === "charge") {
        const bx = cx - 15;
        const by = cy - 9;
        const bars = [0, 1, 2].map((i) => `<rect data-hm-pulse="${i}"
            x="${(bx + 1.5 + i * 8.5).toFixed(1)}" y="${cy - 6}"
            width="6" height="12" rx="1.5" fill="${CHARGE_COLOR}"/>`).join("");
        return `<rect x="${bx}" y="${by}" width="26" height="18" rx="4"
            fill="none" stroke="${CHARGE_COLOR}" stroke-width="2.2"/>
          <rect x="${(bx + 26.5).toFixed(1)}" y="${cy - 4}" width="4.2"
            height="8" rx="1.6" fill="${CHARGE_COLOR}"/>
          ${bars}`;
      }

      if (key === "discharge") {
        /* The ring spins clockwise (`_flowTick` adds to the angle), so the
           arrow heads have to point clockwise or the graphic argues with its
           own motion. Material's "sync" is drawn the other way round - its heads
           point anticlockwise - so the glyph is mirrored inside the spinning
           group. Mirroring only the drawing leaves the rotation untouched: the
           mirror sits INSIDE `rotate()`, so it flips the arrows without
           reversing the spin. */
        return `<g data-hm-spin="1" data-cx="${cx}" data-cy="${cy}"
            transform="rotate(0 ${cx} ${cy})">
            <g transform="translate(${cx} ${cy}) scale(-1 1) translate(${-cx} ${-cy})">
              <g transform="translate(${(cx - 14).toFixed(1)} ${(cy - 14).toFixed(1)}) scale(${(28 / 24).toFixed(4)})">
                <path fill="${DISCHARGE_COLOR}" d="${SYNC_PATH}"/>
                <circle cx="12" cy="12" r="2.8" fill="${DISCHARGE_COLOR}"/>
              </g>
            </g>
          </g>`;
      }

      // standby / locked
      return `<g opacity="0.55">
          <g transform="translate(${(cx - 13).toFixed(1)} ${(cy - 13).toFixed(1)}) scale(${(26 / 24).toFixed(4)})">
            <path fill="${IDLE_COLOR}" d="${HOURGLASS_PATH}"/>
          </g>
        </g>`;
    }

    /**
     * One of the flat corner icons, scaled and centred on a readout.
     *
     * The optical centre is (`iconX` + 1, `y` - 30) - the same point the
     * battery-status glyphs and the 24 px figure are centred on, so a corner
     * never sits off the line of its own number.  The old socket was drawn
     * 16 units lower than the status glyphs, which is why it looked like it
     * was floating above the caption.
     */
    _cornerGlyph(iconX, y, key, size) {
      const build = CORNER_GLYPH[key];
      if (!build) return "";
      const s = size / 24;
      const x = (iconX + 1 - 12 * s).toFixed(2);
      const yy = (y - 30 + (CORNER_DY[key] || 0) - 12 * s).toFixed(2);
      return `<g transform="translate(${x} ${yy}) scale(${s.toFixed(4)})">`
        + build(CORNER_COLORS[key] || "#46505c") + `</g>`;
    }

    /**
     * One corner readout: icon, power value and caption.
     * `anchor` is "start" (icon on the left) or "end" (icon on the right).
     */
    _row(iconX, textX, icon, value, caption, anchor, y = 46) {
      let glyph;
      if (icon.startsWith("status:")) {
        glyph = this._statusGlyph(iconX, y, icon.slice(7));
      } else if (icon in CORNER_GLYPH) {
        glyph = this._cornerGlyph(iconX, y, icon, CORNER_SIZE[icon]);
      } else if (icon === "dot") {
        glyph = `<circle cx="${iconX - 6}" cy="${y - 27}" r="5.5" fill="#f5a623"/>`;
      } else {
        glyph = `<text x="${iconX - 12}" y="${y - 22}" font-size="20">${icon}</text>`;
      }
      return `${glyph}
        <text class="bat-v" x="${textX}" y="${y - 22}" text-anchor="${anchor}">${value}</text>
        <text class="bat-c" x="${textX}" y="${y}" text-anchor="${anchor}">${esc(caption)}</text>`;
    }

    /* -------------------------- history section -------------------------- */

    _historySection() {
      const pills = RANGES.map((r) => `
        <button class="pill ${r.id === this._range ? "on" : ""}"
                data-range="${r.id}">${esc(this._t(r.en, r.zh))}</button>`).join("");

      let body;
      if (this._histError) {
        body = html`<div class="msg">${esc(this._histError)}</div>`;
      } else if (!this._history) {
        body = html`<div class="msg">${this._t("Loading…", "加载中…")}</div>`;
      } else if (!this._history.soc.length) {
        body = html`<div class="msg">${this._t(
          "No statistics recorded for this range (the recorder must be enabled).",
          "该时间段没有统计数据（需要启用 recorder）。",
        )}</div>`;
      } else {
        body = html`
          ${this._untrusted(this._socChart(this._history.soc))}
          <div class="summary">
            <span>${this._t("Charged", "充电")} <b>${fmtEnergy(this._history.charge)}</b></span>
            <span>${this._t("Discharged", "放电")} <b>${fmtEnergy(this._history.discharge)}</b></span>
            <span>${this._t("Packs", "电池数量")} <b>${this._packCount()}</b></span>
          </div>`;
      }

      return html`
        <div class="hist">
          <div class="hhead">
            <div class="hlabel">${this._t("History", "历史数据")}</div>
            <div class="pills">${this._untrusted(pills)}</div>
          </div>
          ${body}
        </div>`;
    }

    _socChart(points) {
      const W = VB_W;
      const H = 150;
      const L = 34;
      const R = W - 14;
      const T = 12;
      const B = H - 24;

      const xs = (i) => L + (R - L) * (points.length === 1 ? 0.5 : i / (points.length - 1));
      const ys = (v) => B - (B - T) * (Math.max(0, Math.min(100, v)) / 100);

      const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)} ${ys(p).toFixed(1)}`).join(" ");
      const area = `${line} L${xs(points.length - 1).toFixed(1)} ${B} L${xs(0).toFixed(1)} ${B} Z`;

      let grid = "";
      for (const v of [0, 25, 50, 75, 100]) {
        grid += `<line x1="${L}" y1="${ys(v).toFixed(1)}" x2="${R}" y2="${ys(v).toFixed(1)}"
          stroke="var(--divider-color)" stroke-width="1" stroke-dasharray="3 4"/>
        <text class="soc-axis" x="${L - 6}" y="${(ys(v) + 4).toFixed(1)}"
          text-anchor="end">${v}</text>`;
      }

      const last = points[points.length - 1];
      const lastX = xs(points.length - 1);
      const lastY = ys(last);

      return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <linearGradient id="hm-bat-areafill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--primary-color)" stop-opacity="0.32"/>
            <stop offset="1" stop-color="var(--primary-color)" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#hm-bat-areafill)" stroke="none"/>
        <path class="soc-line" d="${line}" fill="none"/>
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4"
          fill="var(--primary-color)" stroke="#fff" stroke-width="1.6"/>
        <text class="soc-last" x="${Math.min(lastX + 8, R).toFixed(1)}"
          y="${Math.max(lastY - 8, T + 12).toFixed(1)}"
          text-anchor="${lastX > R - 60 ? "end" : "start"}">${last.toFixed(2)}%</text>
      </svg>`;
    }

    /* ---------------------------- statistics ---------------------------- */

    _rangeDef() {
      return RANGES.find((r) => r.id === this._range) || RANGES[0];
    }

    _maybeFetchHistory() {
      if (!this._hass || !this._config) return;
      if (this._config.show_history === false) return;
      if (this._history && Date.now() - this._histFetchedAt < HIST_TTL_MS) return;
      this._fetchHistory();
    }

    async _fetchHistory() {
      if (!this._hass || !this._config) return;
      if (typeof this._hass.callWS !== "function") return;

      // Same as the power flow card: the device level `soc` (1 s, average of
      // this unit's packs) keeps every SOC on the dashboard consistent.
      const socEntity = this._resolveEntity("soc") || this._resolveEntity("system_soc");
      const chgEntity = this._resolveEntity("battery_charge_energy_today");
      const dchgEntity = this._resolveEntity("battery_discharge_energy_today");
      const ids = [socEntity, chgEntity, dchgEntity].filter(Boolean);

      if (!ids.length) {
        this._histError = this._t(
          "No statistics source found for this device.",
          "未找到该设备的统计数据源。",
        );
        return;
      }

      const def = this._rangeDef();
      const token = ++this._histToken;
      this._histLoading = true;
      this._histError = null;

      const end = new Date();
      const start = def.id === "year"
        ? new Date(end.getFullYear(), 0, 1)
        : dayStart(end, def.days - 1);

      try {
        const result = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: def.period,
          types: ["mean", "change"],
        });
        if (token !== this._histToken) return; // a newer request won

        const socRows = (result && result[socEntity]) || [];
        const soc = socRows
          .map((row) => (row.mean == null ? null : num(row.mean)))
          .filter((value) => value !== null);

        const sum = (rows) => (rows || []).reduce((acc, row) => acc + num(row.change), 0);
        this._history = {
          soc,
          charge: sum(chgEntity ? result[chgEntity] : null) / 1000,
          discharge: Math.abs(sum(dchgEntity ? result[dchgEntity] : null)) / 1000,
        };
        this._histFetchedAt = Date.now();
      } catch (err) {
        if (token !== this._histToken) return;
        this._histError = this._t(
          "Statistics are unavailable — is the recorder enabled?",
          "统计数据不可用 —— 是否启用了 recorder？",
        );
        this._history = null;
      } finally {
        if (token === this._histToken) {
          this._histLoading = false;
          this.requestUpdate();
        }
      }
    }

    /* ---------------------------- interaction ---------------------------- */

    _handleClick(event) {
      const pill = event.target.closest("[data-range]");
      if (!pill) return;
      const range = pill.getAttribute("data-range");
      if (!range || range === this._range) return;
      this._range = range;
      this._history = null;
      this._histFetchedAt = 0;
      this._fetchHistory();
    }

    firstUpdated() {
      this.shadowRoot.addEventListener("click", (event) => this._handleClick(event));
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
  class HoymilesBatteryEditor extends LitElement {
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
          <ha-textfield label="title (defaults to the device model; accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="show_title (false = hide the heading)"
            .value=${config.show_title === false ? "false" : ""}
            @change=${this._changed("show_title")}></ha-textfield>
          <ha-textfield label="show_host_temp (false = hide the head unit temperature)"
            .value=${config.show_host_temp === false ? "false" : ""}
            @change=${this._changed("show_host_temp")}></ha-textfield>
          <ha-textfield label="max_width (px)" .value=${config.max_width || ""}
            @change=${this._changed("max_width")}></ha-textfield>
          <ha-textfield label="alarm_entity" .value=${config.alarm_entity || ""}
            @change=${this._changed("alarm_entity")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-battery-editor")) {
    customElements.define("hoymiles-battery-editor", HoymilesBatteryEditor);
  }
  if (!customElements.get("hoymiles-battery")) {
    customElements.define("hoymiles-battery", HoymilesBattery);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-battery")) {
    window.customCards.push({
      type: "hoymiles-battery",
      name: "Hoymiles Battery",
      description:
        "Battery stack of a Hoymiles micro storage device with per-pack SOC / "
        + "temperature callouts and the head unit temperature (the average of "
        + "the installed packs), scaled to the number of installed packs.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmBatteryRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmBatteryRegister());
}
