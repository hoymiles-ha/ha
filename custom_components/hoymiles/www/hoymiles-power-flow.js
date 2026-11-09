/* ============================================================================
 * Hoymiles Micro Storage — Power flow card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-power-flow`
 *
 * Draws the system as a **wiring diagram**, the way the vendor app does on its
 * system screen: one ringed icon per branch, the inverter in a rounded square
 * in the middle, and thick rounded connectors with a light pulse running along
 * them that shows the direction of the power.
 *
 *   ⬜ PV1 ──┐                  ┌── ⬜ PV2
 *           ├── ▣ inverter ─── ● ── ⬜ grid
 *   ⬜ storage ┘                └── ⬜ load / ⬜ smart plug
 *
 * A ring is only tinted while that branch actually carries power (|P| >= 5 W),
 * so the picture answers "where is the energy going" at a glance; idle
 * branches stay grey.  A branch whose entity does not exist (a slave unit has
 * no system level values) is left out entirely, together with its connector.
 *
 * Sign conventions, all from the 1 s `quick/state` payload:
 *   sys_grid_p  > 0  drawing from the grid, < 0 feeding back
 *   sys_pv_p / sys_pv2_p / sys_load_p / sys_sp_p > 0 consuming or producing
 *   battery     < 0  charging (the firmware treats power into the unit as -)
 *
 * Everything is hand-rolled SVG (no chart library, no CDN), so the card keeps
 * working offline on a Raspberry Pi.
 *
 * Data sources (plain entity states, no recorder required):
 *   system_pv_power (sys_pv_p)             PV1 production           [W]
 *   system_pv2_power (sys_pv2_p)           PV2 production           [W]
 *   system_battery_power                   battery, negative=charge [W]
 *   system_soc                             battery state of charge  [%]
 *   system_grid_power (sys_grid_p)         grid, + = importing      [W]
 *   system_load_power (sys_load_p)         load / lamp              [W]
 *   system_smart_plug_power (sys_sp_p)     smart plug               [W]
 *   battery_status                         standby|charge|discharge|lock
 *   rssi                                   Wi-Fi RSSI, dBm -> signal bars
 *
 * Card config:
 *   type: custom:hoymiles-power-flow
 *   dev_id: MSA-280520260806      # required
 *   title: My home                # optional, defaults to the device id
 *   show_title: true              # optional, false hides the title + device id
 *   language: en                  # optional (en|zh|de); omit to follow Home Assistant
 *   temperature_entity: sensor.x  # optional, shown next to the title
 *   gradient: true                # optional white backdrop (default true)
 *   max_width: 620                # optional px, the drawing stays centered
 *   flow_speed: 1                 # optional multiplier for the flow pulse;
 *                                 # 0.5 = half speed (calmer), 2 = faster
 *   entities:                     # optional entity id overrides, keyed by the
 *                                 # suffix the card looks up
 *     system_pv_power: sensor.my_pv_power
 *     system_pv2_power: sensor.my_pv2_power
 *     system_battery_power: sensor.my_battery_power
 *     system_grid_power: sensor.my_grid_power
 *     system_load_power: sensor.my_load_power
 *     system_smart_plug_power: sensor.my_smart_plug_power
 *     soc: sensor.my_soc
 *     battery_status: sensor.my_battery_status
 *     rssi: sensor.my_rssi
 *   show_rssi: true               # optional, hide the fan with false
 *   grid_mode: auto               # auto | meter | no_meter, see below
 * ========================================================================== */

