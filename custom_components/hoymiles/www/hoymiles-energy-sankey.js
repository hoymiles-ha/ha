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
 *   language: zh                  # optional (en|zh)
 *   range: today                  # optional (today|7d|30d|month)
 *   balancer_label: Loss          # optional label for the residual node
 *   show_toolbar: true            # optional
 *   statistics:                   # optional statistic_id overrides
 *     pv: sensor.my_pv_energy
 *     grid_in: [sensor.a, sensor.b]
 * ========================================================================== */

function _hmSankeyRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Layout constants — the SVG uses a fixed viewBox and is scaled by CSS,
   * so the diagram stays valid on any card width.
   * ------------------------------------------------------------------ */
  const VB_W = 900;
  const VB_H = 420;
  const PAD_TOP = 28;
  const PAD_BOTTOM = 12;
  const LABEL_W = 150;
  const NODE_W = 16;
  const GAP = 10;
  const SRC_X = LABEL_W;
  const HUB_X = Math.round(VB_W / 2 - NODE_W / 2);
  const SNK_X = VB_W - LABEL_W - NODE_W;
  const CHART_H = VB_H - PAD_TOP - PAD_BOTTOM;

  /* ------------------------------------------------------------------ *
   * Node model
   * ------------------------------------------------------------------ */
  const HUB = { id: "hub", en: "Inverter", zh: "逆变器", color: "#6B7280" };

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

  function fmtEnergy(kwh) {
    const v = num(kwh);
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} MWh`;
    if (Math.abs(v) >= 100) return `${v.toFixed(0)} kWh`;
    if (Math.abs(v) >= 10) return `${v.toFixed(1)} kWh`;
    return `${v.toFixed(2)} kWh`;
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
    }

    static getConfigElement() {
      return document.createElement("hoymiles-energy-sankey-editor");
    }

    static getStubConfig() {
      return { dev_id: "", language: "zh", range: DEFAULT_RANGE };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; }
        .head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
                justify-content: space-between; }
        .title { font-size: 15px; font-weight: 500; color: var(--primary-text-color); }
        .total { font-size: 12px; color: var(--secondary-text-color); }
        .toolbar { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 4px; }
        .pill { padding: 3px 10px; border: 1px solid var(--divider-color); border-radius: 999px;
                cursor: pointer; font-size: 12px; color: var(--secondary-text-color);
                background: none; }
        .pill.on { background: var(--primary-color); border-color: var(--primary-color);
                   color: var(--text-primary-color, #fff); }
        svg { display: block; width: 100%; height: auto; }
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
      } else {
        this.requestUpdate();
      }
    }

    getCardSize() { return 6; }

    /* --------------------------- text / config --------------------------- */

    _t(en, zh) { return this._config && this._config.language === "zh" ? zh : en; }
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
          label: cfg.balancer_label || this._label(SYNTH.loss),
        };
        snks.push(balancer);
      } else if (balance < -THRESHOLD) {
        balancer = {
          ...SYNTH.unmeasured,
          value: -balance,
          label: cfg.balancer_label || this._label(SYNTH.unmeasured),
        };
        srcs.push(balancer);
      }

      const total = srcs.reduce((acc, d) => acc + d.value, 0);
      if (total <= 0) {
        return { empty: true, window };
      }

      // Shared scale so source and sink heights line up with the hub.
      const maxNodes = Math.max(srcs.length, snks.length);
      const gaps = Math.max(0, maxNodes - 1) * GAP;
      const usable = Math.max(20, CHART_H - gaps);
      const scale = usable / total;

      const stack = (items) => {
        let y = PAD_TOP;
        return items.map((item) => {
          const h = Math.max(2, item.value * scale);
          const node = { ...item, y, h };
          y += h + GAP;
          return node;
        });
      };

      const srcNodes = stack(srcs);
      const snkNodes = stack(snks);

      // Ribbons: sources -> hub, stacked in node order.
      const srcRibbons = [];
      let srcCursor = PAD_TOP;
      for (const node of srcNodes) {
        srcRibbons.push({
          path: ribbon(SRC_X + NODE_W, node.y, node.h, HUB_X, srcCursor, node.h),
          color: node.color,
          value: node.value,
          label: node.label || this._label(node),
        });
        srcCursor += node.h + GAP;
      }

      const snkRibbons = [];
      let snkCursor = PAD_TOP;
      for (const node of snkNodes) {
        snkRibbons.push({
          path: ribbon(HUB_X + NODE_W, snkCursor, node.h, SNK_X, node.y, node.h),
          color: node.color,
          value: node.value,
          label: node.label || this._label(node),
        });
        snkCursor += node.h + GAP;
      }

      return {
        empty: false,
        window,
        total,
        scale,
        srcs: srcNodes,
        snks: snkNodes,
        srcRibbons,
        snkRibbons,
        hub: { ...HUB, y: PAD_TOP, h: usable, label: this._label(HUB) },
        hasBalancer: !!balancer,
      };
    }

    /* ------------------------------ rendering ---------------------------- */

    _nodeLabel(node, anchorX, anchor) {
      if (node.h < 16) return "";
      const value = fmtEnergy(node.value);
      const text = `${node.label || this._label(node)}  ·  ${value}`;
      const y = node.y + node.h / 2 + 4;
      return `<text x="${anchorX}" y="${y}" text-anchor="${anchor}" font-size="12.5"
        fill="var(--primary-text-color, #212121)">${esc(text)}</text>`;
    }

    _chart(graph) {
      const parts = [];

      for (const r of graph.srcRibbons) {
        parts.push(`<path d="${r.path}" fill="${r.color}" fill-opacity="0.28"></path>`);
      }
      for (const r of graph.snkRibbons) {
        parts.push(`<path d="${r.path}" fill="${r.color}" fill-opacity="0.28"></path>`);
      }

      const rect = (node, x) => {
        const title = `${node.label || this._label(node)}: ${fmtEnergy(node.value)}`;
        return `<rect x="${x}" y="${node.y}" width="${NODE_W}" height="${node.h}"
          rx="3" fill="${node.color}"><title>${esc(title)}</title></rect>`;
      };

      for (const node of graph.srcs) parts.push(rect(node, SRC_X));
      for (const node of graph.snks) parts.push(rect(node, SNK_X));
      parts.push(rect(graph.hub, HUB_X));

      for (const node of graph.srcs) {
        parts.push(this._nodeLabel(node, SRC_X - 8, "end"));
      }
      for (const node of graph.snks) {
        parts.push(this._nodeLabel(node, SNK_X + NODE_W + 8, "start"));
      }

      const hubY = graph.hub.y + graph.hub.h / 2 - 6;
      parts.push(`<text x="${HUB_X + NODE_W / 2}" y="${hubY}" text-anchor="middle"
        font-size="12.5" fill="var(--secondary-text-color, #727272)">${esc(graph.hub.label)}</text>`);
      parts.push(`<text x="${HUB_X + NODE_W / 2}" y="${hubY + 15}" text-anchor="middle"
        font-size="12" fill="var(--secondary-text-color, #727272)">${esc(fmtEnergy(graph.total))}</text>`);

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" role="img"
        aria-label="${esc(this._t("Energy flow", "能量流"))}">${parts.join("")}</svg>`;
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
      if (this._config.show_toolbar === false) return "";
      const pills = RANGES.map((r) => `
        <button class="pill ${r.id === this._range ? "on" : ""}"
          data-range="${r.id}">${esc(this._t(r.en, r.zh))}</button>`).join("");
      const refresh = `<button class="pill" data-range="__refresh">${esc(this._t("Refresh", "刷新"))}</button>`;
      return `<div class="toolbar">${pills}${refresh}</div>`;
    }

    _handleClick = (event) => {
      const target = event.target.closest("[data-range]");
      if (!target) return;
      const value = target.dataset.range;
      if (value === "__refresh") {
        this._fetch();
        return;
      }
      if (value === this._range) return;
      this._range = value;
      this._graph = null;
      this._fetch();
    };

    render() {
      if (!this._config) return html``;
      const title = this._config.title || this._t("Energy flow", "能量流");

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
        <ha-card>
          <div class="head">
            <span class="title">${title}</span>
            ${this._graph && !this._graph.empty
              ? html`<span class="total">${esc(fmtEnergy(this._graph.total))}</span>`
              : ""}
          </div>
          ${this._toolbar()}
          ${body}
          ${notes.length
            ? html`<div class="note">${notes.map((n) => html`${n}<br/>`)}</div>`
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
          <ha-textfield label="title" .value=${config.title || ""}
            @change=${this._valueChanged("title")}></ha-textfield>
          <ha-textfield label="language (en|zh)" .value=${config.language || "zh"}
            @change=${this._valueChanged("language")}></ha-textfield>
          <ha-textfield label="range (${ranges.join("|")})" .value=${config.range || DEFAULT_RANGE}
            @change=${this._valueChanged("range")}></ha-textfield>
          <ha-textfield label="balancer_label" .value=${config.balancer_label || ""}
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
