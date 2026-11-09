/* ============================================================================
 * Hoymiles Micro Storage — Energy flow (Sankey) card
 * ----------------------------------------------------------------------------
 * Lovelace card bundled with the `hoymiles` custom integration.
 *
 * It reads the device's energy sensors from the Home Assistant recorder's
 * long-term statistics via the public websocket command
 *
 *     recorder/statistics_during_period
 *
 * and renders a source -> inverter -> load Sankey diagram.
 *
 * IMPORTANT design notes
 * ----------------------
 * - The card NEVER touches the recorder database. It only calls the HA
 *   websocket API; HA does the SQL work.
 * - The websocket command does not require admin rights, but the recorder
 *   integration must be enabled (it is part of `default_config`).
 * - `types: ["change"]` makes HA return the already-computed delta for the
 *   range, so we never do value-differencing ourselves (this also sidesteps
 *   the `total_increasing` reset-detection edge cases).
 * - Rendering is hand-rolled SVG (no ECharts / no CDN), so the card keeps
 *   working on an offline Raspberry Pi.
 *
 * Card config:
 *   type: custom:hoymiles-energy-sankey
 *   dev_id: MSA-280520260806      # required
 *   title: Energy flow            # optional
 *   language: en                  # optional (en|zh|de); omit to follow Home Assistant
 *   range: today                  # optional (today|7d|30d|month)
 *   balancer_label: Loss          # optional label for the residual node
 *   show_toolbar: true            # optional
 *   ribbon_gap: 3                 # optional px of white line between ribbons
 *   ribbon_opacity: 0.5           # optional ribbon opacity (0..1)
 *   icons:                        # optional per-node emoji overrides
 *     pv: "☀️"
 *   statistics:                   # optional statistic_id overrides
 *     pv: sensor.my_pv_energy
 *     grid_in: [sensor.a, sensor.b]
 *
 * Layout: a direct source -> sink sankey (no hub). Each side is a single
 * column of node boxes (icon + value + unit + share of the period) with a
 * tinted label band facing the ribbons. Because the device meters every port
 * separately, the routing behind the ribbons is NOT measured: it is estimated
 * by spreading each source over the sinks proportionally (iterative
 * proportional fitting), forbidding impossible loops such as
 * battery-discharge -> battery-charge. Read the ribbons as a best-effort
 * attribution, not as metered truth.
 *
 * Interaction: click a ribbon to highlight that single flow, or click a node
 * box to highlight every ribbon that touches it. The rest of the diagram dims
 * and a detail panel lists the involved flows. Click the same target again (or
 * click empty diagram space) to clear. This is a pure view state: the numbers
 * never change.
 * ========================================================================== */