function _hmPowerFlowRegister() {
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
    "My home": "Mein Zuhause",
    "excellent": "sehr gut",
    "good": "gut",
    "fair": "mäßig",
    "weak": "schwach",
    "Wi-Fi signal": "WLAN-Signal",
    "Solar1": "Solar1",
    "Solar2": "Solar2",
    "Storage": "Speicher",
    "Charging": "Laden",
    "Discharging": "Entladen",
    "Standby": "Bereitschaft",
    "Smart plug": "Smarte Steckdose",
    "Idle": "Leerlauf",
    "Grid in": "Netzbezug",
    "Grid out": "Netzeinspeisung",
    "Grid": "Netz",
    "Grid & load": "Netz & Last",
    "Other loads": "Sonstige Lasten",
    "Load": "Last",
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
   *     en: History
   *     zh: 历史数据
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
   * Drawing constants. The SVG uses a fixed viewBox and is scaled by CSS,
   * so the illustration stays valid at any card width.
   * ------------------------------------------------------------------ */
  const VB_W = 700;
  const VB_H = 470;
  const MIN_FLOW = 5; // W; below this a branch is drawn as idle
  /* How far the load has to read *below* zero before `grid_mode: auto`
     accepts it as proof that there is no meter.  A metered system keeps the
     load at or above zero, so this only has to clear rounding and sensor
     noise rather than any real reading. */
  const METER_PROOF_W = 30; // W

  /* How fast the streak travels along a connector, in SVG units per second.
     The travel time is derived from the connector length, so a short stub and a
     long line no longer look like different animals.

     Use the card's `flow_speed` option to nudge the whole thing (1 = default). */
  const FLOW_SPEED_MIN = 55; // units per second at ~0 W
  const FLOW_SPEED_MAX = 230; // units per second at full power
  const FLOW_SPEED_PER_W = 0.25; // units/s gained per watt, saturates near 700 W
  const FLOW_DUR_MIN = 0.9; // s, keeps the very short stubs readable
  const FLOW_DUR_MAX = 4.5; // s

  /* ------------------------------------------------------------------ *
   * The streak
   *
   * A connector that carries power gets **one** streak of light travelling from
   * one end of it to the other, like a signal being sent down the wire.  The
   * connector itself is not recoloured - it keeps the plain grey of
   * `.pf-edge`; only the streak is lit.
   *
   * The streak is a **single dash**, not a repeating pattern: the dash is
   * `STREAK` units long and the gap after it is several times the connector, so
   * only one can be on the line at a time.  A repeating pattern put two or three
   * of them on a long connector, which reads as decoration rather than as
   * something being sent.
   *
   * It is drawn as a run of **slices**, each a short dash with its own colour
   * and opacity, and that is what makes the fade.  The first slice is white and
   * opaque, the last is the branch colour at almost nothing, and the slices in
   * between are interpolated: a smooth comet instead of a bar.  The earlier
   * version stacked four strokes of different length on top of each other, which
   * is why the tail came out as visible steps and the widest stroke read as an
   * empty frame around the bright part - a gradient cannot be made out of a
   * handful of nested outlines.
   *
   * A real `<linearGradient>` was the other option and is wrong here: a gradient
   * is painted in a straight line, so on an L shaped connector the colour would
   * run diagonally across the pipe instead of along it.
   *
   * Slice `i` sits `i * slice` further back than the head, so
   * `dashoffset = length - head` becomes `offset_i = offset_head + i * slice`,
   * and every slice is animated by the same keyframes - the run moves as one
   * piece.
   *
   * The motion is a plain CSS animation of `stroke-dashoffset`, with the three
   * end points handed to the keyframes as CSS variables because they depend on
   * the connector's length.  That also fixes the freeze: the old dots were moved
   * by a requestAnimationFrame loop, and a card that had been detached and
   * re-attached (switching dashboard tabs does) is not re-rendered, so nothing
   * ever restarted the loop.  A CSS animation simply keeps running.
   *
   * The same negative `animation-delay` mechanism puts a rebuilt path back where
   * it was, so a re-render (about once a second, as the readings change) does
   * not restart the streak at the beginning.
   */
  const STREAK_SHARE = 0.34; // streak length, as a fraction of the connector
  const STREAK_MIN = 34; // units; below this a short stub barely reads
  const STREAK_MAX = 120; // units; a long connector must not carry a bar
  /* How many slices a streak is cut into.  More slices, smoother fade - and a
     bigger DOM (14 paths per lit connector).  At card size one slice is about
     2 px wide, so the steps are already invisible; going higher only costs. */
  const STREAK_SLICES = 14;
  /* Share of the cycle spent travelling.  The rest is the pause after the
     streak has left, and it **must match the keyframe percentages** below. */
  const STREAK_TRAVEL = 0.72;
  /* Width at the head and at the tail, in user units.  The grey pipe is 6.8, so
     the streak sits just inside it. */
  const STREAK_WIDTH = 6;
  const STREAK_TIP = 3.6;

  /* A rounded corner is flattened into this many straight segments - fine
     enough that the flattening is invisible at the card's size. */
  const CURVE_STEPS = 12;

  const COLORS = {
    pv: "#f5a623",
    pv6: "#f5a623",
    sp: "#0ea5e9",
    battery: "#22c55e",
    battery_idle: "#9aa3ae",
    charge: "#22c55e",
    discharge: "#f59e0b",
    lock: "#ef4444",
    grid: "#4a90d9",
    grid_out: "#f59e0b",
    load: "#8b95a5",
  };

  /* ------------------------------------------------------------------ *
   * The schematic
   *
   * The vendor app draws the system as a wiring diagram rather than as a
   * house: one ringed icon per node, the inverter in a rounded square in the
   * middle, and thick rounded connectors.  A ring is only coloured while that
   * branch actually carries power, so the picture shows at a glance where the
   * energy is going; everything else stays grey.
   * ------------------------------------------------------------------ */
  const NODE_R = 34;
  /* The node artwork is an opaque square: its ring fills the 68x68 box, and
     everything outside the ring but inside the box is white.  That white
     corner is invisible on the white backdrop, but it also *paints over* the
     connectors drawn before it - which is why the two diagonal branches (the
     only ones whose line starts inside the box, not exactly on its edge) came
     out cut short and square-ended instead of touching their ring.

     Clipping the artwork to a circle of the ring's own radius keeps the white
     corners from ever covering a connector, so a line that starts on the ring
     is visible right up to it, whatever direction it leaves in.  35 is just
     past the ink (measured 34.8..35.0 at 10x) so nothing of the ring is cut. */
  const NODE_CLIP_R = 35;
  const NODE_CLIP_ID = "hm-pf-ring-clip";
  const NODE_ROW_TOP = 108;
  const NODE_ROW_BOT = 356;
  const NODE_COL_L = 104;
  const NODE_COL_M = 468;
  const NODE_COL_R = 600;
  const INV = { x: 322, y: 232, s: 78 };        // unit in the middle: centre + size
  /* The unit's artwork is a square with its own padding, drawn a little bigger
     than a node so it reads as the centre of the diagram. */
  const INV_ICON = 96;
  const JUNCTION = { x: NODE_COL_R, y: 232 };   // where the right branches meet
  /* The two diagonal branches, as explicit endpoints: the arrow heads used to
     be placed by interpolating between them, so the two had to be kept in
     step - the arrows are gone now and the endpoints are simply the ends of
     the connector.

     Both start *on* the ring (34 units from the node centre, like the straight
     branches start on the edge of their artwork), so the line reaches the
     ring instead of stopping in mid air next to it - the lamp end used to sit
     45.6 units out, which left a visible gap at the node. */
  const PV2_A = { x: 492.8, y: 131.3 };
  const PV2_B = { x: JUNCTION.x, y: JUNCTION.y - 6 };
  const LAMP_A = { x: 498.7, y: 341.4 };
  const LAMP_B = { x: JUNCTION.x, y: JUNCTION.y + 6 };
  const PV2_ROUTE = `M${PV2_A.x} ${PV2_A.y} L${PV2_B.x} ${PV2_B.y}`;
  const LAMP_ROUTE = `M${LAMP_A.x} ${LAMP_A.y} L${LAMP_B.x} ${LAMP_B.y}`;

  /* Node artwork, baked straight out of the vendor app's icon set (see
     _preview/bake-icons.py).  Every branch has two variants: the coloured one
     while it carries power, and a dim grey one when it does not - that is the
     "no data" look the app uses, so an idle branch reads as idle even before
     you look at the number.  Regenerate with:

       python _preview/bake-icons.py <iconDir> _preview/pf-icons-data.js
       node    _preview/apply-icons.cjs

     The table is big because the artwork is embedded as data URIs: no extra
     file to serve, no extra route to register, one deployment. */
  /* <<<PF_ICONS>>> */
  /* GENERATED by _preview/bake-icons.py - do not edit by hand.
   *
   * The node artwork of the vendor app's system screen, cropped, scaled to
   * 96px and palette-quantised.  `on` is the coloured icon shown while the
   * branch carries power, `off` the dim grey one for an idle branch.
   */
  const PF_ICON_SIZE = 96;
  const PF_ICONS = {
    "grid.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////79/////v395Mn7oULJJJV9AAAF5ElEQVR42q1YXU8bRxQ9M7MuaYvLLDZNU5TGbhNBSBavWfchD5Ewgdc2RORfEsFrmxKcIEWVGpcF56WKKU7SCtM19qROBBJZTx/W+zX+SqTui73juT73njn3zp0hiD/MsFHQOQBAtg5qzLDjE0j81ToQhSwAKUA4gOYWWSgPMUidaEWOVsubU+A6ZKOU3x1oYJULWbQaNsgCgAMBVtTR3LLKAwyYW8jK5iNmdg4FADKZcW2tyJtbpt3XgBlaVlZt60CEvy6U2RJvlpICfR5Tu78GZiqsmVi5v8giA2HAr+7J9VSiFjeQx+bT6ZR2qd5jwN4tj1XPT856gOv5Xy99/cisqzGYiYyz46Kvr89XO5uugsCcW4Pm43j+yVyadyFod9AoysdG//mQlXGRrsQRmJNvcBuDLM5r130IrQsw1RnkEAC4Zu3KThSBOfnqxfpgAzhHfhSaD1AZAhCFYB8EEIHQAMBIjAAAXLP2zY6PQKazjYnhAIBTnxs7PfMMrP2Zn45GzIecZ2l25BlcvPF2JADg1OZKEqAAY7xdGzkfHYPMm5409qUtRhtIKa54ajWnzkVcFVaXmfgoI3c3XGggjP+p/Fm5v08LZP5QaKB7WTu+CLzgfTYQg5CumMjYGvi375Xq1ta9z3GFigr94Q0oLnMlYuZnIdtT4yb7oMzmOz2JIFutVguEKvK4SQxo0KRKD0WjBGCFmypZgpsaiHQVelb8YBVeYX8/LYiZ+DxchWUAgI4WABDeAgC8D5aVkR83NfDzMNouPdCjH7Idray01ifmgUkxTjq0HcbsTvRISgJoJIPXjMhp0Xp/sr2KzoPEXacEALgv19k9yMcyqgKNyE7o4U3B6eI7MKtLIpaAai50uZaY1uCGA7KCJZ5O4MQGAE75MocTzfa2PU3NqN+usQ3CZUXXdV1nNnTInVgBlUwLWQWAvZzgIPfCgaoiTKJBxOuuu8KjiayUHwnKEROxa21Hf487hA6IBpvHxn4veMIAAJ2YSvK50EDiq5XjaPhur3A3niySQwPtKZIVK1Azz8RjzsSyobuW0i8CjGZ65CSUpAKpAMFWnYPeI0zVgBLIsucSS9pgbJQBCOhy2QKQct+u9pG4apA0AX2tzLh1oq32tFN9DDIcAFlz2+XCKgAYvNdn9dkGyJpRyAJyE1whilN04mvAZWMDINeygFyXUABqoJA8XvUkG98QANBct9TqRwQoTDXT57PvvS+sI9Xqx0AFMnFW23LfU/jU7V1DqBRJGvcyaeKkssSBpgCm7tggcZoIqFBZfb7EAWfroQAm75RUmiRV0oGjyCFf7OTzD1vA5KKqA5fGeCAVgENWK8burvXLIcCh1+IeUxnlgRIAsloxbKBsPTsEwN7EPBZKPhBArrOkDQBl6xmyUBJM0CTpRFsQyPWU39aWU882FPnxPTbLLvOgbzBTF6rTB0Erepq61ubaWfDOnNk/KJS1eR2tEyevEedVglbsVJiGL7mM24vd6MK6edegkCTsjtuQHVXtEdpNLkBdGQvLzcWVGJcfL4HCELcjglX3IEOEvLPnktkM559+Kbo0yc5nT5VOq/4qETRrlM58UgeYtsbCdePoLSNBCCuLJig6E8T0p0mrZ1tkE8E3xts1MGCGaRd8R3p7RRksGz2eLZ2CAc7LhcfyA3bp3A1trA4K4AvC+ej5hPHXXqMrZ1j6wug2lB3Plo68ysdKwXFiyGMU35vdVrpuTqb5KAjm5F8enHnNunS7jfhQgETHdv3jgFOf074aDsH+ueU19JqXaOK7zVEA0jvzML8RHw4RAHSPNCMhAgD/WObU5oYRxRwfwN+B3JsivWcOnJ8sSr/RY8Fx4vrUbxNnA1SkhWceFpxY2tPpF3LA4bXY+flIPR47f01PJpx+FvnK0tiDXF3dRd3UI3LVZT2yJfndJV7N2//DER/H8//qcwnbOg1DJ9bfzjJvPjHqg68pGqXYNcXV7OBrio+/CAmuWuSWZ6+Pumr5+Msc9bpoCz3XRf8B8pNv8B4ffsAAAAAASUVORK5CYII=",
    "grid.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///+/v7l6u+2xdOzHpTEAAAFuUlEQVR42q1YzW8TRxT/zcxaUChinA++QqgtR2qbZpNxNjlwaBUcci0BJX9lI8KlhyoYrFoqEmA6ZSv1gKMYUmo3NvaItCc8nh7Wa8+uv3LoXLzembe/937vY94MQXQwV2KNJwEALZMHc2V0AYn+zRxiLcmBFoAkgGYeXmmMANMsx41qBWu8JOGmLFOVkQKrr9bSaDUk4AEoAexOEs386qsRAkyvpU2jQLMfgm/S7IeKc4c38zYGse110qYsIzp7JZbjzYLGsCGc3R0wEWNNYGt3g1kv+k8nD8we07WogKmJX+amnf5b2nvSOVNmQ7CleKIWhiCIm9cbL4bqWlt5/vX1dybuYba7yTBiCGdXiJhKbs7k3VECflst+FGVWD1bviZHCRh2tDjDA8OdLsBsx9cYObSofFG0EVg9W75aGy2AejWEcEKA150x66FTIQQLAaoYO9TfXQgHANxE5zUmjPnKrWKPVpY6XJ4kcPyKroQ2eK/T4ygKiVK3SCmw4eo3/1yuTRJAvbJYMAAD2IX0T9WJ62GWp53zChTQ7zo401ApDhBAzH5S0ajIcCBI6kh8ku19DQdg/E0sig6Hm82IK+GA/Zb2Y1NrAUID0Q/NKy6kA2TbserG0sHv55WYK95/XwHFPFdxXcOHeLwbcgzKKrwwkAim1Wq1QGIpqJeIC0c7pp/6XjcLGwUAWzzFAUD3v6e4cBgx/bAIiFxHIZjVMWLl+pwiWL/Y98JdAEASLQAgvAUAaBf61t176Aj+qf8/2X1K2j+WyiCUyiE2j4zYNtGUmR4X2iigBRWQ1FKAMgAafQChhGPXe/30Pi7/kNhuBFrvmgP2AKZgg3AHFklYqqToxr9gXpdE5ICykBZNFxmbgbKqyfXzF8j5P3+tVqvV6jS/kUT9hZUrrLZMBbilk/sUhBs/jIwkTHE+Fjdb0WQQiVRkwZtIxDKy7UBFYs/XnNuJHKsOBhSIBLH2ntrzxeh6DeLwg6hzSutBYASeTsWST4fVOzIaodpb/NLApB3cgdUcvteLZi6icSPUAILcNWG5YCQ1CE/jLxhMb6sWmJKTBBgBSl63k5CgbCICAd0sMQBMO/cxWSUtgKkdzcD0wn2A6EkCggMgO5rptWxgxiSVYPYBsuOupQHzCDwuQWOgPkd7HyALaaC1Z+xQBgDJ6QBJhrUfKhCg+dgbUv3ogJbaFQGoptrEqx8zVEUkNMEp/C0OALPfSVcNWExjWgp88HMcaCpgdlOCRDoWQkDVQOjlOEw9f6CAqc1CnCZDY0Zx5DhMuSjEQQuY2ohRDk0xbYv4AIcp+66U3uMjgIPb050sqLF5YASAKftaAqXMy6NIFwlAcEXNgKf3uol/mHm5jzivimrb1ToLs9dLwUPW3o+Gn+SSCrUhbJJeetraaJcqtpuYYxitxHxzbO862ldRXo2mp9KiSfK4SUeRSprVgsKmiUVq+cDmK7iSVBtis6qjjtUGhFoKFASFq74NF3WAmEVwlenYNkuGk6krKmyvOp89i3VatbeJ3htKv0zUCBjZfni2hknMflKSQhuyPCbFqZ2+pxIUcFWf6kGojkWJkYAD+PRe8SwauYm2BihgOuRMJpDUOwEwwKywm3xyG8pOvipUA5tYYcY/g0Z32qKbH9X0DedabSJA9m0pZO1SJTO5WV/tyN5xoF5bTExCOL3duNw7DmihMuMPHEjNdrdgFjbiibFWsI9dgO62q4XKPBrvtHCPZ71efxxR7CQECGNLL6kFKUau1zlTlNHzNMODelGPPFqme11NmM9m5ePczLEZvv73283n1fhpt/bX3FSiPkxC+LlzP5oh+fGELOghB14hc7ws/o8jPmrLH5OLCenZByjvff0ub/7s1oYJ4OT9heTUlWd09VxQbOjquT+cHG/mV+SIi5DM4dCLkMzhyKsW2hly1RLtsWLp7JUilzmmlUfkomVAYPJ10X+mel6tqj/hLAAAAABJRU5ErkJggg==",
    "pv.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7//f/9/v7J8NtAzYDn3/0TAAAFa0lEQVR42p1YzXMTNxT/6cMFE9LIiVPoZEqcKQxgWCLH4cCBKU7hxIEGmr+y0HJti8Ehhx5aF1Hn0iEhzrRMDOvEmoQZmJK1ONi7K9nr2HQvlrXv6ffe0/tcAvdhnsJiRgAATKsM5imXgLh/p3axOAfAaBABYK+MwrMjGKZ2eUmgZcoAgEWRgWlWXA7i0i/OodVUQBHApgYrZbBXdjhsBhYszplmhSxs6s67hU3NS2KvLFUiA/P4nNlQxap1RrHKlsReJUDSI/nK92Cyx2oSt1ZusCQEhrvmPus/S6pb4gWJ1KCxAktmI4EeqvBYn30m+xBkKuevDZB1fbn9MIgE6f7613afJtOjceVpPisarkheyTzxMOCpXdbZmovA/EJTqEEMxq9fDCF4F2C6PUABAEAg67NrNgLzCxunGoMZ4O+EWvAQoHYEgA3BRgKwIDgAjJ8bAgAEsn5mNUK4NNecOBoA8Bv54ztdhuJf53/eGUIPc4Vlx3Y6DKcuvR0KAPj1fMUADGD/XXy99X4oAwqTqdMNUKC9b5QeTm8CPdvRQY4kEeDX86sGFGDioD4CPdoTxBOgYM9HkggwX2mRAwNdOHlsFIkAf7ug3nN4wj0/4x5rvzRkH2BYIW6WcJ+iHasrEhzcUMuPvFrRZajaAmghOYix6Nn63R6EuZ/idT01o4lMjek4NuW0aLnJWvjxa0buPOQQH2yA5Rc9kX01jM1uVuJq5b6JNZj+oG4CAJrIAgAOKzmvHmoRCNJm7MLfMcPpsdczX6bT6XQ6s1ZIp9Pp9Ilj9LPj0TVdYOPUKRB1Ue1eA+nukwktbApBHSMdGIi+3EpirZQWFEFMwghYL70wNN4jClTqnHP5vQzMrjnUMGqL0CbtBCd174UCcTAY2eqjJ4F1ShugtqvIGM6Y6BA9b+0SCid69OXuv91oAYjYg4Mwe3ev4dyv8skNADBrQAkATEXqMZuGw6prB2Dry53ldT3dke/ej/y25ZyglhEYMe1Sd51d7+pDF8DsiKCuTWIrR9YfN8S+HOqaMCH0hUtEnZTef9EAczdtBimS8hMJEAwSqa/f6ipqXSjceNAyMYOJnBUPFp4SSiSIJC1BlS0SYSY5RdaFo4MtxdSTcNWKPM6onHUmuBahbQyIDkL/Lsut7rmHRct4xHAgF7qKp68fPIpS6h9RZ+fYlDqmz0b9XjVaBetiVVkxnLpd0ZHzLZuEq8u0X4YNHOG3ueWLgdyayyQE9QMrhsENiQOiFkSGJbmtSDpiLOfhtu2DqUhyPluN20fbF/i4nVp2iYg8ZircbzkxzHP6G6s+mFaUA/f67529NYzDjfGwrBEsdPr1vqzGUveSfJrfS/Kqq99JDkOoG5nkWwCE3ATQdMuRFBo8YD0AhGaien0Sys1bP0gOT1/X9rZpx2ZxEdhbwxTHdmrGVc08GtQ7EOMpjv1ns7VBxd+1kje9C3C0Kbmy5byoDjifiZcKFMbTE7lRmhn63CiAAzV6Z20UBm/6cFyDAvicSDGcnjCxnQMYYM4zfnx4i8VeX1jd6WQ+VsnWRpCodCi7nfFOYTKaWAYD+IXtatisb9IzQ9X2Uu0/o2b9QyPPTx8Nwd5ca8bjQCD11w+HAZjOzMPCpvdoCPbmWndi4BgJIgIIuxe/nj/KUMwPAcJ0H1zW2ZocSD9eMmvKHS39+sXs7wPqA+Z5PPOwaGI5mMn+YwYMr6X2Lzs9wyv8f2cmU34Sh6wtHXsw3+itosHUY3I2YAn0aklsFNT/HvGZPTbvZ/IpVbQntOIr/6bYe+o1khjgvzqRmfziN1J815m5SPHdFl8Se+V5NexDCFno5IIhH0I+/VPLp3/MGeFz0UfwRyVe/gVUswAAAABJRU5ErkJggg==",
    "pv.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///8/f3e5euywtHnRgnjAAAFX0lEQVR42pVYS29bRRT+5twbWlEJj/MAtYmvx04igRGpnbgLioSom67YFGh+ZoWQYFXyIN00qE2NF8DCTSZOSpPWsScOQqjEMyyufe9MfJ24s5r7OOc7jzmvYXAXBRJlngYAtM0qKJDuD8x9zO+gnOYwCgDjMO1V5HcuICDtVbhR7WcAgKU046ZeFXIoQX6nnDOqWQXyLKV2AO8O48drDgZz+Jdzpl4loUOeJLT0Kry1amMwW9/JXLtZdfjld7w76da6RtIS/soySJyzmsC9la8ofuHFnzqVKz+SVi6BUWJ7enzsMP4t2ulKqk4J2FKsncwlIIi56/Vaoqwq+1vh+p45R+B1bre2knWDyv66OHZVuSJlKmY1wJDVOFNzDReBTkv1q3IYgSFZmEII4Yevgnld0xi6tJDZxzYCnZbqV9RwAnQOC5MhREhw89N/ttoX/A+TfXtjy0QE9KZ08AoXLnXUgyAACEq6hktWRk40IrN64kVwGUFjm4p9gvyeqcnLCHRGfZDv6ZBa+tuoywjQ2Vt8YgACyOOblwIAeoZ9JgACdENjpCVFKJIYSSKgc1R4YkCAx5UcBUAbtgAQaM/URhMpo7gAAaWzYDSCxvoEQAi4wqiLNQDCg3NZ4lzytPPKvSJ87cMO/aCx5BI8c5648IkZ63/av8tdgvRa/FlOTcMzS2eIlciWU+pfZ6Wn4s909MkTX/A3Fr+Dcr3qIpTFphVHjPmy/MjSaqpZXQYANOFzADjbyC1ELDROtO85OvPjclh9Uj98E/IsSh4nb4EiOQVC8u10z+K994wDtp84wTaSZwadVR2PCaQCsePYVcTg8YGEYZeQ5zwM1PjrAMA4mFUd4JHNUTPDBo6Py4ORo1KxNXjeukzbEhAQR4+I4UyfsRGqaMUQiDueVTM9wBfRhoMLS2jfFlHeeiTWQn417Iebqhi7ZnN0DrdnaP/bcNtV86F8fPXl15bQsE1GDLrS288e9PQZLxpyIszpCkzkNxbZl7uOIKsXMKybEMfc9g13ELRQbJDAM9AOgklyg5PALC7KQQBPQmBQRZGsNIBiIgZ3RLKSAq8mCMWEddok7IhLCp9QcDvilC2Ft97ftaJ8a6S0efpAFONdZrr9ar0mdnvineUnIiUI8BHnYqEWOj/39osnT/tMM/xNNTYZ2QKq2ajf237R33UPUlYEGL/6RWyCA7GcoHNaW11l1zcTG9HTzG4uqc94GDt9SflgcUA0ZGRYlpUJCV/w/5yI0/noo599Fve/tprUtc/iTtKJ0bajqyROimLUEkdeinylBopiHmAMeRsxymoaNHY/iZn/XdLbW/eFD+Of74fLHABbBtB0y5HgSvp6IGa80BlpAGfusCHnN4SPzMmX0nnd3Y2iwm1CiFIkfTSmrp2DeDq0ETCB9IHn9zeHFX/XSsH8cSjzSnE0N3griwD1uppR3MZMFSCgsTHRGIUgKJ3p8NBoGq33EQ0BeIC56WVwec9Epx+vt0OEzvrkCDIFd5q9rhLt3I1oYhkO0Ckd/t4/+F05eylEsKir0TjQOSpYk1ryOv28aVR/pNELaoIubo/FpHncjSeU13uLF2tBndshQG9o0gtq9vsLNZgym9oey17vFS6CoE5Pgyg96Bk1J4eeKNIV058Y+qNlRxY+rA2pD8jOXa9/dOgSmOzb6bHXyRRi/3Zr69X5aVf9NX0jmULsV678ZBJS3NrJXNK5FbKSqoukKppZZw/04Igvl3nTGsI8K88Gb9OFsT/z9oyZb53eTbd+CVQSATov30+Pv/cH5VI9k+dSu14l3VrNyqEXIXOlgYuQ1urQi5B3v2p598ucEa6L/gcZVSGaagDa8AAAAABJRU5ErkJggg==",
    "load.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7//f3/qrH/WGb/UF/PHtmbAAAFO0lEQVR42q1YTW/bNhh++MpLk3aVKK1FkQKzKDlA0VyWOi32cRnQ9R/0h+4nbDts6A5zkw3Y1oNt2cPaNFgkUmtTN1vIHWwlImXLBTpebIl8+Lzf5CsGe7A4Q4+zkMMU0gxAvnQW2I9Rjl4opJEAGGe6GDAxbgFEOfVFIYsRACANWaiHWTJeCYjyXuQXeQaWAMglKAnj8cBCdGr/Ke+lepixtJhThGE+JKQYiGwpA4u9pDjJ0lFtj3RE98L8QGPZEN6jfRB3jCKw/2iPLl94lwq83L/yPemZs40Sv0XJKZs1AOzNfjCk0yaxTH6/uv0rnzUE6j0WhOWy0oN+Y4rIkrShnRDVwsVvt28Ou6sA0+uyN7V1oPLukGerAObsRXp9U9b9IG6erzB2JdTe17rGQOWno0C2AEp57eacYg6Id/JnRct6mIDt/mguAFTeeW5mbQC8lVfnFAQAfmImsnU9jC+jyYVZSYxirBnliEQFiJSZZusAuiuDZKHDrZ1XVyTWUhx98cQAHsBIvCxclcOtZrRd1ZiBACiTOQQpLwqWOmrrLJgni3iwJ9ykoTQVbjKR95gAD4i2jyyJWHCcptthGG4cB5ZcPNKYeSAlDt5Ysh73b29vvg3DLX1s6hO3aAPSA9Jzy0ak+smb2QyzWbSlubTsdDebEWLrJZjfF4uwKqg3sdQwTMFj8u5BHcG9vgQWKRxtTKwIvPaBJObxevVjlBZgFWmRijoFZ1yQQVHPHKZiIBh9s1hXBnVAVkBSnOZ1L3T7Emx0eK+S4iKXAYDGaUmwMo3+iAF9+DCpXpbd+nZGgbJgUovUIAHYST+4TL9U1SLWV4bI0jkIJfxf4ktSEypL69ijW1nNneUu2KsbddtvvcZlfPAzn4CakYgFQGk5S/HaYwYQy50CHxwGK5OIjTklqAF0Ahj3nLSOn4is7QQkTGLFloFVo1UHsj4fAtIRMbTQIEC2HdxOmgIEt8Do1mIDCpwtjcfbEIoaMlDQVvYbxyxgWmsac861JTXfeWUDMjQImWMFclzfZHBCh9Y7oQ2gjXKXB9J2FNk26TZMZKb2I9k6qcK9zRSWWyTIlkE1tM5tQECwSr3+eGKv93/ObJXJsUJpW5GNY8eKBG6tKMYWhZ9bjmbM1QHGr1OwsXt+BzR2EkgNa0LrQeAkUE4msgEmfHpBwU4SZzKR5DobqiYSGTcdQCZ0XXuppsldx4ey40tnF8MnlWv0xJmTN7IOV7FTB4pRFS3nznoqA+pAcZf35GRlggYA8x42rqQ1He2xs8c7DCE5pcjsV1RuzQj/4R1NrtZgbG5Z4wLkjQPeQbehtf6JLy04VAYkO1CdhtZGCQC6cUtjxpcAeV8R3mmI+3sCHRjO4sLm4B9xAOapcYoeH2XowPgqcKUNEwD6wAFM7mXzHGJffusYlpbpIDofZhIdwHDi2qbQo2VlmJ9U11DvunsMhVtbW5v2vZLUZ08WN7fonewk7u8li7jJA9YV69bTlKtxFWg6SyfrAH46N4IHAGcy0WhvB9hZ8npTVr2oFmW0hiL24nlP4y0umJ+f8razjVTvryu1lsbE/24+M20E0Z3vinpbVh7tnrdQkOr/ubgNU1W1ZW+y0rTk901VxSuPTQfsk+kqQPdvPuw63a6J1e5puVwNMd0/vejaLtpjlV/b1ksRybQf/HDRGNBlER6UPd28SUCM+/Ewkf9Diw8Zq+1w4yitnzlpUfbD/NCfLQOgzNnt0IxZuoir8LZ5Qf3k+SA+eo8PIe/3qQWItHQ+5iAZt95f1n4u+g+4/ipIMVqNyQAAAABJRU5ErkJggg==",
    "load.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///6+/zL1uCuvs0UaJSEAAAE7klEQVR42q1Y30/cRhD+PDYB0sKtuWslTsJeTFApD+n5QqW+NReaf6DN39k+VarUEpK3IAW4oCrtAz/2jqSBisOLqVqpDbt9uF/ePZ8vkbJP9npmZ75vd2Z27MAcFAjc8x0GQMtkFxQIU8AxX6NjbPhMy+43ppMtRMcFCqTchp9ouQsAuOcwP7locjFWITpeibTuNIEIwDHgxowd7xk2HGP9jeXkoklcddckroTb8C+3sjacLF4vTi6axnrRsdvwO08U8gZ3H26CuMUax8ajGg0n3OGn9IHaIiVNBS35y9vR1NlQbPCk6rpDObYF35crORb4Hf7qINdXGb6oLre0pUDp+t87+dggw4N4akaaCuGdW49Dma+A9Ob28o42FCj96vWMGCMPTWfVuZ6JnkK48c9OgrFDhxQ90xkFuq69npbjFZCeVZcghwrhii4yAOiQFrso3D6CNygc8ryHwu1SpPskjB0hdYlyAaC8Voygh6L0pnc0opY+EBPkoZbkfNSzUFp5qycZANLz+JkGXIAW1n5KJspDBx/PzUgQoFoj4hEHKLJnE9Z1ia94pkcUnqT16q0TMg9Xeh7vaHiAGx6akIP2BvPhrxy1TdhOGgi4oPSzp8Ym8NPNxVlgdrY69afxIXQ/hXTh1E2OKH3AegliYRAFfZ/eSELATEpVnQ1Syh3TV+20QSRKTWPay+QN5765d1cBSLmaDEYb2beKxS3jRI7MhjK1GYDLH/omgmyeEicMpOKb7FzQANB5MnClkqWWRLlFvGRgPmWAfvqtP0Bx10B95ZCAgbkO4PBBFlMW9Y2jyGVZzJwB+leWdcP4jBo52vbowuDJ9EkyQpIhiQDgmllZPUOTBjmKW/XlhUV91r8mo5qxlzGgrTpZNs6BS5CWdV2zK3GWVxCz7WtWFKgOaUxIGFkPlZaEpp1PCpON7RIAr9geGZi6F4YCeT4iPnFYCjkJUBcpiHygBRb2R+U7vECB3heDyikrUhStuTSCWh/YFlQxTVqZrJAp0d6zFY64VePBrcJke2SGA8hhhkbbKi5JYAJgZDu9b0zojg3Jg5m8VbcwDQw07eAgOxzwPLOA3rK/3pB27QO0PXy8sK6MiksCo5F75Nijwn2QnVWAk+HjpW2dSbqxg1gNK562AQrd9LisWcdLbferw1v7pDqMPHnF7K14+8vYFKCV++95YBum/iHn9jmp38CDrtj3YfVN7+HQJsmRwlOjUUa9TDMSTWL1Zw7whzWeH4Yj0+4jgof2JyOoFXEASoxiDgRA3nfvmM34l/c5PCg4dy2eeIUB0NsWGaerHQEPCFqM282an5PGyZnfAjyg/errtsVGWwHoWBpBpaO6yV37I9lxN2+b/Q4XcAEd/reKyddQuv7iSdKlnPbL7ckcBXGH9y66Ca+ad7VcA+nn8mV/U1Vrsokgnm8O2oH0LM50avnjev3VtOyXQMVbZVLFu1yZ31LDDiU9j4tRULr+Vzd0u0VWBVflg0IEldL3KttlpaLQBKU9BIOjr5ZaZcHHyqt4vp/F3UHHEgUH4/qgsLJ2NG21ljok+26eub3Xh23hoNuVf3y0MJerwU8b7Eedkz33nEpORgAXMTvkH6LFhwzTqDr3e5QtWtHl9ebi5U4g8xSQdm4v0vxvtNy7XdNy6cRt+JePQ/GBfoS8/6+W9/+Z8w6/i/4HMs8B683VQP0AAAAASUVORK5CYII=",
    "battery.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX//////f/7/f+p1f9fsP9Uqv+4QbGVAAAEa0lEQVR42q1Yy27jNhQ9vNI0QR8WpWTQySwsSs6gSVYZox9QTLPvn7afUHQz3RRO0lVTjGXGwEwToBFJAW2DQUN2YTuWFMoPoNzZvEf3/SJD87BUYsAZj6GcdoWmnm4RNH8mJQYxh9MAEMOpEbLJCgBZGgqlVQEAyGMW27EUshOQlIOkp0oJ5AAKgLI4nYwaPFjj+4PMjSXLypncLCs1DXk5qvNgdX2DTN3JvKh9Iy/odVxeWPiOCM6GIN4yisDg7JSWfwRLgcxw5y3Z+9ZntJgksV3adom1w2hMHt5SjMzAw0HsvRhPvbLq9Lfkxa1rAcgMy9/9ukGnVycPXDcB6V7v51T7AagsiUvXAFD1esxlBz0cqfyLXV33g3j+0GHshclPf7A1DlR99SHSKwCV/vT5jEUIAOjvq+kqBrBciV+XHMgcfVBYee5N8ozrheN6ubvGmtPT+fWjp0kU6TpAVZBYABJjp3IdwPZllM11+HLw147GWhb65MIBAcBI3E7W0sOlwTPcIwSccW2BcgCw7X81hwYA8fWpwAaHgm8JCAHi71rfoswBzBUttYn1JULQdTZt16ocHLCy5fy+5kIGQP6w86S6OaXUpGzJZG6PJ/chUv7nE5uPvUowxyqETA5+ad8MZqXjTutWBJq+DF2AZurnAIsBACpJ0FCcg4uQwTV1KwC88xtWhp9rhlefaemRZ+7eUcPc7LvvQxE1dOZ7ebP2nbs63lDY0pkS10il7LyuNYwl4lSn163EMGk9bAQTxNSqjgTWFFBxAiw2PhIgVvLNAWzCKcM2ACQUYatjQmi9ObkDCNgS4OQ2EtknTfBRPeW/MATyXkQX/rLfQQ64rEO1DpHYXdwhaheHqss/HYDokm8HcDnrkCn06sbGtoAX4cIOxk5Zf5iF3nRwScLufPRyn0yXIwz393h0lPpI+t1G6Eggr6sZQOBeANM+IzGGTh06Uj2iSUcCeWPDoSSXaL+rtV8x6ooO7k8HkOuIGb+gsSart6l8TobCCGxaBwgRkTTbVL7IEiuSjQuNzQpOrDtNnxqJQ5N1aDQlvcJaEhec0K83GdtrhUqPLQUmikiHuA4bE27ZCHdXyMYo0NMMxL750W7UdsX+v1oCoDOxoRvOciCcTzWtaawxFzy29Xmlp+DNRoYVh6ezQuYc20wibvhsDE2D+SC+mt4cXfwzA5A8vnRrAenew66eZU8ZUX+toWgqzGRRjK3M1w/r+WyODQDgo8rsOiU+Zu+5XiwcVpjkerUWIohGdrnSVDfHluuVJsrnA30wH8TD3atVLNLk6CdVX8uqm+Vq52UwfN+ahsXhm+6xhnD4GD2LTbFSeW/aJVQaHI+j1mrpUvPSVn6EmJ78faXa265Wewd+hJgOo7fO03ZHZmA9cS7kMBoLX5/un7OhfbriywG/qy1hQX1tNi/jT27y+lyaq2p4UF5E9z4AqpIdxG7Ccje7Z7n7g4ZxORI3/9NDyPZPLY+POWo+Ra99zGk/F43w5LnoPwRx0jPx67CsAAAAAElFTkSuQmCC",
    "battery.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///5+vvN1+Gtvs11K4XAAAAEYklEQVR42q1Y308bRxD+bu4oKBF4zzhSY4m79QFSwkPiA1fKIwT1L2j/1UqVKic0Ly1SCcZS2zwQs4YQoMW+5eiPh5bdPviw7y539p3UebJv59tvZnZ2dmcNJIUcgS3bYAC0DA5AjkgqGMm/Xg8tm2k5GmM6aMPrTQGQMnfsQMsDAMCWwezgusNFLsDrrXpaDzqAB6AHmL5d6b1NcBiJ+VuN4LpDXI3mJK6EuWMP23EOI+6v5QfHIjGf1zN37MGeQpZw88tdEE9FjaP1dZMmH8zJUPhStUnJJEBL/ku9Pnc5URv/Upt6QBncgr+WqxkMfI1/6GbaKt2jeqOvUwAKN/7az/YN0u36cwsyCXDXPnvlymwAwrsHjX2dAFD44nxB5OhD02V9MaKIAG7r7/0AuaJd8n7UMQDdNn+uyHwAwov6CiQAWAAA51FwqqboQ/HAfTNhoPDF+QWmiryKvDBHIdL3QcgVl0aBMgGg+vR8Xs4AhJd1HUSp4Z3qrpihD7UiHS9iqKz+q2cRAOHV5g8aMAGqPvk2mKkP7TxcXJCwANXn6UEPAFTaTMlGdvAvtjkKCFlfEWABpnucmot8AMBBym2EjoAF6je7KX1jZNJhavEdySFMGJvpGGljIQiCQH78JE7NC2nBYb9/EvODvDQ/hUWi9V16oMUAANdSpDLwxhGWMnVy63uAYQMAhuQhWVjBOMjaRWFZ2+aW2rpLVtvInsjqdiJ84vn3Fk/6zGuNxJy7r1UifgYJ3YkTkJ00IvFX3d0oMhnF9fssdeA8i6cNR5MMPe1EAlgq/wiBKh4loUGG4sUB1GHURCkxCbKMvgaxcgwGaSmKqystCaIMgco3KcgzCZTt3V72SZujDmg/bylyvg9YScBtSYA+QkmAXxIw0EFQCmCqk+PsJLOQuR2qVQyz3BbrlJusMqf4gZeJE4EMxovHiQyWa5JmeSblLGmmzzBAnbzcyP58R9rM3kHV7CuHJLDstcu0iNsgbZTZokzSHUpVvg7xm2bh0kcmI5KyRGUytKLwsHihUc0BJ+gaFQVwWwpSOlU8pyStQIcTnJvYIaNW0pf1UMR8rpAgnAo2peIFIuGzAws4efYmxiqQe+w6jwajLWokWq+fcn0+Wx8IWIDT5/HIegmlXnz3LLVjN60CQW1tR2WmYP4ZdsgBE9DuP+sFTjq6fb4XjBjocPl0NoHjD3h00Q14fdyx5BOET0Xvvh1Q/eXuTILakhi3A+GlH+vUcorCxod5OWbg/WWavvF4bamtJi1NeOX/yaZ5QTcbf4wuq+b9Rdw+mtZyuKufRxf6qMsKhT8tUBRGHowPFLXSXxa5xYCUv3TfkpjjjsVzunlGubUn7+dTraV2qT73WzaCn21O2sJxtys/PqwuZiL42Q77Rmccim+NmsrIcy58dsz/jxYf0g29+uI7L14GvGG4+3i478gsAMLBg8e09Cs1oj6WGpUT86U9fOWKKQ8hlaD4Q0j5p5byjzkFnov+Awfpysp4Vtq4AAAAAElFTkSuQmCC",
    "plug.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX////+///+/f/g0/+7m/+0k/9Qi3+AAAAFc0lEQVR42qVYXW/cRBQ9c+02aQvZ8aZItFBnPBuppUJt4oZHRJXsP4C/WxBC4qnZJpWKCuo6EyPUIhHP2BJVBc0MD/vl8drZVPghq4zv8bkzc++5d4bBfyhWGPCIcTij3QgUK9+A+f/KDIMo0c4AYDwq9AgyuwBAllKhjZ7YyIhFdqyE6gTIbCCdPlOABJABtMtENhINrxbfx2B4ICbWkw8AtDdMIdoZKA4SfaY8n2VGKS+ObCuBCIYHINFgFdgb7tBiIFi8KtO1J2SND3BG/NKPaqMLrE17Y2rhVmJUDloYxOatcd7qq9l6KfmfrrlCNEypY/UggqEQDZfi1I3iLkB+bga57xJVX4x51/7A0Wv58bqpM8SpzTvtARurGUUwJbib9Uw3AJW+PaWYALa23/6qL7CHc+z2sZu7RL/3CouLnxP2QABACABxaNUKe8Qqfr5gEJlYBcgzimcAeerylQw2NlxOJ90b/L1mVgFQvbl/5AACKOeVR0BSzv/WKO6wWSgE+/UoksLLhlpEbe8IgAHi5nujajJDCUcEOAOd1TWD2OMfLEKA+KuFvc0fRRGcAVifu0SPFiliicUKIeg0yReOBrtJkWmrAEjG+5Id1rbCcKEYSH6u5gzBvtWj2hx2+/ZJzadvMkWIeS1hUzse0WzaUtrDjPbrGpMDhOFiYPvbhmxIBN/Nkw1iTyBwgTh187z+65+33hZqsjeuvpsN8etX14mYWwRq73nRjAgaLTJRGQ6ySTGnVIiXglCwxa7SSV+RqGca47lo6v9uPY9KCtXgaW1kG0eylhsUZwNxtvAPpQ2J1+WuHNAIJGAVSCCz+aO+8fwTITO+oEimswwAbAZKosSV3nsewtWzmblS6sQ4AyBCxLjzKo4KPwpZ4RUY1tMR+lMAnI58QT35Okway8giZxBFAGa/3tMP+b9Ygvi//ktyq7PZqy8EdAqGXhJDC9AFmh1FbgnBQtdJX9oyWS5HIahDVV3vqYJotBYCxDsJivDgWcsqda9IkfQfli3tQudDMBYfAtgwvWrZ4bDTntufzsmxyzM49vA4WZ5D2BkZzMjNHluuwKhNTHhoXvISAIpamiuQ9w3d8xDggPPLMSdTx2dlM3g106oWbeQI9QYtzkruhaiJirHwlihkNS1GbiEjaIBxOAPGeeH3RIyH5oYnjGNEIpolnHMnZ40eyoUnX/pSOg42SjbZYO36h83OuAhd/8hHCHs4aUStwlBmnr3dNiFYIyHUHWmnnbFF1kgH/p7cUnxtZpOiIm3eo6XtD20jhi1V6QgkrMroUVMF1E0ViOAq9+WV3b92rdCGpBQvfASxe6ehusIbmzuGTBLDOLOvmorCejag8l4zczV7d319HW78shmqgysABQfNmUngK0HB42YfDrG3A7LLwpSRnLQRTY8UPxKEuHzQ/JK1U11sZGfgSBHU5dWYuRgEOtnMlzWpTXHjnQIgWMeWmm41bu0TeaVAk66mTUyarhJzajqXfbrMDMT2zuRT1rXbN2lJGDFpQ7fok/WWpWoMUSmO9cRZetayTstrtHsmprPLHItXttKU8yqbaWus5EoKO21aAgCojDxftd+0e7ZmZnJvhemv6NZF0PveLk4o1Zv7ll/EQaWcEEwBbiv49NhdANjavPujrh/Lqjfy/AIKKnf/WPOOZfaOGajOpSWbuufKP4tWr+XGb67ToVvjWZmYAdxW+dl51Y4QeVrMT23z067R/Vu2FSHydO1n11JFR+XAtsStUGmvVlRqFvEzdmCXj/hqj5/VDmFB/aBdRolVsi6PsqjSqDiOTRsAVcGiyJ1gDpFaUxoVoy3VcRFCdtDfMN5FSMSzkXdx8f+uWj78MucS10X/AUBxVFYRJPxDAAAAAElFTkSuQmCC",
    "plug.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///8/f3W3uavv84s6eCpAAAFgElEQVR42pVYzU8bRxT/7dtFhZDEu+C0jRvb44UegipqjHtoDk34yC1Sv8J/WeVWqQccp+klSIG4rtTmYDZj0ySEGu9gqlRK4pkebPDseNfAHBCefb95H/Peb+aNheigHEfZ9QAAoaqAcjwqYEV/+gHKnqtE/5urwgr8YAyApL3qhgi3AQDLHjzVqDGeCPCDspcKD2uAb6VEANhLXqrzMKLDiqxfLoTtGjHZX5OY5PaK16noOizd33QhbNci6/mBveJ1qhJxgzkb6yBmRI1hfeMODSfs4afu6n+bJEUUoATbycxM7A/FTv+Tq6k2xejmrHo0H6OBzX/aqMfaKvK/ZwpNZQDs7q1wK943iHy9NDEpoiZlS6qSQ8JofRBzragGOv66McmTAIr4wjUIHZBffrsVInGo/LvMltIAdFx8+ZFIBqC7n7nRV+EAABavhXU5Rh6Shey3oQY6KL58jbFDvMlcnhQnUcqVVB1njOwgUAQANtvNnQVo7VDxBOA3VZ2fBZBZcdUf+JBa/leJswDoNktPFGADNMN+iewBFbzw5K+2F7npy5MCBMjTxOrXDJNBAEAGgVEdwu1XHPv8PecazdCSB3hKQIltnTOIvnsg4QB2qjGUl3tlzwUAywNmPFUZloi0jhZrcEDNpeEmSHvVVWGodgAsW66H9c0hIguXcQu0PD20yPlehRWtvFY89ZNm07fbnJBzdQHVqJA/cNX3e5svrDWdlFoA4f5wonyfRQPjw9kons6wu0WQdIZEwLx2S0b2PKAPXLMALiNCqCX2YzPJpf3MPV2ChwDJpd6pSu7mmJkReY2JqDbbJOZqaSRYi5n8v6KxqbIs4qmaZnV6kftMT5OgrLkge0fSsaHTnTU/WwExSA4fCAK7XIjQL4qOpaIHzMx6uB0AQP94cI1KdR0IIzCe50EJAJZruSbPpuFYPWZWmwfMxBcR1e71C/X8wyb3YgCLIC4ir0AAP7+8VIJU7SIapDXOBxXH56Tllinf2BzxjyWLA2rifnV01kkGHDLcjjPJSgIQ0DPn3HEmSYHjuGVUEiBd7bRGzpVxGqzbj+7EGpo4Zn6I9UzqUU6I1rAgDA2xiSiiZ7zQCoLvxO2fThK2S5ZuSPZFTIKwiMcOdF5qcRRM+ciJb8ER0/pe0VM1o+dv2DZuCIqi5SD97aoMw0F2d7BZNw7wnqPsKF3brLeJORfAIceGH0S+ypJw4EYveop/sXy4CwCYu4LAKAcLpEay1dkmBgL83h/KTARXUA/SqHNrLeDEfAR7q2ZictRsNn11MrqXlzIZ91UY2ssLqd3opYio+NwRwjUS4ikKni/gQbXNS5GlpP3uTc4kmldTmJqagmo8MUxSpR4cIG3eh/1t3P2nTvfqJk0z7z0nOVpxAZX61wg+4vMjRsgefWPWgZQAMHJrJCdFnNC6ABurHAh4lh6p9VoYx7i5lUOAIBUWR749jVt/D10OArJHLovjBtNUslK1gS8/0nkcYF/dGSyl4tnSVGu5XQbYgPrSzsbxhTFFx8Vq2NfQrY7GKS5GbTa46IaFzMTkWbtB3aX9P0+ossfnzlSRK8naaTvQ3b+pdWrx4/jm3x+JkxNIFo9mSY6PaTr1sDdsaQ6aS+O9oO7C4ELfP+Pk4tHs2JYjl049kHqXddAsjVNB3VvtQccwSAp5g89zligvV+VjHm0tu/sLH9eTjrv8/PXGJ/tRgMq/y0wcxCPY3sLbrddmtytefZaAYHurqZ/VaAOOZubSLo0iGF9zG8OAaJWQrXrrcrTF5+teW2vCNA0i9+565spzX7/0+J3jNa/za07EAdB9eek6Xf2LCqlByAupF/aK16nkeeJDyHxh5CEkrCQ+hFz8qeXkMQfheR9zzvFc9D/yNzodLGdFDgAAAABJRU5ErkJggg==",
    "inverter.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX////+///+/v/4/f5d2OUBxdoQYP2rAAAC9ElEQVR42u2YS2/TQBDH/7uxVKGKZO3k2sZO0wOIR5OmZ0rgE/A9EV8gfSCuKClwpCQOPVLbm8CNxsMhTeu1nfUaVQgh9hJnPb/MzuzOY8PgNjyYjvCYKtx5aCyPexsbFT57YA5gAY6SozRgAQiloTDzAAugI+Oft5eAI0wBuQkLIBkayrtyExxg5hYL/AG3/guAtXpoFQiOUwAbF22BVIFazy6INdUG/kMvD+eZq2io7savtcDB9lsFEAg6vs6Zo21Gqpc4RRqg4mX2Idbb4Gf2QY3FFmoYS+3GJUdr/GX5YQh44x1bgKKhU/VNAHvSswUA2z6KTA6fE/U8AQDMednsFAMs7N240N4ZiUKg2U4kc+fFvAhgF0ryt5+IAqDZUSRYfa4H2EXq1Np7QgvUWOo9q861QP152sjGng5gOUc8FhqAmidp+cvvUgO4rUeTVCy/c7kGmLH2lUKEp33bXQ/wuWDtq8QS6LQvWNVdf1oZwNpv+rTKRed9cZuRcoCYA2CHx4vr73uWUMIzA4hdAHAO/S4A4HwZ+nVGBcnYnl5vu12Uvd3ccsp42XRPZQF2dxVIlgVEWcDPVUHxHdowyhMJ1rt1jTpXE3G5TdL6JcXNHKtp6q/XEOcBM02Ifs1Zk9zW5aUcNwW6rBFvZdZEH3UAeEZF0NSmykktpYKiSAvQIvU+Sq0os7nTkSJAQbWgoNCWoiJMK8iW3amfODvhsZBFRZHqwxsZOvJkcZ0OqoPV48CbmHSV853VU3di1IbGvq4l+t+s/73AgiIJUCTPdF0l57c3CBocCNDAuZ1hLAPEw+wVIHEhtJ6qwKzR2E9VCrav9poiTAJy5LWy7XRyfI4VDXR/ovZ6Amo2oA+k2jB/r7b/r3Cp+sj1VSCu15Kvq7L2qZsMz9oo7aUgSAIdQAzL7DStrcG/czTIXFoCHGBu9s1ZOFlkZ2diafS0m7nlyy+znMmF+AkL4I9z/ZEzWTn4BotctBumf4RgLhlEu8TfRSfxL/wI5N1aTeu8AAAAAElFTkSuQmCC",
    "inverter.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX//////v7+/v7j6e69zNqvv80Z86zbAAACyklEQVR42u2YvW7bMBSFD2kB/UFgk0bWKrTiqUCLNPYDtM3j9hkCP4EDoV1rmdGcSgzQoUNy2SGRI0oUxSwFCoSLZZqfL3l97iFpBnW8QGyrLjHh8n30eLx5/YqjNPGAnYLjmY0DiA5hASQAfu0iAfYJSAC6ip6PPEICzLiKBW6PkAAWReR4NQE4wJ6dpRdgrCXNQzYysOgCxXMjrEVYqJcuwJkcAc6MbgO0vP8WBJZp7mRJoQpKlu+bkTwyv6o3jsKA7mXJbdlgor1AVhQPL5GAKjIJoC54qqMAvZrPDNhCbnVMBE5rxSABzC920ONqpbV4rHLBTvW4vNWpkgcb4ud8FCgXLRcR83QMUJnjOiLjI0CpHNWyniv2vqBjayLlQSA765QFm6ggoHtlxCgIqE3tdtQ3wSmp+Qdt2x2m+rHgAUCL5V37x7WUf2VqWEucSbvaQjZBRL05h5wqPSw+I3C6WU0ftkk2251LYQNqpUSAyS+bJjE3x1KAiXxY3gsAjH++zgQA+/O3YgDmgUULABD8+vGdYkB3S3MAZX0VbvjLHudIyXsoEDQcwQydkoaAvfdkOAxw6wlhjQos2rPRscCi6aTuA7XRwxHIN6UysOjS9Ahr09APt+/bTKUDAL3rJbb6HpQGzztzsvdpECjSTg0ZrcPiI+2EsFSO7HHa9XdT0Ji8U2fZVTm6i2q0DkLVVUQB8auDPupLFQEQbZvHrdIxJcoP58VMR9U06dCR6MXI/h1grQGsMbEA2doCpuMvXbXyJ0WAtmsJu231PNnZAZj2lUytc2ty4gJ6OVl1x6+8htlE2D8dDR8/l66p3pAL3LsWxjCrXTfIOxG4e6fmF9i5OWpqqQHIdQuypsy8RZL4UvJwvyj+J/F57le6KMh/EUqAW535rp6eTpoBCcA+5qHbaqtNlndIcCLEcewfISgxsfVb8ScWoLz+C/5V3YxMzhw7AAAAAElFTkSuQmCC",
  };
  /* <<<END_PF_ICONS>>> */


  /* The old house / battery-stack drawing is unused since the schematic
     replaced it - kept here only until we are sure nothing needs it. */
  const HOUSE = `
    <ellipse cx="305" cy="384" rx="252" ry="13" fill="rgba(15,23,42,0.06)"/>

    <!-- base plinth -->
    <rect x="70" y="350" width="470" height="26" rx="7" fill="#c6ccd4"/>
    <rect x="70" y="350" width="470" height="9" rx="4.5" fill="#dce1e7"/>

    <!-- left wing: single storey, flat roof -->
    <polygon points="100,226 84,210 84,336 100,352" fill="#d3d8df"/>
    <polygon points="84,210 276,210 292,226 100,226" fill="#e5e9ee"/>
    <rect x="100" y="226" width="192" height="126" fill="#f6f7f9"/>
    <rect x="80" y="200" width="104" height="11" rx="3" fill="#c9ced6"/>
    <g stroke="#b0b7c1" stroke-width="2.4" stroke-linecap="round">
      <line x1="88" y1="200" x2="88" y2="170"/>
      <line x1="114" y1="200" x2="114" y2="170"/>
      <line x1="140" y1="200" x2="140" y2="170"/>
      <line x1="166" y1="200" x2="166" y2="170"/>
      <line x1="84" y1="170" x2="174" y2="170"/>
    </g>
    <polygon points="186,190 270,190 286,212 202,212" fill="#2f3b4d"/>
    <g stroke="#61708a" stroke-width="1.2">
      <line x1="207" y1="190" x2="223" y2="212"/>
      <line x1="228" y1="190" x2="244" y2="212"/>
      <line x1="249" y1="190" x2="265" y2="212"/>
      <line x1="194" y1="201" x2="278" y2="201"/>
    </g>

    <!-- right wing: two storeys with a pitched roof -->
    <polygon points="510,196 526,212 526,368 510,352" fill="#e7eaee"/>
    <rect x="292" y="196" width="218" height="156" fill="#f8f9fb"/>
    <rect x="304" y="206" width="194" height="64" fill="#f9e8d5"/>
    <rect x="296" y="270" width="208" height="9" fill="#dde1e7"/>
    <rect x="304" y="279" width="194" height="61" fill="#fbeddb"/>

    <!-- roof + roof solar array -->
    <polygon points="276,200 400,84 524,200" fill="#474d56"/>
    <polygon points="276,200 524,200 514,209 286,209" fill="#3b4149"/>
    <polygon points="301,177 381,101 396,117 316,193" fill="#28323f"/>
    <g stroke="#5b6b84" stroke-width="1.1">
      <line x1="320.9" y1="157.9" x2="335.9" y2="173.9"/>
      <line x1="341.1" y1="139.1" x2="356.1" y2="155.1"/>
      <line x1="361.3" y1="120.3" x2="376.3" y2="136.3"/>
      <line x1="308.5" y1="185" x2="388.5" y2="109"/>
    </g>

    <!-- upper room -->
    <rect x="308" y="212" width="7" height="52" rx="3" fill="#fdf1de"/>
    <rect x="352" y="252" width="12" height="12" rx="3" fill="#c98f63"/>
    <path d="M358 252 C352 240 348 236 344 234 M358 252 C364 240 368 236 372 234 M358 252 L358 236"
          stroke="#3f9d5c" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <rect x="472" y="226" width="7" height="38" rx="2" fill="#c9a072"/>
    <rect x="424" y="244" width="55" height="20" rx="5" fill="#ffffff"/>
    <rect x="428" y="248" width="18" height="12" rx="4" fill="#f0f3f7"/>
    <rect x="412" y="248" width="16" height="16" rx="4" fill="#cdd8e5"/>
    <circle cx="404" cy="236" r="6" fill="#ffd27a"/>
    <rect x="402" y="242" width="4" height="24" rx="2" fill="#d9cfc2"/>

    <!-- lower room -->
    <rect x="304" y="279" width="10" height="60" fill="#f7efe1"/>
    <rect x="342" y="300" width="54" height="14" rx="5" fill="#d6c8ae"/>
    <rect x="342" y="312" width="54" height="20" rx="5" fill="#c3b295"/>
    <rect x="404" y="322" width="36" height="6" rx="2" fill="#bb8f63"/>
    <rect x="408" y="328" width="4" height="8" fill="#a97f57"/>
    <rect x="432" y="328" width="4" height="8" fill="#a97f57"/>
    <rect x="452" y="292" width="44" height="28" rx="3" fill="#20242b"/>
    <rect x="456" y="296" width="36" height="20" rx="2" fill="#3b4450"/>
  `;

  /* ------------------------------------------------------------------ *
   * The battery drawn in front of the house.
   *
   * It is a small replica of the battery card's stack, so the same unit looks
   * the same on both pages: a dark BMS head on top, one grey module per pack
   * (a three pack unit shows three segments), the connector panel on the right
   * and feet on the ground. On top of that the cells are tinted green up to
   * the state of charge, so the picture doubles as a gauge.
   * ------------------------------------------------------------------ */
  /* The stack now stands in front of the house on the scene's ground line, so
     it is a little larger than the schematic version was. */
  const STACK_X = 252; // left edge of the front face
  const STACK_W = 54; // front face width
  const STACK_SIDE = 9; // right hand connector panel
  const STACK_BOTTOM = 392; // ground line the stack stands on
  const STACK_HEAD_H = 18; // dark BMS / PCS module
  const STACK_MOD_H = 26; // one battery module
  const STACK_MAX_PACKS = 4; // matches the battery card and the firmware

  /* ------------------------------------------------------------------ *
   * Geometry of the house scene (the system view).
   *
   * The drawing, the furniture and every pipe read their anchors from here,
   * so a pipe can never end a few units away from the thing it connects to -
   * that mismatch is what makes a hand drawn scene look broken.  All of it is
   * fixed: nothing in here depends on a reading.
   * ------------------------------------------------------------------ */
  const HX = {
    ground: 392, // the line the whole house stands on
    wingL: 88, wingR: 258, // low wing on the left (flat roof, PV1)
    wingRoofY: 296, wingEaveY: 310,
    wallL: 310, wallR: 604, // main block
    eave: 196, ridgeX: 458, ridgeY: 90,
    busX: 545, // vertical run inside the house every branch meets
    busTop: 232, // where the PV2 spur takes over
    busBottom: 370, // where the pack's horizontal run joins
    meterX: 654, meterY: 316, // meter box / on-grid port on the right wall
    /* The branches.  Written from the source towards the house, so a pipe's
       own direction is what `reverse` flips when the power runs the other
       way.  Straight segments only - the round line joins do the corners. */
    routes: {
      pv1: "M160 310 V344 H252", // PV1 roof down, then right into the pack
      bat: "M306 370 H545", // pack, across the ground floor, to the bus
      bus: "M545 370 V232", // the bus, from the pack up to the upper floor
      pv2: "M545 232 V184", // PV2 spur, down into the bus
      grid: "M545 320 H628", // bus out through the wall to the meter
      plug: "M545 332 H506", // bus to the smart socket
    },
  };

  /**
   * `soc` is the state of charge in percent (0..100) or null when the reading
   * is unknown, `packs` the number of battery modules to draw. Only the cell
   * area under the head is filled, so the dark BMS module stays dark at 100 %
   * exactly as it does on the device page.
   */
  function stackMarkup(soc, packs) {
    const count = Math.max(1, Math.min(Math.round(num(packs)) || 1, STACK_MAX_PACKS));
    const known = soc !== null && soc !== undefined && !Number.isNaN(num(soc));
    const frac = known ? clamp(num(soc), 0, 100) / 100 : 0;

    const h = STACK_HEAD_H + count * STACK_MOD_H;
    const top = STACK_BOTTOM - h;
    const modTop = top + STACK_HEAD_H; // the cells start under the head
    const modH = STACK_BOTTOM - modTop;
    const fillH = modH * frac;
    const cx = STACK_X + STACK_W / 2;

    const modules = [];
    const seams = [];
    for (let i = 0; i < count; i += 1) {
      const y = modTop + i * STACK_MOD_H;
      modules.push(`<rect x="${STACK_X}" y="${y}" width="${STACK_W}"
        height="${STACK_MOD_H}" fill="url(#hm-pf-bat-mod)"/>`);
      /* Separators go on top of the green fill, so the pack count stays
         readable at any state of charge. */
      if (i > 0) {
        seams.push(`<rect x="${STACK_X}" y="${y}" width="${STACK_W}" height="1"
          fill="rgba(255,255,255,0.55)"/>`);
      }
    }

    return `
    <g class="pf-stack">
      <defs>
        <clipPath id="hm-pf-stack-face">
          <rect x="${STACK_X}" y="${top}" width="${STACK_W}" height="${h}" rx="5"/>
        </clipPath>
      </defs>
      <rect x="${STACK_X + STACK_W}" y="${top + 4}" width="${STACK_SIDE}"
            height="${h - 4}" rx="3" fill="url(#hm-pf-bat-side)"/>
      <rect x="${STACK_X}" y="${top}" width="${STACK_W}" height="${h}"
            rx="5" fill="#b8bec6"/>
      ${modules.join("")}
      ${fillH > 0 ? `<g clip-path="url(#hm-pf-stack-face)">
        <rect x="${STACK_X}" y="${(STACK_BOTTOM - fillH).toFixed(2)}"
              width="${STACK_W}" height="${fillH.toFixed(2)}"
              fill="${COLORS.battery}"/>
      </g>` : ""}
      ${seams.join("")}
      <rect x="${STACK_X}" y="${top}" width="${STACK_W}" height="${h}" rx="5"
            fill="none" stroke="rgba(15,23,42,0.22)" stroke-width="0.8"/>
      <path d="M${STACK_X} ${top + 5} a5 5 0 0 1 5 -5 h${STACK_W - 10}
               a5 5 0 0 1 5 5 v${STACK_HEAD_H - 5} h-${STACK_W} z"
            fill="url(#hm-pf-bat-top)"/>
      <rect x="${STACK_X}" y="${modTop - 1}" width="${STACK_W}" height="1"
            fill="rgba(0,0,0,0.30)"/>
      <circle cx="${cx}" cy="${top + 6.5}" r="3.4" fill="none"
              stroke="rgba(255,255,255,0.24)" stroke-width="0.9"/>
      <text x="${cx}" y="${top + 8.6}" text-anchor="middle" font-size="5"
            font-weight="600" fill="rgba(255,255,255,0.55)">H</text>
      <rect x="${STACK_X + 5}" y="${STACK_BOTTOM}" width="6" height="6" rx="1.5" fill="#23272d"/>
      <rect x="${cx - 3}" y="${STACK_BOTTOM}" width="6" height="6" rx="1.5" fill="#23272d"/>
      <rect x="${STACK_X + STACK_W - 11}" y="${STACK_BOTTOM}" width="6" height="6" rx="1.5" fill="#23272d"/>
    </g>`;
  }

  /**
   * Turn one of our connectors into the list of points it travels through.
   *
   * The routes below are short paths of `M / L / H / V` segments plus rounded
   * corners written as `Q`; the parser understands exactly those five
   * commands, and remembers each corner's control point so a reversed copy can
   * be rebuilt with the same shape.
   *
   * A token parser is used instead of slicing the string with a regex because
   * a regex cannot tell a command's arguments from the next command's: the
   * pattern used here before swallowed the control point of
   * `Q104 200 114 200` into the argument list of the preceding `V`, which
   * turned the real path "M104 142 V190 Q104 200 114 200 H283" into a seven
   * point zigzag.  The flow on every charging battery and on PV1 therefore
   * jumped up and down the left connector - the direction looked broken
   * because the path itself was.
   */
  function parsePath(d) {
    const tokens = String(d).match(/[MLHVQ]|-?\d*\.?\d+/gi) || [];
    const pts = [];
    let cmd = "M";
    let x = 0;
    let y = 0;
    let i = 0;
    const next = () => Number(tokens[i++]);
    while (i < tokens.length) {
      if (/^[MLHVQ]$/i.test(tokens[i])) { cmd = tokens[i].toUpperCase(); i += 1; }
      if (i >= tokens.length) break;
      if (cmd === "M" || cmd === "L") {
        x = next(); y = next(); pts.push({ x, y, q: null });
      } else if (cmd === "H") {
        x = next(); pts.push({ x, y, q: null });
      } else if (cmd === "V") {
        y = next(); pts.push({ x, y, q: null });
      } else if (cmd === "Q") {
        const cx = next();
        const cy = next();
        x = next();
        y = next();
        pts.push({ x, y, q: { x: cx, y: cy } });
      } else {
        break;
      }
    }
    return pts;
  }

  /**
   * Flatten one of our connectors into a polyline with cumulative lengths.
   *
   * Only the total length is needed now - the pulse is a dash pattern, so the
   * browser works out where along the path it sits - but the polyline is what
   * gives that length without calling `getPointAtLength` on a live element, and
   * it keeps the arithmetic testable outside a browser.
   */
  function pathPolyline(d) {
    const pts = parsePath(d);
    const line = [];
    if (!pts.length) return line;
    let s = 0;
    line.push({ x: pts[0].x, y: pts[0].y, s: 0 });

    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!b.q) {
        s += Math.hypot(b.x - a.x, b.y - a.y);
        line.push({ x: b.x, y: b.y, s });
        continue;
      }
      /* Rounded corner: a quadratic Bezier, sampled finely enough that
         interpolating between the samples cannot be seen. */
      let px = a.x;
      let py = a.y;
      for (let k = 1; k <= CURVE_STEPS; k += 1) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        const x = u * u * a.x + 2 * u * t * b.q.x + t * t * b.x;
        const y = u * u * a.y + 2 * u * t * b.q.y + t * t * b.y;
        s += Math.hypot(x - px, y - py);
        line.push({ x, y, s });
        px = x;
        py = y;
      }
    }
    return line;
  }

  /* Same path string in, same polyline out - the routes never change while the
     page is up, so this is built a handful of times and then reused. */
  const POLYLINE_CACHE = new Map();

  function polyline(d) {
    const key = String(d);
    let line = POLYLINE_CACHE.get(key);
    if (!line) {
      line = pathPolyline(key);
      POLYLINE_CACHE.set(key, line);
    }
    return line;
  }

  /** Total length of a polyline (0 for a degenerate path). */
  function polylineLength(line) {
    return line.length ? line[line.length - 1].s : 0;
  }

  /** Length of one of our connectors, in SVG user units. */
  function pathLength(d) {
    return polylineLength(polyline(d));
  }

  /**
   * How fast a pulse travels, in SVG units per second.
   *
   * The power sets the speed, but the *travel time* is kept between
   * `FLOW_DUR_MIN` and `FLOW_DUR_MAX`: an 18 unit stub would otherwise flick
   * past in a flash, and a long connector at low power would crawl.
   */
  function flowSpeed(power, len, speedScale = 1) {
    const scale = speedScale > 0 ? speedScale : 1;
    const raw = clamp(
      FLOW_SPEED_MIN + Math.abs(num(power)) * FLOW_SPEED_PER_W,
      FLOW_SPEED_MIN, FLOW_SPEED_MAX,
    ) * scale;
    if (!(len > 0)) return raw;
    return clamp(raw, len / FLOW_DUR_MAX, len / FLOW_DUR_MIN);
  }

  /**
   * Reversed copy of a connector, so a flow can run the other way (charging
   * into the battery, importing from the grid) without moving the drawing:
   * "M236 182 H105 V376" -> "M105 376 V182 H236".
   *
   * Both traps worth remembering: a segment that changes in *both* x and y
   * must stay an `L` (emitting `H` collapsed the two diagonals into a
   * horizontal line, so their flow flew off the drawing), and a rounded
   * corner keeps its control point when it is walked backwards.
   *
   * Done here instead of with SMIL `keyPoints` because keyPoints support is
   * uneven across browsers.
   */
  function reversePath(d) {
    const pts = parsePath(d);
    if (pts.length < 2) return String(d);
    const back = pts.slice().reverse();
    let out = `M${back[0].x} ${back[0].y}`;
    for (let i = 1; i < back.length; i += 1) {
      const prev = back[i - 1];
      const p = back[i];
      /* A control point belongs to the segment *ending* at its point, so once
         the path is walked backwards it is the segment's first point that
         carries it.  Using the segment's last point instead put the corner in
         the wrong place (a long curve instead of a straight run plus a bend). */
      if (prev.q) out += ` Q${prev.q.x} ${prev.q.y} ${p.x} ${p.y}`;
      else if (p.y === prev.y) out += ` H${p.x}`;
      else if (p.x === prev.x) out += ` V${p.y}`;
      else out += ` L${p.x} ${p.y}`;
    }
    return out;
  }

  /* The reversed copy of each connector, built once: `reversePath` parses the
     path and rebuilds a string, and every render asks for it again. */
  const REVERSED_CACHE = new Map();

  function travelPath(route) {
    if (!route.reverse) return route.d;
    const key = String(route.d);
    let back = REVERSED_CACHE.get(key);
    if (back === undefined) {
      back = reversePath(key);
      REVERSED_CACHE.set(key, back);
    }
    return back;
  }

  /**
   * Markup for the streak of one connector.
   *
   * `plan` carries the geometry and the timing already worked out by
   * `_beamPlan`, so this only has to turn them into a run of slices.
   *
   * Each slice gets its three keyframe stops as custom properties:
   *
   *   --hm-from  the whole streak still outside the start of the connector
   *   --hm-to    the head has just reached the far end
   *   --hm-park  the whole streak is past the far end, i.e. it has left
   *
   * A slice's own offset is the head's offset plus `i * slice`, which places it
   * `i * slice` further back along the dash pattern.  All of them run on one
   * animation, so the run stays rigid while it travels.
   *
   * The gradient lives in `colour` / `opacity` / `width`: white and opaque at
   * the head, the branch colour and nearly nothing at the tail.  `linecap` is
   * `butt` for the body - a round cap would bulge out of the pipe and make each
   * slice visible as a bead - and `round` for the head, so the streak starts in
   * a small dome instead of a cut edge.
   */
  function flowBeam(plan) {
    const { route, travel, len, duration, phase } = plan;
    const streak = clamp(len * STREAK_SHARE, STREAK_MIN, Math.min(STREAK_MAX, len));
    const slice = streak / STREAK_SLICES;
    /* The gap is well over the connector, so the pattern cannot repeat on it:
       exactly one streak is ever on the wire, however long the line is. */
    const gap = 2 * len + slice;
    /* A negative delay is the part of the cycle that has already run, which is
       how a rebuilt path resumes at the distance it had reached. */
    const delay = (-phase * duration).toFixed(2);

    let out = "";
    for (let i = 0; i < STREAK_SLICES; i += 1) {
      /* 0 at the head, 1 at the tail. */
      const t = i / (STREAK_SLICES - 1);
      const shift = i * slice;
      const from = slice + shift;
      const to = slice - len + shift;
      const park = slice - len - streak + shift;
      const width = (STREAK_WIDTH - (STREAK_WIDTH - STREAK_TIP) * t).toFixed(2);
      /* Nearly gone by the tail, but not quite: a slice that reaches zero
         disappears in a step of its own, which is exactly the banding this is
         meant to avoid. */
      const opacity = (1 - 0.94 * t).toFixed(3);
      const colour = mixHex("#ffffff", route.color, Math.min(1, t * 1.7));

      out += `
        <path d="${esc(travel)}" fill="none" stroke="${colour}"
              stroke-width="${width}" stroke-opacity="${opacity}"
              stroke-linecap="${i === 0 ? "round" : "butt"}"
              stroke-dasharray="${slice.toFixed(2)} ${gap.toFixed(2)}"
              style="--hm-from:${from.toFixed(2)}px;--hm-to:${to.toFixed(2)}px;`
        + `--hm-park:${park.toFixed(2)}px;`
        + `animation-duration:${duration.toFixed(2)}s;animation-delay:${delay}s"/>`;
    }

    return `<g class="pf-beam" data-pf-beam="${route.id}">${out}</g>`;
  }

  /* ------------------------------------------------------------------ *
   * Tiny helpers (kept local, the card is standalone)
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

  /** "1058.9" -> "1 058.9"; keeps the big numbers readable in the diagram. */
  function group(value) {
    const parts = String(value).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  /** Absolute power as it is shown under each node. */
  function fmtW(value) {
    const abs = Math.abs(num(value));
    const text = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    return `${group(text)} W`;
  }

  /**
   * A reading as an update key: the value at the precision it is *printed*
   * with, plus whether that branch counts as live.
   *
   * `shouldUpdate()` compares these, so rounding here is what keeps a change in
   * the third decimal from rebuilding the entire diagram.  The sign is kept -
   * it decides which way the flow runs - and the idle / live threshold is added
   * explicitly, because that is not a printing decision and losing it would
   * leave a branch grey at exactly `MIN_FLOW`.
   */
  function wkey(value) {
    if (value === null || value === undefined) return "x";
    const v = Number(value);
    if (!Number.isFinite(v)) return "x";
    const text = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
    return `${text}|${Math.abs(v) >= MIN_FLOW ? 1 : 0}`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
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
   * Used to walk the streak from white at its head to the branch colour at its
   * tail.  Interpolating in sRGB is not colour correct, but the two ends are
   * close enough in lightness that the difference is invisible here - and it
   * needs no colour space machinery.
   */
  function mixHex(from, to, t) {
    const a = hexRgb(from);
    const b = hexRgb(to);
    const k = clamp(t, 0, 1);
    const parts = a.map((v, i) => Math.round(v + (b[i] - v) * k));
    return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
  }

  /**
   * Signal strength tiers, shared with the battery card so both cards draw the
   * same icon for the same reading. Returns the number of lit bars (0..4).
   */
  function rssiBars(rssi) {
    if (rssi === null || !Number.isFinite(rssi)) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -75) return 2;
    return 1;
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesPowerFlow extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
      /* Streak phase, one entry per connector, 0..1 of its cycle.  It is advanced
         once per render (see `_beamPlan`) and the CSS animation carries the
         streak the rest of the way.  Deliberately not cleared by `setConfig`, so
         editing an unrelated option does not restart every streak. */
      this._pfPhase = new Map(); // route id -> 0..1 of one trip
      this._pfClock = 0; // ms of the last phase advance
      /* `grid_mode: auto` latches here once a negative load proves that
         `sys_grid_p` is not a meter reading; see `_hasMeter`. */
      this._sawNegativeLoad = false;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-power-flow-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 10px 12px 6px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 8px;
                justify-content: space-between; margin: 2px 4px 4px; }
        .head.bare { justify-content: flex-end; }
        .hname { font-size: 20px; font-weight: 600;
                 color: var(--primary-text-color); letter-spacing: 0.2px; }
        .hname .dev { font-size: 13px; font-weight: 400; opacity: 0.65;
                      margin-left: 6px; }
        .hright { display: flex; align-items: center; gap: 14px; flex: none; }
        .signal { display: inline-flex; align-items: center; gap: 6px;
                  font-size: 13.5px; color: var(--secondary-text-color);
                  font-variant-numeric: tabular-nums; }
        .signal .bars { display: block; width: 22px; height: 18px; flex: none; }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                font-size: 14px; color: var(--primary-text-color); }
        .wrap { display: flex; justify-content: center; }
        svg { display: block; width: 100%; height: auto; }

        /* --- the schematic ------------------------------------------------
           Thick rounded connectors, ringed icon nodes and the inverter box.
           The ring is the only coloured part of a node: the glyph inside stays
           grey so a live branch is readable at a glance. */
        .pf-edge { stroke: var(--hm-pf-edge, #d3dae3); stroke-width: 6.8;
                   stroke-linecap: round; stroke-linejoin: round; }
        .pf-junction { fill: var(--hm-pf-edge, #d3dae3); }
        /* Nodes are bitmaps: the artwork carries the ring and the glyph, so
           nothing is stroked on top of it.  The .pf-unit class is the one in
           the middle, which the app draws a little larger. */
        .pf-ic { display: block; }

        /* --- the streak ----------------------------------------------------
           The connector keeps its own grey colour; what travels along it is one
           streak of light, cut into slices that fade out.

           The three stops are CSS variables because they depend on the length of
           the connector, which the keyframes cannot know.  A custom property in
           a keyframe is substituted per element, so this is the only way to give
           every path its own travel distance while all of them share one
           animation.  The 72% stop has to stay in step with STREAK_TRAVEL.

           stroke-linecap is deliberately NOT declared here.  A rule with the
           same specificity as the presentation attribute wins, and this one used
           to say round - which turned every slice into a capsule wider than the
           gap between slices, so the fade came out as a row of visible beads.
           The cap now belongs to each path (butt for the body, round at the
           head), and a stylesheet rule would silently undo that again.

           stroke-dashoffset is written with px on purpose: user units and px are
           the same inside an SVG here, and a bare number is only valid in a
           presentation attribute, not in a CSS declaration. */
        .pf-beam path {
          fill: none;
          stroke-linejoin: round;
          animation-name: hm-flow-run;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        @keyframes hm-flow-run {
          0% { stroke-dashoffset: var(--hm-from, 100px); }
          72% { stroke-dashoffset: var(--hm-to, 0px); }
          100% { stroke-dashoffset: var(--hm-park, -100px); }
        }

        .pf-v { font-size: 19px; font-weight: 600;
                fill: #1f2933; letter-spacing: 0.2px; }
        .pf-soc { font-size: 15px; font-weight: 500; opacity: 0.9; }
        .pf-c { font-size: 13px; fill: #8b95a5; }

        /* --- the house scene (system view) -------------------------------
           A pipe is two strokes: a soft outline and a white core.  One flat
           colour would vanish either on the warm interior or against the sky,
           and the pipes have to be read over both. */
        .pf-pipe { fill: none; stroke: rgba(139, 160, 182, 0.34);
                   stroke-width: 13.5; stroke-linecap: round;
                   stroke-linejoin: round; }
        .pf-pipe-core { fill: none; stroke: #ffffff; stroke-width: 10;
                        stroke-linecap: round; stroke-linejoin: round; }
        .pf-kw { font-size: 19px; font-weight: 700; fill: #1f2933;
                 letter-spacing: 0.2px; font-variant-numeric: tabular-nums; }
        .pf-kc { font-size: 12px; fill: #8b95a5; }
        .pf-lead { fill: none; stroke: #c3ced9; stroke-width: 1; }
        .note { font-size: 12px; color: var(--secondary-text-color);
                text-align: center; padding: 4px 0 8px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-power-flow: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
    }

    getCardSize() {
      return 9;
    }

    /**
     * ``quick/state`` arrives every second, but the drawing only depends on a
     * handful of values — rebuilding the whole SVG on every push is wasteful
     * on a Raspberry Pi, so re-render only when something visible changed.
     */
    shouldUpdate() {
      if (!this._config || !this._hass) return true;
      const signature = this._signature();
      if (signature === this._signatureCache) return false;
      this._signatureCache = signature;
      return true;
    }

    _signature() {
      const d = this._data();
      return [
        hmLang(this._hass, this._config),
        this._config.gradient, this._config.max_width,
        this._text(this._config.title), this._config.show_title, this._config.show_rssi,
        this._config.flow_speed,
        /* `auto` latches on a negative load, so the resolved layout - not just
           the setting - is part of what the drawing depends on. */
        this._config.grid_mode, this._sawNegativeLoad,
        this._temperature(),
        /* Readings are compared at the precision the card prints them with.
           They wiggle in their last digit every second, and rebuilding the
           whole diagram for that makes the browser re-decode the seven
           embedded icons on every push - visible as a hitch on a Raspberry Pi.
           The idle / live threshold is not a printing decision, so it is part
           of the key: otherwise a branch could stay grey at exactly MIN_FLOW. */
        wkey(d.pv), wkey(d.pv2), wkey(d.grid), wkey(d.load), wkey(d.smartPlug),
        wkey(d.battery),
        d.soc === null || d.soc === undefined ? "x" : num(d.soc).toFixed(2),
        d.status, d.rssi, d.packs,
      ].join("\u0001");
    }

    /** Multiplier for the streak speed (`flow_speed`, 1 = default). */
    _flowSpeed() {
      const scale = num(this._config && this._config.flow_speed);
      return scale > 0 ? scale : 1;
    }

    /* --------------------------- the streak --------------------------- */

    /**
     * Work out where every streak is, and how long one trip takes.
     *
     * One entry per lit connector: the geometry (so the caller does not parse the
     * path twice), the duration of one cycle and the phase, 0..1.  A route that
     * carries too little power is left out, and so is a degenerate path.
     *
     * The phase is the only state, and it is advanced here rather than by the
     * browser because the CSS animation is restarted by every re-render - it just
     * gets the phase back through a negative `animation-delay`.  Advancing by
     * `dt / duration` keeps the position continuous when the speed changes: a
     * faster trip covers the same fraction of the connector in less time.
     *
     * The step is clamped because a hidden tab stops painting, and the minutes
     * it was away must not be added as one huge jump.
     */
    _beamPlan(routes) {
      const now = (typeof performance !== "undefined"
        && typeof performance.now === "function")
        ? performance.now()
        : Date.now();
      const last = this._pfClock || now;
      this._pfClock = now;
      const dt = Math.min(Math.max((now - last) / 1000, 0), 5);

      const scale = this._flowSpeed();
      const plan = [];

      for (const route of routes) {
        const power = Math.abs(num(route.power));
        if (power < MIN_FLOW) continue;
        const travel = travelPath(route);
        const len = pathLength(travel);
        if (!(len > 0)) continue;

        /* `flowSpeed` is the speed *while travelling*; the cycle also contains
           the pause after the streak has left, so one trip takes longer than
           `len / speed`. */
        const speed = flowSpeed(power, len, scale);
        const duration = clamp(len / (speed * STREAK_TRAVEL), 0.8, 12);

        const known = this._pfPhase.get(route.id);
        const phase = dt > 0 && Number.isFinite(known)
          ? (known + dt / duration) % 1
          : (Number.isFinite(known) ? known : 0);
        this._pfPhase.set(route.id, phase);

        plan.push({ route, travel, len, duration, phase });
      }
      return plan;
    }

    /**
     * Language changes are announced on `window`; re-rendering is all a card
     * has to do, because the wording is chosen while it renders.
     */
    connectedCallback() {
      super.connectedCallback();
      /* The pulse is a CSS animation, so it keeps running across a detach and
         re-attach by itself - switching dashboard tabs used to freeze it, which
         is why the old dot animation needed a requestAnimationFrame loop that
         had to be restarted by hand.  Only the clock is forgotten, otherwise the
         first render after coming back would add the whole time away. */
      this._pfClock = 0;
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
      this._pfClock = 0;
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
     * Resolve an entity id for this device.
     *
     * Three strategies, cheapest first: the conventional
     * ``<domain>.<slug(dev_id)>_<suffix>`` id, a prefix+suffix scan and
     * finally the integration's ``hoymiles_<dev_id>_<suffix>`` unique id.
     * Results are cached, because the scan is O(entities) and the card
     * re-renders on every state change.
     */
    _resolveEntity(suffix, domain = "sensor") {
      const overrides = (this._config.entities || {});
      if (overrides[suffix]) return overrides[suffix];

      const cacheKey = `${domain}:${suffix}`;
      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${suffix}`;
      let found = hass.states[conventional] ? conventional : null;

      if (!found) {
        // Normalized exact match on the part after `<domain>.<dev>_`.  Using
        // the normalized tail (instead of a plain suffix test) keeps `soc`
        // from matching `system_soc` and still accepts `pack_1_soc` for
        // `pack1_soc`.
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

    /** Numeric state of a device sensor, or `fallback` when unavailable. */
    _read(suffix, fallback = 0, domain = "sensor") {
      const state = this._stateOf(suffix, domain);
      if (!state) return fallback;
      const value = Number(state.state);
      return Number.isFinite(value) ? value : fallback;
    }

    /** Raw string state of a device sensor (used for `bat_sts`). */
    _readText(suffix) {
      const state = this._stateOf(suffix);
      return state ? String(state.state) : "";
    }

    /** State object of a device sensor, or null when missing/unavailable. */
    _stateOf(suffix, domain = "sensor") {
      const entityId = this._resolveEntity(suffix, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unavailable" || value === "unknown") return null;
      return state;
    }

    /** Collect everything the drawing needs in one pass. */
    _data() {
      // The five branches the schematic draws all come from the 1 s
      // `quick/state` payload, i.e. the `system_*` entities the integration
      // creates: pv1 = sys_pv_p, pv2 = sys_pv2_p, grid = sys_grid_p,
      // lamp = sys_load_p, smart plug = sys_sp_p. `null` means the field is
      // absent (a slave unit does not carry the system level values) and that
      // node is left out.
      const pv = this._read("system_pv_power", null);
      const pv2 = this._read("system_pv2_power", null);
      const grid = this._read("system_grid_power", null);
      const load = this._read("system_load_power", null);
      const smartPlug = this._read("system_smart_plug_power", null);

      // Battery is the one node without a `sys_` counterpart at the system
      // level, so it keeps the usual system → device fallback.
      let battery = this._read("system_battery_power", null);
      if (battery === null) battery = this._read("bat_power", 0);

      // Battery SOC is deliberately the device level `soc` entity
      // (`quick/state`, 1 s, the average of this unit's own packs) and NOT
      // `system_soc`: the latter is capacity weighted across the whole network
      // (this unit plus every slave), so it reads differently from the gauge on
      // the dashboard and from the per-pack values.
      let soc = this._read("soc", null);
      if (soc === null) soc = this._read("system_soc", null);

      let status = this._readText("battery_status");
      if (!status) status = this._readText("bat_sts");

      // Wi-Fi signal strength; the power flow card prints it as a fan in the
      // top right corner of the header.
      const rssi = this._read("rssi", null);

      // How many battery modules the illustration draws. `pack_count` is
      // authoritative, but it is a diagnostic entity and may be hidden or
      // missing on older firmware, so the highest pack that actually reports a
      // SOC is used as the fallback (the battery card does the same).
      let packs = 0;
      for (let i = 1; i <= STACK_MAX_PACKS; i += 1) {
        if (this._stateOf(`pack${i}_soc`)) packs = i;
      }
      const declared = Math.round(this._read("pack_count", 0));
      packs = Math.max(1, Math.min(declared > 0 ? declared : packs, STACK_MAX_PACKS));

      return {
        pv, pv2, grid, load, smartPlug, battery, soc,
        status: status.toLowerCase(), rssi, packs,
      };
    }

    /* ----------------------------- render ----------------------------- */

    render() {
      if (!this._config) return html``;
      const d = this._data();
      const temp = this._temperature();
      const showName = this._showName();

      return html`
        <ha-card>
          <div class="head ${showName ? "" : "bare"}">
            ${showName ? html`
              <div class="hname">
                ${esc(this._text(this._config.title) || this._t("My home", "我的家"))}
                <span class="dev">${esc(this._dev())}</span>
              </div>` : ""}
            <div class="hright">
              ${this._signal(d)}
              ${temp === null ? "" : html`
                <div class="chip">
                  <span>☀️</span><span>${temp}</span>
                </div>`}
            </div>
          </div>
          <div class="wrap" style=${this._wrapStyle()}>
            ${this._untrusted(this._svg(d))}
          </div>
        </ha-card>
      `;
    }

    /** The title block (heading + device id) can be hidden with `show_title`.
     * ``title: false`` works too, so a single switch is enough in YAML.
     */
    _showName() {
      return this._config.show_title !== false && this._text(this._config.title) !== false;
    }

    _wrapStyle() {
      const width = num(this._config.max_width);
      return width > 0 ? `max-width:${width}px` : "max-width:620px";
    }

    _temperature() {
      const entityId = this._config.temperature_entity;
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state || state.state === "unavailable" || state.state === "unknown") {
        return null;
      }
      const unit = (state.attributes && state.attributes.unit_of_measurement) || "°C";
      return `${num(state.state).toFixed(0)}${unit}`;
    }

    /**
     * RSSI shown in the top right corner: the same four-bar Wi-Fi icon the
     * battery card uses, plus the raw dBm reading.  Hidden when the device
     * reports no signal value, and switchable off with ``show_rssi: false``.
     */
    _signal(d) {
      if (this._config.show_rssi === false) return null;
      const rssi = d.rssi;
      if (rssi === null || !Number.isFinite(rssi)) return null;

      const bars = rssiBars(rssi);
      const quality = bars === 4 ? this._t("excellent", "优秀")
        : bars === 3 ? this._t("good", "良好")
          : bars === 2 ? this._t("fair", "一般")
            : this._t("weak", "较弱");

      return html`
        <div class="signal" title=${`${this._t("Wi-Fi signal", "Wi-Fi 信号")}: ${quality}`}>
          ${this._untrusted(this._signalBars(bars))}
          <span>${rssi.toFixed(0)} dBm</span>
        </div>`;
    }

    /**
     * The icon: four bars of increasing height. Geometry and colours match
     * ``hoymiles-battery``'s `_signal()` exactly, so the same reading looks
     * identical on both cards.
     */
    _signalBars(bars) {
      const color = bars === 0
        ? "var(--disabled-text-color, #b6bcc4)"
        : "var(--primary-color)";
      let out = "<svg class=\"bars\" width=\"22\" height=\"18\" viewBox=\"0 0 22 18\" "
        + "xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\">";
      for (let i = 0; i < 4; i += 1) {
        const h = 4 + i * 3.4;
        out += `<rect x="${1 + i * 5}" y="${16 - h}" width="3.4" height="${h}" rx="1.4"`
          + ` fill="${i < bars ? color : "var(--divider-color, #dcdfe4)"}"/>`;
      }
      return `${out}</svg>`;
    }

    /* --------------------------- the diagram --------------------------- */

    /**
     * Is there a grid meter in this system?
     *
     * The protocol carries no such flag.  `sys_grid_p` *is* the meter reading,
     * so it is 0 both when no meter is installed and when a metered system is
     * holding a perfect zero exchange - the two are indistinguishable on the
     * wire.  `sys_load_p` is worse than useless as a hint: it is computed as
     * `grid + plug + pv2 - sp`, so with no meter it collapses to the on-grid
     * port power and goes *negative* whenever the unit charges from the house.
     *
     * Hence `grid_mode`:
     *   meter     - the two nodes are drawn separately (the old behaviour)
     *   no_meter  - grid and load are one node, fed by / feeding the house
     *   auto      - starts as `meter` and switches over the first time the
     *               load reads negative.  A house load can only consume, so a
     *               negative figure is proof that `sys_grid_p` is not a
     *               measurement.  The verdict is latched: a meter does not
     *               disappear, and flipping the layout back and forth between
     *               samples would be worse than either answer.
     */
    _hasMeter(d) {
      const mode = String((this._config || {}).grid_mode || "auto").toLowerCase();
      if (mode === "meter") return true;
      if (mode === "no_meter" || mode === "nometer") return false;
      if (num(d.load) < -METER_PROOF_W) this._sawNegativeLoad = true;
      return !this._sawNegativeLoad;
    }

    _svg(d) {
      return this._schematic(d);
    }

    /* The ring-and-connector schematic, which is what `_svg` draws.  The house
       scene below is no longer reachable (the user asked for the wiring
       diagram back) but is kept, so switching between the two is one line. */
    _schematic(d) {
      const present = (v) => v !== null && v !== undefined && !Number.isNaN(num(v));
      const hasMeter = this._hasMeter(d);

       /* The wiring diagram: PV1 / storage run into the inverter's left side, the
         inverter's right side meets a junction on the right edge, and the
         remaining branches fan out from that junction.  Each branch is one
         path, so the light pulse can simply run along it. */
      /* Direction of every connector, decided in one place.
       *
       * A route is always *written* from its own node towards the inverter /
       * junction, so `reverse: true` means "the power runs from the far end
       * back into this branch's node".  Getting this the wrong way round is
       * very visible: the pulse then travels against the energy flow.
       *
       *   pv, pv2      producing            node     -> junction
       *   battery      discharging (>= 0)   node     -> inverter
       *                charging    (<  0)   inverter -> node
       *   grid         importing   (>  0)   grid     -> junction
       *                exporting   (<  0)   junction -> grid
       *   load, plug   consuming   (>= 0)   junction -> node
       */
      const charging = num(d.battery) < 0;
      const trunk = num(d.pv) + num(d.pv2) + num(d.battery); // W into the junction

      const routes = [
        { id: "pv", d: "M104 142 V190 Q104 200 114 200 H283", power: d.pv,
          color: COLORS.pv, reverse: num(d.pv) < 0 },
        { id: "battery", d: "M104 322 V274 Q104 264 114 264 H283", power: d.battery,
          color: COLORS.battery, reverse: charging },
        { id: "trunk", d: `M361 ${JUNCTION.y} H594`, power: trunk,
          color: COLORS.pv, reverse: trunk < 0 },
        {
          /* With a meter this branch is the meter's reading.  Without one there
             is nothing to measure except the on-grid port, which *is* the house
             connection - so the same branch carries the house instead, and the
             node below is captioned "Grid & load". */
          id: "grid",
          d: `M600 142 V${JUNCTION.y - 6}`,
          power: hasMeter ? d.grid : d.load,
          color: (hasMeter ? num(d.grid) >= 0 : num(d.load) >= 0)
            ? COLORS.grid
            : COLORS.grid_out,
          reverse: hasMeter ? num(d.grid) < 0 : num(d.load) >= 0,
        },
      ];
      if (present(d.pv2)) {
        routes.push({ id: "pv2", d: PV2_ROUTE, power: d.pv2,
          color: COLORS.pv6, reverse: num(d.pv2) < 0 });
      }
      if (present(d.load) && hasMeter) {
        routes.push({ id: "load", d: LAMP_ROUTE, power: d.load,
          color: COLORS.load, reverse: num(d.load) >= 0 });
      }
      if (present(d.smartPlug)) {
        routes.push({ id: "plug", d: `M600 322 V${JUNCTION.y + 6}`,
          power: d.smartPlug, color: COLORS.sp, reverse: num(d.smartPlug) >= 0 });
      }

      const edges = routes.map((r) => `
        <path class="pf-edge" d="${r.d}" fill="none"
              vector-effect="non-scaling-stroke"/>`).join("");

      const beams = this._beamPlan(routes).map(flowBeam).join("");

      /* One icon per node and the unit in the middle.  A branch whose entity is
         absent is dropped (and its connector with it); a branch that exists but
         reads zero is still drawn, in its dim variant - exactly like the app. */
      const nodes = this._nodes(d, {
        pv2: present(d.pv2),
        plug: present(d.smartPlug),
        lamp: present(d.load) && hasMeter,
        grid: present(d.grid) && hasMeter,
        merged: present(d.load) && !hasMeter,
      });

      /* The unit in the middle works as soon as *anything* flows through it, so
         its artwork is coloured then and dim when the whole system is idle. */
      const busy = [d.pv, d.pv2, d.grid, d.load, d.smartPlug, d.battery]
        .some((v) => present(v) && Math.abs(num(v)) >= MIN_FLOW);

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        ${this._config.gradient === false
          ? ""
          : `<rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="#ffffff"/>`}
        <clipPath id="${NODE_CLIP_ID}" clipPathUnits="userSpaceOnUse">
          <circle cx="0" cy="0" r="${NODE_CLIP_R}"/>
        </clipPath>
        ${edges}
        ${beams}
        ${this._inverter(busy)}
        <circle class="pf-junction" cx="${JUNCTION.x}" cy="${JUNCTION.y}" r="6"/>
        ${nodes}
      </svg>`;
    }

    /* ------------------------ the house scene ------------------------ */

    /**
     * The system view as the vendor app draws it: a cut-away little house with
     * PV1 on the flat roof of the low wing, PV2 on the pitched roof, the pack
     * standing in front of it, the meter on the right hand wall and the lamp,
     * television and smart socket inside.  The pipes *are* the branches; the
     * beam runs along them exactly as it does in the schematic.
     *
     * Why a second drawing at all: a house answers "where does my energy go"
     * without having to learn what a ringed icon stands for, and it has room
     * for the appliance level detail the schematic could not show.  The data
     * plumbing and the beam are shared, so a number can never
     * disagree between the two views.
     *
     * Topology - and the reason for the arithmetic below:
     *
     *   PV1 ---> pack ---> bus ---+---> smart socket
     *                             +---> meter / on-grid port
     *   PV2 ----------------------+     and up into the rooms
     *
     * Everything PV1 makes lands on the pack first; the pack passes on what it
     * does not keep, plus its own discharge.  Written that way the pipes
     * conserve on their own, without a second guess at how the firmware split
     * the PV between charging and the house:
     *
     *   pack out = pv + bat        (bat < 0 while charging)
     *
     *   pv =    0, bat = -2145  ->  -2145   charging from the house
     *   pv =    0, bat =   +95  ->    +95   discharging
     *   pv =  500, bat =  -500  ->      0   everything into the pack
     *   pv = 1000, bat =  -300  ->   +700   pack keeps 300, house gets 700
     */
    _houseScene(d) {
      const present = (v) => v !== null && v !== undefined && !Number.isNaN(num(v));
      const hasMeter = this._hasMeter(d);

      const pv1 = Math.max(0, num(d.pv));
      const fromPack = pv1 + num(d.battery);
      const busLoad = pv1 + num(d.pv2) + num(d.battery);

      const routes = [
        { id: "pv1", d: HX.routes.pv1, power: pv1,
          color: COLORS.pv, reverse: false },
        { id: "bat", d: HX.routes.bat, power: fromPack,
          color: COLORS.battery, reverse: fromPack < 0 },
        { id: "bus", d: HX.routes.bus, power: busLoad,
          color: COLORS.battery, reverse: busLoad < 0 },
        { id: "pv2", d: HX.routes.pv2, power: num(d.pv2),
          color: COLORS.pv6, reverse: num(d.pv2) > 0 },
        {
          /* With a meter this is the meter's own reading.  Without one there
             is nothing to measure but the on-grid port, which *is* the house
             connection - so the same pipe carries the house and the badge
             says "Grid & load". */
          id: "grid",
          d: HX.routes.grid,
          power: hasMeter ? d.grid : d.load,
          color: (hasMeter ? num(d.grid) >= 0 : num(d.load) >= 0)
            ? COLORS.grid
            : COLORS.grid_out,
          reverse: hasMeter ? num(d.grid) > 0 : num(d.load) >= 0,
        },
      ];
      if (present(d.smartPlug)) {
        routes.push({ id: "plug", d: HX.routes.plug, power: d.smartPlug,
          color: COLORS.sp, reverse: num(d.smartPlug) < 0 });
      }

      /* Two strokes per pipe: a soft outline and a white core.  That is what
         makes a pipe readable on the warm interior, on the blue sky and over
         the dark roof alike - a single colour would vanish somewhere. */
      const pipes = routes.map((r) => `
        <path class="pf-pipe" d="${r.d}"/>
        <path class="pf-pipe-core" d="${r.d}"/>`).join("");

      const beams = this._beamPlan(routes).map(flowBeam).join("");

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        ${this._hxDefs()}
        ${this._config.gradient === false
          ? `<rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="#ffffff"/>`
          : this._hxBackdrop()}
        ${this._hxBuilding()}
        ${this._hxInterior()}
        ${stackMarkup(d.soc, d.packs)}
        ${this._hxMeter(hasMeter, d)}
        ${pipes}
        ${beams}
        ${this._hxLabels(d, hasMeter, present)}
      </svg>`;
    }

    /** Gradients, the port clip and the one shadow filter the scene uses. */
    _hxDefs() {
      return `
        <defs>
          <linearGradient id="hm-hx-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#dcecfa"/>
            <stop offset="55%" stop-color="#f0f8fd"/>
            <stop offset="100%" stop-color="#ffffff"/>
          </linearGradient>
          <linearGradient id="hm-hx-ground" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e9f0f7"/>
            <stop offset="100%" stop-color="#fafcfe"/>
          </linearGradient>
          <linearGradient id="hm-hx-roof" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#515b6b"/>
            <stop offset="100%" stop-color="#333b47"/>
          </linearGradient>
          <linearGradient id="hm-hx-wall" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffffff"/>
            <stop offset="70%" stop-color="#f4f7fa"/>
            <stop offset="100%" stop-color="#e4ebf3"/>
          </linearGradient>
          <linearGradient id="hm-hx-warm" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fff8ec"/>
            <stop offset="100%" stop-color="#fdeede"/>
          </linearGradient>
          <linearGradient id="hm-hx-pv1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#45c487"/>
            <stop offset="100%" stop-color="#1f9b5f"/>
          </linearGradient>
          <linearGradient id="hm-hx-pv2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#2d3e57"/>
            <stop offset="100%" stop-color="#18222f"/>
          </linearGradient>
          <linearGradient id="hm-hx-lamp" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffeec4"/>
            <stop offset="100%" stop-color="#ffd27a"/>
          </linearGradient>
          <radialGradient id="hm-hx-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#ffd27a" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#ffd27a" stop-opacity="0"/>
          </radialGradient>
          <clipPath id="hm-hx-port" clipPathUnits="userSpaceOnUse">
            <circle cx="0" cy="0" r="26"/>
          </clipPath>
        </defs>`;
    }

    /** Sky, the strip of ground the house stands on, and its contact shadow. */
    _hxBackdrop() {
      return `
        <rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="url(#hm-hx-sky)"/>
        <rect x="0" y="${HX.ground}" width="${VB_W}"
              height="${VB_H - HX.ground}" fill="url(#hm-hx-ground)"/>
        <ellipse cx="352" cy="${HX.ground + 2}" rx="300" ry="10"
                 fill="#dbe6f1" opacity="0.5"/>`;
    }

    /**
     * The two volumes: the low wing on the left (whose flat roof carries PV1)
     * and the two storey block with the pitched roof that carries PV2.
     *
     * PV1's array is drawn as a slanted quad on the roof deck rather than as a
     * rectangle, because the deck itself is in perspective - a rectangle on a
     * slanted deck is the fastest way to make the picture read as a diagram
     * again.
     */
    _hxBuilding() {
      return `
        <g class="pf-hx-building">
          <!-- low wing: the PV1 deck is its roof, so the deck has to sit on a
               volume - a floating panel reads as a table, not as a building -->
          <polygon points="88,296 102,310 102,392 88,378" fill="#ccd6e1"/>
          <rect x="102" y="310" width="142" height="82" fill="url(#hm-hx-wall)"/>
          <rect x="102" y="310" width="142" height="22" fill="rgba(15,23,42,0.05)"/>
          <polygon points="88,296 258,296 244,310 102,310"
                   fill="url(#hm-hx-pv1)"/>
          <g stroke="rgba(255,255,255,0.45)" stroke-width="1.1">
            <line x1="130.5" y1="296" x2="137.5" y2="310"/>
            <line x1="173" y1="296" x2="173" y2="310"/>
            <line x1="215.5" y1="296" x2="208.5" y2="310"/>
            <line x1="95" y1="303" x2="251" y2="303"/>
          </g>
          <polygon points="88,296 258,296 244,310 102,310"
                   fill="none" stroke="rgba(15,23,42,0.18)"/>
          <rect x="82" y="290" width="182" height="7" rx="3" fill="#c3cdd8"/>

          <!-- main block: a shaded left face, the front, then the roof -->
          <polygon points="298,196 310,206 310,392 298,382" fill="#cdd7e2"/>
          <rect x="310" y="196" width="294" height="196" fill="url(#hm-hx-wall)"/>
          <rect x="310" y="366" width="294" height="26" fill="rgba(15,23,42,0.045)"/>
          <polygon points="298,196 458,90 618,196" fill="url(#hm-hx-roof)"/>
          <polygon points="458,90 618,196 611,196 458,98" fill="rgba(255,255,255,0.07)"/>
          <rect x="292" y="192" width="332" height="10" rx="4" fill="#4b5563"/>
          <rect x="292" y="199" width="332" height="4" rx="2" fill="#333b47"/>

          <!-- PV2 on the pitched roof -->
          <polygon points="498,116.5 573.2,166.3 556.6,191.3 481.4,141.5"
                   fill="url(#hm-hx-pv2)"/>
          <g stroke="rgba(120,165,210,0.45)" stroke-width="1">
            <line x1="523.1" y1="133.1" x2="506.5" y2="158.1"/>
            <line x1="548.1" y1="149.7" x2="531.5" y2="174.7"/>
            <line x1="489.7" y1="129" x2="564.9" y2="178.9"/>
          </g>
          <polygon points="498,116.5 573.2,166.3 556.6,191.3 481.4,141.5"
                   fill="none" stroke="rgba(255,255,255,0.24)"/>
        </g>`;
    }

    /**
     * The inside of the house: two storeys of warm wall, a pendant lamp
     * upstairs and the sofa, television and smart socket downstairs.  The
     * furniture is what makes the cut-away read as a home rather than as an
     * empty box, and the socket sits where its pipe can reach it.
     */
    _hxInterior() {
      return `
        <g class="pf-hx-interior">
          <rect x="322" y="208" width="270" height="78" fill="url(#hm-hx-warm)"/>
          <rect x="316" y="286" width="282" height="8" fill="#e2e9f0"/>
          <rect x="322" y="294" width="270" height="96" fill="url(#hm-hx-warm)"/>

          <!-- upper room: a pendant lamp -->
          <circle cx="400" cy="244" r="26" fill="url(#hm-hx-glow)"/>
          <polygon points="390,236 410,236 405,247 395,247" fill="url(#hm-hx-lamp)"/>
          <rect x="398.6" y="247" width="2.8" height="14" fill="#d6c3a6"/>
          <rect x="394" y="261" width="12" height="3" rx="1.5" fill="#c9b79a"/>

          <!-- lower room: sofa, television, rug, smart socket -->
          <ellipse cx="366" cy="384" rx="46" ry="6" fill="#f0e6d4" opacity="0.75"/>
          <rect x="326" y="336" width="56" height="10" rx="4" fill="#ddcfb6"/>
          <rect x="322" y="342" width="60" height="18" rx="5" fill="#d3c3a6"/>
          <rect x="344" y="368" width="76" height="7" rx="3" fill="#e6dbc7"/>
          <rect x="396" y="334" width="54" height="28" rx="3.5" fill="#2b323b"/>
          <rect x="400" y="338" width="46" height="20" rx="2" fill="#46536a"/>

          <g class="pf-hx-socket">
            <rect x="484" y="330" width="22" height="22" rx="4.5"
                  fill="#ffffff" stroke="#d3dbe4"/>
            <circle cx="492" cy="341" r="1.6" fill="#b9c3cf"/>
            <circle cx="498" cy="341" r="1.6" fill="#b9c3cf"/>
          </g>
        </g>`;
    }

    /**
     * The right hand wall box: a meter while one is installed, the app's grid
     * artwork when it is not.
     *
     * Without a meter the branch is the on-grid port - which is the house
     * connection - so it keeps the grid slot and the grid artwork, as asked
     * for when the merged node was introduced.  The badge underneath says
     * "Grid & load" so the merge is visible without reading the code.
     */
    _hxMeter(hasMeter, d) {
      const cx = HX.meterX;
      const cy = HX.meterY;
      if (!hasMeter) {
        const busy = Math.abs(num(d.load)) >= MIN_FLOW;
        const art = PF_ICONS[`grid.${busy ? "on" : "off"}`] || "";
        return `<g class="pf-hx-port" transform="translate(${cx} ${cy})">
            <circle cx="0" cy="0" r="27" fill="#ffffff"/>
            <image x="-26" y="-26" width="52" height="52"
                   clip-path="url(#hm-hx-port)" href="${art}"/>
          </g>`;
      }
      return `<g class="pf-hx-meter">
          <rect x="628" y="286" width="52" height="60" rx="8"
                fill="#eef3f8" stroke="#cdd7e2" stroke-width="1.2"/>
          <rect x="634" y="292" width="40" height="28" rx="4"
                fill="#ffffff" stroke="#dde4ec"/>
          <circle cx="${cx}" cy="306" r="9.5" fill="#f8fafc"
                  stroke="#b7c3d1" stroke-width="1.1"/>
          <line x1="${cx}" y1="306" x2="${cx + 5}" y2="299.5"
                stroke="#ef4444" stroke-width="1.6" stroke-linecap="round"/>
          <rect x="638" y="326" width="32" height="4" rx="2" fill="#c7d1dd"/>
          <rect x="638" y="334" width="22" height="4" rx="2" fill="#d8e1ea"/>
        </g>`;
    }

    /**
     * The captions: a big number with the branch name under it, a dashed
     * leader line back to the thing being described, and a pill for the two
     * branches that have a direction worth spelling out.
     *
     * Everything is anchored to the geometry in `HX`; the room load is the
     * only caption without a pipe, because it lives inside the house - the
     * app draws it the same way, with a leader line and nothing else.
     */
    _hxLabels(d, hasMeter, present) {
      const t = (en, zh) => this._t(en, zh);
      const parts = [];

      const label = (x, y, value, caption) => {
        parts.push(`<text class="pf-kw" x="${x}" y="${y}"
                          text-anchor="middle">${esc(value)}</text>
                    <text class="pf-kc" x="${x}" y="${y + 17}"
                          text-anchor="middle">${esc(caption)}</text>`);
      };
      const lead = (path) => parts.push(`<path class="pf-lead" d="${path}"/>`);
      const badge = (x, y, text, fill, ink) => {
        /* 12 units per character is a close fit for the 11.5 px label used
           here, and the minimum keeps the two-character pills from looking
           like a dot. */
        const w = Math.max(50, text.length * 12 + 16);
        parts.push(`<rect x="${(x - w / 2).toFixed(1)}" y="${y - 10}"
                          width="${w.toFixed(1)}" height="20" rx="10" fill="${fill}"/>
                    <text x="${x}" y="${y + 4.4}" text-anchor="middle"
                          font-size="11.5" font-weight="600"
                          fill="${ink}">${esc(text)}</text>`);
      };

      /* Leader lines first, so no caption can be crossed by its own line. */
      lead("M150 414 V318"); // PV1 caption up to the roof deck
      if (present(d.smartPlug)) lead("M472 412 L494 356");
      if (hasMeter) lead("M654 394 V350");
      else lead("M654 394 V344");
      if (hasMeter && present(d.load)) lead("M338 88 L392 240");
      if (present(d.pv2)) lead("M556 88 L546 140");

      /* PV1 */
      label(146, 428, fmtW(d.pv), t("Solar1", "光伏1"));

      /* Storage: the state of charge rides along in the caption, so the pill
         above only has to carry the direction. */
      const soc = d.soc === null || d.soc === undefined
        ? "" : ` · ${num(d.soc).toFixed(1)}%`;
      label(300, 428, fmtW(d.battery), `${t("Storage", "微储")}${soc}`);

      const st = String(d.status || "");
      const discharging = st.includes("discharge");
      const charging = !discharging && st.includes("charge");
      if (charging) badge(300, 404, t("Charging", "充电中"), "#dcfce7", "#15803d");
      else if (discharging) badge(300, 404, t("Discharging", "放电中"), "#ffedd5", "#c2410c");
      else badge(300, 404, t("Standby", "待机"), "#f1f5f9", "#64748b");

      /* Smart socket */
      if (present(d.smartPlug)) {
        label(472, 428, fmtW(d.smartPlug), t("Smart plug", "智能插座"));
      }

      /* Grid, or the merged grid & load branch when there is no meter. */
      if (hasMeter) {
        const g = num(d.grid);
        if (Math.abs(g) < MIN_FLOW) {
          badge(654, 404, t("Idle", "待机"), "#f1f5f9", "#64748b");
        } else if (g > 0) {
          badge(654, 404, t("Grid in", "电网输入"), "#dbeafe", "#1d4ed8");
        } else {
          badge(654, 404, t("Grid out", "电网输出"), "#ffedd5", "#c2410c");
        }
        label(654, 428, fmtW(d.grid), t("Grid", "电网"));
      } else if (present(d.load)) {
        label(654, 428, fmtW(d.load), t("Grid & load", "电网&负载"));
      }

      /* Room load: inside the house, so a leader line instead of a pipe. */
      if (hasMeter && present(d.load)) {
        label(330, 62, fmtW(d.load), t("Other loads", "其他负载"));
      }

      /* PV2 on the roof, with the green dot the app puts next to it. */
      if (present(d.pv2)) {
        parts.push(`<circle cx="520" cy="57" r="3.6" fill="#22c55e"/>`);
        label(560, 62, fmtW(d.pv2), t("Solar2", "光伏2"));
      }

      return `<g class="pf-hx-labels">${parts.join("")}</g>`;
    }

    /**
     * The unit in the middle: the app's own "plug in a square" artwork, which
     * already carries the frame, the glyph and the pin at the bottom - so
     * nothing is stroked on top of it and there is no separate stem.
     *
     * `busy` picks the coloured or the dim variant, the same two-tone rule the
     * nodes use.
     */
    _inverter(busy) {
      const { x, y } = INV;
      const half = INV_ICON / 2;
      const art = PF_ICONS[`inverter.${busy ? "on" : "off"}`] || "";
      return `<image class="pf-ic pf-unit" x="${x - half}" y="${y - half}"
                    width="${INV_ICON}" height="${INV_ICON}" href="${art}"/>`;
    }

    /**
     * The node layer.  `opts` says which optional branches exist.
     *
     * Each node is the vendor app's own artwork, embedded as a data URI: the
     * icon carries the ring too, so nothing is drawn on top of it.  A branch
     * that carries power (|P| >= MIN_FLOW) gets the coloured icon, an idle one
     * the dim grey variant, which is how the app reads "no data here" without
     * you having to read the number.
     *
     * Every node is one group translated to its centre, and its artwork is
     * clipped to the ring (see NODE_CLIP_R) so the opaque white corner of the
     * square can never cover a connector that runs past it.
     *
     * There used to be a small arrow head on each diagonal branch showing which
     * way the power went.  It is gone: the moving pulse already says that, and
     * the arrow only added a second, coarser copy of the same information - the
     * user asked for it to be removed.
     */
    _nodes(d, opts) {
      const t = (en, zh) => this._t(en, zh);
      const working = (v) => Math.abs(num(v)) >= MIN_FLOW;
      const parts = [];

      const node = (x, y, icon, on, value, caption) => {
        const art = PF_ICONS[`${icon}.${on ? "on" : "off"}`] || "";
        parts.push(`<g class="pf-node" transform="translate(${x} ${y})">
            <image class="pf-ic" x="${-NODE_R}" y="${-NODE_R}"
                   width="${NODE_R * 2}" height="${NODE_R * 2}"
                   clip-path="url(#${NODE_CLIP_ID})" href="${art}"/>
            <text class="pf-v" x="0" y="${NODE_R + 26}"
                  text-anchor="middle">${value}</text>
            <text class="pf-c" x="0" y="${NODE_R + 46}"
                  text-anchor="middle">${esc(caption)}</text>
          </g>`);
      };

      node(NODE_COL_L, NODE_ROW_TOP, "pv", working(d.pv),
        fmtW(d.pv), t("Solar1", "光伏1"));
      node(NODE_COL_L, NODE_ROW_BOT, "battery", working(d.battery),
        `${fmtW(d.battery)}${d.soc === null ? "" : `　${num(d.soc).toFixed(2)}%`}`,
        t("Storage", "微储"));

      if (opts.pv2) {
        node(NODE_COL_M, NODE_ROW_TOP, "pv", working(d.pv2),
          fmtW(d.pv2), t("Solar2", "光伏2"));
      }
      if (opts.grid) {
        const g = num(d.grid);
        const importing = g > 0;
        // At ~0 W neither direction is true, so the node just says 电网.
        const caption = Math.abs(g) < MIN_FLOW
          ? t("Grid", "电网")
          : (importing ? t("Grid in", "电网输入") : t("Grid out", "电网输出"));
        node(NODE_COL_R, NODE_ROW_TOP, "grid", working(d.grid),
          fmtW(d.grid), caption);
      }
      if (opts.lamp) {
        node(NODE_COL_M, NODE_ROW_BOT, "load", working(d.load),
          fmtW(d.load), t("Load", "负载"));
      }
      if (opts.merged) {
        /* No meter: the grid branch is the house connection, so its node keeps
           the grid slot and the grid artwork - the label says it covers the
           load as well. */
        node(NODE_COL_R, NODE_ROW_TOP, "grid", working(d.load),
          fmtW(d.load), t("Grid & load", "电网&负载"));
      }
      if (opts.plug) {
        node(NODE_COL_R, NODE_ROW_BOT, "plug", working(d.smartPlug),
          fmtW(d.smartPlug), t("Smart plug", "智能插座"));
      }

      return parts.join("");
    }

    /** Wall clock in ms; overridable so the preview harness can fast forward. */
    _now() {
      return Date.now();
    }

    /**
     * Bottom right node of the diagram.
     *
     * With a meter it is the grid: `sys_grid_p` (`> 0` = drawing from the grid,
     * `< 0` = feeding back), and it wears the 电网输入/电网输出 pill.  Without
     * one the firmware has no way to tell the grid from the house, so the node
     * becomes 「电网&负载」 and shows the device level on-grid port power
     * `grid_on_p` instead — with no pill at all, because that combined reading
     * cannot be attributed to either side (the vendor app shows it the same
     * way).  Its sign convention is also the other way round: `< 0` = drawing
     * from the grid.
     *
     * `reverse` describes the connector: the grid line is drawn from the house
     * out to the grid, so importing has to run it backwards.
     */
    /**
     * The grid is now a plain node on the schematic: `sys_grid_p`, `> 0` =
     * drawing from the grid, `< 0` = feeding back.  The old 电网&负载 variant
     * (and the meter detection that decided between them) went away with the
     * house drawing - the card no longer guesses whether a meter is installed.
     */
    _gridNode(d) {
      const power = d.grid;
      const importing = power > 0;
      return {
        caption: importing ? this._t("Grid in", "电网输入") : this._t("Grid out", "电网输出"),
        value: fmtW(power),
        power,
        color: importing ? COLORS.grid : COLORS.grid_out,
        reverse: importing,
      };
    }

    /** Map the firmware's `bat_sts` string to a label + pill style. */
    _batteryStatus(d) {
      const table = {
        charge: { cls: "ok", en: "Charging", zh: "充电" },
        discharge: { cls: "warn", en: "Discharging", zh: "放电" },
        lock: { cls: "warn", en: "Locked", zh: "锁定" },
        standby: { cls: "", en: "Standby", zh: "待机" },
      };
      let key = d.status;
      if (!table[key]) {
        if (Math.abs(d.battery) < MIN_FLOW) key = "standby";
        else key = d.battery < 0 ? "charge" : "discharge";
      }
      const entry = table[key] || table.standby;
      return { key, cls: entry.cls, text: this._t(entry.en, entry.zh) };
    }

    /**
     * Build a DocumentFragment from raw markup.
     * Lit escapes plain strings, and it has no cheap SVG builder, so the
     * diagram goes through <template>. Every interpolated value is escaped by
     * `esc()` before it lands in the markup.
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
  class HoymilesPowerFlowEditor extends LitElement {
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
          <ha-textfield label="temperature_entity" .value=${config.temperature_entity || ""}
            @change=${this._changed("temperature_entity")}></ha-textfield>
          <ha-textfield label="max_width (px)" .value=${config.max_width || ""}
            @change=${this._changed("max_width")}></ha-textfield>
          <ha-textfield label="flow_speed (default 1, 0.5 = slower)"
            .value=${config.flow_speed === undefined ? "" : String(config.flow_speed)}
            @change=${this._changed("flow_speed")}></ha-textfield>
          <ha-textfield label="grid_mode (auto|meter|no_meter; no_meter merges grid and load)"
            .value=${config.grid_mode || ""} @change=${this._changed("grid_mode")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_title !== false}
              @change=${this._toggle("show_title")}></ha-switch>
            <span>show_title (title and device SN)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.show_rssi !== false}
              @change=${this._toggle("show_rssi")}></ha-switch>
            <span>show_rssi (signal icon)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-power-flow-editor")) {
    customElements.define("hoymiles-power-flow-editor", HoymilesPowerFlowEditor);
  }
  if (!customElements.get("hoymiles-power-flow")) {
    customElements.define("hoymiles-power-flow", HoymilesPowerFlow);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-power-flow")) {
    window.customCards.push({
      type: "hoymiles-power-flow",
      name: "Hoymiles Power Flow",
      description:
        "Illustrated live power flow (PV / storage / grid / load) of a Hoymiles "
        + "micro storage device.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmPowerFlowRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmPowerFlowRegister());
}
