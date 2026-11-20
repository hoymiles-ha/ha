/* ============================================================================
 * Hoymiles G2 — optional chart switches
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-chart-options`
 *
 * The Device view of a micro inverter draws a fixed set of curves.  A few more
 * readings exist (`grid_on_current`, `grid_on_frequency`, ...) and each of them
 * can be shown as a chart card of its own - but the only way to choose used to
 * be *Settings -> Devices & Services -> Hoymiles -> Configure*, which is a
 * long way round for a switch that belongs on the page it changes.
 *
 * This card is that switch, and nothing else: five rows, one per opt-in chart.
 * It never draws a curve itself.  The curves stay ordinary history chart cards
 * in the very same dashboard document, because that is what the backend already
 * does (and what keeps a card's ``since`` - the instant it was enabled - next
 * to the card it belongs to).  One switch therefore changes the stored
 * dashboard.
 *
 * Why the user refreshes, not the card: the panel normally picks a dashboard
 * write up by itself (a Lovelace panel rebuilds once the stored config
 * changes), but not on every Home Assistant release, and never while the user
 * is mid-form.  An automatic ``location.reload()`` would also interrupt anyone
 * still working through the five rows.  So the card writes, says it saved, and
 * offers a refresh button - the reload happens when, and only when, the user
 * asks for it.  A page that updates by itself simply never needs the button.
 *
 * Why the page position is pinned: that same rebuild throws the whole view
 * away and builds it again, and the rebuilt page starts at the top - ticking a
 * row near the bottom of the device view therefore jumped the user away from
 * the switches they were working through.  On top of that, the written chart
 * card is inserted *above* this one, so the switches themselves slid down the
 * page by a card-height on every tick even though the scroll offset never
 * moved.  ``_holdScroll()`` therefore pins this card's own document offset,
 * and falls back to the scroll offset when the rebuild resets that: it puts
 * the card back wherever the user was looking at it, for a few seconds only,
 * and lets go the moment the user scrolls somewhere themselves.  It lives
 * outside the element because the rebuild replaces this very card.
 *
 * Toggles are written once the user stops clicking (a short debounce), so
 * enabling three charts in a row costs one write instead of three.  ``since``
 * - the instant a curve starts - is stamped by the backend at that write, i.e.
 * when the row was ticked, *not* when the page is refreshed.
 *
 * Card config:
 *   type: custom:hoymiles-g2-chart-options
 *   dev_id: RMI-4161A0209FF6          # required
 *   title: 更多数据                    # optional, accepts an en/zh map
 * ========================================================================== */

