/* ============================================================================
 * Hoymiles Micro Storage — History chart card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-history-chart`
 *
 * A power / SOC chart with a 日 / 月 / 年 selector and a date navigator, drawn
 * like the vendor app's history pages:
 *
 *   - every series is filled from the zero line; power / energy series stack
 *     (positive values stacking up, negative values stacking down, so a
 *     charge/discharge sensor reads naturally on both sides of the axis);
 *   - a *level* such as SOC is drawn overlaid instead, because stacking two
 *     packs at 81 % would put the second curve at 81..162 % and the third at
 *     162..243 %, pushing everything but the first off a 0..100 axis. The
 *     `stack` option makes the choice explicit;
 *   - the y axis auto-scales to the data (`niceMax`, so a 490 W peak gets a
 *     0..500 axis). Whether it is mirrored around 0 is decided from the data
 *     itself: a series that changes sign (battery / grid power) gets a ±axis,
 *     one that never goes below zero (PV power, voltage, energy) gets a plain
 *     bottom-up axis so it can use the full height. W is promoted to kW once
 *     the range exceeds 1.5 kW, Wh to kWh ...;
 *   - the x axis is likewise derived from the data, not from a fixed clock
 *     grid: the plot spans the first..last bucket and the ticks step by a
 *     round interval chosen from that span, so a partial day (recorder data
 *     starting at 13:45) still fills the card instead of hugging the right
 *     edge with a single "15:00" label;
 *   - hovering shows a guide line and the value of every series, and the same
 *     timestamp is mirrored on every card that shares a `sync_group`;
 *   - clicking a legend entry highlights that series and dims the others
 *     (clicking it again, or the chart, clears the highlight).
 *
 * Data comes from the Home Assistant recorder (long term statistics) through
 * the public websocket command `recorder/statistics_during_period`. The card
 * never touches the database itself, and `recorder` has to be enabled.
 *
 * Card config:
 *   type: custom:hoymiles-g2-history-chart
 *   dev_id: MSA-280520260806        # optional when every series names an entity
 *   title: History
 *   language: en                    # optional (en|zh); omit to follow Home Assistant
 *   range: day                      # initial range (day|month|year)
 *   height: 330                     # optional svg height in px
 *   unit: W                         # optional unit label (auto-promotes to kW)
 *   zero_line: true                 # optional, draw the 0 line (default true)
 *   symmetric: false                # optional; forces a bottom-up axis. Omit
 *                                   # it and the card picks per render from the
 *                                   # data (mirrored only when a series is
 *                                   # negative), which is also what makes
 *                                   # dashboards written before this option
 *                                   # existed come out right.
 *   stack: false                    # optional; false overlays the curves
 *                                   # instead of stacking them. Defaults to
 *                                   # the value of `symmetric`, so a bottom-up
 *                                   # axis (SOC, temperature) overlays - a
 *                                   # level must never stack - and so does an
 *                                   # automatically resolved one.
 *   min / max: 0 / 100              # optional fixed axis limits
 *   span: 2500                      # optional fixed half-range when symmetric
 *   sync_group: living-room         # optional; cards sharing a group share
 *                                   # their time window (range + date)
 *   show_toolbar: false             # optional; hide this card's own toolbar
 *                                   # (use it on the followers)
 *   since: 2026-11-13T08:30:00Z     # optional lower time bound (ISO 8601 or
 *                                   # epoch ms). Nothing *before* it is asked
 *                                   # of the recorder and the x axis starts
 *                                   # there when the bound falls inside the
 *                                   # window - which is what makes an opt-in
 *                                   # card draw only the data recorded since
 *                                   # the user enabled it, even though the
 *                                   # statistics from before it still exist
 *   series:                         # required, one entry per curve
 *     - entity: sensor.x_pv_power
 *       name: 发电功率
 *       color: "#22c55e"
 *     - entity: sensor.x_system_battery_power
 *       name: 放电[+]/充电[-]
 *       color: "#4a90d9"
 * ========================================================================== */

