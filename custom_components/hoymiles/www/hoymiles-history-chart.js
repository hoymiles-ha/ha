/* ============================================================================
 * Hoymiles Micro Storage — History chart card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-history-chart`
 *
 * A power / SOC chart with a 日 / 月 / 年 selector and a date navigator, drawn
 * like the vendor app's history pages:
 *
 *   - every series is filled from the zero line, positive values stacking up
 *     and negative values stacking down, so a charge/discharge sensor reads
 *     naturally on both sides of the axis;
 *   - the y axis is symmetric around 0 and auto-scales (W is promoted to kW
 *     once the range exceeds 1.5 kW, Wh to kWh ...);
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
 *   type: custom:hoymiles-history-chart
 *   dev_id: MSA-280520260806        # optional when every series names an entity
 *   title: 历史数据
 *   language: zh                    # optional (en|zh)
 *   range: day                      # initial range (day|month|year)
 *   height: 330                     # optional svg height in px
 *   unit: W                         # optional unit label (auto-promotes to kW)
 *   zero_line: true                 # optional, draw the 0 line (default true)
 *   symmetric: true                 # optional; false draws a bottom-up axis
 *                                   # (use it for SOC: min 0 / max 100)
 *   min / max: 0 / 100              # optional fixed axis limits
 *   span: 2500                      # optional fixed half-range when symmetric
 *   sync_group: living-room         # optional; cards sharing a group share
 *                                   # their time window (range + date)
 *   show_toolbar: false             # optional; hide this card's own toolbar
 *                                   # (use it on the followers)
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

  /* ------------------------------------------------------------------ *
   * Layout / behaviour constants
   * ------------------------------------------------------------------ */
  const VB_W = 1200;
  const DEFAULT_H = 330;

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

  /** Pick a unit + divisor so the axis stays readable (W -> kW). */
  function pickUnit(unit, maxValue) {
    if (!unit) return { unit: "", divisor: 1, decimals: 1 };
    const abs = Math.abs(maxValue);
    const prefixes = [
      { scale: 1000, gap: 1500 },
      { scale: 1, gap: 0 },
    ];
    for (const p of prefixes) {
      if (abs >= p.gap) {
        return { unit, divisor: p.scale, decimals: p.scale === 1 ? 0 : 1 };
      }
    }
    return { unit, divisor: 1, decimals: 1 };
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
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
      this._token = 0;
      this._syncJoined = null;
    }

    connectedCallback() {
      super.connectedCallback();
      this._joinSync();
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      this._leaveSync();
    }

    static getConfigElement() {
      return document.createElement("hoymiles-history-chart-editor");
    }

    static getStubConfig() {
      return { title: "历史数据", language: "zh", range: "day", series: [] };
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
        .chart { margin-top: 8px; }
        .chart svg { display: block; width: 100%; }
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
        throw new Error("hoymiles-history-chart: 'series' must list at least one entity");
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

    getCardSize() {
      return 7;
    }

    _t(en, zh) {
      return this._config && this._config.language === "zh" ? zh : en;
    }

    /* --------------------------- time windows --------------------------- */

    _window() {
      const a = this._anchor;
      if (this._range === "month") {
        return {
          start: startOfDay(new Date(a.getFullYear(), a.getMonth(), 1)),
          end: endOfDay(new Date(a.getFullYear(), a.getMonth() + 1, 0)),
        };
      }
      if (this._range === "year") {
        return {
          start: startOfDay(new Date(a.getFullYear(), 0, 1)),
          end: endOfDay(new Date(a.getFullYear(), 11, 31)),
        };
      }
      return { start: startOfDay(a), end: endOfDay(a) };
    }

    /** Statistics granularity: finer for short windows, coarser for long ones. */
    _periods() {
      if (this._range === "month") return ["hour"];
      if (this._range === "year") return ["day"];
      // A day is best rendered from 5 minute statistics, but those are only
      // retained for `purge_keep_days` (10 days by default), so fall back to
      // hourly buckets when the finer query came back empty.
      return ["5minute", "hour"];
    }

    _shiftRange(step) {
      const a = new Date(this._anchor);
      if (this._range === "month") a.setMonth(a.getMonth() + step);
      else if (this._range === "year") a.setFullYear(a.getFullYear() + step);
      else a.setDate(a.getDate() + step);
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
        if (Number.isFinite(year)) a = new Date(year, 0, 1);
      } else if (this._range === "month" && /^\d{4}-\d{2}$/.test(value)) {
        const [y, m] = value.split("-").map(Number);
        a = new Date(y, m - 1, 1);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [y, m, d] = value.split("-").map(Number);
        a = new Date(y, m - 1, d);
      }
      if (!a || Number.isNaN(a.getTime())) return;
      this._anchor = a;
      this._reload();
    }

    /** Drop the cached data and refetch, then tell the group about the window. */
    _reload() {
      this._data = null;
      this._hover = -1;
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
      const same = this._range === state.range
        && this._anchor.getTime() === state.anchor;
      if (same) return;
      this._range = state.range;
      this._anchor = new Date(state.anchor);
      this._data = null;
      this._hover = -1;
      this._remoteTime = null;
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
      const a = this._anchor;
      if (this._range === "year") return String(a.getFullYear());
      if (this._range === "month") return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}`;
      return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())}`;
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
            types: ["mean"],
          });
          if (token !== this._token) return; // a newer request won
          period = candidate;
          rows = result;
          const first = rows && rows[ids[0]];
          if (Array.isArray(first) && first.length > 6) break;
        }

        this._data = this._build(rows || {}, period);
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

    /** Align every series on one time grid and compute the stacked layers. */
    _build(result, period) {
      const series = this._config.series;
      const timeSet = new Set();
      const bySeries = series.map((s) => {
        const map = new Map();
        for (const row of (result[s.entity] || [])) {
          const t = num(row.start);
          map.set(t, row.mean == null ? null : num(row.mean));
          timeSet.add(t);
        }
        return map;
      });

      const times = [...timeSet].sort((a, b) => a - b);
      if (!times.length) return { times, period, layers: [], max: 1, min: 0 };

      // Forward fill so a series that started later still has a value.
      const values = bySeries.map((map) => {
        let last = 0;
        return times.map((t) => {
          const v = map.get(t);
          if (v != null) last = v;
          return last;
        });
      });

      const symmetric = this._config.symmetric !== false;
      const empty = () => times.map(() => 0);
      const add = (acc, other) => acc.map((v, k) => v + other[k]);

      let max = 0;
      let min = 0;
      let layers = [];

      if (symmetric) {
        // Two independent stacks: positive parts grow upwards, negative parts
        // grow downwards, which keeps a charge/discharge sensor readable on
        // both sides of the zero line.
        const pos = [];
        const neg = [];
        let runPos = empty();
        let runNeg = empty();
        values.forEach((vals) => {
          const p = vals.map((v) => (v > 0 ? v : 0));
          const n = vals.map((v) => (v < 0 ? v : 0));
          pos.push(p);
          neg.push(n);
          runPos = add(runPos, p);
          runNeg = add(runNeg, n);
        });
        runPos.forEach((v) => { if (v > max) max = v; });
        runNeg.forEach((v) => { if (-v > max) max = -v; });

        layers = this._config.series.map((s, i) => ({
          series: s,
          pos: {
            base: pos.slice(0, i).reduce(add, empty()),
            top: pos.slice(0, i + 1).reduce(add, empty()),
          },
          neg: {
            base: neg.slice(0, i).reduce(add, empty()),
            top: neg.slice(0, i + 1).reduce(add, empty()),
          },
        }));
      } else {
        // One cumulative stack rising from the baseline (SOC ...).
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
        layers = this._config.series.map((s, i) => ({
          series: s,
          pos: { base: cums[i * 2], top: cums[i * 2 + 1] },
          neg: null,
        }));
      }

      return { times, period, layers, max, min, values };
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const title = this._config.title === false ? ""
        : (this._config.title || this._t("History", "历史数据"));

      // The toolbar sits first so it lands in the card's top left corner.
      return html`
        <ha-card>
          <div class="head">
            ${this._config.show_toolbar === false ? "" : this._toolbar()}
            ${title === "" ? "" : html`<div class="title">${title}</div>`}
          </div>
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
      return html`
        <div class="chart" @mousemove=${(e) => this._onMove(e)}
             @mouseleave=${() => this._setHover(-1)} @click=${() => this._selectSeries(-1)}>
          ${this._untrusted(this._svg(data))}
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
              title=${this._t("Click to highlight", "点击高亮该曲线")}
              @click=${(e) => { e.stopPropagation(); this._selectSeries(i); }}>
              <i class="dot" style="background:${s.color}"></i>${s.name || s.entity}
            </span>`)}
        </div>`;
    }

    _svg(data) {
      const H = num(this._config.height) || DEFAULT_H;
      const { times, layers, max, min } = data;
      const symmetric = this._config.symmetric !== false;
      const x0 = PAD_L;
      const x1 = VB_W - PAD_R;
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
        domainMax = this._config.max != null
          ? num(this._config.max)
          : niceMax(Math.max(max, 1e-9));
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
      const toX = (i) => (times.length === 1
        ? (x0 + x1) / 2
        : x0 + (x1 - x0) * (i / (times.length - 1)));

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

      // areas + top strokes. A selected series keeps full weight, the others
      // fade into the background so one curve can be read on its own.
      const sel = this._selected;
      let areas = "";
      layers.forEach((layer, index) => {
        const color = layer.series.color;
        const isSel = sel === index;
        const dim = sel >= 0 && !isSel;
        const fillOp = sel < 0 ? 0.32 : isSel ? 0.45 : 0.07;
        const strokeW = isSel ? 2.4 : 1.5;
        const strokeOp = dim ? 0.25 : 1;
        for (const side of ["pos", "neg"]) {
          const band = layer[side];
          if (!band) continue;
          const { top, base } = band;
          let flat = true;
          for (let i = 0; i < times.length; i += 1) {
            if (Math.abs(top[i] - base[i]) > 1e-9) { flat = false; break; }
          }
          if (flat) continue;
          let d = "";
          for (let i = 0; i < times.length; i += 1) {
            d += `${i ? "L" : "M"}${toX(i).toFixed(1)} ${toY(top[i]).toFixed(1)}`;
          }
          for (let i = times.length - 1; i >= 0; i -= 1) {
            d += `L${toX(i).toFixed(1)} ${toY(base[i]).toFixed(1)}`;
          }
          d += "Z";
          areas += `<path d="${d}" fill="${esc(color)}" fill-opacity="${fillOp}" stroke="none"/>`;
          // the visible edge of the band
          let edge = "";
          for (let i = 0; i < times.length; i += 1) {
            edge += `${i ? "L" : "M"}${toX(i).toFixed(1)} ${toY(top[i]).toFixed(1)}`;
          }
          areas += `<path d="${edge}" fill="none" stroke="${esc(color)}"`
            + ` stroke-width="${strokeW}" stroke-opacity="${strokeOp}"`
            + " stroke-linejoin=\"round\" stroke-linecap=\"round\"/>";
        }
      });

      const xLabels = this._xLabels(times, toX, H);

      return `<svg viewBox="0 0 ${VB_W} ${H}" preserveAspectRatio="none"
                   style="height:${H}px"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        ${grid}
        ${areas}
        ${xLabels}
        ${this._hoverLayer(data, toX, yTop, yBot, div, axDecimals)}
      </svg>`;
    }

    _xLabels(times, toX, H) {
      const y = H - PAD_B + 18;
      const picks = [];
      const seen = new Set();

      if (this._range === "day") {
        const want = new Set([0, 3, 6, 9, 12, 15, 18, 21, 23]);
        times.forEach((t, i) => {
          const d = new Date(num(t));
          const h = d.getHours();
          if (!want.has(h) || seen.has(h) || d.getMinutes() > 6) return;
          seen.add(h);
          picks.push({ i, text: `${pad2(h)}:00` });
        });
      } else if (this._range === "month") {
        times.forEach((t, i) => {
          const d = new Date(num(t));
          const day = d.getDate();
          if (d.getHours() !== 0 || seen.has(day)) return;
          if (day !== 1 && day % 5 !== 0) return;
          seen.add(day);
          picks.push({ i, text: String(day) });
        });
      } else {
        times.forEach((t, i) => {
          const m = new Date(num(t)).getMonth();
          if (seen.has(m)) return;
          seen.add(m);
          picks.push({ i, text: String(m + 1) });
        });
      }

      return picks.map((p) => {
        const x = toX(p.i);
        const anchor = x < PAD_L + 8 ? "start" : x > VB_W - PAD_R - 8 ? "end" : "middle";
        return `<text class="axis" x="${x.toFixed(1)}" y="${y}"
          text-anchor="${anchor}">${esc(p.text)}</text>`;
      }).join("");
    }

    _hoverLayer(data, toX, yTop, yBot, div, axDecimals) {
      // A hover can come from this card (bucket index) or from another card in
      // the group (timestamp, which may sit on a different bucket grid), so the
      // index is resolved to a fractional position instead of being assumed.
      const pos = this._hoverPosition(data);
      if (pos == null) return "";
      const i = Math.min(Math.max(pos, 0), data.times.length - 1);
      const x = toX(i);
      const when = new Date(num(data.times[i]));
      const stamp = this._range === "day"
        ? `${pad2(when.getHours())}:${pad2(when.getMinutes())}`
        : this._range === "month"
          ? `${when.getMonth() + 1}/${when.getDate()}`
          : `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;

      const display = pickUnit(this._config.unit, data.max);
      const dec = Math.min((axDecimals || 0) + 1, 2);
      const rows = data.values.map((vals, k) => ({
        color: this._config.series[k].color,
        name: this._config.series[k].name || this._config.series[k].entity,
        value: vals[i],
        faded: this._selected >= 0 && this._selected !== k,
      }));

      const lineH = 17;
      const boxW = 210;
      const boxH = 22 + rows.length * lineH;
      const boxX = x + 12 + boxW > VB_W - PAD_R ? x - 12 - boxW : x + 12;
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
      if (this._remoteTime == null) {
        if (this._hover < 0 || this._hover >= n) return null;
        return this._hover;
      }

      const target = num(this._remoteTime);
      const first = num(times[0]);
      const last = num(times[n - 1]);
      const gap = n > 1 ? (last - first) / (n - 1) : Math.max(last - first, 1);
      // Only reject a hover that belongs to a different window (e.g. the group
      // has moved on). Inside the range the nearest bucket is always used, even
      // when the hovered instant falls in one of this card's data gaps.
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
        return lo - 1;
      }
      return lo;
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
      const data = this._data;
      if (!data || data.times.length < 2) return;
      const svg = event.currentTarget.querySelector("svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      // The svg is stretched by CSS, so map through the viewBox coordinates.
      const vbX = ((event.clientX - rect.left) / rect.width) * VB_W;
      const ratio = (vbX - PAD_L) / (VB_W - PAD_R - PAD_L);
      const index = Math.round(Math.min(Math.max(ratio, 0), 1) * (data.times.length - 1));
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
          <ha-textfield label="title" .value=${config.title || ""}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="language (en|zh)" .value=${config.language || "zh"}
            @change=${this._changed("language")}></ha-textfield>
          <ha-textfield label="range (day|month|year)" .value=${config.range || "day"}
            @change=${this._changed("range")}></ha-textfield>
          <ha-textfield label="unit (W|%)" .value=${config.unit || ""}
            @change=${this._changed("unit")}></ha-textfield>
          <ha-textfield label="height (px)" .value=${config.height || ""}
            @change=${this._changed("height")}></ha-textfield>
          <ha-textfield label="sync_group" .value=${config.sync_group || ""}
            @change=${this._changed("sync_group")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_toolbar !== false}
              @change=${this._toggle("show_toolbar")}></ha-switch>
            <span>show_toolbar (本卡自己的时间控件)</span>
          </label>
        </div>
        <div class="hint">
          ${"Curves are configured with the `series` list (entity / name / color) in the YAML editor."}
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-history-chart-editor")) {
    customElements.define("hoymiles-history-chart-editor", HoymilesHistoryChartEditor);
  }
  if (!customElements.get("hoymiles-history-chart")) {
    customElements.define("hoymiles-history-chart", HoymilesHistoryChart);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-history-chart")) {
    window.customCards.push({
      type: "hoymiles-history-chart",
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