function _hmChartOptionsRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* The shared language module (`hoymiles-g2-i18n.js`) is injected before this
   * file, so `window.HoymilesG2I18n` is already there.  The fallback only
   * matters if that asset failed to load. */
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
    pick(current, en, zh) {
      return current === "zh" ? zh : en;
    },
    watch: () => {},
    unwatch: () => {},
  };

  const hmLang = (hass, config) => I18N.lang(hass, config);
  const hmText = (value, lang) => I18N.text(value, lang);

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /* Must stay in step with `lovelace.OPTIONAL_CHARTS`: the keys are the ones
   * the backend accepts, the labels and units are only what the row prints. */
  const CHARTS = [
    { key: "grid_current", unit: "A", color: "#f59e0b",
      en: "Grid Current", zh: "电网电流" },
    { key: "grid_frequency", unit: "Hz", color: "#8b5cf6",
      en: "Grid Frequency", zh: "电网频率" },
    { key: "active_power", unit: "W", color: "#22c55e",
      en: "Active Power", zh: "有功功率" },
    { key: "reactive_power", unit: "var", color: "#06b6d4",
      en: "Reactive Power", zh: "无功功率" },
    { key: "rssi", unit: "dBm", color: "#94a3b8",
      en: "Signal Strength", zh: "信号强度" },
  ];

  /* How long the card waits for the user to stop clicking before it writes the
   * dashboard.  Without it, ticking three rows would reload the page three
   * times. */
  const APPLY_DELAY_MS = 800;

  /* How long a dashboard rebuild may take to settle before the page is left
   * alone again.  Long enough for the write + refetch + rebuild to finish on a
   * Pi 4, short enough that a user who scrolls away immediately is not fought
   * with for the rest of the session. */
  const SCROLL_HOLD_MS = 5000;

  /* Module scope on purpose: the rebuild replaces the <hoymiles-g2-chart-options>
   * element itself, so anything remembered on `this` is gone by the time the
   * new scroll position needs correcting. */
  let _scrollHold = null;

  /* The switch card, looked up across shadow roots and cached.  A Lovelace view
   * nests view -> section -> card inside shadow DOM, so a plain querySelector
   * only ever sees the outermost layer. */
  let _selfEl = null;

  function _scrollRoot() {
    return document.scrollingElement || document.documentElement;
  }

  function _scrollTop() {
    const el = _scrollRoot();
    return el ? el.scrollTop : 0;
  }

  function _scrollTo(y) {
    const el = _scrollRoot();
    if (el) el.scrollTop = y;
    try {
      window.scrollTo(0, y);
    } catch (err) {
      /* Older engines without a usable window.scrollTo: scrollTop was enough. */
    }
  }

  function _cardEl() {
    if (_selfEl && _selfEl.isConnected) return _selfEl;
    _selfEl = null;
    const stack = [document];
    let guard = 0;
    while (stack.length && guard < 8192) {
      const node = stack.pop();
      guard += 1;
      const kids = node.children || [];
      for (let i = 0; i < kids.length; i += 1) {
        const child = kids[i];
        if (String(child.tagName || "").toLowerCase() === "hoymiles-g2-chart-options") {
          _selfEl = child;
          return child;
        }
        stack.push(child);
        if (child.shadowRoot) stack.push(child.shadowRoot);
      }
    }
    return null;
  }

  /**
   * Where this card sits in the *document*, independent of how far the page is
   * scrolled.  This is the number that actually moves when a chart card is
   * inserted above the switches - the scroll offset does not, which is why
   * holding the offset alone left the card drifting down the page.
   */
  function _cardTop() {
    const el = _cardEl();
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    return el.getBoundingClientRect().top + _scrollTop();
  }

  function _releaseScroll() {
    if (_scrollHold && _scrollHold.raf) cancelAnimationFrame(_scrollHold.raf);
    _scrollHold = null;
  }

  /**
   * Keep this card where the user left it while the dashboard rebuilds.
   *
   * Called just before a write.  What must not move is the card's *viewport*
   * offset (``top - scrollTop``): that is the number the eye reads.  A rebuild
   * can disturb it two different ways, and they need different answers:
   *
   *   - the card's document offset changes, because the write inserts a chart
   *     card *above* the switches.  Here the scroll offset must move by exactly
   *     that much, so the correction is absolute - ``scrollTop = newTop -
   *     off0`` - and not an increment.  Measuring the *change* in the document
   *     offset and adding it to the *current* scroll offset double-counted the
   *     browser's own scroll tweak (the switches still slid ~220 px, which is
   *     precisely one card-height).
   *   - the scroll offset collapses to the top of the page, which is what a
   *     rebuilt Lovelace view does.  There the document offset is still valid,
   *     so the remembered scroll offset is restored as-is.
   *
   * Anything else - the offset moving on its own - is the user scrolling, and
   * is adopted rather than undone, so this never fights somebody reading the
   * page and lets go the moment the hold window expires.
   */
  function _holdScroll() {
    _releaseScroll();
    const y = _scrollTop();
    const top = _cardTop();
    if (y <= 0 && top == null) return;
    const hold = {
      off: top == null ? null : top - y,
      top,
      seenY: y,
      until: Date.now() + SCROLL_HOLD_MS,
      raf: 0,
    };
    _scrollHold = hold;
    const tick = () => {
      if (_scrollHold !== hold) return;
      if (Date.now() > hold.until) {
        _releaseScroll();
        return;
      }
      const nowY = _scrollTop();
      const nowTop = _cardTop();
      if (nowTop != null && hold.top != null) {
        if (Math.abs(nowTop - hold.top) > 2) {
          /* A card appeared above: re-anchor absolutely, so whatever the
             rebuild did to the scroll offset is irrelevant. */
          _scrollTo(nowTop - hold.off);
        } else if (nowY <= 1 && hold.seenY > 2) {
          _scrollTo(hold.seenY);             /* the rebuild reset it */
        } else if (Math.abs((nowTop - nowY) - hold.off) > 2) {
          hold.off = nowTop - nowY;          /* the user moved: follow */
          hold.seenY = nowY;
        } else {
          hold.seenY = nowY;
        }
        hold.top = _cardTop();
      } else {
        hold.seenY = nowY;
      }
      hold.raf = requestAnimationFrame(tick);
    };
    hold.raf = requestAnimationFrame(tick);
  }

  class HoymilesChartOptions extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _state: { type: Object },
        _draft: { type: Object },
        _busy: { type: Boolean },
        _applying: { type: Boolean },
        _saved: { type: Boolean },
        _error: { type: String },
      };
    }

    constructor() {
      super();
      this._config = null;
      this._hass = null;
      /* `{key: since}` for the charts that are currently on the dashboard, and
       * the same shape for what the user has ticked but not yet saved.  `null`
       * means "not read yet", which is what disables the switches: showing five
       * unticked rows before the answer arrives would invite a click that
       * wipes a selection the page has not shown yet. */
      this._state = null;
      this._draft = null;
      this._busy = false;
      this._applying = false;
      /* Something was written and this page has not been reloaded yet, so what
       * the page shows and what the dashboard now holds differ.  Drives the
       * "saved, refresh to see it" note - and never a reload of our own. */
      this._saved = false;
      this._error = "";
      this._loaded = false;
      this._loading = false;
      this._timer = null;
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; height: 100%; box-sizing: border-box; }
        .head { display: flex; align-items: center; gap: 8px;
                color: var(--primary-text-color); margin-bottom: 8px; }
        .name { font-size: 15px; font-weight: 500; line-height: 1.3; }
        /* The choices are pills, not switch rows: one line of chips takes a
         * third of the height a stacked list of five rows needed, and the
         * on/off state reads from the chip itself (bold + coloured outline). */
        .chips { display: flex; flex-wrap: wrap; gap: 8px 10px; }
        .li { display: inline-flex; align-items: center; gap: 7px;
              font-size: 12.5px; color: var(--primary-text-color);
              cursor: pointer; border-radius: 999px; padding: 4px 13px 4px 5px;
              background: var(--secondary-background-color, rgba(127,127,127,0.12));
              transition: opacity .15s, background .15s, box-shadow .15s;
              user-select: none; appearance: none; border: 0;
              font-family: inherit; line-height: 1.35; text-align: left; }
        .li:hover { box-shadow: inset 0 0 0 1px var(--divider-color); }
        .li.off { opacity: 0.38; }
        .li.on { font-weight: 600;
                 box-shadow: inset 0 0 0 1px var(--primary-color); }
        .li:disabled { cursor: default; }
        .li:disabled:not(.on) { opacity: 0.28; }
        .dot { width: 17px; height: 17px; border-radius: 50%; flex: 0 0 auto;
               box-sizing: border-box;
               border: 2px solid var(--card-background-color, #fff); }
        .unit { font-size: 11px; color: var(--secondary-text-color);
                margin-left: 1px; font-variant-numeric: tabular-nums; }
        .err { font-size: 12.5px; color: var(--error-color, #db4437);
               margin-top: 8px; overflow-wrap: anywhere; }
        .note { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px;
                font-size: 12.5px; color: var(--secondary-text-color);
                margin-top: 8px; }
        .link { appearance: none; border: 0; background: none; padding: 0;
                font: inherit; color: var(--primary-color); cursor: pointer;
                text-decoration: underline; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-g2-chart-options: 'dev_id' is required");
      }
      this._config = { ...config };
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._loaded && !this._loading) this._load();
      this.requestUpdate();
    }

    connectedCallback() {
      super.connectedCallback();
      I18N.watch(this);
    }

    disconnectedCallback() {
      I18N.unwatch(this);
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      super.disconnectedCallback();
    }

    getCardSize() {
      /* Title plus one or two rows of chips - the toggles no longer stack, so
       * the card is roughly half the height it used to claim. */
      return 2;
    }

    _dev() {
      return String((this._config && this._config.dev_id) || "");
    }

    _t(en, zh) {
      return I18N.pick(hmLang(this._hass, this._config), en, zh);
    }

    /** Call a `SupportsResponse` service and return its `response` payload. */
    async _call(service, data) {
      const hass = this._hass;
      if (!hass || typeof hass.callService !== "function") return null;
      const result = await hass.callService(
        "hoymiles",
        service,
        data,
        undefined,
        false,
        true
      );
      if (result && result.response) return result.response;
      return result || null;
    }

    async _load() {
      const dev = this._dev();
      if (!this._hass || !dev) return;
      this._loading = true;
      try {
        const answer = await this._call("get_optional_charts", { dev_id: dev });
        const charts = (answer && answer.charts) || {};
        this._state = { ...charts };
        this._draft = { ...charts };
        this._error = "";
      } catch (err) {
        this._error = String((err && err.message) || err || "");
        this._state = null;
        this._draft = null;
      } finally {
        this._loading = false;
        this._loaded = true;
        this.requestUpdate();
      }
    }

    _on(key) {
      return !!(this._draft && Object.prototype.hasOwnProperty.call(this._draft, key));
    }

    _toggle(key, on) {
      if (!this._draft || this._busy) return;
      if (on) {
        if (!Object.prototype.hasOwnProperty.call(this._draft, key)) {
          this._draft[key] = "";
        }
      } else {
        delete this._draft[key];
      }
      this._error = "";
      this.requestUpdate();
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        this._apply();
      }, APPLY_DELAY_MS);
    }

    /**
     * Write the ticked set to the dashboard.
     *
     * Every key is sent explicitly, `false` included: the backend reads an
     * omitted key as "unchanged", so a partial payload would silently keep a
     * chart the user just switched off.
     *
     * The page is *not* reloaded here.  The backend stamps ``since`` on a new
     * curve at this very moment - ticking a row is what starts the recording,
     * not the refresh that follows - so the write is complete before the user
     * reloads, and a reload later only makes the cards appear.  Doing it
     * automatically would interrupt anyone still working through the five rows.
     *
     * The scroll position is captured *before* the write because the rebuild
     * that follows is what resets it; ``_holdScroll()`` then restores it.
     */
    async _apply() {
      const dev = this._dev();
      if (!this._draft || !dev || this._busy) return;

      const wanted = {};
      for (const item of CHARTS) {
        wanted[item.key] = Object.prototype.hasOwnProperty.call(this._draft, item.key);
      }

      _holdScroll();
      this._busy = true;
      this._applying = true;
      this.requestUpdate();
      try {
        const answer = await this._call("set_optional_charts", {
          dev_id: dev,
          charts: wanted,
        });
        const applied = (answer && answer.charts) || {};
        this._state = { ...applied };
        this._draft = { ...applied };
        this._busy = false;
        this._applying = false;
        this._saved = true;
        this._error = "";
        this.requestUpdate();
      } catch (err) {
        this._busy = false;
        this._applying = false;
        this._error = String((err && err.message) || err || "");
        this.requestUpdate();
      }
    }

    _refresh() {
      try {
        window.location.reload();
      } catch (err) {
        this._error = String((err && err.message) || err || "");
        this.requestUpdate();
      }
    }

    render() {
      if (!this._config) return html``;
      const title = hmText(this._config.title, hmLang(this._hass, this._config))
        || this._t("More Data", "更多数据");

      const ready = this._draft != null;

      /* A chip is ticked when its key is present.  Clicking a ticked chip again
       * clears it, which is exactly what `_toggle(key, false)` already does. */
      const chips = CHARTS.map((item) => {
        const on = this._on(item.key);
        return html`
          <button
            class="li ${on ? "on" : "off"}"
            ?disabled=${!ready || this._busy}
            aria-pressed=${on ? "true" : "false"}
            @click=${() => this._toggle(item.key, !on)}>
            <span class="dot" style="background:${item.color}"></span>
            <span>${hmText({ en: item.en, zh: item.zh }, hmLang(this._hass, this._config))}</span>
            <span class="unit">${esc(item.unit)}</span>
          </button>`;
      });

      return html`
        <ha-card>
          <div class="head"><div class="name">${esc(title)}</div></div>
          <div class="chips">${chips}</div>
          ${this._applying
            ? html`<div class="note">${this._t("Applying…", "正在应用…")}</div>`
            : this._saved
              ? html`<div class="note">
                  <span>${this._t(
                    "Saved. If this page has not caught up yet, refresh it.",
                    "已保存。若本页未随之更新，请刷新页面。"
                  )}</span>
                  <button class="link" @click=${() => this._refresh()}>
                    ${this._t("Refresh now", "立即刷新")}
                  </button>
                </div>`
              : ""}
          ${this._error
            ? html`<div class="err">${esc(this._error)}</div>`
            : ""}
        </ha-card>
      `;
    }
  }

  customElements.define("hoymiles-g2-chart-options", HoymilesChartOptions);

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-chart-options")) {
    window.customCards.push({
      type: "hoymiles-g2-chart-options",
      name: "Hoymiles Optional Data",
      description: "Switch the opt-in device data cards on and off from the device page itself.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmChartOptionsRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmChartOptionsRegister());
}