function _hmSankeyRegister() {
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
    "No energy sensor of this device was found. Check that the integration is set up and the device is online.": "Es wurde kein Energie-Sensor dieses Geräts gefunden. Prüfe, ob die Integration eingerichtet und das Gerät online ist.",
    "The recorder integration is unavailable, so long-term statistics cannot be read.": "Die Recorder-Integration ist nicht verfügbar, daher können keine Langzeitstatistiken gelesen werden.",
    "Failed to read statistics": "Statistiken konnten nicht gelesen werden",
    "Energy flow": "Energiefluss",
    "total": "gesamt",
    "Click again to clear.": "Erneut klicken zum Aufheben.",
    "Refresh": "Aktualisieren",
    "Reading statistics…": "Statistiken werden gelesen…",
    "No data yet.": "Noch keine Daten.",
    "No energy was recorded in the selected period.": "Im gewählten Zeitraum wurde keine Energie aufgezeichnet.",
    "Tip: click a ribbon or a node box to highlight that part of the flow.": "Tipp: Auf ein Band oder einen Knoten klicken, um diesen Teil des Flusses hervorzuheben.",
    "Ports are metered independently, so a balance line is shown for conversion losses and unmeasured flows.": "Die Anschlüsse werden unabhängig gemessen; deshalb zeigt eine Ausgleichslinie Wandlungsverluste und nicht gemessene Flüsse.",
    "No statistics yet for: ": "Noch keine Statistiken für: ",
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
   *     en: Energy flow
   *     zh: 能量流
   *   balancer_label:
   *     en: Loss / other
   *     zh: 损耗/其他
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
   * Layout constants — the SVG uses a fixed viewBox and is scaled by CSS,
   * so the diagram stays valid on any card width.
   * ------------------------------------------------------------------ */
  const VB_W = 1180;
  const VB_H = 470;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 14;
  const SIDE_PAD = 12;
  const NODE_W = 58;      // width of a node box (icon + value + %)
  const CHIP_W = 186;     // tinted "label band" drawn next to a node box
  const GAP = 14;         // vertical gap between node boxes
  const MIN_NODE_H = 46;  // keep small nodes readable
  const LEFT_X = SIDE_PAD;                    // left node box
  const LEFT_CHIP_X = LEFT_X + NODE_W;        // left label band
  const RIBBON_L = LEFT_CHIP_X + CHIP_W;      // ribbons start here
  const RIGHT_X = VB_W - SIDE_PAD - NODE_W;   // right node box
  const RIGHT_CHIP_X = RIGHT_X - CHIP_W;      // right label band
  const RIBBON_R = RIGHT_CHIP_X;              // ribbons end here
  const CHART_H = VB_H - PAD_TOP - PAD_BOTTOM;

  /** Emoji glyphs keep the card dependency-free (no icon font, no CDN). */
  const ICONS = {
    pv: "☀️",
    grid_in: "⚡",
    grid_out: "⚡",
    bat_discharge: "🔋",
    bat_charge: "🔋",
    plug_in: "🔌",
    plug_out: "🔌",
    eps_in: "⚠️",
    eps_out: "⚠️",
    loss: "📉",
    unmeasured: "❓",
  };

  /**
   * Flows that cannot physically exist inside one accounting period:
   * a medium cannot feed itself (battery discharge -> battery charge, ...).
   */
  const NO_LOOP = [
    ["bat_discharge", "bat_charge"],
    ["grid_in", "grid_out"],
    ["plug_in", "plug_out"],
    ["eps_in", "eps_out"],
  ];

  /* ------------------------------------------------------------------ *
   * Node model — sources on the left, sinks on the right, ribbons in
   * between. There is no artificial "hub" node: the diagram is a direct
   * source -> sink sankey, exactly like an energy-flow reference chart.
   * ------------------------------------------------------------------ */
  const NODE_DEFS = [
    // ---- sources (left) ----
    { id: "pv", side: "src", en: "PV", zh: "光伏", color: "#F5A623",
      keys: ["system_pv_energy_today", "system_pv2_energy_today"] },
    { id: "grid_in", side: "src", en: "Grid in", zh: "电网受电", color: "#4A90D9",
      keys: ["grid_on_energy_in_today"] },
    { id: "bat_discharge", side: "src", en: "Battery out", zh: "电池放电", color: "#9B8AFF",
      keys: ["battery_discharge_energy_today"] },
    { id: "plug_in", side: "src", en: "Plug in", zh: "插座输入", color: "#2DD4BF",
      keys: ["plug_input_energy_today"] },
    { id: "eps_in", side: "src", en: "EPS in", zh: "EPS 输入", color: "#FB923C",
      keys: ["eps_input_energy_today"] },
    // ---- sinks (right) ----
    { id: "grid_out", side: "snk", en: "Grid out", zh: "电网送电", color: "#2E6DB4",
      keys: ["grid_on_energy_out_today"] },
    { id: "bat_charge", side: "snk", en: "Battery in", zh: "电池充电", color: "#7B61FF",
      keys: ["battery_charge_energy_today"] },
    { id: "plug_out", side: "snk", en: "Plug out", zh: "插座输出", color: "#12B76A",
      keys: ["plug_output_energy_today"] },
    { id: "eps_out", side: "snk", en: "EPS out", zh: "EPS 输出", color: "#E5484D",
      keys: ["eps_output_energy_today"] },
  ];

  // Synthetic nodes, only drawn when a balancing amount exists.
  const SYNTH = {
    unmeasured: { id: "unmeasured", side: "src", en: "Unmetered", zh: "未计量", color: "#A78BFA" },
    loss: { id: "loss", side: "snk", en: "Loss / other", zh: "损耗/其他", color: "#9CA3AF" },
  };

  const RANGES = [
    { id: "today", en: "Today", zh: "今日" },
    { id: "7d", en: "7 days", zh: "近 7 天" },
    { id: "30d", en: "30 days", zh: "近 30 天" },
    { id: "month", en: "This month", zh: "本月" },
  ];
  const DEFAULT_RANGE = "today";

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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

  /* ------------------------------------------------------------------ *
   * Icon set
   *
   * The same filled, multi-colour SVG language as the control and gauge cards,
   * so the header of this card does not fall back to an emoji while the rest of
   * the dashboard is drawn art.  Only the flow-related shapes live here; the
   * gauge card carries the production / battery ones.
   *
   * `icon:` takes one of these names, or any other string, which is rendered as
   * text - that keeps an `icon: 📊` config working.
   * ------------------------------------------------------------------ */
  const ICON_SVG = {
    /* Three coloured sources merging into one thick slate line. */
    flow: (u) => `
      <g fill="none" stroke-linecap="round" stroke-width="2.5">
        <path d="M2.2 5.4h3.3l3.7 5.3" stroke="#f59e0b"/>
        <path d="M2.2 12h7" stroke="#22c55e"/>
        <path d="M2.2 18.6h3.3l3.7-5.3" stroke="#3b82f6"/>
        <path d="M10.9 12h10.9" stroke="#94a3b8" stroke-width="3.4"/>
      </g>
      <circle cx="9.9" cy="12" r="1.8" fill="#94a3b8"/>`,

    /* Two source nodes and a sink, joined by ribbons: a sankey diagram. */
    sankey: (u) => `
      <rect x="1.5" y="2.8" width="2.7" height="6.6" rx="1.1" fill="#f59e0b"/>
      <rect x="1.5" y="14.6" width="2.7" height="6.6" rx="1.1" fill="#22c55e"/>
      <rect x="19.8" y="6.2" width="2.7" height="11.6" rx="1.1" fill="#3b82f6"/>
      <g fill="none" stroke-width="1.9" stroke-linecap="round">
        <path d="M4.6 6.1c3.3 0 5.9 4.3 8.6 4.3 2.1 0 3.3-.8 6.1-1.6"
          stroke="#f59e0b" stroke-opacity=".8"/>
        <path d="M4.6 17.9c3.3 0 5.9-4.3 8.6-4.3 2.1 0 3.3.8 6.1 1.6"
          stroke="#22c55e" stroke-opacity=".8"/>
      </g>`,

    /* Two arrows in opposite directions: "in and out", an exchange. */
    swap: (u) => `
      <g stroke-linecap="round" stroke-width="2.1" fill="none">
        <path d="M3 8.4h13.4" stroke="#f59e0b"/>
        <path d="M21 15.6H7.6" stroke="#22c55e"/>
      </g>
      <path fill="#f59e0b" d="M14.9 4.9 20.2 8.4l-5.3 3.5z"/>
      <path fill="#22c55e" d="M9.1 12.1 3.8 15.6L9.1 19.1z"/>`,

    /* A neutral fallback, so an unknown name is never invisible. */
    dot: () => `<circle cx="12" cy="12" r="4.2" fill="currentColor"/>`,
  };

  /** Split a kWh value into a readable number + unit (484 Wh / 4.74 kWh). */
  function splitEnergy(kwh) {
    const v = num(kwh);
    const abs = Math.abs(v);
    if (abs >= 1000) return { text: (v / 1000).toFixed(2), unit: "MWh" };
    if (abs >= 1) return { text: v.toFixed(2), unit: "kWh" };
    return { text: (v * 1000).toFixed(0), unit: "Wh" };
  }

  function fmtValue(kwh) {
    return splitEnergy(kwh).text;
  }

  function fmtUnit(kwh) {
    return splitEnergy(kwh).unit;
  }

  function fmtEnergy(kwh) {
    const { text, unit } = splitEnergy(kwh);
    return `${text} ${unit}`;
  }

  function fmtPct(part, total) {
    if (!total) return "0%";
    return `${((part / total) * 100).toFixed(1)}%`;
  }

  /** Start of the local day, `offsetDays` days back. */
  function dayStart(date, offsetDays) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (offsetDays || 0));
    return d;
  }

  function resolveWindow(rangeId, now) {
    switch (rangeId) {
      case "7d":
        return { start: dayStart(now, 6), end: now };
      case "30d":
        return { start: dayStart(now, 29), end: now };
      case "month": {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        d.setDate(1);
        return { start: d, end: now };
      }
      case "today":
      default:
        return { start: dayStart(now, 0), end: now };
    }
  }

  /** Smooth sankey ribbon between two vertical segments. */
  function ribbon(x1, y1, h1, x2, y2, h2) {
    const dx = Math.max(12, (x2 - x1) * 0.5);
    return [
      `M ${x1} ${y1}`,
      `C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      `L ${x2} ${y2 + h2}`,
      `C ${x2 - dx} ${y2 + h2}, ${x1 + dx} ${y1 + h1}, ${x1} ${y1 + h1}`,
      "Z",
    ].join(" ");
  }

  /**
   * Find the scale so that `sum(max(minH, value * scale))` fills `avail`.
   * Tiny nodes keep a readable minimum height while the ribbons that leave
   * them stay proportional to their real value.
   */
  function fitScale(values, avail) {
    const n = values.length;
    if (!n) return { scale: 0, minH: MIN_NODE_H };
    const usable = Math.max(8, avail - (n - 1) * GAP);
    const minH = Math.min(MIN_NODE_H, usable / n);
    const sum = (s) => values.reduce((acc, v) => acc + Math.max(minH, v * s), 0);
    let lo = 0;
    let hi = Math.max(1e-6, usable / Math.max(1e-9, Math.min(...values)));
    let guard = 0;
    while (sum(hi) < usable && guard < 80) {
      hi *= 2;
      guard += 1;
    }
    for (let i = 0; i < 48; i += 1) {
      const mid = (lo + hi) / 2;
      if (sum(mid) < usable) lo = mid;
      else hi = mid;
    }
    return { scale: hi, minH };
  }

  /**
   * Split every source over every sink.
   *
   * The device meters each port on its own, so the real routing (which kWh
   * went where) is NOT measured. We therefore spread each source over the
   * sinks proportionally to the sink sizes and then run a few iterations of
   * iterative proportional fitting so that both the row totals (sources) and
   * the column totals (sinks) come out right. `forbidden` removes cells that
   * cannot physically exist, e.g. a battery discharging into itself.
   *
   * The result is a best-effort estimate, which is why the card keeps an
   * explicit "loss / unmetered" node instead of pretending to be exact.
   */
  function allocate(srcs, snks, forbidden) {
    const n = srcs.length;
    const m = snks.length;
    const total = srcs.reduce((acc, v) => acc + v, 0) || 1;
    const a = srcs.map(() => new Array(m).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) a[i][j] = (srcs[i] * snks[j]) / total;
    }
    for (const [i, j] of forbidden) {
      if (i >= 0 && i < n && j >= 0 && j < m) a[i][j] = 0;
    }
    for (let it = 0; it < 8; it += 1) {
      for (let i = 0; i < n; i += 1) {
        const row = a[i].reduce((x, v) => x + v, 0);
        if (row > 0) for (let j = 0; j < m; j += 1) a[i][j] *= srcs[i] / row;
      }
      for (let j = 0; j < m; j += 1) {
        let col = 0;
        for (let i = 0; i < n; i += 1) col += a[i][j];
        if (col > 0) for (let i = 0; i < n; i += 1) a[i][j] *= snks[j] / col;
      }
    }
    // Landing pass: make the source side exact so ribbon thickness always
    // adds up to the value printed in the source node.
    for (let i = 0; i < n; i += 1) {
      const row = a[i].reduce((x, v) => x + v, 0);
      if (row > 0) {
        const k = srcs[i] / row;
        for (let j = 0; j < m; j += 1) a[i][j] *= k;
      } else if (m) {
        const allowed = [];
        for (let j = 0; j < m; j += 1) {
          if (!forbidden.some(([fi, fj]) => fi === i && fj === j)) allowed.push(j);
        }
        if (allowed.length) a[i][allowed[0]] += srcs[i];
      }
    }
    return a;
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesEnergySankey extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _range: { type: String },
        _loading: { type: Boolean },
        _error: { type: String },
        _graph: { type: Object },
        _missing: { type: Array },
        _noStats: { type: Array },
        _selected: { type: Object },
      };
    }

    constructor() {
      super();
      this._range = DEFAULT_RANGE;
      this._loading = false;
      this._error = null;
      this._graph = null;
      this._missing = [];
      this._noStats = [];
      this._fetchToken = 0;
      // Click-to-highlight state. Stored by node id / flow endpoints (not by
      // array index) so it survives a data refresh that rebuilds the graph.
      //   null                                  -> nothing highlighted
      //   { kind: "flow", from, to }            -> one ribbon
      //   { kind: "node", side: "src"|"snk", id } -> every ribbon of a node
      this._selected = null;
      // Unique prefix so several cards on one page do not clash on <clipPath> ids.
      this._uid = `hm-sk-${Math.random().toString(36).slice(2, 9)}`;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-energy-sankey-editor");
    }

    static getStubConfig() {
      return { dev_id: "", range: DEFAULT_RANGE };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; }
        .head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
                justify-content: space-between; }
        .title { font-size: 15px; font-weight: 500; color: var(--primary-text-color);
                 display: flex; align-items: center; gap: 7px; }
        .title svg { display: block; flex: none; }
        .total { font-size: 12px; color: var(--secondary-text-color); }
        .toolbar { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 4px; }
        .pill { padding: 3px 10px; border: 1px solid var(--divider-color); border-radius: 999px;
                cursor: pointer; font-size: 12px; color: var(--secondary-text-color);
                background: none; }
        .pill.on { background: var(--primary-color); border-color: var(--primary-color);
                   color: var(--text-primary-color, #fff); }
        svg { display: block; width: 100%; height: auto; }
        /* Click-to-highlight: the ribbons and node boxes are hit targets. */
        svg .ribbon { cursor: pointer; transition: fill-opacity 0.18s ease; }
        svg .node { cursor: pointer; transition: opacity 0.18s ease; }
        svg .node.dim { opacity: 0.38; }
        .detail { margin-top: 8px; padding: 8px 10px; border-radius: 8px;
                  background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
                  border: 1px solid var(--divider-color); }
        .dhead { font-size: 12.5px; font-weight: 500; color: var(--primary-text-color); }
        .dflows { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; }
        .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
                color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .chip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block;
                  flex: 0 0 auto; }
        .dhint { font-size: 11px; color: var(--secondary-text-color); margin-top: 6px;
                 opacity: 0.8; }
        .legend { display: grid; gap: 4px 14px; margin-top: 8px;
                  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
        .item { display: flex; align-items: center; gap: 6px; font-size: 12.5px;
                color: var(--primary-text-color); }
        .dot { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 auto; }
        .item .val { margin-left: auto; color: var(--secondary-text-color);
                     font-variant-numeric: tabular-nums; }
        .sep { grid-column: 1 / -1; height: 1px; background: var(--divider-color);
               margin: 6px 0 2px; }
        .note { font-size: 12px; color: var(--secondary-text-color); margin-top: 8px;
                line-height: 1.5; }
        .msg { padding: 14px 4px; font-size: 13px; color: var(--secondary-text-color);
               line-height: 1.6; }
        .err { color: var(--error-color); }
        code { font-size: 12px; }
        .spin { display: inline-block; width: 12px; height: 12px; margin-right: 6px;
                border: 2px solid var(--divider-color); border-top-color: var(--primary-color);
                border-radius: 50%; animation: sp 0.8s linear infinite; vertical-align: -2px; }
        @keyframes sp { to { transform: rotate(360deg); } }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-energy-sankey: 'dev_id' is required");
      }
      this._config = { ...config };
      if (config.range) this._range = config.range;
      this._graph = null;
      // setConfig may run after the first `hass` assignment (e.g. when the
      // dashboard is edited in place), so refresh in that case.
      if (this._hass) this._fetch();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first && hass) {
        this._fetch();
        return;
      }
      /* Node and ribbon labels are baked into `_graph` when it is built, so a
       * language change has to rebuild it - otherwise the title and toolbar
       * switch language while the diagram keeps the old one. */
      const lang = hmLang(hass, this._config);
      if (this._langUsed && lang !== this._langUsed) {
        this._langUsed = lang;
        this._graph = null;
        this._fetch();
        return;
      }
      this.requestUpdate();
    }

    getCardSize() { return 6; }

    /* --------------------------- text / config --------------------------- */

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
    }

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
    }
    _dev() { return this._config.dev_id; }

    _label(def) { return this._t(def.en, def.zh); }

    /** Resolve an entity id for one of this device's energy sensors. */
    _resolveEntity(suffix, domain = "sensor") {
      const hass = this._hass;
      if (!hass) return null;
      const states = hass.states || {};
      const entities = hass.entities || {};
      const dev = slug(this._dev());

      const conventional = `${domain}.${dev}_${suffix}`;
      if (states[conventional]) return conventional;

      const prefix = `${domain}.${dev}`;
      for (const entityId of Object.keys(states)) {
        if (entityId.startsWith(prefix) && entityId.endsWith(suffix)) return entityId;
      }

      const uniqueSuffix = `hoymiles_${this._dev()}_${suffix}`;
      for (const [entityId, entry] of Object.entries(entities)) {
        if (entry && entry.unique_id === uniqueSuffix) return entityId;
      }
      return null;
    }

    /** statistic_ids for a node: config override, else resolved entities. */
    _statisticIds(def) {
      const overrides = (this._config.statistics || {})[def.id];
      if (overrides) {
        return (Array.isArray(overrides) ? overrides : [overrides]).filter(Boolean);
      }
      const ids = [];
      for (const suffix of def.keys || []) {
        const entityId = this._resolveEntity(suffix);
        if (entityId) ids.push(entityId);
      }
      return ids;
    }

    /* ------------------------------ fetching ----------------------------- */

    async _fetch() {
      const hass = this._hass;
      if (!hass || !this._config) return;

      const token = ++this._fetchToken;
      this._loading = true;
      this._error = null;
      this.requestUpdate();

      try {
        const window = resolveWindow(this._range, new Date());

        // Gather every statistic_id we might need, and remember which node
        // could not be resolved at all (entity missing / renamed).
        const ids = [];
        const missing = [];
        const nodeIds = {};
        for (const def of NODE_DEFS) {
          const nodeStatIds = this._statisticIds(def);
          if (!nodeStatIds.length) missing.push(this._label(def));
          nodeIds[def.id] = nodeStatIds;
          ids.push(...nodeStatIds);
        }

        if (!ids.length) {
          if (token !== this._fetchToken) return;
          this._graph = null;
          this._missing = missing;
          this._error = this._t(
            "No energy sensor of this device was found. Check that the integration is set up and the device is online.",
            "未找到该设备的能量传感器。请确认集成已配置且设备在线。"
          );
          return;
        }

        const result = await hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: window.start.toISOString(),
          end_time: window.end.toISOString(),
          statistic_ids: ids,
          period: "day",
          units: { energy: "kWh" },
          types: ["change"],
        });

        if (token !== this._fetchToken) return;

        // Sum `change` per node.
        const values = {};
        const noStats = [];
        for (const def of NODE_DEFS) {
          let sum = 0;
          let found = false;
          for (const statId of nodeIds[def.id] || []) {
            const rows = result && result[statId];
            if (Array.isArray(rows) && rows.length) {
              found = true;
              for (const row of rows) sum += num(row.change);
            }
          }
          if (!found && (nodeIds[def.id] || []).length) noStats.push(this._label(def));
          values[def.id] = sum;
        }

        this._graph = this._buildGraph(values, window, token);
        this._missing = missing;
        this._noStats = noStats;
      } catch (err) {
        if (token !== this._fetchToken) return;
        this._graph = null;
        const message = String((err && err.message) || err);
        this._error = /recorder/i.test(message)
          ? this._t(
              "The recorder integration is unavailable, so long-term statistics cannot be read.",
              "recorder 集成不可用，无法读取长期统计。"
            )
          : `${this._t("Failed to read statistics", "读取统计失败")}: ${message}`;
      } finally {
        if (token === this._fetchToken) {
          this._loading = false;
          /* Record it for *every* outcome, including the error paths: their
           * message is language dependent too, and leaving it unset would make
           * the language check in `set hass` skip the rebuild. */
          this._langUsed = hmLang(this._hass, this._config);
          this.requestUpdate();
        }
      }
    }

    /* ---------------------------- graph layout --------------------------- */

    _buildGraph(values, window, token) {
      const cfg = this._config || {};

      const srcs = NODE_DEFS.filter((d) => d.side === "src")
        .map((d) => ({ ...d, value: num(values[d.id]) }))
        .filter((d) => d.value > 0.0005);

      const snks = NODE_DEFS.filter((d) => d.side === "snk")
        .map((d) => ({ ...d, value: num(values[d.id]) }))
        .filter((d) => d.value > 0.0005);

      const inTotal = srcs.reduce((acc, d) => acc + d.value, 0);
      const outTotal = snks.reduce((acc, d) => acc + d.value, 0);

      // Sankey requires conservation. The device meters each port
      // independently, so a difference is expected (conversion losses,
      // sampling offsets, unmeasured loads). Absorb it in an explicit node
      // instead of rescaling the real numbers.
      const balance = inTotal - outTotal;
      const THRESHOLD = 0.001; // kWh – below this it is noise
      let balancer = null;
      if (balance > THRESHOLD) {
        balancer = {
          ...SYNTH.loss,
          value: balance,
          label: this._text(cfg.balancer_label) || this._label(SYNTH.loss),
        };
        snks.push(balancer);
      } else if (balance < -THRESHOLD) {
        balancer = {
          ...SYNTH.unmeasured,
          value: -balance,
          label: this._text(cfg.balancer_label) || this._label(SYNTH.unmeasured),
        };
        srcs.push(balancer);
      }

      const total = srcs.reduce((acc, d) => acc + d.value, 0);
      if (total <= 0) {
        return { empty: true, window };
      }

      // Each column fills the chart height on its own: the left column stacks
      // the sources, the right column the sinks.
      const leftFit = fitScale(srcs.map((d) => d.value), CHART_H);
      const rightFit = fitScale(snks.map((d) => d.value), CHART_H);

      const stack = (items, fit) => {
        let y = PAD_TOP;
        return items.map((item) => {
          const h = Math.max(fit.minH, item.value * fit.scale);
          const node = { ...item, y, h };
          y += h + GAP;
          return node;
        });
      };

      const srcNodes = stack(srcs, leftFit);
      const snkNodes = stack(snks, rightFit);

      // Estimate which source feeds which sink (ports are metered apart).
      const indexOf = (arr, id) => arr.findIndex((x) => x.id === id);
      const forbidden = [];
      for (const [srcId, snkId] of NO_LOOP) {
        const i = indexOf(srcNodes, srcId);
        const j = indexOf(snkNodes, snkId);
        if (i >= 0 && j >= 0) forbidden.push([i, j]);
      }
      const matrix = allocate(
        srcNodes.map((n) => n.value),
        snkNodes.map((n) => n.value),
        forbidden
      );

      // Ribbon thickness is value * scale and attaches centred on the node
      // box, so a tiny node still gets a hairline ribbon.
      const gapPx = num(cfg.ribbon_gap != null ? cfg.ribbon_gap : 3);
      const flows = [];
      const srcCursor = srcNodes.map(
        (n) => n.y + n.h / 2 - (n.value * leftFit.scale) / 2
      );
      const snkCursor = snkNodes.map(
        (n) => n.y + n.h / 2 - (n.value * rightFit.scale) / 2
      );

      for (let i = 0; i < srcNodes.length; i += 1) {
        for (let j = 0; j < snkNodes.length; j += 1) {
          const value = matrix[i][j];
          if (!(value > 0)) continue;
          const hL = value * leftFit.scale;
          const hR = value * rightFit.scale;
          if (hL < 0.7 && hR < 0.7) continue;
          const insetL = hL > gapPx * 2.5 ? gapPx / 2 : 0;
          const insetR = hR > gapPx * 2.5 ? gapPx / 2 : 0;
          flows.push({
            path: ribbon(
              RIBBON_L, srcCursor[i] + insetL, Math.max(0.6, hL - insetL * 2),
              RIBBON_R, snkCursor[j] + insetR, Math.max(0.6, hR - insetR * 2)
            ),
            color: srcNodes[i].color,
            value,
            srcId: srcNodes[i].id,
            snkId: snkNodes[j].id,
            from: srcNodes[i].label || this._label(srcNodes[i]),
            to: snkNodes[j].label || this._label(snkNodes[j]),
          });
          srcCursor[i] += hL;
          snkCursor[j] += hR;
        }
      }

      return {
        empty: false,
        window,
        total,
        outTotal: snkNodes.reduce((acc, n) => acc + n.value, 0),
        srcs: srcNodes,
        snks: snkNodes,
        flows,
        hasBalancer: !!balancer,
      };
    }

    /* ------------------------------ rendering ---------------------------- */

    /**
     * One node = a coloured box (icon + value + unit + share of the period)
     * plus a tinted label band on the ribbon-facing side.
     */
    _nodeBox(node, boxX, chipX, chipAnchor, shareBase, info) {
      const color = node.color;
      const label = node.label || this._label(node);
      const uid = `${this._uid}-${node.side}-${node.id}`;
      const cx = boxX + NODE_W / 2;
      const icon = (this._config.icons || {})[node.id] || ICONS[node.id] || "•";
      const tall = node.h >= 76;
      const inner = [];
      const key = `${node.side}:${node.id}`;

      // Selection: true when this node touches the highlighted flow(s).
      const isSel = !!info && info.nodeKeys.has(key);
      const isDim = !!info && !isSel;
      const ring = isSel
        ? `<rect x="${boxX - 2}" y="${node.y - 2}" width="${NODE_W + 4}"
            height="${node.h + 4}" rx="8" fill="none"
            stroke="var(--primary-text-color, #212121)" stroke-width="2.5"></rect>`
        : "";

      if (node.h >= 42) {
        inner.push(`<text x="${cx}" y="${node.y + (tall ? 18 : 14)}" text-anchor="middle"
          font-size="${tall ? 15 : 11}">${esc(icon)}</text>`);
      }
      if (tall) {
        inner.push(`<text x="${cx}" y="${node.y + 43}" text-anchor="middle" font-size="17"
          font-weight="600" fill="#fff">${esc(fmtValue(node.value))}</text>`);
        inner.push(`<text x="${cx}" y="${node.y + 56}" text-anchor="middle" font-size="9.5"
          fill="#fff" fill-opacity="0.85">${esc(fmtUnit(node.value))}</text>`);
      } else if (node.h >= 30) {
        inner.push(`<text x="${cx}" y="${node.y + 31}" text-anchor="middle" font-size="11.5"
          font-weight="600" fill="#fff">${esc(fmtEnergy(node.value))}</text>`);
      } else {
        inner.push(`<text x="${cx}" y="${node.y + node.h / 2 + 4}" text-anchor="middle"
          font-size="10.5" font-weight="600" fill="#fff">${esc(fmtEnergy(node.value))}</text>`);
      }
      if (node.h >= 40) {
        inner.push(`<rect x="${boxX}" y="${node.y + node.h - 16}" width="${NODE_W}" height="16"
          fill="#000" fill-opacity="0.14"></rect>`);
        inner.push(`<text x="${cx}" y="${node.y + node.h - 4.5}" text-anchor="middle"
          font-size="9.5" fill="#fff" fill-opacity="0.95">${esc(fmtPct(node.value, shareBase))}</text>`);
      }

      const chipTextX = chipAnchor === "end" ? chipX + CHIP_W - 12 : chipX + 12;
      return `<g class="node${isDim ? " dim" : ""}" data-node="${esc(key)}">
        <clipPath id="${uid}"><rect x="${boxX}" y="${node.y}" width="${NODE_W}"
          height="${node.h}" rx="6"></rect></clipPath>
        <rect x="${boxX}" y="${node.y}" width="${NODE_W}" height="${node.h}" rx="6"
          fill="${color}"><title>${esc(`${label}: ${fmtEnergy(node.value)}`)}</title></rect>
        <g clip-path="url(#${uid})">${inner.join("")}</g>
        <rect x="${chipX}" y="${node.y}" width="${CHIP_W}" height="${node.h}" rx="4"
          fill="${color}" fill-opacity="0.16"></rect>
        <text x="${chipTextX}" y="${node.y + node.h / 2 + 4.5}" text-anchor="${chipAnchor}"
          font-size="13" fill="var(--primary-text-color, #212121)">${esc(label)}</text>
        ${ring}
      </g>`;
    }

    /** True when `flow` should stay lit for the current selection. */
    _flowSelected(flow, sel) {
      if (!sel) return false;
      if (sel.kind === "flow") return flow.srcId === sel.from && flow.snkId === sel.to;
      return flow.srcId === sel.id || flow.snkId === sel.id;
    }

    /**
     * Resolve `_selected` against the current graph.
     * Returns null when nothing is highlighted (or the highlight no longer
     * matches any ribbon, e.g. after the device stopped using that port).
     */
    _selectionInfo(graph) {
      const sel = this._selected;
      if (!sel || !graph) return null;
      const flows = graph.flows.filter((f) => this._flowSelected(f, sel));
      if (!flows.length) return null;
      let node = null;
      if (sel.kind === "node") {
        node = [...graph.srcs, ...graph.snks]
          .find((n) => n.id === sel.id && n.side === sel.side) || null;
        if (!node) return null;
      }
      const nodeKeys = new Set();
      for (const f of flows) {
        nodeKeys.add(`src:${f.srcId}`);
        nodeKeys.add(`snk:${f.snkId}`);
      }
      return { sel, flows, node, nodeKeys };
    }

    _chart(graph) {
      const base = num(
        this._config.ribbon_opacity != null ? this._config.ribbon_opacity : 0.5
      );
      const info = this._selectionInfo(graph);
      const parts = [];

      // Ribbons first so the node boxes are drawn on top of them.
      for (const f of graph.flows) {
        const isSel = !!info && info.flows.indexOf(f) >= 0;
        const opacity = !info ? base : isSel ? Math.min(1, base + 0.4) : Math.max(0.06, base * 0.16);
        const stroke = isSel ? ` stroke="${f.color}" stroke-opacity="0.95" stroke-width="1"` : "";
        parts.push(`<path class="ribbon" d="${f.path}" fill="${f.color}"
          fill-opacity="${opacity.toFixed(3)}" data-flow="${esc(f.srcId)}|${esc(f.snkId)}"${stroke}
          ><title>${esc(`${f.from} → ${f.to}: ${fmtEnergy(f.value)}`)}</title></path>`);
      }

      for (const node of graph.srcs) {
        parts.push(this._nodeBox(node, LEFT_X, LEFT_CHIP_X, "start", graph.total, info));
      }
      for (const node of graph.snks) {
        parts.push(
          this._nodeBox(node, RIGHT_X, RIGHT_CHIP_X, "end", graph.outTotal || graph.total, info)
        );
      }

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" role="img"
        aria-label="${esc(this._t("Energy flow", "能量流"))}">${parts.join("")}</svg>`;
    }

    /** Detail panel for the current highlight (empty when nothing is selected). */
    _detailBar(graph) {
      const info = this._selectionInfo(graph);
      if (!info) return "";
      const { flows, node, sel } = info;
      const sum = flows.reduce((acc, f) => acc + f.value, 0);

      let head;
      if (node) {
        const shareBase = sel.side === "src" ? graph.total : graph.outTotal || graph.total;
        head = `${node.label || this._label(node)} · ${fmtEnergy(node.value)} · ${fmtPct(node.value, shareBase)}`;
      } else {
        const f = flows[0];
        head = `${f.from} → ${f.to} · ${fmtEnergy(f.value)} · ${fmtPct(f.value, graph.total)}`;
      }

      const chips = flows
        .slice()
        .sort((a, b) => b.value - a.value)
        .map((f) => {
          const dir = node ? (sel.side === "src" ? "→" : "←") : "→";
          const other = node
            ? (sel.side === "src" ? f.to : f.from)
            : `${f.from} → ${f.to}`;
          return `<span class="chip"><i style="background:${f.color}"></i>${esc(
            `${dir} ${other} ${fmtEnergy(f.value)}`
          )}</span>`;
        })
        .join("");

      const total = flows.length > 1
        ? ` · ${esc(this._t("total", "合计"))} ${esc(fmtEnergy(sum))}`
        : "";

      return `<div class="detail">
        <div class="dhead">${esc(head)}${total}</div>
        <div class="dflows">${node ? chips : ""}</div>
        <div class="dhint">${esc(this._t("Click again to clear.", "再次点击取消高亮。"))}</div>
      </div>`;
    }

    _legend(graph) {
      const item = (node) => `
        <div class="item">
          <span class="dot" style="background:${node.color}"></span>
          <span>${esc(node.label || this._label(node))}</span>
          <span class="val">${esc(fmtEnergy(node.value))} · ${esc(fmtPct(node.value, graph.total))}</span>
        </div>`;

      const srcs = graph.srcs.map(item).join("");
      const snks = graph.snks.map(item).join("");
      return `<div class="legend">${srcs}<div class="sep"></div>${snks}</div>`;
    }

    _toolbar() {
      if (this._config.show_toolbar === false) return null;
      const pills = RANGES.map(
        (r) =>
          `<button class="pill ${r.id === this._range ? "on" : ""}"` +
          ` data-range="${esc(r.id)}">${esc(this._t(r.en, r.zh))}</button>`
      ).join("");
      const refresh =
        `<button class="pill" data-range="__refresh">` +
        `${esc(this._t("Refresh", "刷新"))}</button>`;
      // Must go through _untrusted(): a plain string would be escaped by Lit
      // and end up rendered as literal text instead of buttons.
      return this._untrusted(`<div class="toolbar">${pills}${refresh}</div>`);
    }

    _sameSelection(a, b) {
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === "flow") return a.from === b.from && a.to === b.to;
      return a.side === b.side && a.id === b.id;
    }

    _handleClick = (event) => {
      const rangeEl = event.target.closest("[data-range]");
      if (rangeEl) {
        const value = rangeEl.dataset.range;
        if (value === "__refresh") {
          this._fetch();
          return;
        }
        if (value === this._range) return;
        this._range = value;
        this._graph = null;
        this._selected = null;
        this._fetch();
        return;
      }

      // Click-to-highlight: a ribbon, or any ribbon of a node box.
      const flowEl = event.target.closest("[data-flow]");
      const nodeEl = event.target.closest("[data-node]");
      if (flowEl || nodeEl) {
        let next;
        if (flowEl) {
          const [from, to] = String(flowEl.dataset.flow).split("|");
          next = { kind: "flow", from, to };
        } else {
          const raw = String(nodeEl.dataset.node);
          const at = raw.indexOf(":");
          next = { kind: "node", side: raw.slice(0, at), id: raw.slice(at + 1) };
        }
        this._selected = this._sameSelection(this._selected, next) ? null : next;
        this.requestUpdate();
        return;
      }

      // Clicking empty diagram space clears the highlight.
      if (this._selected && event.target.closest("svg")) {
        this._selected = null;
        this.requestUpdate();
      }
    };

    render() {
      if (!this._config) return html``;
      const title = this._text(this._config.title) || this._t("Energy flow", "能量流");

      let body;
      if (this._loading && !this._graph) {
        body = html`<div class="msg"><span class="spin"></span>${this._t("Reading statistics…", "正在读取统计…")}</div>`;
      } else if (this._error) {
        body = html`<div class="msg err">${this._error}</div>`;
      } else if (!this._graph) {
        body = html`<div class="msg">${this._t("No data yet.", "暂无数据。")}</div>`;
      } else if (this._graph.empty) {
        body = html`<div class="msg">${this._t(
          "No energy was recorded in the selected period.",
          "所选时间段内没有能量记录。"
        )}</div>`;
      } else {
        body = html`
          ${this._untrusted(this._chart(this._graph))}
          ${this._untrusted(this._detailBar(this._graph))}
          ${this._untrusted(this._legend(this._graph))}
        `;
      }

      // Optional notes: unresolved entities / entities without statistics.
      const notes = [];
      if (this._missing && this._missing.length) {
        notes.push(this._t(
          `No entity found for: ${this._missing.join(", ")}.`,
          `未找到实体：${this._missing.join("、")}。`
        ));
      }
      if (this._noStats && this._noStats.length) {
        notes.push(this._t(
          `No statistics yet for: ${this._noStats.join(", ")}.`,
          `暂无统计数据：${this._noStats.join("、")}。`
        ));
      }

      return html`
        <ha-card @click=${this._handleClick}>
          <div class="head">
            <span class="title">${this._icon(this._config.icon)}${title}</span>
            ${this._graph && !this._graph.empty
              ? html`<span class="total">${esc(fmtEnergy(this._graph.total))}</span>`
              : ""}
          </div>
          ${this._toolbar()}
          ${body}
          ${notes.length
            ? html`<div class="note">${notes.map((n) => html`${n}<br/>`)}</div>`
            : ""}
          ${this._graph && !this._graph.empty && !this._selected
            ? html`<div class="note">${this._t(
                "Tip: click a ribbon or a node box to highlight that part of the flow.",
                "提示：点击彩带或左右节点，即可高亮该部分能量流向。"
              )}</div>`
            : ""}
          ${this._graph && !this._graph.empty && this._graph.hasBalancer
            ? html`<div class="note">${this._t(
                "Ports are metered independently, so a balance line is shown for conversion losses and unmeasured flows.",
                "各端口独立计量，差额以“损耗/其他”或“未计量”表示。"
              )}</div>`
            : ""}
        </ha-card>
      `;
    }

    /**
     * Build a TrustedHTML-free fragment.
     * We render SVG via innerHTML because Lit has no cheap SVG builder here;
     * every interpolated value goes through `esc()` in `_chart`/`_legend`.
     */
    /**
     * The header icon: a named SVG from the built-in set, or plain text.
     *
     * A name that is not in the set falls through to text, which keeps an
     * `icon: 📊` config working.  The SVG is injected as a string: a `<path>`
     * built inside a lit template is parsed in the HTML namespace and never
     * paints, while the HTML parser handles SVG foreign content correctly.
     */
    _icon(name) {
      if (!name) return "";
      const build = ICON_SVG[name];
      if (!build) return esc(String(name));
      const uid = "hms" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-";
      const svg = `<svg viewBox="0 0 24 24" width="19" height="19" `
        + `xmlns="http://www.w3.org/2000/svg">${build(uid)}</svg>`;
      return this._untrusted(svg);
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
  class HoymilesEnergySankeyEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, hass: { type: Object } };
    }

    setConfig(config) {
      this._config = { ...config };
    }

    _valueChanged(field) {
      return (event) => {
        const config = { ...(this._config || {}), [field]: event.target.value };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    static get styles() {
      return css`
        .row { padding: 8px; }
        ha-textfield, ha-select { display: block; width: 100%; }
      `;
    }

    render() {
      const config = this._config || {};
      const ranges = RANGES.map((r) => r.id);
      return html`
        <div class="row">
          <ha-textfield label="dev_id" .value=${config.dev_id || ""}
            @change=${this._valueChanged("dev_id")}></ha-textfield>
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._valueChanged("title")}></ha-textfield>
          <ha-textfield label="icon (flow | sankey | swap, or any text)"
            .value=${config.icon || ""}
            @change=${this._valueChanged("icon")}></ha-textfield>
          <ha-textfield label="range (${ranges.join("|")})" .value=${config.range || DEFAULT_RANGE}
            @change=${this._valueChanged("range")}></ha-textfield>
          <ha-textfield label="balancer_label (accepts an en/zh map)" .value=${hmField(config.balancer_label)}
            @change=${this._valueChanged("balancer_label")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-energy-sankey-editor")) {
    customElements.define("hoymiles-energy-sankey-editor", HoymilesEnergySankeyEditor);
  }
  if (!customElements.get("hoymiles-energy-sankey")) {
    customElements.define("hoymiles-energy-sankey", HoymilesEnergySankey);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-energy-sankey")) {
    window.customCards.push({
      type: "hoymiles-energy-sankey",
      name: "Hoymiles Energy Flow (Sankey)",
      description:
        "Sankey diagram of the energy flow of a Hoymiles micro storage device, "
        + "built from Home Assistant long-term statistics.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmSankeyRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmSankeyRegister());
}