function _hmHistoryRegister() {
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

  /* ------------------------------------------------------------------ *
   * Layout / behaviour constants
   * ------------------------------------------------------------------ */
  /* `VB_W` is only the drawing width used before the card has been measured.
   * The charts fill their card via `preserveAspectRatio="none"`, which would
   * squash every label horizontally (a 625 px card over a 1200 unit viewBox
   * compresses text to 52 % of its width). To keep text undistorted the viewBox
   * width follows the measured pixel width (`_vbW`), leaving the scale at 1:1.
   */
  const VB_W = 1200;
  const MIN_VB_W = 320;
  /* `ha-card` padding is `12px 16px 14px`, so the drawing area is this much
     narrower than the host. Only used before the svg exists. */
  const CARD_PAD_X = 32;
  const DEFAULT_H = 330;

  /* How often a card re-queries a window that is still open (today / this month
   * / this year). Statistics are bucketed, so polling faster than the bucket
   * gains nothing: the 1 s entities behind a day window are read as 5 minute
   * means, and a fresh bucket is worth showing within half a minute of it being
   * written. Anything shorter only adds recorder load on a dashboard showing
   * six of these cards at once.
   *
   * The jitter spreads the cards of one dashboard apart so they never share a
   * tick.
   */
  const AUTO_REFRESH_MS = 30000;
  const AUTO_REFRESH_JITTER_MS = 8000;

  const PAD_L = 64;   // room for the y labels
  const PAD_R = 18;
  const PAD_T = 14;
  const PAD_B = 34;   // room for the x labels

  const RANGES = [
    { id: "day", en: "Day", zh: "日" },
    { id: "month", en: "Month", zh: "月" },
    { id: "year", en: "Year", zh: "年" },
  ];

  const DEFAULT_COLORS = ["#22c55e", "#4a90d9", "#22d3ee", "#f5a623", "#a78bfa"];

  /* ------------------------------------------------------------------ *
   * Zoom.
   *
   * The wheel narrows the x axis around the instant under the pointer, which
   * is the only anchoring that feels right: a zoom around the centre throws
   * the point you were looking at off screen. `_zoom` is a plain 0..1 span of
   * the window (`null` = not zoomed), so it survives a refetch and means the
   * same thing on a day, a month and a year.
   *
   * Only the curve modes zoom. A bar chart already *is* the calendar - one bar
   * per day of a month, one per month of a year - so narrowing it shows four of
   * thirty bars bigger, which loses the comparison it exists for; see
   * `_zoomable()`.
   * ------------------------------------------------------------------ */
  const ZOOM_MIN_SPAN = 0.02;
  const ZOOM_WHEEL = 0.0022;
  const DOUBLE_CLICK_MS = 350;
  /** Nominal length of one bar slot when no neighbour can supply it. */
  const DAY_MS = 24 * 60 * 60 * 1000;

  /* How long one statistics bucket lasts, per `period` name. Used to decide
     whether a bucket is entirely older than an opt-in card's `since`: a row is
     stamped with the instant its bucket *starts*, so the bucket containing the
     enabling instant has to survive the cut. */
  const PERIOD_MS = {
    "5minute": 5 * 60 * 1000,
    hour: 60 * 60 * 1000,
    day: DAY_MS,
    // A month bucket is stamped with the 1st; 28 days is a safe lower bound,
    // which only ever keeps one extra bucket, never drops a wanted one.
    month: 28 * DAY_MS,
  };

  /** Resolve `_zoom` into a 0..1 span, clamped and normalised. */
  function zoomWindow(zoom) {
    if (!zoom) return { from: 0, to: 1, narrow: false };
    const a = Math.min(Math.max(num(zoom.a), 0), 1);
    const b = Math.min(Math.max(num(zoom.b), 0), 1);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (!(hi - lo > 1e-6)) return { from: 0, to: 1, narrow: false };
    return { from: lo, to: hi, narrow: hi - lo < 0.999 };
  }

  /**
   * A smooth path through `pts`, as cubic segments.
   *
   * Monotone (Fritsch-Carlson) rather than a plain Catmull-Rom: the tangent at
   * every point is limited by the smaller neighbouring slope, so a sharp peak
   * is rounded *without* overshooting past the real reading. A plain
   * interpolating spline draws a reading of 490 W up to 530 W between two
   * samples and back, i.e. it invents power the device never produced, and on
   * an energy curve it would draw a total that goes down and up again.
   *
   * `pts` is `[x, y]` pairs; the result is `M .. C ..` and can be appended to.
   */
  function smoothPath(pts) {
    const n = pts.length;
    if (!n) return "";
    if (n < 3) {
      return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    }
    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      const h = pts[i + 1][0] - pts[i][0];
      dx.push(h);
      slope.push(h === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / h);
    }
    const tangent = new Array(n);
    tangent[0] = slope[0];
    tangent[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      const a = slope[i - 1];
      const b = slope[i];
      // A flat or reversing stretch pins the tangent to zero, which is what
      // keeps the curve monotone across a peak.
      tangent[i] = a * b <= 0 ? 0 : (a + b) / 2;
    }
    for (let i = 0; i < n - 1; i += 1) {
      const s = slope[i];
      if (s === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
      const a = tangent[i] / s;
      const b = tangent[i + 1] / s;
      const h = a * a + b * b;
      if (h > 9) {
        const k = 3 / Math.sqrt(h);
        tangent[i] = k * a * s;
        tangent[i + 1] = k * b * s;
      }
    }
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i += 1) {
      const h = dx[i] / 3;
      const c1x = pts[i][0] + h;
      const c1y = pts[i][1] + tangent[i] * h;
      const c2x = pts[i + 1][0] - h;
      const c2y = pts[i + 1][1] - tangent[i + 1] * h;
      d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)}`
        + ` ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
    }
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Time-window sharing.
   *
   * Cards that declare the same `sync_group` keep one window between them, so
   * a dashboard can pair e.g. a power chart with an SOC chart and drive both
   * from a single toolbar. The group holds the last window plus the set of
   * member cards; whichever card the user touches publishes to the others.
   * Membership is per DOM lifetime, so removing a card cannot leak.
   * ------------------------------------------------------------------ */
  const SYNC_GROUPS = new Map();

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
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

  /* `esc()` is only for the markup strings handed to `_untrusted()` (they go
   * through `innerHTML`, so they really do need escaping). Lit templates escape
   * their own text and attribute bindings, so wrapping a `${...}` inside a
   * `html` template in `esc()` would render `&amp;` on screen - a series called
   * "电网&负载" would read as "电网&amp;负载". */

  /** Round `value` up to a readable 1 / 2 / 5 / 10 × 10^n step.
   *
   * The 2.5 mantissa is deliberately not used: the axis draws five labels
   * (max, max/2, 0, -max/2, -max), so 2.5 would put the ticks at 1.25 apart
   * and no sensible number of decimals renders them faithfully.
   */
  function niceMax(value) {
    if (!(value > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    const mantissa = value / exp;
    const step = mantissa <= 1 ? 1 : mantissa <= 2 ? 2
      : mantissa <= 5 ? 5 : 10;
    return step * exp;
  }

  /** Round `value` up to a readable tick spacing: 1 / 2 / 2.5 / 5 × 10^n.
   *
   * This is for the *step* of a bottom-up axis, where the labels are the four
   * quarters of the domain. Rounding the step instead of the domain keeps a
   * 587 W peak on a 0..600 axis rather than pushing `niceMax` up to 1000 and
   * leaving half the height empty - which is exactly the complaint the fixed
   * `span` used to cause.
   */
  function niceStep(value) {
    if (!(value > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    const mantissa = value / exp;
    const step = mantissa <= 1 ? 1
      : mantissa <= 2 ? 2
        : mantissa <= 2.5 ? 2.5
          : mantissa <= 5 ? 5 : 10;
    return step * exp;
  }

  /** Smallest number of decimals (0..3) that renders `step` exactly. */
  function decimalsFor(step) {
    const abs = Math.abs(step);
    if (!(abs > 0) || !Number.isFinite(abs)) return 0;
    for (let d = 0; d <= 3; d++) {
      if (Math.abs(abs - Number(abs.toFixed(d))) < abs * 1e-6) return d;
    }
    return 3;
  }

  function fmtNumber(value, decimals) {
    const text = num(value).toFixed(decimals);
    const parts = text.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  /** Pick a unit + divisor for the axis.
   *
   * This used to promote W to kW once the range passed 1.5 kW, but it divided
   * the numbers without renaming the unit: a 2 500 W axis was drawn as
   * "2.50 W", so a 540 W reading looked like 0.54 W sitting near the zero line.
   * The labels always carry the unit the user configured (`unit: W`), so the
   * divisor has to stay 1 - the axis is then in the same unit as the data and
   * every label, tooltip and reading lines up. Charts that need a coarser axis
   * set `span` / `max` instead of relying on a silent rescale.
   */
  function pickUnit(unit, maxValue) {
    if (!unit) return { unit: "", divisor: 1, decimals: 1 };
    return { unit, divisor: 1, decimals: Math.abs(maxValue) >= 100 ? 0 : 1 };
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /**
   * The time zone every time in this card is expressed in.
   *
   * `""` means "the browser's", which is what Home Assistant's own history does
   * and what this card did before the region switch existed.  When a region is
   * chosen (toolbar dropdown, or the options flow) the day boundaries, the axis
   * labels and the tooltips all move to it, so 「今日」 on this chart starts at
   * the *device's* midnight rather than the reader's.
   */
  function regionZone() {
    const api = window.HoymilesG2Region;
    return api && typeof api.zone === "function" ? api.zone() : "";
  }

  function startOfDay(date) {
    const api = window.HoymilesG2Region;
    if (api && typeof api.startOfDayIn === "function") {
      return api.startOfDayIn(date, api.zone());
    }
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function endOfDay(date) {
    const api = window.HoymilesG2Region;
    if (api && typeof api.endOfDayIn === "function") {
      return api.endOfDayIn(date, api.zone());
    }
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  /**
   * `HH:MM` of one instant, in the chosen region.
   *
   * Replaces the direct `d.getHours()` calls: those answer for the browser, which
   * is precisely the mismatch the region switch exists to fix.
   */
  function hhmm(ms) {
    const api = window.HoymilesG2Region;
    if (api && typeof api.timeLabel === "function") return api.timeLabel(ms, api.zone());
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** The year/month/day/weekday of one instant, in the chosen region. */
  function partsOf(ms) {
    const api = window.HoymilesG2Region;
    if (api && typeof api.partsIn === "function") return api.partsIn(ms, api.zone());
    const d = new Date(ms);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      weekday: d.getDay(),
    };
  }

  /** The first instant of a region-local calendar date. */
  function regionDate(year, month, day) {
    const api = window.HoymilesG2Region;
    if (!api || typeof api.startOfDayIn !== "function") {
      return new Date(year, month, day);
    }
    /* "Midnight of that date, pretended to be UTC" is a guess; correcting it by
       the region's offset at the guess is the standard two-pass fix, the second
       pass being needed because the offset itself can change on that night. */
    const naive = Date.UTC(year, month, day);
    const once = new Date(naive - api.offsetIn(new Date(naive), api.zone()));
    const twice = new Date(naive - api.offsetIn(once, api.zone()));
    return twice;
  }

  /** Width of bucket `i`, in milliseconds - the width of its bar.
   *
   * A bar runs from its own timestamp to the next bucket's, so the width comes
   * from the gap *ahead*; the last bucket has no such neighbour and mirrors the
   * gap behind it instead. A lone bucket falls back to whatever the caller
   * offers (an hour of the window), which only happens while the recorder still
   * holds a single row.
   */
  function barSlot(times, i, fallback) {
    const t = num(times[i]);
    if (i + 1 < times.length) return num(times[i + 1]) - t;
    if (i > 0) return t - num(times[i - 1]);
    return fallback;
  }

  /** Index of the bar covering `target`, or -1 when it falls in a hole.
   *
   * Bars are drawn edge to edge, so a pointer anywhere over a column belongs to
   * that column. Nearest-timestamp matching would hand the right half of every
   * bar to the *next* bucket, which is harmless while the guide line sits on a
   * bar's left edge and wrong the moment it is centred: the readout would jump
   * a day ahead while the cursor was still over the bar being read.
   */
  function barBucketAt(times, target) {
    const n = times.length;
    if (!n) return -1;
    if (n === 1) return target >= num(times[0]) ? 0 : -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (num(times[mid]) <= target) lo = mid;
      else hi = mid - 1;
    }
    const start = num(times[lo]);
    if (target < start) return -1;
    return target < start + barSlot(times, lo, 1) ? lo : -1;
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesHistoryChart extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _range: { type: String },
        _anchor: { type: Object },
        _data: { type: Object },
        _loading: { type: Boolean },
        _error: { type: String },
        _hover: { type: Number },
        _selected: { type: Number },
        _remoteTime: { type: Number },
        _vbW: { type: Number },
        _zoom: { type: Object },
        _totals: { type: Object },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._range = "day";
      this._anchor = new Date();
      this._data = null;
      this._loading = false;
      this._error = null;
      this._hover = -1;
      this._selected = -1;
      this._remoteTime = null;
      /* Month / year / lifetime energy tiles, filled by `_fetchTotals()`. */
      this._totals = null;
      this._totalToken = 0;
      this._token = 0;
      /* viewBox width in CSS pixels; guarded so `_svg` works before mount. */
      this._vbW = VB_W;
      this._ro = null;
      this._syncJoined = null;
      this._timer = null;
      this._onVisibility = null;
      /* `null` = the whole window. Otherwise `{a, b}` as 0..1 fractions of it.
         Kept as a fraction so a refetch or a bucket-count change cannot move
         the zoomed stretch out from under the user. */
      this._zoom = null;
      /* Set when a new data set has just been laid out: the next render draws
         the curves flattened onto the zero line and the one after that plays
         them up (see `_playGrow`).  `_growNext` arms it for the *next* query -
         only a new window animates, never the 30 s refresh of the one already
         on screen. */
      this._pendingGrow = false;
      this._growNext = true;
      /* Drag-to-pan state; `null` whenever no button is held. */
      this._drag = null;
      /* Double-click detection state. It is timed from `mousedown`, not from
         `click`: every render replaces the whole `<svg>` subtree (the markup
         arrives as a fresh string), so a re-render between button-down and
         button-up leaves the browser with no common target and it emits no
         `click` and no `dblclick` at all. Button-down always arrives. */
      this._lastDownAt = 0;
      this._lastDownX = 0;
      this._lastDownY = 0;
      /* Kept as a second opinion for the cases where the native sequence does
         survive (nothing re-rendered mid-click), so a fast pair of clicks still
         resets when only one of the two paths sees it. */
      this._lastClickAt = 0;
      /* Set by a double-click that already reset the zoom, so the `click` that
         belongs to the same gesture does not also clear the legend highlight. */
      this._dblReset = false;
      /* Per-instance id for the plot clip: `clip-path: url(#id)` resolves
         document-wide, so two cards sharing an id would clip each other's
         drawing to the wrong height. */
      this._uid = `hmg2-chart-${Math.random().toString(36).slice(2, 9)}`;
    }

    connectedCallback() {
      super.connectedCallback();
      I18N.watch(this);
      this._joinSync();
      this._watchWidth();
      this._startAutoRefresh();
      /* A region change moves every day boundary, so the window, the labels and
         the totals all have to be recomputed - not just redrawn. */
      const api = window.HoymilesG2Region;
      if (api && typeof api.watch === "function") {
        this._unwatchRegion = api.watch(() => {
          /* The anchor is an instant; keep it, but rebuild everything derived
             from which calendar day that instant is on. */
          this._reload();
        });
      }
    }

    disconnectedCallback() {
      I18N.unwatch(this);
      super.disconnectedCallback();
      this._leaveSync();
      this._stopAutoRefresh();
      if (this._unwatchRegion) { this._unwatchRegion(); this._unwatchRegion = null; }
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }

    /**
     * Poll the current window so a live day keeps growing.
     *
     * The recorder answer is a snapshot of the buckets that existed at query
     * time, so without a second query the card froze on whatever it saw when
     * the dashboard loaded - which is exactly why "PV power by port" and
     * "Grid voltage" stayed flat through a sunny morning while the System tab
     * was already moving.  A statistics bucket never changes once written, so
     * re-reading the same window just appends the newer ones.
     *
     * Scheduled with `setTimeout` rather than `setInterval` so each tick can
     * carry its own jitter: a dashboard stacks up to six of these cards in one
     * sync group, and firing them all in the same millisecond would put six
     * identical recorder queries on the wire at once, every time.
     */
    _startAutoRefresh() {
      this._stopAutoRefresh();
      this._scheduleRefresh();
      this._onVisibility = () => {
        // Coming back to the tab should show the current data straight away
        // instead of whatever was on screen before it was hidden.
        if (!document.hidden) this._maybeRefresh();
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", this._onVisibility);
      }
    }

    _stopAutoRefresh() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this._onVisibility) {
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", this._onVisibility);
        }
        this._onVisibility = null;
      }
    }

    _scheduleRefresh() {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._maybeRefresh();
        if (this.isConnected) this._scheduleRefresh();
      }, AUTO_REFRESH_MS + Math.round(Math.random() * AUTO_REFRESH_JITTER_MS));
    }

    _maybeRefresh() {
      if (!this._hass || !this._config) return;
      if (this._loading) return;
      // A hidden tab has nobody watching it; skip the work and let the next
      // visible tick pick up everything that accumulated in the meantime.
      if (typeof document !== "undefined" && document.hidden) return;
      const { end } = this._window();
      // Only a window that still reaches into the future can gain rows. A past
      // day, month or year is already complete and is never re-queried.
      if (end.getTime() <= Date.now()) return;
      this._softFetch();
    }

    /**
     * Refetch without clearing the drawing.
     *
     * `_reload()` drops `_data` first, which makes `_body()` flash a spinner.
     * An unattended refresh must not do that, and it must not reset `_hover`
     * either: the index addresses a bucket, not a scroll position, so keeping
     * it keeps the readout under the cursor steady while the curve extends.
     */
    async _softFetch() {
      const keep = this._data;
      const keepError = this._error;
      await this._fetch();
      // A failed unattended query must not blank a chart that is still
      // perfectly valid, so the previous drawing and its last verdict win over
      // the fresh failure. `_body()` prints the error before anything else, so
      // both have to be restored for the chart to stay on screen.
      if (!this._data && keep) {
        this._data = keep;
        this._error = keepError;
        this.requestUpdate();
      }
    }

    /**
     * Keep the drawing width equal to the svg's pixel width.
     *
     * The svg is stretched by CSS (`width:100%` with a fixed pixel height), so
     * with `preserveAspectRatio="none"` a viewBox wider than the card squashes
     * the text horizontally. Measuring instead of hard-coding keeps the x scale
     * at 1 and the labels crisp at any card width.
     */
    _watchWidth() {
      if (typeof ResizeObserver !== "function" || this._ro) return;
      this._ro = new ResizeObserver(() => this._measure());
      this._ro.observe(this);
    }

    /**
     * Re-read the drawing width. Called after every render (the svg only exists
     * once there is data, and `_vbW` has to follow the first real layout) and by
     * the ResizeObserver (for later card resizes).
     */
    _measure() {
      const renderRoot = this.renderRoot;
      const svg = renderRoot ? renderRoot.querySelector("svg") : null;
      const svgWidth = svg ? svg.getBoundingClientRect().width : 0;
      const width = Math.round(svgWidth
        || this.getBoundingClientRect().width - CARD_PAD_X);
      if (width < MIN_VB_W) return;
      // 2 px of slack keeps rounding from ping-ponging the render.
      if (Math.abs(width - this._vbW) < 2) return;
      this._vbW = width;
      this.requestUpdate();
    }

    /** Current drawing width, falling back to the default before layout. */
    _width() {
      const width = this._vbW;
      return width >= MIN_VB_W ? width : VB_W;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-g2-history-chart-editor");
    }

    static getStubConfig() {
      return { range: "day", series: [] };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 16px 14px; }
        .head { display: flex; flex-wrap: wrap; gap: 8px 12px;
                align-items: center; }
        .title { font-size: 16px; font-weight: 600;
                 color: var(--primary-text-color); }
        .head.no-title .title { display: none; }
        /* Toolbar, shaped like the vendor app's history pages: the date
           navigator on the left, the range picker on the right. */
        .toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
                   width: 100%; justify-content: space-between; }
        .toolbar select {
          font: inherit; font-size: 13px; color: var(--primary-text-color);
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color); border-radius: 10px;
          padding: 7px 10px; outline: none; cursor: pointer;
        }
        /* date navigator: one rounded pill holding ‹ date › */
        .toolbar .nav {
          display: flex; align-items: center; gap: 2px;
          border: 1px solid var(--divider-color); border-radius: 999px;
          padding: 2px; background: var(--card-background-color, #fff);
        }
        .toolbar .nav input {
          font: inherit; font-size: 13px; font-weight: 600;
          color: var(--primary-text-color);
          background: none; border: none; outline: none;
          padding: 5px 6px; text-align: center;
        }
        select:focus, input:focus { border-color: var(--primary-color); }
        .navbtn {
          width: 30px; height: 30px; border-radius: 50%; border: none;
          background: none; cursor: pointer; font: inherit;
          font-size: 15px; color: var(--primary-text-color); line-height: 1;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .navbtn:hover { background: var(--secondary-background-color, rgba(127,127,127,0.1)); }
        /* A chart answers the pointer - a crosshair guide line, a readout and
           (on a curve) wheel zoom plus drag-to-pan - so it advertises that with
           a crosshair instead of the plain arrow it used to show. Without it a
           card looked like a static picture; the empty state below still gets
           no cursor, because there is nothing there to point at. */
        .chart { margin-top: 8px; position: relative; cursor: crosshair; }
        .chart svg { display: block; width: 100%; }
        /* The reveal: a freshly loaded window grows out of the zero line
           instead of snapping into place.  A CSS transform on the drawing group
           is composited (no per-frame re-render, which matters on a Pi with six
           of these cards open), and the origin is handed in as an inline style
           because only the drawing knows where zero sits on the axis. */
        .grow { transform-box: view-box; transform-origin: 0 0;
                transition: transform 520ms cubic-bezier(0.22, 0.61, 0.36, 1); }
        .grow.start { transform: scaleY(0); }
        /* A zoomed chart is pannable, so it advertises the grab cursor; the
           double-click reset is spelled out in the hint under it because it is
           not discoverable otherwise. */
        .chart.zoomed { cursor: grab; }
        .chart.dragging { cursor: grabbing; }
        .hint { font-size: 11px; color: var(--secondary-text-color);
                text-align: center; opacity: 0.75; margin-top: 2px;
                user-select: none; }
        .total { margin-left: auto; font-size: 13px; font-weight: 600;
                 color: var(--primary-text-color); white-space: nowrap; }
        /* Energy tiles (month / year / lifetime). They sit above the plot like
           the vendor app's summary row, so the number is read before the shape
           of the curve. */
        .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 4px; }
        .tile { flex: 1 1 0; min-width: 92px; padding: 8px 10px;
                border-radius: 12px;
                background: var(--secondary-background-color, #f4f5f7);
                text-align: center; }
        .tile .tv { font-size: 17px; font-weight: 700; line-height: 1.2;
                    color: var(--primary-text-color); }
        .tile .tl { font-size: 11.5px; margin-top: 2px;
                    color: var(--secondary-text-color); }
        .axis { font-size: 11.5px; fill: var(--secondary-text-color); }
        .grid { stroke: var(--divider-color); stroke-width: 1; stroke-dasharray: 3 4; }
        .zero { stroke: var(--secondary-text-color); stroke-width: 1.1; opacity: 0.55; }
        .guide { stroke: var(--primary-color); stroke-width: 1; stroke-dasharray: 2 3;
                 opacity: 0.8; }
        .tipbox { fill: var(--card-background-color, #fff); stroke: var(--divider-color);
                  stroke-width: 1; }
        .tiptext { font-size: 12px; fill: var(--primary-text-color); }
        /* pill-shaped legend, like the app: colored disc inside a grey chip */
        .legend { display: flex; flex-wrap: wrap; gap: 8px 10px;
                  justify-content: center; margin-top: 10px; }
        .li { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px;
              color: var(--primary-text-color); cursor: pointer;
              border-radius: 999px; padding: 4px 13px 4px 5px;
              background: var(--secondary-background-color, rgba(127,127,127,0.12));
              transition: opacity .15s, background .15s, box-shadow .15s;
              user-select: none; }
        .li:hover { box-shadow: inset 0 0 0 1px var(--divider-color); }
        .li.off { opacity: 0.38; }
        .li.on { font-weight: 600;
                 box-shadow: inset 0 0 0 1px var(--primary-color); }
        .dot { width: 17px; height: 17px; border-radius: 50%; flex: 0 0 auto;
               box-sizing: border-box;
               border: 2px solid var(--card-background-color, #fff); }
        .msg { font-size: 13px; color: var(--secondary-text-color); padding: 26px 2px;
               text-align: center; }
        .err { color: var(--error-color); }
        .spin { display: inline-block; width: 12px; height: 12px; margin-right: 6px;
                border: 2px solid var(--divider-color); border-top-color: var(--primary-color);
                border-radius: 50%; animation: sp 0.8s linear infinite; vertical-align: -2px; }
        @keyframes sp { to { transform: rotate(360deg); } }
      `;
    }

    setConfig(config) {
      if (!config || !Array.isArray(config.series) || !config.series.length) {
        throw new Error("hoymiles-g2-history-chart: 'series' must list at least one entity");
      }
      this._config = {
        ...config,
        series: config.series.map((s, i) => ({
          ...s,
          color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        })),
      };
      if (config.range) this._range = config.range;
      this._data = null;
      this._zoom = null;
      this._growNext = true;
      this._joinSync();
      // `hass` may already be set when the dashboard is edited in place.
      if (this._hass) this._fetch();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first && this._config) this._fetch();
      this.requestUpdate();
    }

    /** Re-measure after every render: the svg appears only once data arrived. */
    updated() {
      this._measure();
      this._playGrow();
    }

    getCardSize() {
      return 7;
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

    /** A series' display name, resolved for the current language. */
    _sName(s) {
      if (!s) return "";
      return this._text(s.name != null ? s.name : s.entity) || "";
    }

    /* --------------------------- time windows --------------------------- */

    /**
     * The lower bound of an opt-in card's *data*, in ms, or ``null``.
     *
     * A card the user enabled from the options page carries the instant it was
     * enabled.  The statistics from before that instant are still in the
     * recorder - that is the whole point of the option - so the card has to
     * exclude them itself; ``since`` accepts ISO 8601 or epoch milliseconds,
     * whichever the generator wrote.
     *
     * The bound clips the *series* only, never the window: see `_window()` for
     * why dragging the window along with it broke every axis comparison with
     * the cards beside it.
     */
    _since() {
      const raw = this._config && this._config.since;
      if (raw == null || raw === "") return null;
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      const ms = Date.parse(String(raw));
      return Number.isFinite(ms) ? ms : null;
    }

    _window() {
      const a = this._anchor;
      /* The anchor is a browser-local `Date`, but the calendar it is being read
         against is the chosen region's - so the year/month/day come from the
         region, not from `getFullYear()`/`getMonth()`. */
      const p = partsOf(a);
      let start;
      let end;
      if (this._range === "month") {
        start = regionDate(p.year, p.month - 1, 1);
        /* Day 0 of the next month = last day of this one. */
        end = endOfDay(regionDate(p.year, p.month, 0));
      } else if (this._range === "year") {
        start = regionDate(p.year, 0, 1);
        end = endOfDay(regionDate(p.year, 11, 31));
      } else {
        start = startOfDay(a);
        end = endOfDay(a);
      }
      /* The window is the calendar window, whatever ``since`` says.
         It used to be cut at ``since``, on the reasoning that the axis should
         begin where the card was enabled - but that gave an opt-in card an
         axis running 10:06 -> 23:00 while the fixed cards of the same view ran
         00:00 -> 24:00.  Two cards side by side then disagreed about what the
         horizontal axis meant, and the vertical guide line the sync group
         shares stopped landing on the same instant in both: the times simply
         did not line up.  Clipping the data (in `_build`) instead of the window
         keeps one clock under every card of the view, which is the point of
         sharing a `sync_group` at all. */
      return { start, end };
    }

    /**
     * Is this card drawing bars instead of curves?
     *
     * `mode: auto` (the default for the energy card) draws the *day* as a
     * curve and the month / year as one bar per day / per month, which is what
     * makes "20.91 kWh in November" readable at a glance: a curve can only
     * show that a value went up, a bar shows how much each day contributed.
     * A power card keeps `mode: line` everywhere - bars of instantaneous watts
     * would say nothing about how much energy was produced.
     */
    _barMode() {
      const mode = this._config && this._config.mode;
      if (mode === "bar") return true;
      if (mode === "line") return false;
      if (mode !== "auto") return false;
      return this._range !== "day" && this._isEnergy();
    }

    /** True when the y axis carries energy rather than a rate. */
    _isEnergy() {
      const unit = String(
        (this._config && this._config.unit)
        || (this._config && this._config.series && this._config.series[0]
          && this._config.series[0].unit)
        || "",
      ).trim().toLowerCase();
      return unit === "wh" || unit === "kwh" || unit === "mwh";
    }

    /**
     * Does this series hold its last reading across a hole in the data?
     *
     * A *measurement* does not: an online device reports on every tick - even
     * a plain 0 W reading - so a bucket with no row at all means the device was
     * not talking to the broker in it.  Drawing the last reading across that
     * stretch claims a level nobody measured, so such a series drops to 0.
     *
     * A *running total* is the opposite: it is a lifetime accumulator, and the
     * energy produced while the gateway was away is still counted - the very
     * next bucket carries it.  Letting it fall to 0 and climb back would draw a
     * counter resetting itself.  A level (`%`) holds for the same reason at a
     * smaller scale: 0 % would read as an empty battery rather than as a missed
     * reading.
     */
    _holdsGaps() {
      if (this._isEnergy()) return true;
      const unit = String(
        (this._config && this._config.unit)
        || (this._config && this._config.series && this._config.series[0]
          && this._config.series[0].unit)
        || "",
      ).trim();
      return unit === "%";
    }

    /**
     * Factor that converts a statistic into the card's display unit.
     *
     * The recorder always answers in the sensor's own unit (Wh for every energy
     * entity this integration creates), but 20 910 Wh on an axis is unreadable:
     * the vendor app prints 20.91 kWh.  Rather than rescaling silently - which
     * is what once made the W axis print "2.50 W" for 2 500 W - the factor is
     * explicit config (`unit: kWh` + `scale: 0.001`), so the numbers, the axis
     * label and the totals all agree.
     */
    _scale() {
      const s = num(this._config && this._config.scale);
      return s > 0 ? s : 1;
    }

    /** Statistics granularity: finer for short windows, coarser for long ones. */
    _periods() {
      /* A bar is one *slot* of the window - one day of a month, one month of a
         year - so the buckets have to be that wide. Asking for hourly means of
         a month and then adding them up would also have been possible, but a
         daily bucket is one recorder row instead of twenty-four.

         The list is a *fallback chain* rather than a single answer.  A newly
         created total_increasing sensor does not have long-term statistics for
         hours or days until the recorder has compiled them, so a card pointed
         at one asked for `day` rows, got none, and drew "no statistics" even
         though 5 minute rows existed for every bucket.  The finer periods are
         only used when the coarse one is empty, and what they return is folded
         back onto the slot grid by `_coarsen()` - the drawing stays one bar per
         day either way. */
      if (this._barMode()) {
        return this._range === "year"
          ? ["month", "day", "hour"]
          : ["day", "hour", "5minute"];
      }
      if (this._range === "month") return ["hour"];
      if (this._range === "year") return ["day"];
      // A day is best rendered from 5 minute statistics, but those are only
      // retained for `purge_keep_days` (10 days by default), so fall back to
      // hourly buckets when the finer query came back empty.
      return ["5minute", "hour"];
    }

    /**
     * The bucket width the *drawing* wants, i.e. the first period of the chain.
     *
     * Used to decide whether rows that came back from a fallback period still
     * have to be folded onto the slot grid before they are drawn.
     */
    _slotPeriod() {
      return this._periods()[0];
    }

    /**
     * Fold finer statistics onto the drawing's slot width.
     *
     * The recorder only compiles long-term statistics once it has had the data
     * for a while: a `total_increasing` sensor created this morning has 5 minute
     * rows for every bucket and no `day` row at all until the nightly compile
     * runs.  The chart asked for `day`, got nothing, and printed 「统计数据不可用」
     * over data that was sitting right there.
     *
     * So the query walks down to a finer period when the coarse one is empty,
     * and this puts the answer back on the grid the card wants to draw.  The
     * aggregation rules are the ones statistics already follow per row:
     *
     * * `change` is **summed** - one day's energy is the sum of its hours;
     * * `state` keeps the **last** non-null value of the slot, because it is the
     *   meter reading at the end of it;
     * * `mean` is averaged over the rows that carried one (only measured
     *   quantities have it, and a plain average is what the recorder itself does
     *   for a coarser bucket).
     *
     * `sum` is dropped on purpose: it is the lifetime running total, and `_build`
     * never reads it.
     */
    _coarsen(rows) {
      const period = this._slotPeriod();
      const bucketMs = PERIOD_MS[period] || 0;
      if (!rows || !(bucketMs > 0)) return rows;

      /* Aligned to the region's calendar, so a "day" bucket starts at regional
         midnight and lines up with `_bucketGrid()` whether the browser and the
         recorder agree on the zone or not.  A month slot is aligned to the 1st. */
      const keyOf = (ms) => {
        const p = partsOf(new Date(ms));
        const start = period === "month"
          ? regionDate(p.year, p.month - 1, 1)
          : regionDate(p.year, p.month - 1, p.day);
        return start.getTime();
      };

      const out = {};
      for (const [id, list] of Object.entries(rows)) {
        if (!Array.isArray(list)) { out[id] = list; continue; }
        const slots = new Map();
        for (const row of list) {
          const t = num(row.start);
          if (!Number.isFinite(t)) continue;
          const key = keyOf(t);
          let slot = slots.get(key);
          if (!slot) {
            slot = { start: key, end: num(row.end) || t + bucketMs, mean: null, state: null, change: null, n: 0 };
            slots.set(key, slot);
          }
          if (row.change != null) slot.change = (slot.change || 0) + num(row.change);
          if (row.state != null) slot.state = num(row.state);
          if (row.mean != null) {
            slot.mean = slot.mean == null ? num(row.mean) : slot.mean + num(row.mean);
            slot.n += 1;
          }
          const end = num(row.end);
          if (Number.isFinite(end) && end > slot.end) slot.end = end;
        }
        out[id] = [...slots.values()]
          .sort((a, b) => a.start - b.start)
          .map((slot) => ({
            start: slot.start,
            end: slot.end,
            mean: slot.mean == null ? null : slot.mean / slot.n,
            state: slot.state,
            change: slot.change,
          }));
      }
      return out;
    }

    _shiftRange(step) {
      /* Stepping is calendar arithmetic *in the region*: "yesterday" means the
         previous regional day, not "24 hours earlier" (which lands on the same
         date across a daylight-saving change). */
      const p = partsOf(this._anchor);
      let a;
      if (this._range === "month") {
        a = regionDate(p.year, p.month - 1 + step, 1);
      } else if (this._range === "year") {
        a = regionDate(p.year + step, 0, 1);
      } else {
        /* Noon keeps away from midnight, so a single-day step can never land on
           the ambiguous hour of a clock change. */
        const noon = regionDate(p.year, p.month - 1, p.day).getTime() + 12 * 3600 * 1000;
        const next = partsOf(noon);
        a = regionDate(next.year, next.month - 1, next.day + step);
      }
      /* No clamp against ``since`` here.  An opt-in card used to refuse to step
         back past the moment it was enabled, which made it disagree with every
         other card of its `sync_group`: the group relayed "yesterday" and this
         one stayed on today, so the same dashboard showed two different days
         side by side.  Navigation is the *group's*, and stepping into a window
         that predates the card simply draws an empty one - which is truthful,
         and it says so in as many words. */
      this._anchor = a;
      this._reload();
    }

    _onRangeChange(event) {
      this._range = event.target.value;
      this._reload();
    }

    _onAnchorChange(event) {
      const value = event.target.value;
      let a = null;
      if (this._range === "year") {
        const year = parseInt(value, 10);
        if (Number.isFinite(year)) a = regionDate(year, 0, 1);
      } else if (this._range === "month" && /^\d{4}-\d{2}$/.test(value)) {
        const [y, m] = value.split("-").map(Number);
        a = regionDate(y, m - 1, 1);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [y, m, d] = value.split("-").map(Number);
        a = regionDate(y, m - 1, d);
      }
      if (!a || Number.isNaN(a.getTime())) return;
      this._anchor = a;
      this._reload();
    }

    /** Drop the cached data and refetch, then tell the group about the window. */
    _reload() {
      this._data = null;
      this._hover = -1;
      /* A zoom is a fraction of *one* window, so it cannot survive a move to
         another day: the same 20..30 % would point at a different hour, which
         reads as the chart jumping somewhere random after a date change. */
      this._zoom = null;
      this._drag = null;
      this._growNext = true;
      this._fetch();
      this._pushSync();
    }

    /* --------------------------- sync group --------------------------- */

    _syncKey() {
      const key = this._config && this._config.sync_group;
      return key == null || key === "" || key === false ? null : String(key);
    }

    _joinSync() {
      const key = this._syncKey();
      if (key === this._syncJoined) return;
      this._leaveSync();
      if (!key) return;
      let group = SYNC_GROUPS.get(key);
      if (!group) {
        group = { state: null, members: new Set() };
        SYNC_GROUPS.set(key, group);
      }
      group.members.add(this);
      this._syncJoined = key;
      // Adopt the window the group already has, so a late card does not show a
      // different period than the one next to it.
      if (group.state) this._applySync(group.state);
      if (group.hover != null) this._applyRemoteHover(group.hover);
    }

    _leaveSync() {
      const key = this._syncJoined;
      if (!key) return;
      const group = SYNC_GROUPS.get(key);
      if (group) {
        group.members.delete(this);
        if (!group.members.size) SYNC_GROUPS.delete(key);
      }
      this._syncJoined = null;
    }

    /** Publish this card's window to the rest of the group. */
    _pushSync() {
      const key = this._syncKey();
      if (!key) return;
      const group = SYNC_GROUPS.get(key);
      if (!group) return;
      const state = { range: this._range, anchor: this._anchor.getTime() };
      group.state = state;
      for (const member of group.members) {
        if (member !== this) member._applySync(state);
      }
    }

    /** Follow the group's window. Never pushes back, so it cannot loop. */
    _applySync(state) {
      if (!state) return;
      const rangeChanged = this._range !== state.range;
      /* The group relays the window every member shares, including one that
         predates an opt-in card's ``since``: that card then clips its own data
         (in `_build`) and renders an empty axis, rather than refusing to move
         and leaving two cards of the same view on two different days. */
      this._range = state.range;
      const target = new Date(state.anchor);
      /* A moved window can land on the anchor it already had while the range
         did change, which still means a different window to fetch. */
      if (!rangeChanged && this._anchor.getTime() === target.getTime()) return;
      this._anchor = target;
      this._data = null;
      this._hover = -1;
      this._remoteTime = null;
      this._zoom = null;
      this._growNext = true;
      if (this._config && this._hass) this._fetch();
      this.requestUpdate();
    }

    /** Publish the hovered timestamp so the rest of the group can mirror it. */
    _pushHover(index) {
      const key = this._syncKey();
      if (!key) return;
      const group = SYNC_GROUPS.get(key);
      if (!group) return;
      const times = this._data && this._data.times;
      const time = index >= 0 && times && times.length
        ? num(times[Math.min(index, times.length - 1)])
        : null;
      // `mousemove` fires far more often than the bucket changes, so only a new
      // timestamp is worth waking the other cards for.
      if (group.hover === time) return;
      group.hover = time;
      for (const member of group.members) {
        if (member !== this) member._applyRemoteHover(time);
      }
    }

    /** Mirror another card's hover. Never pushes back. */
    _applyRemoteHover(time) {
      const next = time == null ? null : num(time);
      if (this._remoteTime === next && (next != null || this._hover < 0)) return;
      this._remoteTime = next;
      if (next == null) this._hover = -1;
      this.requestUpdate();
    }

    _anchorValue() {
      /* The `<input type="date">` value has to read the anchor in the region's
         calendar, otherwise picking "2026-11-20" in a region one offset away
         would show up as the 19th in the field that was just used to set it. */
      const a = partsOf(this._anchor);
      if (this._range === "year") return String(a.year);
      if (this._range === "month") return `${a.year}-${pad2(a.month)}`;
      return `${a.year}-${pad2(a.month)}-${pad2(a.day)}`;
    }

    async _fetch() {
      if (!this._hass || !this._config) return;
      if (typeof this._hass.callWS !== "function") {
        this._error = this._t("Home Assistant is not connected.", "未连接到 Home Assistant。");
        return;
      }

      const ids = this._config.series.map((s) => s.entity).filter(Boolean);
      const { start, end } = this._window();
      const token = ++this._token;
      const periods = this._periods();

      this._loading = true;
      this._error = null;

      try {
        let rows = null;
        let period = periods[0];
        for (const candidate of periods) {
          const result = await this._hass.callWS({
            type: "recorder/statistics_during_period",
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            statistic_ids: ids,
            period: candidate,
            /* `mean` for a measured quantity (W, V, A), `states` for a running
               total. An energy sensor is total_increasing, so its statistics
               carry `state` / `sum` / `change` and leave `mean` null - asking
               for `mean` alone drew every energy card as a flat zero line.
               `change` is the amount the counter grew *in that bucket*, which
               is exactly the energy produced during it, and is preferred over
               differencing `state` by hand: the recorder already handles the
               meter reset in the middle of a bucket. */
            types: ["mean", "state", "change"],
          });
          if (token !== this._token) return; // a newer request won
          period = candidate;
          rows = result;
          const first = rows && rows[ids[0]];
          /* Any row at all is enough to keep the finer granularity. Requiring
             *more* than six rows used to demote the whole day to hourly buckets
             through the first hours of the morning - the sparse stretch is
             precisely when the user is watching the sun come up - so a day
             still in progress drew hour-wide steps until well past dawn.
             An empty result still falls through, which is what keeps a range
             whose 5 minute statistics were already purged on hourly buckets. */
          if (Array.isArray(first) && first.length > 0) break;
        }

        /* The rows may have come back from a fallback period - a sensor whose
           daily statistics the recorder has not compiled yet still answers with
           hourly and 5 minute ones.  Fold them onto the grid the drawing wants
           before building the layers, or a month would be plotted as hundreds of
           bars a few pixels wide.
           Only when the fallback is *finer* than the slot: the day range walks
           the other way (`5minute` -> `hour`), and those rows are drawn as they
           are with a wider bucket. */
        const drawPeriod = this._slotPeriod();
        let buildPeriod = period;
        if ((PERIOD_MS[period] || 0) < (PERIOD_MS[drawPeriod] || 0)) {
          rows = this._coarsen(rows);
          buildPeriod = drawPeriod;
        }

        this._data = this._build(rows || {}, buildPeriod);
        /* A new window is drawn grown-out instead of snapped-in, so opening a
           card reads as the day filling up rather than as a diagram that was
           simply always there.  Only a *new* window: re-querying the same open
           month every 30 s must not replay the animation under the user. */
        if (this._growNext) {
          this._pendingGrow = !!this._data;
          this._growNext = false;
        }
        if (this._config.show_totals === true) this._fetchTotals();
      } catch (err) {
        if (token !== this._token) return;
        this._data = null;
        this._error = this._t(
          "Statistics are unavailable — is the recorder enabled?",
          "统计数据不可用 —— 是否启用了 recorder？",
        );
      } finally {
        if (token === this._token) {
          this._loading = false;
          this.requestUpdate();
        }
      }
    }

    /**
     * Month / year / lifetime totals for the energy card.
     *
     * The vendor app prints three numbers above the history: this month, this
     * year and since installation. The integration has no month or year
     * sensor, but the recorder does: the growth of the lifetime counter over a
     * window *is* the energy produced in it, so the tiles are derived from the
     * same statistic the chart plots rather than from new entities.
     */
    async _fetchTotals() {
      const series = (this._config && this._config.series) || [];
      const id = series[0] && series[0].entity;
      if (!id || !this._hass || typeof this._hass.callWS !== "function") return;
      const now = new Date();
      /* "This month" and "this year" are the *region's* months and years, so the
         growth read out of the lifetime counter matches the 「今日」 / 「本月」 tiles
         the device itself computes against its own midnight. */
      const p = partsOf(now);
      const monthStart = regionDate(p.year, p.month - 1, 1);
      const yearStart = regionDate(p.year, 0, 1);
      /* The lifetime window starts at the epoch: the recorder simply returns
         whatever it has, which is the whole history of the counter. */
      const epoch = regionDate(2000, 0, 1);
      const token = ++this._totalToken;
      /* `change` is additive across buckets, so the granularity is free to
         follow the length of the window rather than being fixed: a day of
         hourly rows and a year of daily rows sum to the same number, but the
         lifetime window is a quarter of a century wide and asking for a row
         per day would pull ten thousand of them out of the recorder on every
         repaint of the card. */
      const sum = async (from, to, period) => {
        const result = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: from.toISOString(),
          end_time: to.toISOString(),
          statistic_ids: [id],
          period,
          types: ["change"],
        });
        const rows = (result && result[id]) || [];
        let total = 0;
        for (const row of rows) total += num(row.change);
        return total;
      };
      /* Same fallback as the chart itself, and for the same reason: a recently
         created counter has no `day` or `month` aggregates until the recorder
         compiles them, so the coarse sum comes back as 0 while the finer periods
         already hold everything.  Tried only when the coarse answer was empty -
         a genuine 0 is left alone, and the extra queries cost nothing on the
         common path. */
      const sumWithFallback = async (from, to, coarse, fine) => {
        const first = await sum(from, to, coarse);
        if (first > 0) return first;
        const second = await sum(from, to, fine);
        return second > 0 ? second : first;
      };
      try {
        const [month, year, life] = await Promise.all([
          sumWithFallback(monthStart, now, "day", "hour"),
          sumWithFallback(yearStart, now, "month", "day"),
          /* The lifetime window is a quarter of a century wide, so its fallback
             steps to weeks rather than days: the sum is the same number, but a
             few hundred rows instead of a few thousand on every repaint. */
          sumWithFallback(epoch, now, "month", "week"),
        ]);
        if (token !== this._totalToken) return;
        this._totals = {
          month: month * this._scale(),
          year: year * this._scale(),
          life: life * this._scale(),
        };
      } catch (err) {
        if (token !== this._totalToken) return;
        /* The chart itself is still fine, so a failed total must not surface
           as an error banner - the tiles are simply left out. */
        this._totals = null;
      }
      this.requestUpdate();
    }

    /**
     * The three energy tiles: month, year and lifetime.
     *
     * Drawn from statistics rather than from entities, so they follow the same
     * retention rules as the chart and stay correct after a meter reset. The
     * tiles are static markup, so they go through `_untrusted()`.
     */
    _totalsRow() {
      const totals = this._totals;
      if (!totals) return "";
      const display = pickUnit(this._config.unit, Math.max(totals.life, 1e-9));
      const unit = this._config.unit || "";
      const tile = (label, value) => {
        const shown = Number.isFinite(value)
          ? fmtNumber(value / display.divisor, Math.abs(value) >= 100 ? 1 : 2)
          : "\u2014";
        return `<div class="tile"><div class="tv">${esc(shown)}${unit ? ` ${esc(unit)}` : ""}</div>`
          + `<div class="tl">${esc(label)}</div></div>`;
      };
      return `<div class="tiles">`
        + tile(this._t("This month", "月发电量"), totals.month)
        + tile(this._t("This year", "年发电量"), totals.year)
        + tile(this._t("Lifetime", "总发电量"), totals.life)
        + "</div>";
    }

    /** Align every series on one time grid and compute the stacked layers. */
    _build(result, period) {
      /* A bar is a *quantity*, not a level: the energy produced during that
         day or month. That is the recorder's `change` for the bucket, and the
         fallback when a statistics row does not carry one is the growth of
         `state` since the previous bucket - never `state` itself, which is the
         lifetime meter and would draw a staircase rising forever. */
      const bars = this._barMode();
      const series = this._config.series;
      /* Statistics arrive in the sensor's own unit (Wh); `scale` converts them
         into the card's (`kWh` = 0.001) once, so the bars, the axis, the
         tooltip and the tiles all speak the same unit. */
      const scale = this._scale();
      /* An opt-in card draws nothing from before it was enabled, so buckets
         that ended before ``since`` are dropped here - at the data, not at the
         window (`_window()` stays on the calendar so the x axis still matches
         every other card of the view).
         The comparison is against a bucket's *end*, not its start: a statistic
         row is stamped with the instant its bucket begins, and the bucket the
         card was ticked in began a few minutes earlier, so a plain
         ``start < since`` test would throw that bucket away and leave a freshly
         ticked card empty until the next one was written. */
      const since = this._since();
      const bucketMs = PERIOD_MS[period] || 0;
      const timeSet = new Set();
      const bySeries = series.map((s) => {
        const map = new Map();
        for (const row of (result[s.entity] || [])) {
          const t = num(row.start);
          if (since != null && t + bucketMs <= since) continue;
          /* `mean` first, then `state`: a measured quantity reports `mean`,
             a total_increasing counter (energy) only reports `state`. Never
             fall through to `sum`, which is a lifetime running total and would
             plot an ever-climbing diagonal. */
          const v = row.mean != null ? num(row.mean)
            : row.state != null ? num(row.state)
              : null;
          const change = row.change != null ? num(row.change) : null;
          map.set(t, { v, change, state: row.state != null ? num(row.state) : null });
          timeSet.add(t);
        }
        return map;
      });

      const observed = [...timeSet].sort((a, b) => a - b);
      if (!observed.length) {
        /* Nothing at all in the window: `_body()` prints the "no statistics"
           line, which is clearer than an axis full of zero bars. */
        return {
          times: observed, period, layers: [], max: 1, min: 0, bars, holes: null,
        };
      }

      /* In the bar modes the axis is the calendar, not the recorder's answer.
         Only the buckets that exist used to be plotted, which had two visible
         consequences: a day the device reported nothing for left no slot at
         all, so the neighbouring bar spanned two days and came out twice as
         wide as the rest; and early in the month every bar crowded into the
         left edge of the card with the rest of it empty, because a 13-day
         month has only 13 slots however wide the card is.

         So the slots come from the window - every day of the month, every
         month of the year - and a day without a reading contributes a zero
         bar. That is the honest number (nothing was produced) and it makes
         every bar the same width and the whole card carry the chart. */
      const grid = bars ? this._barTimes(observed) : null;
      const times = grid ? grid.times : this._filledTimes(observed, bucketMs);
      /* The statistic bucket that feeds each drawn slot. A nominal day with no
         reading has no entry, which is what makes it draw as zero. */
      const bucketOf = new Map();
      if (grid) {
        if (grid.slotOf) {
          for (const [slot, t] of grid.slotOf) bucketOf.set(slot, t);
        } else {
          for (const t of times) bucketOf.set(t, t);
        }
      }

      // Forward fill so a series that started later still has a value. In bar
      // mode the fill is 0 rather than the previous reading: a bucket the
      // device did not report produced no energy, and carrying the previous
      // bar over would draw a day of production that never happened.
      const holds = this._holdsGaps();
      const values = bySeries.map((map) => {
        let last = 0;
        let prevState = null;
        return times.map((t) => {
          const hit = map.get(bucketOf.has(t) ? bucketOf.get(t) : t);
          if (bars) {
            if (!hit) return 0;
            if (hit.change != null) {
              prevState = hit.state;
              return hit.change * scale;
            }
            if (hit.state != null && prevState != null) {
              const delta = hit.state - prevState;
              prevState = hit.state;
              // A counter that went backwards was reset; the recorder's own
              // `change` handles that, a hand-computed difference cannot, so
              // the bucket is dropped rather than drawn as a negative bar.
              return delta >= 0 ? delta * scale : 0;
            }
            prevState = hit.state != null ? hit.state : prevState;
            return 0;
          }
          if (hit && hit.v != null) {
            last = hit.v * scale;
            return last;
          }
          /* No row for this bucket.  `_filledTimes()` put a slot here on
             purpose so the hole is drawn instead of being interpolated over,
             and what that slot is worth depends on what the series means:
             a missing reading is 0 W (the device was not reporting), while a
             running total keeps the level it had reached. */
          return holds ? last : 0;
        });
      });

      /* Which buckets the device did not report at all, so the plot can draw
         the outage as a level of 0 (a curve) while the pointer still refuses to
         claim a reading there - see `_hoverPosition()`.  A bucket only counts
         as a hole when *every* series is missing from it; one series dropping
         out while another still reports is a gap in that series, not an outage,
         and the axis as a whole still has a measurement behind it. */
      const holes = bars ? null : times.map((t) => {
        const at = bucketOf.has(t) ? bucketOf.get(t) : t;
        for (const map of bySeries) if (map.has(at)) return false;
        return true;
      });

      /* Whether the axis is mirrored is a property of the *data*, not of the
         card: a battery or grid power reading changes sign, so it belongs on a
         ±axis, while PV power, a voltage or an energy counter never go below
         zero and would waste half the height on an empty negative half.  An
         explicit `symmetric:` still wins, but leaving it out now resolves per
         render, which also repairs dashboards written before the option
         existed. */
      const dataMin = values.length
        ? values.reduce((acc, vals) => vals.reduce((a, v) => (v < a ? v : a), acc), 0)
        : 0;
      const symmetric = this._config.symmetric != null
        ? this._config.symmetric !== false
        : dataMin < 0;
      /* Stacking depends on what the numbers *mean*, not on the axis. Power
         and energy series that add up (charge + discharge, per-phase power)
         stack; a level must never stack - with three packs at 81 % the second
         curve would be drawn at 81..162 % and the third at 162..243 %, so on a
         0..100 axis only the first stays visible, which reads as "Battery 2
         and 3 are wrong".  Independent measurements - PV, grid and load power -
         must not stack either: drawing the load on top of the PV made a 204 W
         load look larger than the 216 W PV feeding it.  So the default follows
         `symmetric` (a mirrored axis means signed, additive energy) and an
         explicit `stack:` overrides either way. */
      const stacked = this._config.stack != null
        ? this._config.stack !== false
        : symmetric;
      const empty = () => times.map(() => 0);
      const add = (acc, other) => acc.map((v, k) => v + other[k]);

      let max = 0;
      let min = 0;
      let layers = [];

      if (symmetric) {
        // Positive parts grow upwards, negative parts grow downwards, which
        // keeps a charge/discharge sensor readable on both sides of the zero
        // line.
        const pos = values.map((vals) => vals.map((v) => (v > 0 ? v : 0)));
        const neg = values.map((vals) => vals.map((v) => (v < 0 ? v : 0)));

        if (stacked) {
          // Two independent stacks, each series riding on the ones before it.
          let runPos = empty();
          let runNeg = empty();
          const cums = pos.map((p, i) => {
            const layer = {
              posBase: runPos,
              negBase: runNeg,
              posTop: add(runPos, p),
              negTop: add(runNeg, neg[i]),
            };
            runPos = layer.posTop;
            runNeg = layer.negTop;
            return layer;
          });
          const last = cums[cums.length - 1];
          last.posTop.forEach((v) => { if (v > max) max = v; });
          last.negTop.forEach((v) => { if (-v > max) max = -v; });

          layers = series.map((s, i) => ({
            series: s,
            pos: { base: cums[i].posBase, top: cums[i].posTop },
            neg: { base: cums[i].negBase, top: cums[i].negTop },
          }));
        } else {
          // Overlaid: every curve grows from the zero line on its own.
          pos.forEach((p) => p.forEach((v) => { if (v > max) max = v; }));
          neg.forEach((n) => n.forEach((v) => { if (-v > max) max = -v; }));

          layers = series.map((s, i) => ({
            series: s,
            pos: { base: empty(), top: pos[i] },
            neg: { base: empty(), top: neg[i] },
          }));
        }
      } else if (stacked) {
        // One cumulative stack rising from the baseline (energy series).
        const cums = [];
        let run = empty();
        values.forEach((vals) => {
          cums.push([...run]);
          run = run.map((acc, k) => acc + vals[k]);
          cums.push([...run]);
        });
        run.forEach((v) => {
          if (v > max) max = v;
          if (v < min) min = v;
        });
        layers = series.map((s, i) => ({
          series: s,
          pos: { base: cums[i * 2], top: cums[i * 2 + 1] },
          neg: null,
        }));
      } else {
        // A level drawn bottom-up (SOC): every curve is plotted at its own
        // value so the series can be compared directly.
        values.forEach((vals) => vals.forEach((v) => {
          if (v > max) max = v;
          if (v < min) min = v;
        }));
        layers = series.map((s, i) => ({
          series: s,
          pos: { base: empty(), top: values[i] },
          neg: null,
        }));
      }

      /* The sum of each series over the window, in the sensor's own unit. In
         bar mode this is the energy produced during the period - the number
         the vendor app prints as "发电量合计" above the chart. */
      const totals = values.map((vals) => vals.reduce((a, v) => a + v, 0));

      return {
        times, period, layers, max, min, values, symmetric, bars, totals, holes,
      };
    }

    /**
     * Every bar slot of the current window, in chronological order.
     *
     * One slot per calendar day of the month, or per month of the year, so the
     * bar chart always describes the *period* rather than the subset of it the
     * recorder happened to answer for.  A day is a single slot and gets no
     * nominal grid at all.
     */
    _bucketGrid() {
      const { start } = this._window();
      if (this._range === "day") return [];
      const slots = [];
      /* The slots are the region's calendar dates, not the browser's: read the
         year and month out of the window in the region, then build each slot
         through `regionDate` so a bar sits exactly on regional midnight. */
      const p = partsOf(start);
      if (this._range === "year") {
        for (let month = 0; month < 12; month += 1) {
          slots.push(regionDate(p.year, month, 1).getTime());
        }
        return slots;
      }
      const year = p.year;
      const month = p.month - 1;
      // Day 0 of the next month is the last day of this one, so February and a
      // leap year need no special case.
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      for (let day = 1; day <= last; day += 1) {
        slots.push(regionDate(year, month, day).getTime());
      }
      return slots;
    }

    /**
     * Fold the recorder's buckets onto the nominal bar grid.
     *
     * The two grids do not have to agree exactly - a statistics bucket carries
     * the instant the period began, which is local midnight for a day bucket
     * only as long as the recorder and the browser share a timezone.  Matching
     * on exact equality would then turn every bar into a zero, so a bucket is
     * assigned to the slot that *contains* it, and a bucket that falls outside
     * every slot is appended as a slot of its own.  A measurement is therefore
     * never dropped, whatever the timestamps look like.
     *
     * Returns the slot list to draw (nominal slots first, so absent days still
     * get an empty column) plus the slot -> bucket lookup.
     */
    _barTimes(observed) {
      const nominal = this._bucketGrid();
      if (!nominal.length) {
        return { times: [...observed].map((ms) => num(ms)).sort((a, b) => a - b), slotOf: null };
      }
      const slotOf = new Map();
      const extra = [];
      /* Index of the last nominal slot the recorder answered for. The slot
         list is cut after it, which is what fills the card: on the 13th of a
         month only days 1..13 are drawn, evenly spread across the whole width,
         instead of thirteen bars squeezed into the left two fifths with a
         fortnight of empty axis trailing after them. Days that are in the past
         but carry no reading are *not* cut - they stay as a zero bar. */
      let lastSlot = -1;
      for (const raw of observed) {
        const t = num(raw);
        let lo = 0;
        let hi = nominal.length - 1;
        let at = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (nominal[mid] <= t) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        if (at < 0) { extra.push(t); continue; }
        const start = nominal[at];
        const next = at + 1 < nominal.length
          ? nominal[at + 1]
          : start + (start - nominal[at - 1] || DAY_MS);
        if (t < next) {
          if (!slotOf.has(start)) slotOf.set(start, t);
          if (at > lastSlot) lastSlot = at;
        } else {
          extra.push(t);
        }
      }
      const times = nominal.slice(0, lastSlot + 1);
      for (const t of extra) if (!times.includes(t)) times.push(t);
      times.sort((a, b) => a - b);
      return { times, slotOf };
    }

    /**
     * The axis of a curve, with the buckets the device never reported restored.
     *
     * A gateway that lost its MQTT connection leaves a genuine *hole* in the
     * statistics: an entity that was `unavailable` contributes no numeric
     * state, so the recorder writes no row for that bucket at all - not a row
     * with a null mean, no row.  Joining the rows on either side of it drew a
     * smooth climb from the last reading before the outage to the first one
     * after it: a curve through sixty-five minutes that were never measured.
     * Materialising the missing buckets is what lets `_build` give each of them
     * a value of its own, so the plot shows the outage instead of papering over
     * it.
     *
     * Only the stretch *after* the first reading is filled.  What came before
     * it is unknown - the series may not have existed yet - and the plot lifts
     * the line off the base with a short ramp there rather than claiming a
     * little of something since midnight.
     */
    _filledTimes(observed, bucketMs) {
      if (!(bucketMs > 0) || !observed.length) return observed;
      /* Never fill into the future: a day window runs to 23:59:59, and buckets
         past `now` would report 0 W for an hour that has not happened.  A
         window entirely in the past is filled to its own end, so an outage that
         began at 20:00 still reaches the right edge of that day. */
      const { end } = this._window();
      const stop = Math.min(end.getTime(), Date.now());
      const half = bucketMs / 2;
      const out = [];
      for (let i = 0; i < observed.length; i += 1) {
        if (i > 0) {
          const prev = num(observed[i - 1]);
          const next = num(observed[i]);
          for (let t = prev + bucketMs; t < next - half; t += bucketMs) out.push(t);
        }
        out.push(num(observed[i]));
      }
      /* The trailing stretch only counts as an outage when it is longer than a
         couple of buckets.  The newest bucket is written when it *closes*, so a
         device that is talking perfectly right now always leaves the current,
         still-open bucket missing - filling that would dip every healthy curve
         to 0 at the right edge once per bucket. */
      const last = num(observed[observed.length - 1]);
      if (stop - last > bucketMs * 2) {
        for (let t = last + bucketMs; t <= stop; t += bucketMs) out.push(t);
      }
      return out;
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const title = this._config.title === false ? ""
        : (this._text(this._config.title) || this._t("History", "历史数据"));
      /* The period's total, for the bar modes only: on a power chart the sum of
         the instantaneous readings means nothing. Shows even before the first
         paint resolves (empty string), so the head does not jump. */
      const total = this._data && this._data.bars ? this._totalLabel(this._data) : "";

      // The toolbar sits first so it lands in the card's top left corner.
      return html`
        <ha-card>
          <div class="head">
            ${this._config.show_toolbar === false ? "" : this._toolbar()}
            ${title === "" ? "" : html`<div class="title">${title}</div>`}
            ${total === "" ? "" : html`<div class="total">${total}</div>`}
          </div>
          ${this._config.show_totals === true ? this._untrusted(this._totalsRow()) : ""}
          ${this._body()}
          ${this._legend()}
        </ha-card>
      `;
    }

    _toolbar() {
      const rangeOptions = RANGES.map((r) =>
        `<option value="${r.id}" ${r.id === this._range ? "selected" : ""}>${esc(this._t(r.en, r.zh))}</option>`).join("");
      const inputType = this._range === "day" ? "date"
        : this._range === "month" ? "month" : "number";

      return html`
        <div class="toolbar">
          <div class="nav">
            <button class="navbtn" title=${this._t("Previous", "上一个")}
              @click=${() => this._shiftRange(-1)}>‹</button>
            <input type=${inputType} .value=${this._anchorValue()}
              @change=${(e) => this._onAnchorChange(e)} />
            <button class="navbtn" title=${this._t("Next", "下一个")}
              @click=${() => this._shiftRange(1)}>›</button>
          </div>
          <select @change=${(e) => this._onRangeChange(e)}>${this._untrusted(rangeOptions)}</select>
        </div>`;
    }

    _body() {
      if (this._error) return html`<div class="msg err">${this._error}</div>`;
      if (this._loading && !this._data) {
        return html`<div class="msg"><span class="spin"></span>${this._t("Loading…", "正在读取统计…")}</div>`;
      }
      const data = this._data;
      if (!data || !data.times.length) {
        return html`<div class="msg">${this._t(
          "No statistics recorded for this period.",
          "该时间段没有统计数据。",
        )}</div>`;
      }
      /* Bars are a calendar, not a stretch of time to explore: a month of day
         bars is already one bar per day, and zooming into it only hides the
         days it exists to compare.  `_barMode()` is resolved per render, so the
         gesture follows the range selector (day curve = zoomable, month / year
         bars = not) with no extra config. */
      const zoomable = !data.bars;
      const cls = [
        "chart",
        zoomable && this._zoom ? "zoomed" : "",
        zoomable && this._drag ? "dragging" : "",
      ].filter(Boolean).join(" ");
      return html`
        <div class=${cls}
             @mousemove=${(e) => this._onMove(e)}
             @mousedown=${(e) => this._onDragStart(e)}
             @mouseleave=${() => this._onLeave()} @click=${() => this._onChartClick()}
             @wheel=${(e) => this._onWheel(e)}>
          ${this._untrusted(this._svg(data))}
          ${zoomable
            ? html`<div class="hint">${this._t(
              "Scroll to zoom · drag to pan · double-click to reset",
              "滚动缩放 · 拖动平移 · 双击复位",
            )}</div>`
            : ""}
        </div>`;
    }

    /**
     * Legend rows. They are real Lit elements (not `_untrusted` markup) because
     * they carry click handlers; each one toggles its curve's highlight.
     */
    _legend() {
      const selected = this._selected;
      return html`
        <div class="legend">
          ${this._config.series.map((s, i) => html`
            <span class="li ${selected < 0 ? "" : selected === i ? "on" : "off"}"
              title=${this._t("Click to Highlight", "点击高亮该曲线")}
              @click=${(e) => { e.stopPropagation(); this._selectSeries(i); }}>
              <i class="dot" style="background:${s.color}"></i>${this._sName(s)}
            </span>`)}
        </div>`;
    }

    _svg(data) {
      const H = num(this._config.height) || DEFAULT_H;
      const W = this._width();
      const { times, layers, max, min } = data;
      /* `_build` resolves this per render from the data (unless the config
         pins it), so the axis is mirrored exactly when the series actually
         crosses zero. */
      const symmetric = data.symmetric !== false;
      const x0 = PAD_L;
      const x1 = W - PAD_R;
      const yTop = PAD_T;
      const yBot = H - PAD_B;

      // Axis limits: mirrored around zero by default, otherwise a plain
      // bottom-up range (0..100 for SOC).
      let domainMax;
      let domainMin;
      let ticks;
      if (symmetric) {
        const nice = this._config.span != null
          ? num(this._config.span)
          : niceMax(max <= 0 ? 1 : max);
        domainMax = nice;
        domainMin = -nice;
        ticks = [nice, nice / 2, 0, -nice / 2, -nice];
      } else {
        /* Bottom-up axis: pick a round *step* and derive the top from it, so
           the highest curve fills most of the height. `niceMax(max)` alone
           jumps 587 -> 1000, i.e. the data would only reach 59 % of the plot -
           the same "the card looks tiny" symptom the fixed `span` produced. */
        if (this._config.max != null) {
          domainMax = num(this._config.max);
        } else {
          const quarters = 4;
          domainMax = niceStep(Math.max(max, 1e-9) / quarters) * quarters;
        }
        domainMin = this._config.min != null ? num(this._config.min) : 0;
        if (domainMax <= domainMin) domainMax = domainMin + 1;
        ticks = [0, 1, 2, 3, 4].map((k) => domainMax - ((domainMax - domainMin) * k) / 4);
      }

      const extent = Math.max(Math.abs(domainMax), Math.abs(domainMin));
      const display = pickUnit(this._config.unit, extent);
      const div = display.divisor;
      // Label precision follows the tick spacing, otherwise a 0.5 step would
      // print as "1" next to "0".
      const tickStep = (symmetric ? domainMax / 2 : (domainMax - domainMin) / 4) / div;
      const axDecimals = decimalsFor(tickStep);
      const toY = (v) => yTop
        + ((domainMax - Math.min(Math.max(num(v), domainMin), domainMax))
          / (domainMax - domainMin)) * (yBot - yTop);
      const yZero = toY(0);
      /* Map by *timestamp* on the card's own window, not on the data.
         Statistic buckets are not evenly spaced - an offline device leaves a
         hole - so an index-based scale would stretch those gaps to look like
         continuous data.  The domain is the window (00:00 -> 24:00 for a day),
         which is what makes a day chart always start at midnight instead of at
         whatever the first bucket happened to be; a plot squeezed into the
         right quarter because the recorder's history began at 18:00 read as a
         broken axis.  `_visibleDomain()` applies the wheel zoom on top.
         Positions are deliberately *not* clamped to the plot: the drawing is
         clipped to it instead, so a zoomed-in curve leaves the frame cleanly
         rather than being pressed flat against the border. */
      const domain = this._visibleDomain();
      const tFirst = domain.first;
      const tLast = domain.last;
      const tSpan = tLast - tFirst;
      const midX = (x0 + x1) / 2;
      const toXTime = (t) => {
        if (tSpan <= 0) return midX;
        return x0 + ((num(t) - tFirst) / tSpan) * (x1 - x0);
      };
      /* A fractional bucket index (a cross-group hover can land between
         buckets) is linearly interpolated between its neighbours. */
      const toX = (i) => {
        if (times.length <= 1) return midX;
        const k = Math.min(Math.max(num(i), 0), times.length - 1);
        const lo = Math.floor(k);
        const frac = k - lo;
        const tLo = num(times[lo]);
        const t = frac > 0 && lo + 1 < times.length
          ? tLo + (num(times[lo + 1]) - tLo) * frac
          : tLo;
        return toXTime(t);
      };

      let grid = "";
      ticks.forEach((t, index) => {
        const y = toY(t).toFixed(1);
        if (t !== 0) {
          grid += `<line class="grid" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`;
        }
        const label = t / div;
        /* The unit rides on the topmost tick ("2.50 W"). It used to be a hint
           of its own in the same corner, which put it on top of this very
           label. */
        const unit = index === 0 && display.unit ? ` ${display.unit}` : "";
        grid += `<text class="axis" x="${x0 - 8}" y="${(toY(t) + 4).toFixed(1)}"
          text-anchor="end">${label.toFixed(axDecimals)}${esc(unit)}</text>`;
      });
      if (this._config.zero_line !== false && symmetric) {
        grid += `<line class="zero" x1="${x0}" y1="${yZero.toFixed(1)}" x2="${x1}" y2="${yZero.toFixed(1)}"/>`;
      }

      /* A selected series keeps full weight, the others fade into the
         background so one curve can be read on its own. */
      const sel = this._selected;
      const isBar = !!data.bars;
      const yBase = isBar ? toY(0) : 0;

      /* Bars are drawn edge to edge, from one bucket boundary to the next, so a
         bar's visual centre sits half a slot to the *right* of the bucket's own
         timestamp. Everything that points at a bucket - the guide line under
         the pointer and the date printed on the axis - belongs on that centre.
         A label under a bar's left edge reads as belonging to the bar before it,
         and a guide line on the left edge leaves the whole column to its right,
         which is what made a hover look like it was sitting one day early.
         `slotMin` is the narrowest gap between two buckets, i.e. the unit the
         axis actually ticks in (a day, a month); a day the recorder has no
         bucket for has no bar to centre on and borrows it as a nominal width. */
      let slotMin = Infinity;
      for (let i = 1; i < times.length; i += 1) {
        const d = num(times[i]) - num(times[i - 1]);
        if (d > 0 && d < slotMin) slotMin = d;
      }
      if (!Number.isFinite(slotMin)) slotMin = tSpan / 24;
      const slotByStart = new Map();
      for (let i = 0; i < times.length; i += 1) {
        slotByStart.set(num(times[i]), barSlot(times, i, slotMin));
      }
      const centreOf = (ms) => {
        const at = num(ms);
        /* A tick or a hover names an instant that may sit anywhere inside a
           bar, not necessarily on its start: a year axis steps by months and
           asks for the 1st, while a bar that began on a day boundary covers
           that instant whole. Snapping to the containing bar is what puts the
           label on the column the reading belongs to. */
        const hit = barBucketAt(times, at);
        if (hit >= 0) {
          const start = num(times[hit]);
          return (toXTime(start) + toXTime(start + slotByStart.get(start))) / 2;
        }
        /* No bar covers it - a hole in the data. Centre on the nominal column
           so the label still sits over a date rather than on the seam. */
        return toXTime(at + slotMin / 2);
      };
      /* Where the guide line is drawn: a bar's centre in the bar modes, the
         interpolated timestamp for a curve. A cross-group hover can arrive as a
         fractional index, and bars have no in-between position, so it rounds. */
      const markX = isBar
        ? (i) => centreOf(num(times[Math.min(Math.max(Math.round(num(i)), 0),
          times.length - 1)]))
        : toX;

      let areas = "";
      layers.forEach((layer, index) => {
        const color = layer.series.color;
        const isSel = sel === index;
        const dim = sel >= 0 && !isSel;
        const fillOp = sel < 0 ? 0.32 : isSel ? 0.45 : 0.07;
        const strokeW = isSel ? 2.4 : 1.5;
        const strokeOp = dim ? 0.25 : 1;
        const barOp = dim ? 0.3 : 1;

        if (isBar) {
          /* One filled rectangle per slot - per day of a month, per month of a
             year - measured from the zero line. The width comes from the gap to
             the next bucket (so an uneven month still lines up on the calendar)
             minus a gap, which is what makes a bar chart readable as a series
             of separate amounts rather than as an area. */
          for (const side of ["pos", "neg"]) {
            const band = layer[side];
            if (!band) continue;
            const { top, base } = band;
            for (let i = 0; i < times.length; i += 1) {
              const value = top[i] - base[i];
              if (Math.abs(value) < 1e-9) continue;
              const t = num(times[i]);
              const slot = barSlot(times, i, tSpan / 24);
              const left = toXTime(t);
              const right = toXTime(t + slot);
              const width = Math.max(right - left, 2);
              // 22 % of the slot becomes the gap, split evenly.
              const gap = Math.min(width * 0.22, 10);
              const yTopBar = Math.min(toY(top[i]), yBase);
              const height = Math.abs(toY(top[i]) - yBase);
              if (height < 0.4) continue;
              areas += `<rect x="${(left + gap / 2).toFixed(1)}" y="${yTopBar.toFixed(1)}"`
                + ` width="${(width - gap).toFixed(1)}" height="${height.toFixed(1)}"`
                + ` rx="2" fill="${esc(color)}" fill-opacity="${barOp}" stroke="none"/>`;
            }
          }
          return;
        }

        for (const side of ["pos", "neg"]) {
          const band = layer[side];
          if (!band) continue;
          const { top, base } = band;
          let flat = true;
          for (let i = 0; i < times.length; i += 1) {
            if (Math.abs(top[i] - base[i]) > 1e-9) { flat = false; break; }
          }
          /* A series that never leaves its base - every bucket zero, or a band
             stacked on a sibling that happened to equal it - is skipped as a
             filled *area* but never as a *line*.  Dropping it entirely made a
             channel that honestly read 0 W look exactly like one the card had
             failed to load, which is the misleading case the user reported: the
             legend still lists the series, so a missing curve reads as a broken
             chart rather than as "measured, and it was zero".  A flat series
             therefore still strokes its top edge below, which lands on the zero
             line as a thin line in the series colour. */
          /* The top edge is smoothed, the base stays straight: the base is the
             zero line or the band of the series below, and smoothing it would
             let one curve bleed into the next. `smoothPath()` is monotone, so a
             peak is rounded but never overshoots the value that was actually
             measured. */
          const topPts = times.map((_, i) => [toX(i), toY(top[i])]);
          /* Rise from the zero line instead of opening with a wall.
             The first bucket is rarely at the left edge of the window - a
             device that came online at 10:40 has nothing to draw before it -
             so the area used to begin with a vertical edge straight up to the
             first reading, which read as a fault rather than as "no data yet".
             A short anchor at the height of the base (the zero line, or the
             band below when stacked) in front of the first reading gives it
             that lead-in, without dragging the curve all the way back to the
             corner of the plot: the ramp is meant to lift the line off zero,
             it is not meant to claim "production started at midnight".
             The lead is roughly half a bucket (clamped), so it stays a slope
             rather than the vertical wall it replaces.  The anchor is only
             added when there is room for it, so a series that already touches
             the left edge is untouched.
             Only the left side gets an anchor.  The right edge needs none: a
             stretch the device did not report is already materialised as
             readings of 0 by `_filledTimes()`, so a curve that went quiet
             arrives at the axis having honestly fallen to zero rather than
             needing a decorative drop tacked onto its end. */
          const baseAt = (i) => toY(base[i]);
          if (topPts.length) {
            const slot = times.length > 1
              ? Math.abs(toX(1) - toX(0))
              : (x1 - x0) / 24;
            const lead = Math.max(10, Math.min(36, slot * 1.5));
            const firstX = topPts[0][0];
            if (firstX > x0 + 0.5) {
              topPts.unshift([Math.max(x0, firstX - lead), baseAt(0)]);
            }
          }
          const basePts = [];
          for (let i = times.length - 1; i >= 0; i -= 1) {
            basePts.push([toX(i), baseAt(i)]);
          }
          const d = `${smoothPath(topPts)}`
            + basePts.map(([bx, by]) => `L${bx.toFixed(1)} ${by.toFixed(1)}`).join("")
            + "Z";
          /* A flat series has no area to fill - the band has zero height - so
             only the edge is emitted, which is the whole point of keeping it. */
          if (!flat) {
            areas += `<path d="${d}" fill="${esc(color)}" fill-opacity="${fillOp}" stroke="none"/>`;
          }
          // the visible edge of the band
          areas += `<path d="${smoothPath(topPts)}" fill="none" stroke="${esc(color)}"`
            + ` stroke-width="${strokeW}" stroke-opacity="${strokeOp}"`
            + " stroke-linejoin=\"round\" stroke-linecap=\"round\"/>";
        }
      });

      const xLabels = this._xLabels(toXTime, H, domain, isBar ? { times, centreOf } : null);

      /* The plot is clipped to its own rectangle. Without it, a curve that
         leaves the visible window after a zoom would be drawn over the y axis
         labels and past the right edge of the card; the timestamps themselves
         are deliberately *not* clamped, because pressing them flat against the
         border would draw a vertical wall of fake readings. */
      const clipId = `${this._uid}-plot`;
      /* The reveal origin: the zero line, so the curves rise out of the axis
         they are measured from rather than out of the top of the plot.
         Percentages, not pixels: the reference box of a `transform-box:
         view-box` group is the viewBox itself, so a share of the height is
         exact whatever `preserveAspectRatio` does to the rendered size. */
      const growOrigin = `transform-origin:0 ${((yZero / H) * 100).toFixed(2)}%`;

      return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                   style="height:${H}px"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <clipPath id="${clipId}">
            <rect x="${x0}" y="${yTop}" width="${x1 - x0}" height="${yBot - yTop}"/>
          </clipPath>
        </defs>
        ${grid}
        <g class="grow" style="${growOrigin}">
        <g clip-path="url(#${clipId})">
        ${areas}
        </g>
        </g>
        ${xLabels}
        ${this._hoverLayer(data, toX, yTop, yBot, div, axDecimals, markX)}
      </svg>`;
    }

    _xLabels(toXTime, H, domain, bars) {
      const y = H - PAD_B + 18;
      const W = this._width();

      /* The ticks follow the *window*, not the data.
         They used to follow the first..last bucket, which put "00:00" nowhere
         on the axis of a day whose statistics began at 18:00 - the curve then
         filled the whole card while the labels all crowded into its right half,
         reading as a broken axis.  A day window now runs 00:00 -> 24:00 whether
         or not the recorder has a bucket at midnight, so the axis is the clock.
         The step is the smallest round candidate that keeps the label count
         under what the width can carry. */
      const first = domain.first;
      const last = domain.last;
      const spanMs = Math.max(last - first, 0);
      if (spanMs <= 0) return "";

      /* One label per ~110 px of plot, clamped to 2..8 - tied to the measured
         width so a wide card gets more ticks and a narrow one fewer. */
      const plotW = W - PAD_L - PAD_R;
      const maxLabels = Math.min(8, Math.max(2, Math.round(plotW / 110)));

      /* The bar modes bring their own ticks: a month of day bars, a year of
         month bars. They are picked by *bucket* rather than by elapsed time, so
         the labels land on real calendar days and months and every one of them
         can be drawn on its own column's centre. A round millisecond step - the
         mechanism the curve uses below - only happens to line up because a day
         is round; 61 days is not a month, and a year axis built from it labelled
         the bars "1, 3, 4, 6, 8, 10".

         The stride is chosen from the number of bars the visible window holds so
         the count stays under what the width can carry, and the last bar is
         always labelled: it is the one the eye goes to first. */
      if (bars && bars.times.length) {
        const visible = [];
        for (let i = 0; i < bars.times.length; i += 1) {
          const t = num(bars.times[i]);
          if (t >= first && t <= last) visible.push(i);
        }
        if (!visible.length) return "";
        /* A bar label is one or two characters ("7", "12"), so it needs far
           less room than the "00:00" of a curve axis: 48 px keeps a month of
           day numbers legible where 110 px would have labelled only every
           fourth day. */
        const barMax = Math.min(31, Math.max(2, Math.floor(plotW / 48)));
        const stride = Math.max(1, Math.ceil(visible.length / barMax));
        const picksBar = [];
        const lastIndex = visible[visible.length - 1];
        const pushBar = (index, slot) => {
          const t = num(bars.times[index]);
          const text = this._label(t);
          if (picksBar.some((p) => p.text === text)) return;
          picksBar.push({ ms: t, text, slot });
        };
        visible.forEach((index, k) => {
          if (k % stride === 0) pushBar(index, k);
        });
        /* `stride` rarely divides the slot count, so the last regular pick can
           land one column before the final bar and the two labels collide on
           the right edge. Drop it when it is closer than half a stride. */
        const finalSlot = visible.length - 1;
        while (picksBar.length && finalSlot - picksBar[picksBar.length - 1].slot < stride / 2) {
          picksBar.pop();
        }
        pushBar(lastIndex, finalSlot);
        return picksBar.map((p) => {
          const x = bars.centreOf(p.ms);
          const anchor = x < PAD_L + 8 ? "start" : x > W - PAD_R - 8 ? "end" : "middle";
          return `<text class="axis" x="${x.toFixed(1)}" y="${y}"
            text-anchor="${anchor}">${esc(p.text)}</text>`;
        }).join("");
      }

      /* Round steps per range, in milliseconds. A day view steps by minutes /
         hours, a month by days, a year by months. */
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      const candidates = this._range === "year"
        ? [day * 1, 30 * day, 61 * day, 92 * day]
        : this._range === "month"
          ? [day, 2 * day, 3 * day, 5 * day, 7 * day, 10 * day, 14 * day]
          : [5 * minute, 10 * minute, 15 * minute, 30 * minute,
            hour, 2 * hour, 3 * hour, 4 * hour, 6 * hour, 12 * hour];

      let step = candidates[candidates.length - 1];
      for (const c of candidates) {
        if (spanMs / c <= maxLabels - 1) { step = c; break; }
      }
      /* A zoomed-in day can need ticks finer than five minutes ("00:12"), which
         is why the sub-hour steps are divided down once the span is small. */
      if (this._range === "day" && spanMs / step <= maxLabels - 1) {
        while (step > minute && spanMs / step <= maxLabels - 1) step /= 2;
      }

      /* Align the first tick to a round boundary at that step, in the *chosen
         region's* wall clock.  For a month / year step this lands on midnight of
         the day, which is what makes "1/5" sit under a real day rather than a
         fractional one. */
      const align = (ms) => {
        const p = partsOf(ms);
        if (step >= day) {
          return startOfDay(new Date(ms)).getTime();
        }
        const stepMin = Math.max(1, Math.round(step / minute));
        const minuteOfDay = p.hour * 60 + p.minute;
        const snapped = Math.floor(minuteOfDay / stepMin) * stepMin;
        /* Rebuild the instant from the region's own wall clock, so "08:30" is
           08:30 where the device is, not where the browser is. */
        return regionDate(p.year, p.month - 1, p.day).getTime() + snapped * minute;
      };

      const seen = new Set();
      const picks = [];
      const pushAt = (ms) => {
        const label = this._label(ms);
        if (seen.has(label)) return;
        seen.add(label);
        picks.push({ ms, text: label });
      };

      /* The first tick is the window's own start (00:00 for a day, the 1st for
         a month, January for a year), then every round step up to the end. */
      pushAt(first);
      for (let t = align(first) + step; t <= last; t += step) {
        if (t - first < step * 0.5) continue;
        pushAt(t);
      }
      if (picks.length < 2) pushAt(last);

      return picks.map((p) => {
        const x = toXTime(p.ms);
        const anchor = x < PAD_L + 8 ? "start" : x > W - PAD_R - 8 ? "end" : "middle";
        return `<text class="axis" x="${x.toFixed(1)}" y="${y}"
          text-anchor="${anchor}">${esc(p.text)}</text>`;
      }).join("");
    }

    /** Axis label for a timestamp, in the resolution the range calls for. */
    _label(ms) {
      const d = partsOf(ms);
      if (this._range === "year") {
        // A month number is all that fits under a 12-month axis; the tooltip
        // carries the full date.
        return String(d.month);
      }
      if (this._range === "month") {
        /* Just the day of the month.  "11/3" under every bar repeated the
           month 31 times and squeezed the number that actually differs into
           half the width; the month is already in the toolbar's date field and
           in the tooltip, so the axis only has to say which day it is. */
        return String(d.day);
      }
      return `${pad2(d.hour)}:${pad2(d.minute)}`;
    }

    /* ------------------------------ zoom ------------------------------ */

    /**
     * The visible stretch of the window, in milliseconds.
     *
     * The plot always spans the *window* (midnight to midnight, the 1st to the
     * last of the month, January to December) and the wheel zoom narrows a
     * sub-range of it. Deriving both from the same source is what keeps the
     * guide line, the tick labels and the inverse pointer mapping in step.
     */
    _visibleDomain() {
      const { start, end } = this._window();
      /* The bar modes span their *slots*, not the calendar window. A month in
         progress only has slots up to today, and mapping those onto the whole
         month would crowd them into the left two fifths of the card; spanning
         first slot -> end of last slot spreads them across the full width and
         leaves no empty axis trailing to the right. Zoom and the pointer
         mapping both read the domain from here, so they stay in step. */
      const data = this._data;
      const isBar = !!(data && data.bars && data.times && data.times.length);
      let t0 = start.getTime();
      let t1 = end.getTime();
      if (isBar) {
        const times = data.times;
        const n = times.length;
        t0 = num(times[0]);
        t1 = t0 + 1;
        const lastStart = num(times[n - 1]);
        const lastEnd = lastStart + barSlot(times, n - 1, DAY_MS);
        if (lastEnd > t0) t1 = lastEnd;
      }
      const zoom = zoomWindow(this._zoom);
      const span = Math.max(t1 - t0, 1);
      return {
        first: t0 + span * zoom.from,
        last: t0 + span * zoom.to,
        narrow: zoom.narrow,
      };
    }

    /** Pointer position across the plot, as a 0..1 ratio, or null. */
    _pointerRatio(event) {
      const root = this.renderRoot;
      const svg = root ? root.querySelector(".chart svg") : null;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return null;
      // The svg is stretched by CSS, so map through the viewBox coordinates.
      const vbX = ((event.clientX - rect.left) / rect.width) * this._width();
      const x0 = PAD_L;
      const x1 = this._width() - PAD_R;
      if (x1 <= x0) return null;
      return Math.min(Math.max((vbX - x0) / (x1 - x0), 0), 1);
    }

    /**
     * Wheel = zoom the time axis around the instant under the pointer.
     *
     * Zooming around the centre would slide the part you were reading out of
     * frame, so the instant under the cursor is kept fixed: the new span is
     * placed so that the same time lands under the same pixel. Scrolling back
     * out past the whole window simply clears the zoom, which is what makes the
     * gesture reversible without a second control.
     */
    _onWheel(event) {
      if (!this._zoomable()) return;
      if (!this._data || !this._data.times.length) return;
      // Ctrl+wheel is the browser's page zoom; never steal it.
      if (event.ctrlKey) return;
      const ratio = this._pointerRatio(event);
      if (ratio == null) return;
      event.preventDefault();

      const current = zoomWindow(this._zoom);
      const span0 = current.to - current.from;
      const anchor = current.from + ratio * span0;
      const factor = Math.exp(num(event.deltaY) * ZOOM_WHEEL);
      const span = Math.min(Math.max(span0 * factor, ZOOM_MIN_SPAN), 1);

      if (span >= 0.999) {
        this._resetZoom();
        return;
      }
      let from = anchor - ratio * span;
      from = Math.min(Math.max(from, 0), 1 - span);
      this._zoom = { a: from, b: from + span };
      this.requestUpdate();
    }

    /**
     * Button down on the plot: a second quick one resets the zoom, otherwise it
     * starts a pan (when zoomed).
     *
     * `mousedown` is the only event that is guaranteed to arrive. The plot is
     * re-rendered as a whole whenever the hover index, the pan or the zoom
     * changes, which detaches the node the pointer went down on - and a click
     * needs the same node under the pointer for both halves of the gesture. So
     * the gesture is timed here, and this handler must not re-render either, or
     * it would break its own `mouseup`.
     */
    _onDragStart(event) {
      if (event.button !== 0) return;
      if (!this._zoomable()) return;
      const now = Date.now();
      /* A new press starts a new gesture: whatever the previous one wanted to
         swallow is no longer coming (a click needs the same node under the
         pointer for both halves, and the re-render takes that away). */
      this._dblReset = false;
      /* A pan does not produce a click (it re-renders mid-gesture), so `_dragged`
         would otherwise stay set and swallow the next real click. Consume it
         here, and do not let the release of a pan count as the first half of a
         double click. */
      const afterPan = this._dragged;
      this._dragged = false;
      const steady = Math.abs(event.clientX - this._lastDownX) <= 8
        && Math.abs(event.clientY - this._lastDownY) <= 8;
      const dbl = !afterPan && steady && now - this._lastDownAt <= DOUBLE_CLICK_MS;
      this._lastDownAt = dbl || afterPan ? 0 : now;
      this._lastDownX = event.clientX;
      this._lastDownY = event.clientY;
      if (dbl) {
        this._lastClickAt = 0;
        this._dblReset = true;
        this._resetZoom();
        return;
      }
      if (!this._zoom || !this._data) return;
      const zoom = zoomWindow(this._zoom);
      this._drag = {
        x: event.clientX,
        from: zoom.from,
        span: zoom.to - zoom.from,
        moved: false,
      };
      this._dragMove = (e) => this._onDragMove(e);
      this._dragEnd = () => this._onDragEnd();
      window.addEventListener("mousemove", this._dragMove);
      window.addEventListener("mouseup", this._dragEnd);
      /* Only the cursor changes, so paint it without going through Lit: a
         re-render here would replace the node under the pointer and eat the
         click that follows the release. */
      this._setChartState("dragging", true);
    }

    /** Toggle one class on the plot element without a re-render. */
    _setChartState(name, on) {
      const root = this.renderRoot;
      const div = root ? root.querySelector(".chart") : null;
      if (div) div.classList.toggle(name, !!on);
    }

    _onDragMove(event) {
      const drag = this._drag;
      if (!drag) return;
      const root = this.renderRoot;
      const svg = root ? root.querySelector(".chart svg") : null;
      if (!svg) return;
      const width = svg.getBoundingClientRect().width;
      if (!width) return;
      const shift = -((event.clientX - drag.x) / width) * drag.span;
      if (Math.abs(event.clientX - drag.x) > 2) drag.moved = true;
      let from = drag.from + shift;
      from = Math.min(Math.max(from, 0), 1 - drag.span);
      this._zoom = { a: from, b: from + drag.span };
      // A pan is not a hover: chasing the pointer would flash a readout for a
      // point that is sliding under the cursor at 60 fps.
      this._hover = -1;
      this.requestUpdate();
    }

    _onDragEnd() {
      if (this._dragMove) {
        window.removeEventListener("mousemove", this._dragMove);
        window.removeEventListener("mouseup", this._dragEnd);
      }
      this._dragMove = null;
      this._dragEnd = null;
      // Same reason as `_onDragStart`: no re-render, or the release produces no
      // click and the double-click reset becomes unreachable after a pan.
      this._setChartState("dragging", false);
      if (!this._drag) return;
      // Keep `moved` for one click, so releasing a pan does not also clear the
      // highlighted series.
      const moved = this._drag.moved;
      this._drag = null;
      this._dragged = moved;
    }

    _resetZoom() {
      const had = this._zoom != null;
      this._zoom = null;
      if (had) this.requestUpdate();
    }

    /**
     * Can the time axis be zoomed right now?
     *
     * Not in the bar modes: those plot one bar per day (or per month) of a
     * window that is already the calendar, so there is nothing to zoom *into* -
     * narrowing a month of 30 bars shows four of them bigger, which loses the
     * comparison the chart was opened for.  A day curve stays zoomable, because
     * that is where "what happened between 13:00 and 14:00" is a real question.
     * The answer is derived per render from the data, so switching the range
     * selector turns the gesture on and off with it.
     */
    _zoomable() {
      return !(this._data && this._data.bars);
    }

    /* --------------------------- the reveal --------------------------- */

    /**
     * Play a freshly loaded window out of the zero line.
     *
     * A chart that appears fully drawn reads as a picture; one that rises from
     * zero reads as a measurement that just arrived, which is what the number
     * on the axis actually is.  `requestAnimationFrame` on the class flip is
     * what makes the browser interpolate instead of jumping: the same frame
     * that inserts `.grow.start` must not also remove it, or the transition has
     * no starting value to animate from.
     */
    _playGrow() {
      if (!this._pendingGrow) return;
      this._pendingGrow = false;
      const root = this.renderRoot;
      const group = root ? root.querySelector(".chart svg .grow") : null;
      if (!group) return;
      /* Flatten it *without* a transition first, otherwise the class that is
         about to be removed again would animate the chart downwards before it
         grows.  Only once the flat state is committed is the transition turned
         back on, and that is what the second frame is for. */
      group.style.transition = "none";
      group.classList.add("start");
      void group.getBoundingClientRect();
      requestAnimationFrame(() => {
        group.style.transition = "";
        requestAnimationFrame(() => { group.classList.remove("start"); });
      });
    }


    /**
     * A click clears the highlight.
     *
     * The zoom reset is handled on `mousedown` (see `_onDragStart`); this keeps
     * a matching fallback for the clicks that do survive to the browser, so a
     * fast pair still resets if the button-down path somehow missed it. Both
     * paths are idempotent: resetting an unzoomed chart does nothing.
     */
    _onChartClick() {
      if (this._dragged) {
        this._dragged = false;
        return;
      }
      if (this._dblReset) {
        this._dblReset = false;
        return;
      }
      const now = Date.now();
      const previous = this._lastClickAt;
      this._lastClickAt = now;
      if (previous && now - previous <= DOUBLE_CLICK_MS) {
        this._lastClickAt = 0;
        this._resetZoom();
        return;
      }
      this._selectSeries(-1);
    }

    /** Pointer left the plot: drop the readout and end a stuck pan. */
    _onLeave() {
      if (this._drag) this._onDragEnd();
      /* Two presses separated by the pointer leaving the plot are not a double
         click, however close together they were. */
      this._lastDownAt = 0;
      this._setHover(-1);
    }

    /** The energy produced across the whole window, for the bar modes. */
    _totalLabel(data) {
      const totals = data && data.totals;
      if (!totals || !totals.length) return "";
      const display = pickUnit(this._config.unit, Math.max(Math.abs(totals[0]), 1e-9));
      const value = totals[0] / display.divisor;
      const unit = this._config.unit || display.unit || "";
      const shown = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
      return `${this._t("Total", "合计")}: ${shown} ${unit}`.trim();
    }

    _hoverLayer(data, toX, yTop, yBot, div, axDecimals, markX) {
      const W = this._width();
      // A hover can come from this card (bucket index) or from another card in
      // the group (timestamp, which may sit on a different bucket grid), so the
      // index is resolved to a fractional position instead of being assumed.
      const pos = this._hoverPosition(data);
      if (pos == null) return "";
      const i = Math.min(Math.max(pos, 0), data.times.length - 1);
      // In the bar modes the guide line belongs on the centre of the column, not
      // on the boundary where the bucket happens to start.
      const x = markX ? markX(i) : toX(i);
      /* The tooltip stamp is the one place a reader compares this card against
         the device's own app, so it is formatted in the region too. */
      const when = partsOf(data.times[i]);
      const stamp = this._range === "day"
        ? `${pad2(when.hour)}:${pad2(when.minute)}`
        : this._range === "month"
          ? `${when.month}/${when.day}`
          : `${when.year}-${pad2(when.month)}-${pad2(when.day)}`;

      const display = pickUnit(this._config.unit, data.max);
      const dec = Math.min((axDecimals || 0) + 1, 2);
      const rows = data.values.map((vals, k) => ({
        color: this._config.series[k].color,
        name: this._sName(this._config.series[k]),
        value: vals[i],
        faded: this._selected >= 0 && this._selected !== k,
      }));

      const lineH = 17;
      const boxW = 210;
      const boxH = 22 + rows.length * lineH;
      const boxX = x + 12 + boxW > W - PAD_R ? x - 12 - boxW : x + 12;
      const boxY = Math.min(yTop + 4, yBot - boxH);

      let box = `<rect class="tipbox" x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}"
          width="${boxW}" height="${boxH}" rx="8"/>`;
      box += `<text class="tiptext" x="${(boxX + 10).toFixed(1)}" y="${(boxY + 15).toFixed(1)}"
        style="font-weight:600">${esc(stamp)}</text>`;
      rows.forEach((row, k) => {
        const y = boxY + 15 + (k + 1) * lineH;
        const v = row.value / div;
        const text = v.toFixed(dec);
        // Keep the faded rows in the tooltip (the numbers stay comparable) but
        // send them to the back visually.
        const groupOp = row.faded ? " opacity=\"0.4\"" : "";
        box += `<g${groupOp}>`;
        box += `<circle cx="${(boxX + 14).toFixed(1)}" cy="${(y - 4).toFixed(1)}" r="4"
            fill="${esc(row.color)}"/>`;
        box += `<text class="tiptext" x="${(boxX + 26).toFixed(1)}" y="${y.toFixed(1)}">${esc(
          String(row.name).slice(0, 12),
        )}</text>`;
        box += `<text class="tiptext" x="${(boxX + boxW - 10).toFixed(1)}" y="${y.toFixed(1)}"
            text-anchor="end" style="font-weight:600">${text}${esc(display.unit ? ` ${display.unit}` : "")}</text>`;
        box += "</g>";
      });

      return `<line class="guide" x1="${x.toFixed(1)}" y1="${yTop}" x2="${x.toFixed(1)}"
        y2="${yBot}"/>${box}`;
    }

    /* ---------------------------- interaction ---------------------------- */

    /**
     * Where the guide line belongs, as a bucket index, or null when nothing is
     * hovered.
     *
     * A remote hover is matched by timestamp with a binary search: statistic
     * buckets are *not* evenly spaced (a device that was offline leaves a hole
     * in the series), so an index cannot be derived from a linear scale.
     */
    _hoverPosition(data) {
      const times = data.times;
      const n = times.length;
      if (!n) return null;
      /* A hole is not a reading.  The curve falls to 0 across an outage so the
         outage is *visible*, but letting the guide line settle on one of those
         buckets would print "0 W at 10:45" for an instant the device never
         measured - a number that looks as trustworthy as any other on the
         card.  The pointer simply has nothing to say there. */
      const hole = (index) => !!(data.holes && data.holes[index]);
      if (this._remoteTime == null) {
        if (this._hover < 0 || this._hover >= n) return null;
        if (hole(this._hover)) return null;
        return this._hover;
      }

      const target = num(this._remoteTime);
      const first = num(times[0]);
      const last = num(times[n - 1]);
      const gap = n > 1 ? (last - first) / (n - 1) : Math.max(last - first, 1);
      // Only reject a hover that belongs to a different window (e.g. the group
      // has moved on). Inside the range the nearest bucket is used, unless the
      // hovered instant falls on a bucket this card has no reading for.
      if (target < first - gap || target > last + gap) return null;

      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (num(times[mid]) < target) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0
        && Math.abs(num(times[lo - 1]) - target) <= Math.abs(num(times[lo]) - target)) {
        lo -= 1;
      }
      return hole(lo) ? null : lo;
    }

    /** Select a series by legend index; `-1` clears the highlight. */
    _selectSeries(index) {
      this._selected = this._selected === index ? -1 : index;
      this.requestUpdate();
    }

    /**
     * Track the pointer. `index` is this card's bucket; `-1` clears.
     *
     * The hover is broadcast as a timestamp, so the other cards in the group
     * can place their own guide line even if their buckets are coarser.
     */
    _setHover(index, publish = true) {
      const changed = this._hover !== index || this._remoteTime != null;
      this._remoteTime = null;
      this._hover = index;
      if (changed) this.requestUpdate();
      if (publish) this._pushHover(index);
    }

    _onMove(event) {
      if (this._drag) return;
      const data = this._data;
      if (!data || data.times.length < 2) return;
      const ratio = this._pointerRatio(event);
      if (ratio == null) return;
      /* `toX` is timestamp-based, so invert it the same way: the pointer picks
         an instant inside the *visible* window, and the nearest bucket to that
         instant is hovered. Using an index ratio here would land on the wrong
         point wherever the series has a gap, and would ignore the zoom. */
      const domain = this._visibleDomain();
      const target = domain.first + (domain.last - domain.first) * ratio;
      /* In the bar modes a column owns every pixel between its two edges, and
         the guide line is drawn on the column's centre. Picking the *nearest
         timestamp* would put the cursor over the right half of a bar and report
         the next day, because a bar's centre is half a slot away from its own
         start. `barBucketAt()` asks which rectangle is actually under the
         pointer, which is what the eye is reading. */
      if (data.bars) {
        const hit = barBucketAt(data.times, target);
        if (hit >= 0) {
          this._setHover(hit);
          return;
        }
      }
      let index = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < data.times.length; i += 1) {
        const diff = Math.abs(num(data.times[i]) - target);
        if (diff < bestDiff) { bestDiff = diff; index = i; }
      }
      /* The pointer is over a bucket the device never reported.  There is no
         reading to name, and snapping to the nearest *real* bucket instead
         would park the guide line on a moment the pointer is not at - so the
         card says nothing at all, and the group's guide line is cleared with
         it.  That is the difference between "0 W" and "no data": the curve
         falls to 0 so the outage is visible, but a tooltip would dress that 0
         up as a measurement. */
      if (data.holes && data.holes[index]) {
        this._setHover(-1);
        return;
      }
      this._setHover(index);
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
  class HoymilesHistoryChartEditor extends LitElement {
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
        ha-textfield, ha-select { display: block; width: 100%; margin-bottom: 8px; }
        .hint { font-size: 12px; color: var(--secondary-text-color); padding: 0 10px 8px; }
        .sw { display: flex; align-items: center; gap: 10px; padding: 6px 0;
              font-size: 14px; color: var(--primary-text-color); }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="language (auto|en|zh, auto follows Home Assistant)"
            .value=${config.language || ""} @change=${this._changed("language")}></ha-textfield>
          <ha-textfield label="range (day|month|year)" .value=${config.range || "day"}
            @change=${this._changed("range")}></ha-textfield>
          <ha-textfield label="unit (W|%)" .value=${config.unit || ""}
            @change=${this._changed("unit")}></ha-textfield>
          <ha-textfield label="height (px)" .value=${config.height || ""}
            @change=${this._changed("height")}></ha-textfield>
          <ha-textfield label="sync_group" .value=${config.sync_group || ""}
            @change=${this._changed("sync_group")}></ha-textfield>
          <label class="sw">
            <span>symmetric axis</span>
            <select .value=${this._triValue(config.symmetric)}
              @change=${this._tri("symmetric")}>
              <option value="auto">auto (mirrored only when the data crosses 0)</option>
              <option value="on">on (always mirrored)</option>
              <option value="off">off (bottom-up, for SOC / temperature)</option>
            </select>
          </label>
          <label class="sw">
            <span>stack the curves</span>
            <select .value=${this._triValue(config.stack)}
              @change=${this._tri("stack")}>
              <option value="auto">auto (follow the axis type)</option>
              <option value="on">on (additive series, e.g. per-pack charge)</option>
              <option value="off">off (independent readings, e.g. PV / grid / load)</option>
            </select>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.show_toolbar !== false}
              @change=${this._toggle("show_toolbar")}></ha-switch>
            <span>show_toolbar (this card's own time controls)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.show_totals === true}
              @change=${this._toggle("show_totals")}></ha-switch>
            <span>show_totals (month / year / lifetime energy tiles)</span>
          </label>
          <label class="sw">
            <span>mode</span>
            <select .value=${config.mode || "auto"}
              @change=${this._changed("mode")}>
              <option value="auto">auto (bars for month / year energy, curve for a day)</option>
              <option value="bar">bar (one bar per day / month)</option>
              <option value="line">line (always a curve)</option>
            </select>
          </label>
        </div>
        <div class="hint">
          ${"Curves are configured with the `series` list (entity / name / color) in the YAML editor."}
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-g2-history-chart-editor")) {
    customElements.define("hoymiles-g2-history-chart-editor", HoymilesHistoryChartEditor);
  }
  if (!customElements.get("hoymiles-g2-history-chart")) {
    customElements.define("hoymiles-g2-history-chart", HoymilesHistoryChart);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-history-chart")) {
    window.customCards.push({
      type: "hoymiles-g2-history-chart",
      name: "Hoymiles History Chart",
      description:
        "Power / SOC history with a day-month-year selector and date navigator, "
        + "built from Home Assistant long term statistics.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmHistoryRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmHistoryRegister());
}
