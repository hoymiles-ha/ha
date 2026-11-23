/* ============================================================================
 * Hoymiles Micro Storage — Power flow card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-g2-power-flow`
 *
 * Draws the system as a **wiring diagram**, the way the vendor app does on its
 * system screen: one ringed icon per branch, the inverter in a rounded square
 * in the middle, and thick rounded connectors with a streak of light that shows the
 * direction of the power.
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
 *   type: custom:hoymiles-g2-power-flow
 *   dev_id: MSA-280520260806      # required
 *   title: My home                # optional, defaults to the device id
 *   show_title: true              # optional, false hides the title + device id
 *   language: en                  # optional (en|zh); omit to follow Home Assistant
 *   temperature_entity: sensor.x  # optional, shown next to the title
 *   alarm_entity: sensor.x        # optional; when set, a badge in the corner
 *                                 # of the drawing shows the condition - a
 *                                 # green tick with no alarms, the vendor app's
 *                                 # red warning triangle with them.  Unset on
 *                                 # the System tab, which has no single device
 *                                 # to ask.  While the alarm card beside it is
 *                                 # hidden the drawing also widens over the
 *                                 # freed columns.
 *   gradient: true                # optional white backdrop (default true)
 *   max_width: 620                # optional px cap; 0 = no cap, fill the cell;
 *                                 # omitted = 620
 *   flow_speed: 1                 # optional multiplier for the flowing streak;
 *                                 # 0.5 = half speed (calmer), 2 = faster
 *   variant: inverter             # optional; 'inverter' draws the HiFlow
 *                                 # micro-inverter layout (the PV inputs and
 *                                 # the product photo) instead of the
 *                                 # four-branch storage schematic.  Never
 *                                 # auto-detected, so the system view of a
 *                                 # storage device is unaffected.
 *   show_grid: true               # optional, inverter layout only.  The
 *                                 # 并网端口 node is the AC output of the unit -
 *                                 # the branch the PV energy actually leaves
 *                                 # through - so it is drawn by default, the
 *                                 # same way the storage schematic always
 *                                 # draws its grid side.  Set false to hide
 *                                 # it on an install that does not want the
 *                                 # node.  The reading is the unit's own AC
 *                                 # output: `grid_on_power`, falling back to
 *                                 # `grid_on_power_5_min` (the one a micro
 *                                 # inverter actually publishes), and finally
 *                                 # to `system_grid_power` (see `_data`).
 *   image: /local/photo.png       # optional product photo for that layout;
 *                                 # omit to take the one that matches the
 *                                 # unit's SKU (see `IV_IMAGE_BY_CODE`), which
 *                                 # is what makes the ports on the photo agree
 *                                 # with the number of nodes drawn below it.
 *   pv_count: 2                   # optional; number of PV inputs drawn in
 *                                 # the inverter layout, 1 to 4 (1 = the
 *                                 # single-input 1650 / 4160, 2 = the 4161
 *                                 # 2-in-1, 4 = the 4162 4-in-1). Omit to
 *                                 # auto-detect: the SKU in the serial first,
 *                                 # then the highest port that reports a
 *                                 # reading, then the registry's model name.
 *   dim_when_idle: true           # optional; fade the photo when nothing flows
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
 * ========================================================================== */

function _hmPowerFlowRegister() {
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
   * Drawing constants. The SVG uses a fixed viewBox and is scaled by CSS,
   * so the illustration stays valid at any card width.
   * ------------------------------------------------------------------ */
  const VB_W = 700;
  const VB_H = 470;
  const MIN_FLOW = 1; // W; below this a branch is drawn as idle
  /* How negative 负载 has to get before the system view treats it as export
     rather than as noise.  The meter is a summing device: a house that draws
     nothing at all still reads a few tenths of a watt either way (`-0.6 W` was
     measured on an idle installation), and folding that into 光伏 - which is
     what `foldedLoad` does - deleted the 负载 branch from the drawing for the
     whole night.  The dead band is the same order as `MIN_FLOW`, so a reading
     that is too small to light a node is also too small to remove one. */
  const FOLD_DEAD_BAND = MIN_FLOW;

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
   * between are interpolated: a smooth comet instead of a bar.  Stacking four
   * strokes of different length on top of each other was the earlier approach
   * and is why the tail came out as visible steps.
   *
   * A real `<linearGradient>` is wrong here: a gradient is painted in a
   * straight line, so on an L shaped connector the colour would run diagonally
   * across the pipe instead of along it.
   *
   * Slice `i` sits `i * slice` further back than the head, so
   * `dashoffset = length - head` becomes `offset_i = offset_head + i * slice`,
   * and every slice is animated by the same keyframes - the run moves as one
   * piece.
   *
   * The motion is a plain CSS animation of `stroke-dashoffset`, with the three
   * end points handed to the keyframes as CSS variables because they depend on
   * the connector's length.  That also fixes the freeze the old
   * `requestAnimationFrame` dots had: a card that was detached and re-attached
   * (switching dashboard tabs does) is not re-rendered, so nothing restarted
   * the loop.  A CSS animation simply keeps running.
   *
   * The same negative `animation-delay` mechanism puts a rebuilt path back
   * where it was, so a re-render (about once a second, as the readings change)
   * does not restart the streak at the beginning.
   */
  const STREAK_SHARE = 0.34; // streak length, as a fraction of the connector
  const STREAK_MIN = 34; // units; below this a short stub barely reads
  const STREAK_MAX = 120; // units; a long connector must not carry a bar
  /* How many slices a streak is cut into.  More slices, smoother fade - and a
     bigger DOM (14 paths per lit connector).  At card size one slice is about
     2 px wide, so the steps are already invisible; going higher only costs. */
  const STREAK_SLICES = 14;
  /* One cycle of the whole diagram, in seconds.  Every connector runs on this
     single clock: that is what lets several branches meet at the junction
     instead of each one running on its own timer.  `flow_speed` scales the
     whole cycle. */
  const FLOW_CYCLE_S = 6;
  /* The three stages of that cycle, in order.  Energy gathers into the unit
     (0), runs through it to the junction - together with everything else
     arriving there (1) - and finally leaves the junction towards whatever is
     consuming it (2).  Each stage starts exactly where the previous one ends,
     so a downstream branch can never light up before the energy that feeds it
     has arrived.  The keyframe names below must match. */
  const FLOW_STAGES = ["in", "trunk", "out"];
  /* Width at the head and at the tail, in user units.  The grey pipe is 6.8, so
     the streak sits just inside it. */
  const STREAK_WIDTH = 6;
  const STREAK_TIP = 3.6;

  /* A rounded corner is flattened into this many straight segments - fine
     enough that the flattening is invisible at the card's size.  Used when a
     streak travel path is measured. */
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

  /* ------------------------------------------------------------------ *
   * One schematic, two vertical rhythms
   *
   * The storage drawing and a micro inverter's System tab are the same wiring
   * diagram, but not the same *amount* of it: the micro inverter has no 微储
   * branch and no 光伏2 branch (`_isInverterSystem`), so two of its four
   * rows are empty and the rings sat in a canvas sized for the storage chart.
   * Measured on the test installation at a 725 px card width, that left the
   * System tab's card 176 px taller than the Device tab's while carrying
   * *less* ink - that is what the user saw as "too tall, the page looks bad".
   *
   * So the geometry lives here instead of in `_svgSystem`, in two named
   * profiles.  Every number is in viewBox units, and because the SVG is
   * scaled by CSS the rendered height follows `vbH` linearly, which is the
   * only lever that actually changes the card's height (a narrower
   * `max_width` would shrink the drawing without making the card shorter
   * *relative* to its width).
   *
   * `SYS_FULL` reproduces the original storage drawing **exactly** - same
   * routes, same caption offsets - so the 微储 dashboards are untouched.  The
   * profiles are only selected by `_isInverterSystem`, never by anything a
   * user can change, so this cannot drift between the two product families.
   * ------------------------------------------------------------------ */
  /* The storage profile is the original, untouched geometry. */
  const SYS_FULL = {
    vbH: VB_H,
    rowTop: NODE_ROW_TOP,
    rowBot: NODE_ROW_BOT,
    midY: JUNCTION.y,
    unitY: INV.y,
    pvRoute: "M104 142 V190 Q104 200 114 200 H283",
    batteryRoute: "M104 322 V274 Q104 264 114 264 H283",
    gridRoute: `M600 142 V${JUNCTION.y - 6}`,
    plugRoute: `M600 322 V${JUNCTION.y + 6}`,
    loadRoute: LAMP_ROUTE,
    /* Captions above a ring, and below it.  The storage drawing needs the
       wider offsets because the diagonals of 光伏2 / 负载 pass close to the
       text there. */
    capTop: { v: -(NODE_R + 28), c: -(NODE_R + 48) },
    capBot: { v: NODE_R + 26, c: NODE_R + 46 },
  };

  /* The micro inverter profile.
   *
   * `rowTop` / `rowBot` are 8 and 88 units closer to the middle than the
   * storage drawing's, and `midY` is where the unit sits (`unitY`), so the two
   * horizontal runs entering it are collinear - the storage drawing has to
   * offset them by 32 units to leave the 微储 branch its mirrored slot.
   *
   * Every coordinate below is derived from those three numbers rather than
   * hand-placed, so the rings and the connectors cannot drift apart:
   *
   *   pv      starts on the ring's bottom edge (rowTop + NODE_R)
   *   battery starts on the ring's top edge    (rowBot - NODE_R)
   *   grid    the same edge on the right column
   *   plug    the same edge, rising
   *   load    a straight run from its ring to the junction, starting 34 units
   *           along the line itself (the rule `PV2_A` already follows)
   *
   * `vbH` is then set from the *ink*: the highest text is the top row's caption
   * at `rowTop - 74`, so it starts at 16; the lowest is the bottom row's caption
   * at `rowBot + 72`, so it ends at 344 in a 360 tall canvas - 16 units of
   * margin either side, which is the tightest that does not clip a descender.
   * Rendered at 725 px wide that is 373 px against 487 px before. */
  const SYS_COMPACT = {
    vbH: 360,
    rowTop: 100,
    rowBot: 268,
    midY: 184,
    unitY: 184,
    pvRoute: "M104 134 V174 Q104 184 114 184 H283",
    batteryRoute: "M104 234 V194 Q104 184 114 184 H283",
    gridRoute: "M600 134 V178",
    plugRoute: "M600 234 V190",
    loadRoute: "M496.7 249.8 L600 190",
    capTop: { v: -(NODE_R + 24), c: -(NODE_R + 40) },
    capBot: { v: NODE_R + 22, c: NODE_R + 38 },
  };

  /* ------------------------------------------------------------------ *
   * The micro-inverter layout (`variant: inverter`)
   *
   * A HiFlow is a grid-tied micro inverter: it has no battery and no
   * off-grid port, so the four node schematic spends half its area on
   * branches the hardware does not have.  This layout draws what the unit
   * actually is - the product photo in the middle, the 并网端口 above and to
   * its right, and the PV inputs along the bottom - and keeps the two powers
   * that matter.  That is the arrangement the vendor app uses for a single
   * unit, and it is what makes the ports read as separate endpoints: nothing
   * shares a row, so nothing can look "missing".
   *
   * The bottom row carries one node per DC input, laid out per input count (see
   * `IV_NODE_X`): one on the left for a 一拖一, both corners for a 一拖二, and a
   * spread row for the 4-input 4162 - whose two middle nodes have no side edge
   * to reach and therefore rise straight into the photo's bottom edge.
   *
   * The 并网端口 value is the *absolute* reading: whether the energy is being
   * drawn from the grid (取电) or fed back into it (馈电) is carried by the
   * streaks, which run towards the unit while importing and away from it while
   * exporting, and by the colour of the connector.
   *
   * The photo is a transparent cut-out, so a connector that stops at a fixed
   * box could end in mid-air.  The box is therefore derived from each photo's
   * own intrinsic size (see `IV_PHOTO_ASPECT`), keeping the width fixed and
   * letting the height follow - which leaves the left/right edges - where the
   * connectors stop - at the same x for both models.
   * ------------------------------------------------------------------ */
  const IV_W = 700;
  /* Tall enough for the caption block under each bottom-row node (a 34 px ring
     plus two text lines) and for the 并网端口 row above the photo: the drawing
     has PV inputs along the bottom and the AC output on the right, the same
     three-branch shape the storage schematic shows. */
  const IV_H = 370;
  const IV_PHOTO_W = 300;
  const IV_PHOTO_MAX_H = 190;
  const IV_PHOTO_CX = IV_W / 2;
  const IV_PHOTO_CY = 130;
  /* Intrinsic size of each product photo, so a connector can stop exactly on
     the artwork: the 2-in-1 cut-out (360x168) is a wide strip that fills its
     frame, while the single-input one (736x486) is closer to 3:2 and is
     noticeably shorter once scaled to the same width.  A custom `image` falls
     back to the 2-in-1 aspect, which is the shape this layout is designed
     around. */
  const IV_PHOTO_ASPECT = {
    "hiflow.png": 736 / 486,
    "hiflow-800.png": 189 / 168,
    "hiflow-pro-1in1.png": 237 / 168,
    "hiflow-pro-2in1.png": 360 / 168,
    "hiflow-pro-4in1.png": 366 / 168,
  };
  const IV_PHOTO_ASPECT_FALLBACK = 360 / 168;
  const IV_CORNER = 10;                          // rounded elbow radius
  /* The DC inputs share one bottom row.  The row is laid out per input count
     rather than incrementally: a single-input unit keeps its one node on the
     far left (where the storage schematic's PV1 also is) and a three-input one
     spreads across the whole row instead of piling up on one side.  The one
     cut-out that draws its DC lead on the *right* face (the Pro 1-in-1, 4160)
     says so through `pvSides` in `IV_TERMINAL_BY_ART` and its node is mirrored
     to the same x on the other side, so the connector never crosses the photo.

     A 4-input body is the exception.  Its artwork carries **two MC4 pairs on
     each cheek** and nothing on the bottom edge, so its four nodes sit two per
     side, just outside the photo's edges - PV1 + PV2 on the left, PV3 + PV4
     mirrored on the right.  Keeping them in the middle of the row (as an
     evenly spread `[95, 235, 465, 605]` did) would have forced the inner two to
     rise into an edge the render does not draw a port on.

     The 4-input x values are pulled in from the outer positions of the 2-input
     layout to make room for the second node per cheek while keeping every ring
     clear of the photo (which is 300 px wide, i.e. x 200..500) and of the
     drawing's own edges. */
  const IV_PV_MAX = 4;
  const IV_NODE_ROW_Y = 275;
  const IV_NODE_X = {
    1: [95],
    2: [95, 605],
    3: [95, 350, 605],
    4: [78, 150, 550, 622],
  };
  /* Vertical gap between two connectors that land on the same cheek without a
     measured stub list to aim at.  Only used as a fallback - a listed cut-out
     gets its heights from the artwork itself. */
  const IV_SIDE_STAGGER = 30;
  /* The 并网端口 node: the AC output of the unit.  It takes the unit's own
     on-grid port power, which is where a micro inverter's energy actually
     leaves - the PV inputs feed it, and it feeds the house.  Its placement is
     defined again below, over the photo, now that the node is permanent. */
  const IV_NODE_GRID = { x: 605, y: 90 };

  /* The one body that is drawn with **two** PV ports: the small HiFlow (1650).
   *
   * The firmware inside this unit reports two input voltages and two input
   * powers (`pv1_p` / `pv2_p`), and on the units measured the two readings are
   * identical - it is a one-connector body whose DC stage is described as two
   * channels.  The vendor app draws it the way the hardware reads, so the
   * Device view shows 左上 PV1 / 左下 PV2 and folds the two into the one figure
   * it can actually report; `_svgInverter` prints the summed `pvTotal` on both
   * ports because there is no per-channel number to show.
   *
   * Only this cut-out gets that treatment.  `4160` is also a single-input body
   * (`IV_PV_COUNT_BY_CODE`), but its artwork runs its one DC lead out of the
   * *right* face and it genuinely has one input, so splitting it would invent a
   * port the hardware does not have.  The gate therefore names the SKU, not the
   * port count.
   *
   * Geometry: the two strings are drawn as two **round nodes** - the same ring
   * every other branch of this diagram uses, not a square tile - stacked on the
   * left cheek and joined by a short vertical bus a little clear of the body,
   * and the bus continues into the unit as one lead.  That is the shape the
   * vendor app draws and the one on the product page: two panels, one input.
   *
   * The pair is **mirror-symmetric about the lead's own height**: the centre is
   * the height the artwork puts its MC4 pair at (so the lead still arrives at
   * the plug the render actually draws) and the two rings straddle it by half of
   * `IV_SPLIT_GAP` each.  An off-centre pair read as "one input is bigger than
   * the other", which is precisely the claim this drawing must not make - both
   * ports report the identical figure.
   *
   * The one reading is printed **once**, and printed *with its caption*: the
   * two text lines sit together in the notch the two rings leave to the left of
   * the merge bar, right-aligned on that bar so they grow away from it, and
   * centred on the horizontal lead so the pair reads as belonging to the
   * junction rather than to either ring.  Putting the figure in one place and
   * 「PV端口」 far below it made the value look like it belonged to a ring and the
   * wording like it belonged to nothing; stacking both *above* the bar put them
   * in the ring band instead of in the blank the notch is.
   *
   * `IV_SPLIT_BUS_X` is how far that bus stands off the rings, wide enough that
   * the two runs read as separate horizontals and not as one thick line, while
   * still clear of the photo (whose left edge is at 243 for this cut-out). */
  const IV_SPLIT_PV_CODE = "1650";
  const IV_SPLIT_X = 64;
  /* Centre-to-centre distance of the two rings.  Wide enough that the two rims
     leave a band of clear canvas between them for the value + caption block. */
  const IV_SPLIT_GAP = 120;
  const IV_SPLIT_BUS_X = 172;
  /* Baseline distance between the reading and the caption beside it.  The two
     lines straddle the lead by half of it, so the block's own optical centre
     lands *on* the junction instead of floating above it. */
  const IV_SPLIT_LINE = 22;
  /* Clear canvas kept between the right edge of the text block and the merge
     bar, so neither line ever touches the vertical stroke. */
  const IV_SPLIT_TEXT_GAP = 8;
  /* The drawing is shorter than `IV_H` in this variant: the ports sit against
     the body's own top and bottom edges instead of along the bottom row, so the
     strip under it `IV_H` reserves for a row of caption blocks is empty.  The
     viewBox follows the content, which also makes the unit itself larger. */
  const IV_SPLIT_H = 300;
  /* PV input count by PID - the four digits at the start of the serial
     (`RMI-4161A0209FF6` -> `4161`, and the same for `GARAGE-4161A0209FF6`).
     The firmware's model string names a whole family - `HiFlow` covers both the
     1-input 1650 and the 1-input 4160 - so the PID is the finer discriminator
     and the one a new SKU is added to.  It is also the *only* stable part of
     the id: the prefix before the dash is a user setting.
     Keep this table in sync with `PID_PV_COUNT` in `const.py` and
     `docs/hiflow-inverters.md`. */
  const IV_PV_COUNT_BY_CODE = {
    1650: 1,   // HiFlow, single input
    4160: 1,   // HiFlow, single input
    4161: 2,   // HiFlow Pro 2-in-1
    4162: 4,   // HiFlow Pro 4-in-1
  };
  /* Terminals sit this far inside the photo's corner rather than exactly on
     it: a connector that ends at the very corner reads as passing the unit by,
     not as plugging into it. */
  const IV_TERMINAL_INSET = 22;
  /* Where each cut-out actually shows its ports: `pvFrac` / `pvRightFrac` are
     heights as a fraction of the photo, `pvRightXFrac` a width fraction.

     A connector has to stop on the cable exit the render draws, not on a corner
     the layout picked: the small HiFlow body (1650) carries its MC4 pair on the
     **left** face (around 57% down) and its AC socket on the **right** face at
     46% down, while the Pro bodies put the AC lead high on the right (24-30%
     down) and the Pro 1-in-1 (4160) puts its single PV pair there as well, low
     on the right (see its own entry below).  The 800's socket is a *recess*, so
     it is found by the run of rows that sit 30-40 luminance points darker than
     the panel around them and that project one pixel past the rest of the right
     face - not by its outline, which the render's drop shadow swallows.

     `pvSides` is the escape hatch for the one body whose DC input is on the
     right: the layout's bottom row is laid out per input count and puts a lone
     node on the left, so an artwork that names `pvSides` overrides that and the
     node is mirrored to the matching column.

     The two-input body is the awkward one: its two MC4 pairs sit on *opposite*
     cheeks at slightly different heights (77% down on the left, 74% on the
     right), and the right-hand pair stops short of the crop - the artwork keeps
     a strip of empty background past the plug, so aiming at the photo's right
     edge leaves the connector dangling in white space beside the port it was
     meant to reach.  `pvRightXFrac` is that plug's tip.

     Values were measured off the artwork's own dark connector runs, so they stay
     correct when a photo is scaled to a new size.  A cut-out that is not listed
     keeps the layout's own corner-based estimate, which is what a
     dashboard-supplied `image` gets. */
  const IV_TERMINAL_BY_ART = {
    "hiflow-800.png": { pvFrac: 0.574, gridFrac: 0.455 },
    /* The Pro 1-in-1 is the one cut-out whose DC input is **not** on the left:
       the render draws the body on the left third and runs *both* leads out of
       its right face - the AC plug high up (27% down, reaching the crop's right
       edge) and the MC4 pair low down (81-98% down, with the plug's body around
       x 175..208 of the 237 px crop).  `pvSides` therefore overrides the layout's
       left-by-default column, and the x fraction stops the connector on that
       plug instead of in the empty background past it. */
    "hiflow-pro-1in1.png": {
      pvRightFrac: 0.893,
      pvRightXFrac: 0.8,
      pvSides: ["right"],
      gridFrac: 0.268,
    },
    "hiflow-pro-2in1.png": {
      pvFrac: 0.768,
      pvRightFrac: 0.735,
      pvRightXFrac: 0.9028,
      gridFrac: 0.298,
    },
    /* A four-input body draws **two MC4 pairs per cheek** - four plugs a side,
       one PV string per pair - so a single height per cheek is not enough to
       aim with.  The rows are listed and `ivTerminals` averages each pair into
       the midpoint of the two plugs that string actually uses.

       Measured off the render's four cable bands: left cheek 0.738 / 0.774 /
       0.807 / 0.842, right cheek 0.741 / 0.780 / 0.818 / 0.860 (slightly lower,
       because that face also carries the AC lead higher up).  The plugs are
       only 6 px apart in the 366x168 artwork, i.e. ~8 px once scaled to the
       drawing, so the two strings of one cheek do end up close together - which
       is what the hardware looks like.

       The x fractions are the exception to the rule used by every other
       cut-out here.  This render is much wider than the body it shows and its
       crop keeps a band of empty background on *both* sides: the silhouette
       only spans x 77..258 of the 366 px, so aiming at `photo.l` / `photo.r`
       left all four connectors stopping 65-90 px short of the unit, hanging in
       the white margin - and the thin diagonal cable lines the render draws
       there happen to miss the exact rows the connectors land on (measured:
       at row 127 only x 9-26 and 36-39 are opaque out of the whole 0..77
       margin), which is why the gap reads as a gap and not as a joined cable.
       Aiming a few pixels *into* the silhouette instead makes the run
       disappear behind the unit, which is what "plugged in" looks like.  The
       artwork paints over the connectors (`edges` are emitted before
       `_unitImage`, and transparent crop pixels paint nothing), so the line is
       hidden exactly where the unit covers it and nowhere else. */
    "hiflow-pro-4in1.png": {
      pvLeftFracs: [0.738, 0.774, 0.807, 0.842],
      pvRightFracs: [0.741, 0.780, 0.818, 0.860],
      pvLeftXFrac: 0.222,
      pvRightXFrac: 0.696,
      gridFrac: 0.238,
    },
  };
  /* One cut-out per SKU, matched to the port count the drawing shows.  The
     photo is part of the diagram rather than decoration: every connector stops
     on its edge, so a 4-input unit has to show a 4-input body or the two middle
     risers appear to end in mid-air.  The firmware's model string names a whole
     family (`HiFlow` covers both 1650 and 4160), so the SKU — the first four
     digits of the serial — is what selects the artwork. */
  const IV_IMAGE_DEFAULT = "/hoymiles_g2_static/hiflow-pro-2in1.png";
  const IV_IMAGE_BY_CODE = {
    1650: "/hoymiles_g2_static/hiflow-800.png",
    4160: "/hoymiles_g2_static/hiflow-pro-1in1.png",
    4161: "/hoymiles_g2_static/hiflow-pro-2in1.png",
    4162: "/hoymiles_g2_static/hiflow-pro-4in1.png",
  };
  /* Used when the SKU is not in the table at all — a unit that predates this
     list, or one configured through `dev_id` alone.  Matching the art to the
     resolved port count keeps the geometry sane even then. */
  const IV_IMAGE_BY_COUNT = {
    1: "/hoymiles_g2_static/hiflow-pro-1in1.png",
    2: "/hoymiles_g2_static/hiflow-pro-2in1.png",
    3: "/hoymiles_g2_static/hiflow-pro-2in1.png",
    4: "/hoymiles_g2_static/hiflow-pro-4in1.png",
  };

  /** Placement of one product photo: fixed width, aspect-derived height. */
  function ivPhoto(art) {
    const name = String(art || "").split("/").pop().split("?")[0];
    const aspect = IV_PHOTO_ASPECT[name] > 0
      ? IV_PHOTO_ASPECT[name]
      : IV_PHOTO_ASPECT_FALLBACK;
    /* Width is capped by height, not fixed: the single-input cut-out is far
       closer to square, and at a fixed 300 px width it grew tall enough to
       reach the grid node and leave the connector no room to turn.  Capping the
       height narrows that photo instead and keeps the drawing's proportions. */
    const w = Math.min(IV_PHOTO_W, IV_PHOTO_MAX_H * aspect);
    const h = w / aspect;
    return {
      w,
      h,
      l: IV_PHOTO_CX - w / 2,
      r: IV_PHOTO_CX + w / 2,
      t: IV_PHOTO_CY - h / 2,
      b: IV_PHOTO_CY + h / 2,
    };
  }

  /**
   * The ports of one photo, in drawing coordinates.
   *
   * Each side is resolved on its own: `pvLeftX/Y` and `pvRightX/Y` are where a
   * DC connector plugs into the left or right cheek, `pvBottom` is the inset a
   * riser has to stop at, and `gridY` where the AC output leaves.  All of them
   * come from `IV_TERMINAL_BY_ART`, so a connector stops on the cable the render
   * actually shows.
   *
   * `gridY` is `null` when the artwork is not in the table, which keeps the
   * caller's own estimate for an unknown / custom image.  The PV side always has
   * a value: an unlisted image gets the photo corner plus `IV_TERMINAL_INSET`,
   * which is where such a render's cable leaves anyway.
   *
   * `pvLeftSlots` / `pvRightSlots` are only filled in by an artwork that lists
   * its plugs individually (`pvLeftFracs` / `pvRightFracs`).  One PV string is
   * wired through an MC4 **pair** - a plus and a minus connector side by side -
   * so the strings of such a body are counted in pairs and each lands on the
   * midpoint of its own two plugs.  `null` means "one terminal per side, use
   * `pvLeftY` / `pvRightY`".
   *
   * `pvSides` is `null` for every cut-out that follows the layout's own column
   * order; an artwork that names it (`["right"]` for the Pro 1-in-1, whose only
   * DC lead leaves the right face) pins each slot to that cheek.
   */
  function ivTerminals(art, photo) {
    const name = String(art || "").split("/").pop().split("?")[0];
    const spec = IV_TERMINAL_BY_ART[name] || null;
    const yAt = (frac) => (Number.isFinite(frac) ? photo.t + frac * photo.h : null);
    const xAt = (frac) => (Number.isFinite(frac) ? photo.l + frac * photo.w : null);
    /* Four measured plugs per cheek are two MC4 pairs, not four strings: keep
       the pair together by averaging the two heights.  A trailing odd plug is
       its own terminal, so a 3-plug cheek still resolves. */
    const pairUp = (fracs) => {
      if (!Array.isArray(fracs) || !fracs.length) return null;
      const out = [];
      for (let i = 0; i < fracs.length; i += 2) {
        const a = yAt(fracs[i]);
        const b = i + 1 < fracs.length ? yAt(fracs[i + 1]) : a;
        if (a !== null && b !== null) out.push((a + b) / 2);
      }
      return out.length ? out : null;
    };
    const inset = photo.b - IV_TERMINAL_INSET;
    const leftY = yAt(spec && spec.pvFrac);
    const rightY = yAt(spec && spec.pvRightFrac);
    /* Both cheeks can name their own x, because a cut-out's crop is not always
       tight around the body: the Pro 4-in-1 keeps a wide empty margin on *both*
       sides, so aiming at `photo.l` / `photo.r` left all four connectors ending
       in white space well short of the unit.  Unlisted artwork keeps the photo
       edge, which is correct for a tightly cropped render. */
    const leftX = xAt(spec && spec.pvLeftXFrac);
    const rightX = xAt(spec && spec.pvRightXFrac);
    const leftSlots = pairUp(spec && spec.pvLeftFracs);
    const rightSlots = pairUp(spec && spec.pvRightFracs);
    return {
      pvBottom: inset,
      pvLeftX: leftX === null ? photo.l : leftX,
      pvLeftY: leftSlots ? leftSlots[0] : (leftY === null ? inset : leftY),
      pvRightX: rightX === null ? photo.r : rightX,
      pvRightY: rightSlots
        ? rightSlots[0]
        : (rightY === null ? (leftY === null ? inset : leftY) : rightY),
      pvLeftSlots: leftSlots,
      pvRightSlots: rightSlots,
      pvSides: (spec && Array.isArray(spec.pvSides)) ? spec.pvSides : null,
      gridY: yAt(spec && spec.gridFrac),
    };
  }

  /**
   * One connector: straight out of the node, one rounded elbow, straight into
   * the unit.
   *
   * Written as `M / V / Q / H` so the existing `parsePath` / `reversePath`
   * helpers understand it unchanged - the streak then runs along it and can be
   * reversed for a charging / exporting reading without the drawing moving.
   *
   * `x2` is the x the connector stops at (a photo edge) and `y2` the height of
   * its terminal there.  The vertical run starts on the node's own rim, so the
   * line never appears to grow out of the middle of the ring.
   */
  function elbowRoute(node, x2, y2) {
    const dir = x2 >= node.x ? 1 : -1;
    const hx = node.x + dir * IV_CORNER;
    /* A terminal level with the node leaves the ring sideways.  Routing it
       through a rim would draw a loop smaller than the ring itself and the
       connector would read as a knot rather than a cable. */
    if (Math.abs(y2 - node.y) < NODE_R) {
      return `M${node.x + dir * NODE_R} ${node.y} H${x2}`;
    }
    const down = y2 > node.y;
    const rim = down ? node.y + NODE_R : node.y - NODE_R;
    const gap = down ? y2 - rim : rim - y2;
    /* The single-input photo is proportionally taller, so its top edge sits very
       close to the grid node and the elbow would fold back on itself.  Shrink
       the corner to whatever room is left instead of drawing a kink. */
    if (gap < 2) return `M${node.x} ${rim} Q${node.x} ${y2} ${hx} ${y2} H${x2}`;
    const r = Math.min(IV_CORNER, gap / 2);
    const vy = down ? y2 - r : y2 + r;
    return `M${node.x} ${rim} V${vy} Q${node.x} ${y2} ${hx} ${y2} H${x2}`;
  }

  /**
   * A connector that runs straight up into the unit's bottom edge.
   *
   * A four-input unit has two nodes sitting *under* the photo, so their
   * connector cannot turn sideways to reach a side edge - it has to go up into
   * the lower edge.  No elbow, so the path is a plain `M / V`: `parsePath` and
   * `reversePath` already handle it.  The path is written node -> unit, which
   * is the same direction every other connector uses.
   */
  function riserRoute(node, y2) {
    const up = y2 < node.y;
    const rim = up ? node.y - NODE_R : node.y + NODE_R;
    return `M${node.x} ${rim} V${y2}`;
  }

  /**
   * A connector that runs to a shared junction and then into the unit as one
   * lead - the shape the vendor app draws for a two-channel input.
   *
   * Two DC strings leave their own ports, travel horizontally at their own
   * height, meet on a short vertical a little clear of the body, and continue
   * into the port as a single run.  That is *not* what `elbowRoute` produces: it
   * turns each connector separately into the cheeks, which on this artwork would
   * stack two elbows on top of each other and read as two cables entering the
   * same hole.  The junction makes the merge explicit instead, and each string
   * keeps its own path so each keeps its own streak - the branches stay
   * distinguishable even though they enter the hardware together.
   *
   * Written as `M / H / V / H` (or `M / H` when the node is already level with
   * the port) so `parsePath` / `reversePath` handle it unchanged.  The path
   * runs port -> unit like every other connector, so a streak authored forward
   * reads as "into the unit".
   *
   * `joinX` is the shared vertical and `portY` the height of the single lead
   * that leaves it - both are the same for every string of the group, which is
   * what draws the merge: the verticals overlap into one line and the last
   * horizontal is emitted twice, in the same place.
   */
  function mergeRoute(node, joinX, portY, x2) {
    const dir = joinX >= node.x ? 1 : -1;
    /* Leave the ring sideways rather than through a rim: at a node level with
       the port a rim start would draw a loop smaller than the ring itself. */
    const start = `M${node.x + dir * NODE_R} ${node.y}`;
    const tail = Math.abs(portY - node.y) < 0.5 ? "" : `V${portY} `;
    return `${start} H${joinX} ${tail}H${x2}`;
  }

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
    "grid.on": "data:image/png;base64,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",
    "grid.off": "data:image/png;base64,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",
    "pv.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7//f/9/v7J8NtAzYDn3/0TAAAFa0lEQVR42p1YzXMTNxT/6cMFE9LIiVPoZEqcKQxgWCLH4cCBKU7hxIEGmr+y0HJti8Ehhx5aF1Hn0iEhzrRMDOvEmoQZmJK1ONi7K9nr2HQvlrXv6ffe0/tcAvdhnsJiRgAATKsM5imXgLh/p3axOAfAaBABYK+MwrMjGKZ2eUmgZcoAgEWRgWlWXA7i0i/OodVUQBHApgYrZbBXdjhsBhYszplmhSxs6s67hU3NS2KvLFUiA/P4nNlQxap1RrHKlsReJUDSI/nK92Cyx2oSt1ZusCQEhrvmPus/S6pb4gWJ1KCxAktmI4EeqvBYn30m+xBkKuevDZB1fbn9MIgE6f7613afJtOjceVpPisarkheyTzxMOCpXdbZmovA/EJTqEEMxq9fDCF4F2C6PUABAEAg67NrNgLzCxunGoMZ4O+EWvAQoHYEgA3BRgKwIDgAjJ8bAgAEsn5mNUK4NNecOBoA8Bv54ztdhuJf53/eGUIPc4Vlx3Y6DKcuvR0KAPj1fMUADGD/XXy99X4oAwqTqdMNUKC9b5QeTm8CPdvRQY4kEeDX86sGFGDioD4CPdoTxBOgYM9HkggwX2mRAwNdOHlsFIkAf7ug3nN4wj0/4x5rvzRkH2BYIW6WcJ+iHasrEhzcUMuPvFrRZajaAmghOYix6Nn63R6EuZ/idT01o4lMjek4NuW0aLnJWvjxa0buPOQQH2yA5Rc9kX01jM1uVuJq5b6JNZj+oG4CAJrIAgAOKzmvHmoRCNJm7MLfMcPpsdczX6bT6XQ6s1ZIp9Pp9Ilj9LPj0TVdYOPUKRB1Ue1eA+nukwktbApBHSMdGIi+3EpirZQWFEFMwghYL70wNN4jClTqnHP5vQzMrjnUMGqL0CbtBCd174UCcTAY2eqjJ4F1ShugtqvIGM6Y6BA9b+0SCid69OXuv91oAYjYg4Mwe3ev4dyv8skNADBrQAkATEXqMZuGw6prB2Dry53ldT3dke/ej/y25ZyglhEYMe1Sd51d7+pDF8DsiKCuTWIrR9YfN8S+HOqaMCH0hUtEnZTef9EAczdtBimS8hMJEAwSqa/f6ipqXSjceNAyMYOJnBUPFp4SSiSIJC1BlS0SYSY5RdaFo4MtxdSTcNWKPM6onHUmuBahbQyIDkL/Lsut7rmHRct4xHAgF7qKp68fPIpS6h9RZ+fYlDqmz0b9XjVaBetiVVkxnLpd0ZHzLZuEq8u0X4YNHOG3ueWLgdyayyQE9QMrhsENiQOiFkSGJbmtSDpiLOfhtu2DqUhyPluN20fbF/i4nVp2iYg8ZircbzkxzHP6G6s+mFaUA/f67529NYzDjfGwrBEsdPr1vqzGUveSfJrfS/Kqq99JDkOoG5nkWwCE3ATQdMuRFBo8YD0AhGaien0Sys1bP0gOT1/X9rZpx2ZxEdhbwxTHdmrGVc08GtQ7EOMpjv1ns7VBxd+1kje9C3C0Kbmy5byoDjifiZcKFMbTE7lRmhn63CiAAzV6Z20UBm/6cFyDAvicSDGcnjCxnQMYYM4zfnx4i8VeX1jd6WQ+VsnWRpCodCi7nfFOYTKaWAYD+IXtatisb9IzQ9X2Uu0/o2b9QyPPTx8Nwd5ca8bjQCD11w+HAZjOzMPCpvdoCPbmWndi4BgJIgIIuxe/nj/KUMwPAcJ0H1zW2ZocSD9eMmvKHS39+sXs7wPqA+Z5PPOwaGI5mMn+YwYMr6X2Lzs9wyv8f2cmU34Sh6wtHXsw3+itosHUY3I2YAn0aklsFNT/HvGZPTbvZ/IpVbQntOIr/6bYe+o1khjgvzqRmfziN1J815m5SPHdFl8Se+V5NexDCFno5IIhH0I+/VPLp3/MGeFz0UfwRyVe/gVUswAAAABJRU5ErkJggg==",
    "pv.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///8/f3e5euywtHnRgnjAAAFX0lEQVR42pVYS29bRRT+5twbWlEJj/MAtYmvx04igRGpnbgLioSom67YFGh+ZoWQYFXyIN00qE2NF8DCTSZOSpPWsScOQqjEMyyufe9MfJ24s5r7OOc7jzmvYXAXBRJlngYAtM0qKJDuD8x9zO+gnOYwCgDjMO1V5HcuICDtVbhR7WcAgKU046ZeFXIoQX6nnDOqWQXyLKV2AO8O48drDgZz+Jdzpl4loUOeJLT0Kry1amMwW9/JXLtZdfjld7w76da6RtIS/soySJyzmsC9la8ofuHFnzqVKz+SVi6BUWJ7enzsMP4t2ulKqk4J2FKsncwlIIi56/Vaoqwq+1vh+p45R+B1bre2knWDyv66OHZVuSJlKmY1wJDVOFNzDReBTkv1q3IYgSFZmEII4Yevgnld0xi6tJDZxzYCnZbqV9RwAnQOC5MhREhw89N/ttoX/A+TfXtjy0QE9KZ08AoXLnXUgyAACEq6hktWRk40IrN64kVwGUFjm4p9gvyeqcnLCHRGfZDv6ZBa+tuoywjQ2Vt8YgACyOOblwIAeoZ9JgACdENjpCVFKJIYSSKgc1R4YkCAx5UcBUAbtgAQaM/URhMpo7gAAaWzYDSCxvoEQAi4wqiLNQDCg3NZ4lzytPPKvSJ87cMO/aCx5BI8c5648IkZ63/av8tdgvRa/FlOTcMzS2eIlciWU+pfZ6Wn4s909MkTX/A3Fr+Dcr3qIpTFphVHjPmy/MjSaqpZXQYANOFzADjbyC1ELDROtO85OvPjclh9Uj98E/IsSh4nb4EiOQVC8u10z+K994wDtp84wTaSZwadVR2PCaQCsePYVcTg8YGEYZeQ5zwM1PjrAMA4mFUd4JHNUTPDBo6Py4ORo1KxNXjeukzbEhAQR4+I4UyfsRGqaMUQiDueVTM9wBfRhoMLS2jfFlHeeiTWQn417Iebqhi7ZnN0DrdnaP/bcNtV86F8fPXl15bQsE1GDLrS288e9PQZLxpyIszpCkzkNxbZl7uOIKsXMKybEMfc9g13ELRQbJDAM9AOgklyg5PALC7KQQBPQmBQRZGsNIBiIgZ3RLKSAq8mCMWEddok7IhLCp9QcDvilC2Ft97ftaJ8a6S0efpAFONdZrr9ar0mdnvineUnIiUI8BHnYqEWOj/39osnT/tMM/xNNTYZ2QKq2ajf237R33UPUlYEGL/6RWyCA7GcoHNaW11l1zcTG9HTzG4uqc94GDt9SflgcUA0ZGRYlpUJCV/w/5yI0/noo599Fve/tprUtc/iTtKJ0bajqyROimLUEkdeinylBopiHmAMeRsxymoaNHY/iZn/XdLbW/eFD+Of74fLHABbBtB0y5HgSvp6IGa80BlpAGfusCHnN4SPzMmX0nnd3Y2iwm1CiFIkfTSmrp2DeDq0ETCB9IHn9zeHFX/XSsH8cSjzSnE0N3griwD1uppR3MZMFSCgsTHRGIUgKJ3p8NBoGq33EQ0BeIC56WVwec9Epx+vt0OEzvrkCDIFd5q9rhLt3I1oYhkO0Ckd/t4/+F05eylEsKir0TjQOSpYk1ryOv28aVR/pNELaoIubo/FpHncjSeU13uLF2tBndshQG9o0gtq9vsLNZgym9oey17vFS6CoE5Pgyg96Bk1J4eeKNIV058Y+qNlRxY+rA2pD8jOXa9/dOgSmOzb6bHXyRRi/3Zr69X5aVf9NX0jmULsV678ZBJS3NrJXNK5FbKSqoukKppZZw/04Igvl3nTGsI8K88Gb9OFsT/z9oyZb53eTbd+CVQSATov30+Pv/cH5VI9k+dSu14l3VrNyqEXIXOlgYuQ1urQi5B3v2p598ucEa6L/gcZVSGaagDa8AAAAABJRU5ErkJggg==",
    "load.on": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7//f3/qrH/WGb/UF/PHtmbAAAFO0lEQVR42q1YTW/bNhh++MpLk3aVKK1FkQKzKDlA0VyWOi32cRnQ9R/0h+4nbDts6A5zkw3Y1oNt2cPaNFgkUmtTN1vIHWwlImXLBTpebIl8+Lzf5CsGe7A4Q4+zkMMU0gxAvnQW2I9Rjl4opJEAGGe6GDAxbgFEOfVFIYsRACANWaiHWTJeCYjyXuQXeQaWAMglKAnj8cBCdGr/Ke+lepixtJhThGE+JKQYiGwpA4u9pDjJ0lFtj3RE98L8QGPZEN6jfRB3jCKw/2iPLl94lwq83L/yPemZs40Sv0XJKZs1AOzNfjCk0yaxTH6/uv0rnzUE6j0WhOWy0oN+Y4rIkrShnRDVwsVvt28Ou6sA0+uyN7V1oPLukGerAObsRXp9U9b9IG6erzB2JdTe17rGQOWno0C2AEp57eacYg6Id/JnRct6mIDt/mguAFTeeW5mbQC8lVfnFAQAfmImsnU9jC+jyYVZSYxirBnliEQFiJSZZusAuiuDZKHDrZ1XVyTWUhx98cQAHsBIvCxclcOtZrRd1ZiBACiTOQQpLwqWOmrrLJgni3iwJ9ykoTQVbjKR95gAD4i2jyyJWHCcptthGG4cB5ZcPNKYeSAlDt5Ysh73b29vvg3DLX1s6hO3aAPSA9Jzy0ak+smb2QyzWbSlubTsdDebEWLrJZjfF4uwKqg3sdQwTMFj8u5BHcG9vgQWKRxtTKwIvPaBJObxevVjlBZgFWmRijoFZ1yQQVHPHKZiIBh9s1hXBnVAVkBSnOZ1L3T7Emx0eK+S4iKXAYDGaUmwMo3+iAF9+DCpXpbd+nZGgbJgUovUIAHYST+4TL9U1SLWV4bI0jkIJfxf4ktSEypL69ijW1nNneUu2KsbddtvvcZlfPAzn4CakYgFQGk5S/HaYwYQy50CHxwGK5OIjTklqAF0Ahj3nLSOn4is7QQkTGLFloFVo1UHsj4fAtIRMbTQIEC2HdxOmgIEt8Do1mIDCpwtjcfbEIoaMlDQVvYbxyxgWmsac861JTXfeWUDMjQImWMFclzfZHBCh9Y7oQ2gjXKXB9J2FNk26TZMZKb2I9k6qcK9zRSWWyTIlkE1tM5tQECwSr3+eGKv93/ObJXJsUJpW5GNY8eKBG6tKMYWhZ9bjmbM1QHGr1OwsXt+BzR2EkgNa0LrQeAkUE4msgEmfHpBwU4SZzKR5DobqiYSGTcdQCZ0XXuppsldx4ey40tnF8MnlWv0xJmTN7IOV7FTB4pRFS3nznoqA+pAcZf35GRlggYA8x42rqQ1He2xs8c7DCE5pcjsV1RuzQj/4R1NrtZgbG5Z4wLkjQPeQbehtf6JLy04VAYkO1CdhtZGCQC6cUtjxpcAeV8R3mmI+3sCHRjO4sLm4B9xAOapcYoeH2XowPgqcKUNEwD6wAFM7mXzHGJffusYlpbpIDofZhIdwHDi2qbQo2VlmJ9U11DvunsMhVtbW5v2vZLUZ08WN7fonewk7u8li7jJA9YV69bTlKtxFWg6SyfrAH46N4IHAGcy0WhvB9hZ8npTVr2oFmW0hiL24nlP4y0umJ+f8razjVTvryu1lsbE/24+M20E0Z3vinpbVh7tnrdQkOr/ubgNU1W1ZW+y0rTk901VxSuPTQfsk+kqQPdvPuw63a6J1e5puVwNMd0/vejaLtpjlV/b1ksRybQf/HDRGNBlER6UPd28SUCM+/Ewkf9Diw8Zq+1w4yitnzlpUfbD/NCfLQOgzNnt0IxZuoir8LZ5Qf3k+SA+eo8PIe/3qQWItHQ+5iAZt95f1n4u+g+4/ipIMVqNyQAAAABJRU5ErkJggg==",
    "load.off": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgBAMAAAAQtmoLAAAAElBMVEX///////7+///6+/zL1uCuvs0UaJSEAAAE7klEQVR42q1Y30/cRhD+PDYB0sKtuWslTsJeTFApD+n5QqW+NReaf6DN39k+VarUEpK3IAW4oCrtAz/2jqSBisOLqVqpDbt9uF/ePZ8vkbJP9npmZ75vd2Z27MAcFAjc8x0GQMtkFxQIU8AxX6NjbPhMy+43ppMtRMcFCqTchp9ouQsAuOcwP7locjFWITpeibTuNIEIwDHgxowd7xk2HGP9jeXkoklcddckroTb8C+3sjacLF4vTi6axnrRsdvwO08U8gZ3H26CuMUax8ajGg0n3OGn9IHaIiVNBS35y9vR1NlQbPCk6rpDObYF35crORb4Hf7qINdXGb6oLre0pUDp+t87+dggw4N4akaaCuGdW49Dma+A9Ob28o42FCj96vWMGCMPTWfVuZ6JnkK48c9OgrFDhxQ90xkFuq69npbjFZCeVZcghwrhii4yAOiQFrso3D6CNygc8ryHwu1SpPskjB0hdYlyAaC8Voygh6L0pnc0opY+EBPkoZbkfNSzUFp5qycZANLz+JkGXIAW1n5KJspDBx/PzUgQoFoj4hEHKLJnE9Z1ia94pkcUnqT16q0TMg9Xeh7vaHiAGx6akIP2BvPhrxy1TdhOGgi4oPSzp8Ym8NPNxVlgdrY69afxIXQ/hXTh1E2OKH3AegliYRAFfZ/eSELATEpVnQ1Syh3TV+20QSRKTWPay+QN5765d1cBSLmaDEYb2beKxS3jRI7MhjK1GYDLH/omgmyeEicMpOKb7FzQANB5MnClkqWWRLlFvGRgPmWAfvqtP0Bx10B95ZCAgbkO4PBBFlMW9Y2jyGVZzJwB+leWdcP4jBo52vbowuDJ9EkyQpIhiQDgmllZPUOTBjmKW/XlhUV91r8mo5qxlzGgrTpZNs6BS5CWdV2zK3GWVxCz7WtWFKgOaUxIGFkPlZaEpp1PCpON7RIAr9geGZi6F4YCeT4iPnFYCjkJUBcpiHygBRb2R+U7vECB3heDyikrUhStuTSCWh/YFlQxTVqZrJAp0d6zFY64VePBrcJke2SGA8hhhkbbKi5JYAJgZDu9b0zojg3Jg5m8VbcwDQw07eAgOxzwPLOA3rK/3pB27QO0PXy8sK6MiksCo5F75Nijwn2QnVWAk+HjpW2dSbqxg1gNK562AQrd9LisWcdLbferw1v7pDqMPHnF7K14+8vYFKCV++95YBum/iHn9jmp38CDrtj3YfVN7+HQJsmRwlOjUUa9TDMSTWL1Zw7whzWeH4Yj0+4jgof2JyOoFXEASoxiDgRA3nfvmM34l/c5PCg4dy2eeIUB0NsWGaerHQEPCFqM282an5PGyZnfAjyg/errtsVGWwHoWBpBpaO6yV37I9lxN2+b/Q4XcAEd/reKyddQuv7iSdKlnPbL7ckcBXGH9y66Ca+ad7VcA+nn8mV/U1Vrsokgnm8O2oH0LM50avnjev3VtOyXQMVbZVLFu1yZ31LDDiU9j4tRULr+Vzd0u0VWBVflg0IEldL3KttlpaLQBKU9BIOjr5ZaZcHHyqt4vp/F3UHHEgUH4/qgsLJ2NG21ljok+26eub3Xh23hoNuVf3y0MJerwU8b7Eedkz33nEpORgAXMTvkH6LFhwzTqDr3e5QtWtHl9ebi5U4g8xSQdm4v0vxvtNy7XdNy6cRt+JePQ/GBfoS8/6+W9/+Z8w6/i/4HMs8B683VQP0AAAAASUVORK5CYII=",
    "gridload.on": "data:image/png;base64,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",
    "gridload.off": "data:image/png;base64,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",
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
  const STACK_X = 272; // left edge of the front face
  const STACK_W = 40; // front face width
  const STACK_SIDE = 7; // right hand connector panel
  const STACK_BOTTOM = 350; // ground line the stack stands on
  const STACK_HEAD_H = 13; // dark BMS / PCS module
  const STACK_MOD_H = 19; // one battery module
  const STACK_MAX_PACKS = 4; // matches the battery card and the firmware

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
   * point zigzag.  The streaks on every charging battery and on PV1 therefore
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
   * The card measures the connectors itself, so it needs the length of an
   * distance along a connector.  Doing that in plain JavaScript (rather than
   * `getPointAtLength` on every frame) keeps the animation off the layout
   * engine and - just as useful - keeps it testable outside a browser.
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

  /** Point at `dist` along the polyline, walking it from the start. */
  function pointAt(line, dist) {
    const total = polylineLength(line);
    if (!(total > 0)) return line[0] || { x: 0, y: 0 };

    let want = dist % total;
    if (want < 0) want += total;

    let lo = 0;
    let hi = line.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (line[mid].s <= want) lo = mid;
      else hi = mid - 1;
    }
    const a = line[lo];
    const b = line[Math.min(lo + 1, line.length - 1)];
    const span = b.s - a.s;
    const t = span > 0 ? (want - a.s) / span : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** Length of one of our connectors, in SVG user units. */
  function pathLength(d) {
    return polylineLength(polyline(d));
  }

  /**
   * Reversed copy of a connector, so a flow can run the other way (charging
   * into the battery, importing from the grid) without moving the drawing:
   * "M236 182 H105 V376" -> "M105 376 V182 H236".
   *
   * Both traps worth remembering: a segment that changes in *both* x and y
   * must stay an `L` (emitting `H` collapsed the two diagonals into a
   * horizontal line, so their streaks flew off the drawing), and a rounded
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

  /** The path a route's streak actually travels, cached both ways round. */
  const TRAVEL_CACHE = new Map();

  function travelPath(route) {
    const key = `${route.reverse ? "r" : "f"}:${route.d}`;
    const hit = TRAVEL_CACHE.get(key);
    if (hit !== undefined) return hit;
    const out = route.reverse ? reversePath(route.d) : String(route.d);
    TRAVEL_CACHE.set(key, out);
    return out;
  }

  /**
   * Markup for one connector's streak, as a run of slices that fade out.
   *
   * The connector itself keeps its own grey (`pf-edge`); what travels along it
   * is one streak of light, drawn as `STREAK_SLICES` short dashes.  `t` runs 0
   * at the head to 1 at the tail: the head is white and opaque, the tail is the
   * branch colour at almost nothing, and the slices in between are
   * interpolated - a comet rather than a bar.
   *
   * Slice `i` sits `i * slice` further back than the head, so
   * `dashoffset = length - head` becomes `offset_i = offset_head + i * slice`,
   * and every slice is animated by the same keyframes - the run moves as one
   * piece.  The three end points travel as CSS variables because the keyframes
   * cannot know a connector's length, while all of them share one animation.
   */
  function flowBeam(plan) {
    const { route, travel, len, stage, cycle, delay } = plan;
    const streak = clamp(len * STREAK_SHARE, STREAK_MIN, Math.min(STREAK_MAX, len));
    const slice = streak / STREAK_SLICES;
    /* The gap is well over the connector, so the pattern cannot repeat on it:
       exactly one streak is ever on the wire, however long the line is. */
    const gap = 2 * len + slice;
    /* One negative delay for every connector on the diagram.  It is the part of
       the shared cycle that has already run, which is what keeps the branches
       in step across the re-render that every reading change causes. */
    const delayText = (-delay).toFixed(2);
    const stageName = `hm-pf-${FLOW_STAGES[stage] || FLOW_STAGES[0]}`;

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
        + `--hm-park:${park.toFixed(2)}px;animation-name:${stageName};`
        + `animation-duration:${cycle.toFixed(2)}s;animation-delay:${delayText}s"/>`;
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

  /**
   * Drop the `_2` / `_3` … Home Assistant appends to a colliding entity id.
   *
   * HA never fails a registration whose derived id is taken; it numbers it.
   * A unit whose serial was registered once before - the very case behind
   * `sensor.<serial>_system_pv_power_2` - therefore has *every* id off by one
   * suffix, while the card derives the plain one from the config.  Comparing
   * the two has to look past that number, so the tail is run through this
   * before `norm()`.
   *
   * Only a trailing `_<digits>` is removed, so a key that legitimately ends in
   * digits (`pv1_power`, `grid_on_power_5_min`) is untouched - that is what
   * makes this safe to compare, unlike a blanket digit strip.
   */
  function stripAuditSuffix(value) {
    const text = String(value == null ? "" : value);
    const at = text.lastIndexOf("_");
    if (at <= 0) return text;
    const tail = text.slice(at + 1);
    if (!/^[0-9]+$/.test(tail) || /^0+$/.test(tail)) return text;
    return text.slice(0, at);
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

  /** `#rrggbb` (or `#rgb`) -> `[r, g, b]`. */
  function hexRgb(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return [255, 255, 255];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  /** Blend two hex colours (`t` 0 -> `from`, 1 -> `to`) as `rgb(...)`. */
  function mixHex(from, to, t) {
    const a = hexRgb(from);
    const b = hexRgb(to);
    const k = clamp(t, 0, 1);
    const at = (i) => Math.round(a[i] + (b[i] - a[i]) * k);
    return `rgb(${at(0)},${at(1)},${at(2)})`;
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
      /* Registry device ids owning this serial, filled lazily by `_deviceIds`
         and only used by the name-matching fallback of `_resolveEntity`. */
      this._deviceIdsCache = null;
      /* Start of the shared flow clock, in `performance.now()` milliseconds.
         0 means "not started yet", which `_beamPlan` fills in on the first
         render.  All the streaks are driven by CSS animations from this one
         origin, so nothing here has to be animated by hand - which is also why
         a diagram that is detached and re-attached (switching dashboard tabs
         does that) keeps moving. */
      this._pfEpoch = 0;
      /* The cell's own `grid-column`, captured before `_syncRowSpan` first
         overrides it; `undefined` means "not captured yet", and
         `_rowSpanHidden` records whether the override is currently applied. */
      this._rowSpanBase = undefined;
      this._rowSpanHidden = false;
      /* Width of the drawing while the card shares its row, in px.  The
         schematic keeps exactly this size once the alarm list hides and the
         card takes the whole row (see `_wrapStyle`), so the card's height does
         not change when a device stops reporting faults.  `_halfWidthBase` is
         the card width the number was measured against, so a resized window
         re-measures instead of reusing a stale figure. */
      this._halfWidth = 0;
      this._halfWidthBase = 0;
      /* Frames left to retry an early, pre-layout measurement - see
         `_remeasureLater`. */
      this._remeasureTries = 0;
      /* Watches the card's width so a measurement taken before the dashboard
         settled is corrected - see `_watchHalfWidth`. */
      this._halfWidthObserver = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-g2-power-flow-editor");
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
        /* The role chip: only a master or a slave shows one (see _roleChip),
           so it is coloured quietly - it explains the drawing, it is not a
           warning.  No backtick characters in here: this whole block is a
           template literal, so a stray one would end the string early. */
        .role { font-size: 12.5px; line-height: 1; padding: 4px 8px;
                border-radius: 999px; border: 1px solid currentColor;
                font-weight: 500; opacity: 0.8; }
        .role.master { color: var(--primary-color); }
        .role.slave { color: var(--secondary-text-color); }
        .wrap { display: flex; justify-content: center; position: relative;
                /* The drawing fills the cell unless a "max_width" caps it, and
                   a cap (when there is one) leaves it centred.  On the Device
                   tab the cap is off, so the schematic grows with the card in
                   both of that page's shapes: half of the row while faults
                   are listed beside it, and the whole row once they are not. */
                margin: 0 auto; }
        /* Health badge in the corner of the schematic.  It sits *over* the
           drawing rather than in the header because the header is about the
           device (name, role, signal) and this is about its condition: a green
           tick when the alarm sensor reports nothing, a red lamp when it does.
           Nothing is drawn at all when the card has no alarm entity, so the
           System tab - which has no single device to ask - shows no badge. */
        .health { position: absolute; left: 2px; top: 0; display: inline-flex;
                  align-items: center; gap: 5px; font-size: 12.5px;
                  font-weight: 600; line-height: 1;
                  /* No plate behind it: the badge sits straight on the card and
                     is the only coloured thing in the corner, exactly like the
                     G3 dashboard.  The count lives in the tooltip rather than
                     next to the icon, which keeps the corner quiet. */
                  background: none; }
        .health svg { display: block; flex: none; }
        .health.ok { color: #15803d; }
        /* The vendor app's warning tone: a saturated red, not the theme's
           error colour, so the triangle reads the same on a dark dashboard
           as on the light one the app uses. */
        .health.warn { color: #e53935; }
        .health.unknown { color: var(--secondary-text-color); }
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

        /* The travelling streak.  Note what is *not* here: stroke-linecap.
           Each slice sets its own as a presentation attribute (the tip is
           round, the rest butt), and a rule of equal specificity would beat it
           and turn the smooth fade back into visible beads. */
        .pf-beam path { fill: none; stroke-linejoin: round;
                        animation-timing-function: linear;
                        animation-iteration-count: infinite; }
        /* The three stages of the shared cycle: gather into the unit (in), run
           through it to the junction (trunk), leave towards the load (out).
           Each ends exactly where the next begins, so nothing downstream can
           light up before what feeds it has arrived.  The end points come in
           as CSS variables because they depend on the connector's length. */
        @keyframes hm-pf-in {
          0%, 4% { stroke-dashoffset: var(--hm-from, 100px); }
          30% { stroke-dashoffset: var(--hm-to, 0px); }
          35%, 100% { stroke-dashoffset: var(--hm-park, -100px); }
        }
        @keyframes hm-pf-trunk {
          0%, 30% { stroke-dashoffset: var(--hm-from, 100px); }
          55% { stroke-dashoffset: var(--hm-to, 0px); }
          60%, 100% { stroke-dashoffset: var(--hm-park, -100px); }
        }
        @keyframes hm-pf-out {
          0%, 55% { stroke-dashoffset: var(--hm-from, 100px); }
          82% { stroke-dashoffset: var(--hm-to, 0px); }
          87%, 100% { stroke-dashoffset: var(--hm-park, -100px); }
        }

        .pf-v { font-size: 19px; font-weight: 600;
                fill: #1f2933; letter-spacing: 0.2px; }
        .pf-soc { font-size: 15px; font-weight: 500; opacity: 0.9; }
        .pf-c { font-size: 13px; fill: #8b95a5; }
        /* The micro-inverter layout has no white plate to sit on any more (see
           _inverterSvg), so its labels take the card's own text colours.  The
           storage schematic keeps the fixed greys above: its drawing is still
           painted on white and would lose contrast on a dark dashboard. */
        .pf-iv { fill: var(--primary-text-color, #1f2933); }
        .pf-iv-c { fill: var(--secondary-text-color, #8b95a5); }
        /* The backdrop of the micro-inverter drawing: the card's own surface,
           not a white rectangle, so the schematic reads as part of the card in
           either theme. */
        .pf-bg { fill: var(--card-background-color, #ffffff); }
        /* The product photo in the micro-inverter layout.  It is a transparent
           cut-out, so it is drawn straight on the backdrop with no frame. */
        .pf-body { display: block; }
        /* The single reading of the 1650's split pair, printed together with its
           「PV端口」 caption centred on the merge bus (see IV_SPLIT_PV_CODE).
           Same size as a ring node's figure so the eye reads it as the port's
           value rather than as an annotation; the caption is a touch smaller so
           the pair stays inside the gap between the two ring rims. */
        .pf-panel-value { font-size: 17px; font-weight: 600; }
        .pf-panel-c { font-size: 12.5px; }
        .note { font-size: 12px; color: var(--secondary-text-color);
                text-align: center; padding: 4px 0 8px; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-g2-power-flow: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
    }

    set hass(hass) {
      this._hass = hass;
      this.requestUpdate();
    }

    /**
     * Widen the card's grid cell while the device reports no alarms.
     *
     * The Device tab places this card (24 columns) beside the alarm list (24)
     * in one grid section, so the two are equal halves while a fault is on
     * screen - the vendor app's own layout for that page.  Both spans live in
     * the stored dashboard config, so the section alone cannot know that the
     * alarm card hid itself: it would keep reserving the right half and leave a
     * blank panel next to the schematic.  Asking the *cell* to span the whole
     * row instead is the only place that can react to live state, and it
     * degrades quietly: without a grid-item wrapper (a non-sections dashboard,
     * a `picture` embedding, a test page) nothing is touched at all.
     *
     * The element to style is found by walking up until an ancestor actually
     * carries the card's `grid-column` - `hui-card` itself is `display: inline`
     * and its parent is the grid item in the current dashboard markup, so
     * writing to `hui-card` was silently a no-op there.
     *
     * Spanning the row is *not* what grows the drawing.  The Device tab's card
     * carries no width cap (``max_width: 0``), so without a counter-measure the
     * schematic would scale with the cell it is given - twice as wide, and
     * therefore twice as tall, the moment the alarm list hides.  The user asked
     * for the opposite: the card's height must be the same in both shapes, only
     * its length changes, with the schematic centred in the extra space.  So
     * while the span is applied `_wrapStyle` caps the drawing at the width it
     * had in half a row and `justify-content: center` puts it in the middle.
     *
     * The System tab has no alarm entity - there is no single device to ask -
     * so it never takes this path and keeps its own width.
     */
    /**
     * Whether the card has to own its whole row: it has an alarm list, and that
     * list is empty (or has not been heard from) so it hides itself.
     *
     * The alarm card drops out on *both* "no alarms" and "nothing heard yet"
     * (`only_when_alarm` treats a silent device as nothing to show), so the
     * schematic has to reclaim the row in both cases.  Deriving this from the
     * readings alone - never from the layout - is what lets it be asked at three
     * different moments: by `_signature` (so a change triggers a render), by
     * `willUpdate` (so the very first paint of that render already has the right
     * width cap) and by `_syncRowSpan` (where the cell is actually written).
     */
    _rowSpanWanted() {
      if (!this._config || !this._config.alarm_entity) return false;
      const count = this._alarmCount();
      return count == null || count === 0;
    }

    _syncRowSpan() {
      if (!this._config || !this._config.alarm_entity) return;
      const cell = this._gridItem();
      if (!cell) return;
      /* The dashboard's own inline style is the value to restore, so it is
         captured once, before the first override.  Writing "" instead would
         drop the cell back to a single column on a wide screen. */
      if (this._rowSpanBase === undefined) this._rowSpanBase = cell.style.gridColumn || "";
      this._rowSpanHidden = this._rowSpanWanted();
      if (this._rowSpanHidden) {
        if (cell.style.gridColumn !== "1 / -1") cell.style.gridColumn = "1 / -1";
      } else if (cell.style.gridColumn === "1 / -1") {
        /* Only undo an override this card made - on a narrow screen, or when
           the dashboard has re-laid the row out itself, the restored value is
           already whatever it should be. */
        cell.style.gridColumn = this._rowSpanBase;
      }
    }

    /**
     * The element the dashboard's grid actually sizes, or ``null``.
     *
     * Sections wrap every card in ``<hui-card>``, but the *span* is set on the
     * element around it (``hui-card`` is ``display: inline`` and inherits the
     * width of its parent grid item).  So the search starts at the closest
     * ``hui-card`` and walks outwards until it finds an ancestor that either
     * already carries a ``grid-column`` or whose parent is a grid container.
     */
    _gridItem() {
      let el = this.closest ? this.closest("hui-card") : null;
      if (!el) {
        // A plain `custom:...` card outside a sections dashboard: the wrapper
        // HA creates still counts, as long as it is a grid child.
        el = this.parentElement;
        if (!el) return null;
        const host = el.parentElement;
        if (!host) return null;
        const display = getComputedStyle(host).display;
        return display === "grid" || display === "inline-grid" ? el : null;
      }
      let node = el;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        if (node.style && node.style.gridColumn) return node;
        const parent = node.parentElement;
        if (!parent) break;
        const display = getComputedStyle(parent).display;
        if (display === "grid" || display === "inline-grid") return node;
        node = parent;
      }
      return el;
    }

    /**
     * Settle the row span *before* the template is evaluated.
     *
     * Whether the card owns the whole row follows from the readings alone, so it
     * can be decided here instead of in `updated()`.  That matters because the
     * width cap in `_wrapStyle` is part of the template: deciding it afterwards
     * would paint one frame of a full-width, full-height drawing before the cap
     * snapped it down, which on a slow Raspberry Pi is a very visible jump.
     *
     * The DOM write itself still happens in `_syncRowSpan()`, which runs after
     * the update - `willUpdate` must not touch the document.
     */
    willUpdate() {
      this._rowSpanHidden = this._rowSpanWanted();
    }

    updated() {
      super.updated();
      this._syncRowSpan();
      this._measureHalfWidth();
      this._watchHalfWidth();
    }

    /**
     * Remember how wide the schematic is while the card shares its row.
     *
     * That number is the width the drawing keeps once the alarm list hides and
     * the card spans the whole row - see `_syncRowSpan` and `_wrapStyle`.  It is
     * measured rather than hard coded because it depends on the dashboard's own
     * column width, the card padding and any `max_width` cap, and because the
     * half-row layout is the one an idle device has been drawing all along: the
     * picture simply stays exactly the size the user is used to.
     *
     * Two situations have to be handled, and only one of them is free:
     *
     * - the card is already narrow (alarms on screen), so the wrap *is* at the
     *   width to remember and can be read directly;
     * - the card spans the row (no alarms yet) and the box on screen is the
     *   capped one - reading it would feed the cap back into itself and shrink
     *   the drawing on every render.  Here the dashboard's own column is
     *   restored for a single synchronous reflow, measured, and put back.  That
     *   costs one layout, so it only happens when the card width has changed
     *   since the last measurement (first render, window resize, rotation).
     */
    _measureHalfWidth() {
      if (!this.renderRoot) return;
      const wrap = this.renderRoot.querySelector(".wrap");
      if (!wrap) return;
      const container = wrap.parentElement || wrap;
      const base = Math.round(container.clientWidth);
      if (!this._rowSpanWanted()) {
        const width = Math.round(wrap.clientWidth);
        if (width <= 0) return this._remeasureLater();
        this._halfWidth = width;
        this._halfWidthBase = base;
        this._remeasureTries = 0;
        return;
      }
      if (base > 0 && base === this._halfWidthBase && this._halfWidth > 0) return;
      const cell = this._gridItem();
      if (!cell) return;
      const span = cell.style.gridColumn;
      const cap = wrap.style.maxWidth;
      cell.style.gridColumn = this._rowSpanBase || "";
      wrap.style.maxWidth = "none";
      const width = Math.round(wrap.clientWidth);
      cell.style.gridColumn = span;
      wrap.style.maxWidth = cap;
      /* A card can be laid out before the dashboard around it is, which reads
         as a zero-width wrap - ask again next frame instead of leaving the
         drawing on the "50%" guess until the next reading happens to change. */
      if (width <= 0) return this._remeasureLater();
      this._halfWidthBase = base;
      this._remeasureTries = 0;
      if (width !== this._halfWidth) {
        /* `_wrapStyle` reads the number during render, and the measured width is
           part of `_signature`, so this asks for that render. */
        this._halfWidth = width;
        this.requestUpdate();
      }
    }

    /** Retry `_measureHalfWidth` on the next frame, a few times at most. */
    _remeasureLater() {
      const tries = (this._remeasureTries || 0) + 1;
      this._remeasureTries = tries;
      if (tries > 6) return;
      requestAnimationFrame(() => {
        if (this.isConnected) this._measureHalfWidth();
      });
    }

    /**
     * Watch the card's own width, so a stale measurement cannot survive.
     *
     * A first render can happen before the dashboard has decided how wide the
     * section is - the card is briefly laid out at some provisional width, which
     * would otherwise be remembered as "half a row" for the rest of the session.
     * There is no reading to wait for (`quick/state` re-renders are gated by
     * `shouldUpdate`), so the size itself is the signal.  The callback only acts
     * when the *width* changed, because the cap changes the card's height.
     */
    _watchHalfWidth() {
      if (this._halfWidthObserver || typeof ResizeObserver === "undefined") return;
      const wrap = this.renderRoot && this.renderRoot.querySelector(".wrap");
      const target = wrap && (wrap.parentElement || wrap);
      if (!target) return;
      this._halfWidthObserver = new ResizeObserver(() => {
        const el = this.renderRoot && this.renderRoot.querySelector(".wrap");
        if (!el) return;
        const container = el.parentElement || el;
        const base = Math.round(container.clientWidth);
        if (base > 0 && base !== this._halfWidthBase) this._measureHalfWidth();
      });
      this._halfWidthObserver.observe(target);
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
        /* Which of the two drawings is shown, and what the unit looks like:
           both are part of the visual result, so a changed `variant` or
           `image` must rebuild the SVG.  The resolved photo — not the raw
           config value — is the key, because with no `image` configured the
           artwork follows the SKU, and two SKUs can share a port count. */
        this._isMicroInverter() ? "inv" : "sys",
        /* A micro inverter's system view drops a branch (`inverter-system`), so
           the two flavours of the schematic have to be distinguishable in the
           rebuild key as well - otherwise switching a card between them would
           keep the old SVG. */
        this._isInverterSystem(),
        this._productImage(), this._config.dim_when_idle,
        /* Whether the inverter layout draws the 并网端口 node is a config
           decision, so toggling it has to rebuild the SVG.  The node is on
           unless it is explicitly disabled. */
        this._config.show_grid !== false,
        /* How many PV inputs the unit has decides how many nodes are drawn,
           and it is resolved from the readings / the device registry rather
           than from a config field alone - so it has to be part of the key or a
           unit that starts reporting its second input keeps the old single-node
           layout forever. */
        this._pvCount(),
        this._temperature(),
        /* Readings are compared at the precision the card prints them with.
           They wiggle in their last digit every second, and rebuilding the
           whole diagram for that makes the browser re-decode the seven
           embedded icons on every push - visible as a hitch on a Raspberry Pi.
           The idle / live threshold is not a printing decision, so it is part
           of the key: otherwise a branch could stay grey at exactly MIN_FLOW. */
        wkey(d.pv), wkey(d.pv2), wkey(d.grid), wkey(d.load), wkey(d.smartPlug),
        wkey(d.battery),
        /* The micro-inverter layout prints the unit's own AC port reading
           instead of the system balance, so that one has to be in the key too
           or the 并网端口 number would freeze at its first value. */
        wkey(d.gridPort),
        /* The micro-inverter layout prints the per-port readings, not the
           system totals, so they are part of the key as well - all of them, so
           a 4-input unit redraws when its third or fourth port starts. */
        d.pvPorts.map(wkey).join(","),
        d.soc === null || d.soc === undefined ? "x" : num(d.soc).toFixed(2),
        d.status, d.rssi, d.packs,
        /* The role still changes the drawing: `solar2` decides whether a second
           DC input is read at all, and the role chip itself is part of the
           header.  `plug` no longer gates any branch - the system schematic
           draws all of them whatever the role - so it is only in the key for
           the sake of the `d.smartPlug` value, which its own `wkey` entry
           already covers. */
        d.role, d.solar2,
        /* `has_meter: false` turns the 电网 node into the lumped 「电网&负载」,
           so the flag changes the diagram and has to be in the key - without
           it the first report after a reload would leave the two-node layout
           on screen forever.  负载 itself is drawn either way. */
        String(d.meter),
        /* The corner badge and the row width both follow the alarm count, and
           neither is a reading - without this key the first alarm after a
           restart would leave the card spanning a row it no longer owns. */
        String(this._alarmCount()),
        /* Spanning the row caps the drawing at its half-row width
           (`_wrapStyle`), i.e. it changes the SVG's size without changing any
           reading, so it belongs in the key too - and it is derived from the
           alarm count, which is already in the key, so this entry is what makes
           the *cap* follow rather than the count alone. */
        this._rowSpanWanted() ? "wide" : "half",
        /* And the cap is a *measured* number that only exists after the first
           layout pass, so learning it has to trigger a render of its own - the
           first paint is drawn with the "50%" estimate. */
        this._halfWidth,
      ].join("\u0001");
    }

    /** Multiplier for the flow speed (`flow_speed`, 1 = default). */
    _flowSpeed() {
      const scale = num(this._config && this._config.flow_speed);
      return scale > 0 ? scale : 1;
    }

    /* ---------------------------- the streaks ---------------------------- */

    /**
     * Decide what each connector's streak should be doing right now.
     *
     * Every lit connector is put on **one shared clock** - `FLOW_CYCLE_S`
     * divided by `flow_speed` - and each is given the stage of that cycle it
     * belongs to.  A single negative `animation-delay` per connector then puts
     * its CSS animation at the right point of the cycle, so the whole diagram
     * runs in step: PV arrives, meets the battery at the junction, and only
     * then does the trunk carry the total onwards.  Independent timers per
     * branch (what the old dots did) could never express that, and every
     * branch drifted against its neighbours.
     *
     * The epoch is remembered on the card rather than derived from the
     * document, because the SVG is rebuilt about once a second: a rebuild must
     * place the streaks exactly where the previous frame had them, and a
     * document-time origin would jump them all forward by the render time.
     */
    _beamPlan(routes) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (!this._pfEpoch) this._pfEpoch = now;

      const cycle = FLOW_CYCLE_S / this._flowSpeed();
      const phase = ((now - this._pfEpoch) / (cycle * 1000)) % 1;
      const delay = phase * cycle;

      const plan = [];
      for (const route of routes) {
        /* A merge bar is not a run: the two halves of a split input already
           carry a streak each up to it, and a third one crawling down the bar
           would claim the energy travels along the bar rather than gathering
           on it.  Same reason the junction in the storage schematic has no
           streak of its own. */
        if (route.beam === false) continue;
        if (Math.abs(num(route.power)) < MIN_FLOW) continue;
        const travel = travelPath(route);
        const len = pathLength(travel);
        if (!(len > 0)) continue;
        plan.push({
          route, travel, len,
          stage: route.stage || 0,
          cycle, delay,
        });
      }
      return plan;
    }

    /** Re-arm the flow clock so a re-mounted card starts a fresh cycle. */
    connectedCallback() {
      super.connectedCallback();
      I18N.watch(this);
      /* The streaks are CSS animations and survive the detach / re-attach that
         switching dashboard tabs performs, so there is nothing to restart.
         The clock is reset all the same: the card may come back a long time
         later, and a phase computed from the old epoch would drop the streaks
         in mid-run. */
      this._pfEpoch = 0;
      /* A window resize - or a tablet rotating - changes the dashboard's column
         width, so the remembered half-row width has to be measured again.
         Debounced: the measurement itself forces a reflow, and `resize` fires
         on every frame of a drag. */
      this._onResize = () => {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
          this._halfWidthBase = 0;
          this._remeasureTries = 0;
          this._measureHalfWidth();
        }, 200);
      };
      window.addEventListener("resize", this._onResize);
    }

    disconnectedCallback() {
      I18N.unwatch(this);
      window.removeEventListener("resize", this._onResize);
      clearTimeout(this._resizeTimer);
      if (this._halfWidthObserver) {
        this._halfWidthObserver.disconnect();
        this._halfWidthObserver = null;
      }
      super.disconnectedCallback();
      this._pfEpoch = 0;
    }

    /* ----------------------------- lookup ----------------------------- */

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
     * Resolve an entity id for this device.
     *
     * Five strategies, cheapest first: the conventional
     * ``<domain>.<slug(dev_id)>_<suffix>`` id, a prefix+suffix scan, a scan
     * keyed on the serial for a renamed device, both of those again with Home
     * Assistant's disambiguation number stripped, and finally the registry's
     * ``name``/``translation_key``.  Results are cached, because the scan is
     * O(entities) and the card re-renders on every state change.
     *
     * The numbered pass is what makes a colliding serial work at all.  HA does
     * not fail a registration whose derived ``entity_id`` is taken - it appends
     * ``_2``, ``_3`` … - so a unit registered once before carries every id one
     * suffix away from the conventional one, and without this the card fell
     * through to its placeholder values and drew every node as `—`.
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

      if (!found) {
        // The same, tolerating Home Assistant's `_2`.  Tried after the exact
        // pass so an unsuffixed id always wins and only a genuinely numbered
        // one is picked up; shortest wins for the same reason, which prefers
        // `_2` over `_10`.
        const prefix = `${domain}.${dev}`;
        const wanted = norm(suffix);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          if (norm(stripAuditSuffix(entityId.slice(prefix.length + 1))) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found) {
        // A renamed device.  Renaming it in Home Assistant rewrites every
        // entity id to the new name, so `sensor.rmi_4161a0209ff6_grid_port_power`
        // became `sensor.wo_shi_rmi_4161a0209ff6_grid_port_power` and the
        // `<slug(dev_id)>_` prefix the two strategies above rely on is gone.
        // The serial never changes, so the normalized tail *after the serial*
        // is compared instead: that still pins the entity to this unit and it
        // keeps `soc` from matching `system_soc`, because only the part that
        // follows the serial is looked at.
        const marker = norm(this._dev());
        const wanted = norm(suffix);
        for (const entityId of Object.keys(hass.states)) {
          const flat = norm(entityId);
          const at = marker ? flat.indexOf(marker) : -1;
          if (at < 0) continue;
          if (flat.slice(at + marker.length) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found) {
        // Same rename-tolerant pass, tolerating the disambiguation number.
        const marker = norm(this._dev());
        const wanted = norm(suffix);
        for (const entityId of Object.keys(hass.states)) {
          const flat = norm(entityId);
          const at = marker ? flat.indexOf(marker) : -1;
          if (at < 0) continue;
          if (norm(stripAuditSuffix(flat.slice(at + marker.length))) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found && hass.entities) {
        // Last resort, and the only one that still works when neither the
        // serial nor the slug survives in the id: match the registry `name`
        // (or its `translation_key`) our own sensor description gives, exactly
        // as the number card does.  Scoped to this unit's devices, because a
        // name match across the whole registry would happily return another
        // inverter's sensor - showing the wrong unit's watts is worse than
        // showing `—`.  The unique_id the comment above used to rely on is
        // **not** in `hass.entities` (the frontend payload omits it), so that
        // branch was dead code.
        const deviceIds = this._deviceIds();
        const wanted = norm(suffix);
        for (const [entityId, entry] of Object.entries(hass.entities)) {
          if (!entry || !entityId.startsWith(`${domain}.`)) continue;
          if (deviceIds.size && !deviceIds.has(entry.device_id)) continue;
          if (norm(stripAuditSuffix(entry.name)) !== wanted
            && norm(stripAuditSuffix(entry.translation_key)) !== wanted) continue;
          if (!hass.states[entityId]) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    /**
     * The registry device ids that belong to `dev_id`, resolved once.
     *
     * `hass.devices` keys an array of `[domain, identifier]` pairs, and the
     * integration registers the serial verbatim, so the serial surviving in the
     * identifier is what ties a device to this card.  An empty set means "could
     * not tell" - the caller then skips the scoped fallback rather than guessing.
     */
    _deviceIds() {
      if (this._deviceIdsCache) return this._deviceIdsCache;
      const out = new Set();
      const devices = (this._hass && this._hass.devices) || {};
      const serial = String(this._dev() || "");
      if (!serial) {
        this._deviceIdsCache = out;
        return out;
      }
      for (const [deviceId, device] of Object.entries(devices)) {
        if (!device) continue;
        for (const pair of device.identifiers || []) {
          if (Array.isArray(pair) && String(pair[1]) === serial) {
            out.add(deviceId);
            break;
          }
        }
      }
      this._deviceIdsCache = out;
      return out;
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
      //
      // A **slave** in a master/slave pair is exactly that case: protocol §32
      // 「状态事件」 reports `has_meter: false` for it, so the firmware has
      // nothing to build `sys_*` from and every system level entity stays
      // `unknown` forever.  Falling through to the unit's own per-port and
      // on-grid readings keeps the diagram readable instead of showing five
      // dashes; a master or a single unit never reaches these fallbacks because
      // its system level values are present.
      const ev = this._eventInfo();
      /* 光伏1 is **the generation of the devices in this system**.  There are
         two candidate fields and they measure different ends of the same wire:
         `sys_pv_p` (`system_pv_power`) is the DC side - what the panels fed
         *into* the units - while `sys_plug_p` (`system_plug_power`) is what the
         installation delivered at its AC terminals.  Measured on the same
         second, `sys_pv_p` 133.3 W against `sys_plug_p` 100.6 W, the difference
         being the units' own conversion and standby losses.

         A micro inverter's system view shows the AC figure, because that is the
         number the vendor app puts on its front page, the one the device itself
         echoes back when a power set-point is verified, and the one the 功率
         curve beside this card is drawn from (`lovelace.py`).  Keeping the
         drawing on the DC field would have made the two disagree by ~25 W on a
         130 W roof, which reads as a bug.

         The storage schematic keeps `sys_pv_p`: there the PV branch leads into
         the battery, where the DC figure is the one that balances.

         The fallback to this unit's own `pv1_power` is kept, and only this one:
         a slave publishes no system level figures at all, and that unit *is* a
         device in the system, so its own first input is a true (if partial)
         sample of the same quantity - the same kind of number, measured
         smaller.  It never turns into a different concept. */
      const pvSource = this._isInverterSystem()
        ? (this._read("system_plug_power", null) ?? this._read("system_pv_power", null))
        : this._read("system_pv_power", null);
      const pv = pvSource ?? this._read("pv1_power", null);
      /* 光伏2 is a **different quantity and has no device-side counterpart**:
         it is generation coming from *outside* this system - a second array, a
         neighbour's roof, anything the meter sees but the system does not own.
         In practice it lights up when the grid is exporting heavily while the
         system's own devices produce nothing.

         So `system_pv2_power` is read **alone**.  It used to fall back to this
         unit's `pv2_power`, which is the second *DC connector on the machine* -
         an input, not an external source.  On a 2-input unit that fallback
         silently filled 光伏2 with the unit's own second string, which is drawn
         on the Device tab as 「PV2」 and means something else entirely.  The two
         must never be confused, so a system without the aggregate shows `—`.

         `has_solar2` is still consulted, but only as the hardware fact it is:
         `false` (no external second source fitted) drops the branch, `true` or
         "not reported" keeps it. */
      const solar2 = ev.solar2 !== false;
      const pv2 = solar2 ? this._read("system_pv2_power", null) : null;
      /* The micro-inverter layout labels one node per *physical* PV input, so
         it needs the per-port readings, not the system totals: pv1 is the
         unit's own first input and pv2 its second.  They are `null` on a
         one-input unit, which is exactly what decides how many nodes to draw.
         A 4-input unit (`RMI-4162`) adds `pv3` / `pv4`, so all four are read -
         the two extra entities exist on every model and simply stay `unknown`
         where the port is absent.

         These entities are 1 s: `pv<n>_power` prefers `quick/state["pv<n>_p"]`
         and only falls back to the 5 min `pvs[].p` when that field is missing.
         That is what lets the Device tab follow the same second-by-second rate
         as the System tab - a slave unit has no meter and therefore no system
         level data at all, so the Device tab has to stand on its own. */
      const pvPorts = [];
      for (let i = 1; i <= IV_PV_MAX; i += 1) {
        pvPorts.push(this._read(`pv${i}_power`, null));
      }
      /* Every input added up, as the firmware's own strings report them.  The
         Device tab of a one-input body draws that body's *whole* DC side, and
         `pv1_power` alone is not it: a `1650` publishes two inputs on
         ``quick/state`` even though it exposes one connector, and its
         ``device/state`` carries the same split in ``pvs[]``.  Measured on
         three of them over 45 s: `pv1_p` 4.8 against `pv2_p` 4.8, 4.3/4.3 and
         4.0/4.0 - the firmware mirrors the single MPPT into both fields.

         Summing that mirror therefore reports twice the real DC power, which is
         exactly what was asked for and what the vendor app shows for this body:
         the number on the Device tab is the sum of the strings the unit
         declares, not a de-duplicated guess at how many MPPTs sit behind them.
         De-duplicating was tried first and rejected - it needs a per-model
         "these two fields are one input" table that a future firmware can
         falsify silently, while the sum needs nothing and agrees with the app.

         A body with several inputs is unaffected: `pv_total_power` is only
         consulted for the single-port layout, where `pv1_power` and `pv2_power`
         have no separate nodes to be drawn on. */
      const pvTotal = this._read("pv_total_power", null);
      /* The household side of the meter, and the smart plug beside it.  Both are
         drawn on the system schematic no matter what §32 says about this unit's
         installation (see `_svgSystem`): the schematic shows the house the unit
         is wired into, not only the parts the unit itself can measure.  A slave
         reports no `system_load_power` / `system_smart_plug_power`, so those
         nodes print `—` - present but blank, which is exactly what they are. */
      const load = this._read("system_load_power", null);
      const smartPlug = this._read("system_smart_plug_power", null);

      /* 并网端口, two separate readings with two separate conventions - they
         must not be conflated, because the storage schematic and the inverter
         layout read the port from opposite ends of the same wire.

         `grid` - the *system* grid balance, i.e. the house's side of the
         meter.  Positive = importing, negative = feeding back.  This is the
         one `_svgSystem` has always drawn, so its sign is
         fixed in stone.  `system_grid_power` is primary; `grid_on_p` uses the
         opposite sign (negative = drawing from the grid), so the fallback is
         negated to keep the convention.

         `gridPort` - the *unit's own* AC output, positive = energy leaving
         the unit into the house.  Only the inverter layout draws it, and it
         is what the 并网端口 node on a micro inverter should show.  The 1 s
         `grid_on_p` only exists on units that declare the `system_state`
         capability (storage), so a micro inverter has it permanently
         `unknown`; the same field in the 5 min payload is NOT capability
         gated and is what such a unit actually publishes - measured live,
         `system_pv_power` 539.7 W against `grid_on_power_5_min` 509.9 W, i.e.
         PV minus the unit's own consumption, which is exactly the outflow the
         AC port carries. */
      let grid = this._read("system_grid_power", null);
      if (grid === null) {
        const onGrid = this._read("grid_on_power", null);
        if (onGrid !== null) grid = -onGrid;
      }

      const neg = (v) => (v === null || v === undefined ? null : -v);
      const onGrid5 = this._read("grid_on_power_5_min", null);
      const onGrid1s = this._read("grid_on_power", null);
      /* The 1 s AC port reading of a micro inverter: `quick/state["grid_on_p"]`,
         i.e. the `grid_port_power` entity.  The very same number is repeated in
         the 5 min `device/state` as `grid[0].p`, which is what
         `grid_on_power_5_min` carries, so the fast and the slow reading describe
         one physical port and must agree in sign.

         They are *compared* rather than assumed, because a firmware reporting
         the port from the opposite end of the wire would otherwise draw the
         arrow backwards on every unit in the field.  The 5 W guard keeps the
         comparison from firing while a unit idles, and nothing is cached, so a
         real disagreement is corrected again on the next render.  Reading this
         instead of the 5 min value is what lets the 并网端口 node keep up with
         the System tab instead of trailing it by up to five minutes. */
      const onGridFast = this._read("grid_port_power", null);
      let gridPort;
      if (onGridFast !== null) {
        const disagree = onGrid5 !== null
          && Math.abs(onGridFast) > 5 && Math.abs(onGrid5) > 5
          && Math.sign(onGridFast) !== Math.sign(onGrid5);
        gridPort = disagree ? -onGridFast : onGridFast;
      } else if (onGrid1s !== null) gridPort = onGrid1s;
      else if (onGrid5 !== null) gridPort = onGrid5;
      else gridPort = neg(this._read("system_grid_power", null));

      // Battery is the one node without a `sys_` counterpart at the system
      // level, so it keeps the usual system → device fallback. A pure micro
      // inverter (RMI-4161, no storage) has neither entity, so `battery` stays
      // `null` and the whole storage branch is left out of the diagram.
      let battery = this._read("system_battery_power", null);
      if (battery === null) battery = this._read("bat_power", null);

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
        pv, pv2, pvPorts, pvTotal, grid, gridPort, load, smartPlug, battery, soc,
        status: status.toLowerCase(), rssi, packs,
        /* Which role the *installation* gave this unit, per protocol §32.  The
           role no longer hides any branch of the system schematic - it only
           decides the header chip - but it is kept in the data so a layout that
           does draw this unit alone (the micro-inverter one) can still tell. */
        role: ev.role,
        solar2,
        /* Whether the installation has a meter at all, straight from §32
           「状态事件」.  `false` means this unit takes no part in metering: the
           firmware has no idea where the grid ends and the house begins, so
           the system schematic draws one combined 「电网&负载」 node instead of
           two (see `_svgSystem`).  `true` or "not reported" keeps the two-node
           layout - the same "unknown ⇒ draw as before" rule `solar2` follows. */
        meter: ev.meter,
      };
    }

    /**
     * The device's role in the installation, from protocol §32 「状态事件」.
     *
     * The integration exposes the whole payload as the `system_role` sensor:
     * the state is the role (`single` / `master` / `slave`) and the attributes
     * are the snapshot, so the card reads one entity instead of twenty.  Both
     * are optional - an older firmware without the topic, or one that has not
     * reported yet, yields `role: ""` and `null` flags, and every consumer
     * treats that as "draw what the readings say".
     *
     * `servant` is normalised to `slave`; the protocol guide says `slave` but
     * at least one build publishes the other spelling.
     */
    _eventInfo() {
      const state = this._stateOf("system_role");
      const attrs = (state && state.attributes) || {};
      let role = state ? String(state.state || "").trim().toLowerCase() : "";
      if (role === "servant") role = "slave";
      if (role !== "single" && role !== "master" && role !== "slave") role = "";
      const flag = (name) => (typeof attrs[name] === "boolean" ? attrs[name] : null);
      return {
        role,
        meter: flag("has_meter"),
        plug: flag("has_plug"),
        solar2: flag("has_solar2"),
      };
    }

    /**
     * How many PV inputs the micro inverter has: 1 (一拖一) to 4 (一拖四).
     *
     * Resolved in this order, first hit wins:
     *
     *  1. `pv_count: 1|2|3|4` in the card config - explicit, always wins, and
     *     the only way to force it when every entity is still `unknown`.
     *  2. The product id (PID) in the serial - see `IV_PV_COUNT_BY_CODE`.
     *     Every inverter serial starts with the four digit PID
     *     (`4161A0209FF6`), which identifies the port count exactly.  This is
     *     checked before any live reading because a 4-input unit at night
     *     publishes `pv3` / `pv4` as `0`, and "no live second reading" must not
     *     demote it to 1.
     *  3. A live per-port reading.  The highest `pvN_power` that reports a value
     *     decides, so a unit whose code is unknown still draws what it
     *     publishes.  All models *create* the `pvN_*` entities (the
     *     description table is shared), so existence proves nothing; a value
     *     does, and `unknown` / `unavailable` means the input is absent.
     *  4. The model name from the device registry - `HiFlow Pro` is the
     *     multi-input family, `HiFlow` the single-input one.  The G2
     *     integration's own device entry has `model: null`, so the parallel
     *     `mqtt` device (same serial, no `RMI-` prefix) is the one that carries
     *     it.  Only reached when the serial carries no known code.
     *
     * Falls back to 1, so a unit with nothing reported draws the simpler
     * single-input layout instead of inventing extra connectors.
     */
    _pvCount() {
      const forced = Math.round(Number(this._config && this._config.pv_count));
      if (forced >= 1 && forced <= IV_PV_MAX) return forced;

      const code = this._productCode();
      if (code && IV_PV_COUNT_BY_CODE[code]) return IV_PV_COUNT_BY_CODE[code];

      /* Highest port that actually reports a value.  `_stateOf` returns null for
         `unknown` / `unavailable`, which is what an absent input looks like. */
      let reported = 0;
      for (let i = 1; i <= IV_PV_MAX; i += 1) {
        if (this._stateOf(`pv${i}_power`)) reported = i;
      }
      if (reported > 0) return reported;

      const model = this._deviceModel();
      if (/pro/i.test(model)) return 2;
      if (/hiflow/i.test(model)) return 1;
      return 1;
    }

    /**
     * True when the Device view draws **two** PV ports for this unit.
     *
     * Only the small HiFlow (1650) is drawn that way - see `IV_SPLIT_PV_CODE`
     * for why a one-input body gets two nodes.  The test is on the SKU alone,
     * never on the resolved port count, because `4160` is also a single-input
     * body and its artwork (and its firmware) really does have one DC lead.
     *
     * This used to bail out whenever the card carried `pv_count >= 1`, on the
     * idea that a dashboard which forced a port count was stating what the
     * hardware has.  That made the split unreachable in practice: the
     * integration always writes `pv_count` from `PID_PV_COUNT`, and `1650`
     * maps to `1` there - the very SKU this layout exists for - so every
     * generated dashboard switched the two-port drawing off.  Port count and
     * drawing are two different questions: the count says how many readings
     * exist (one, for this body), the drawing says how many leads the vendor
     * app puts on it (two).  The opt-out is therefore an explicit
     * `split_pv: false`, which no generator writes and a user can.
     */
    _splitPv() {
      if (this._config && this._config.split_pv === false) return false;
      return this._productCode() === IV_SPLIT_PV_CODE;
    }

    /**
     * The four digit PID from the serial, or `""`.
     *
     * `RMI-4161A0209FF6` -> `"4161"`, `4161A0209FF6` -> `"4161"`, and
     * `GARAGE-4161A0209FF6` -> `"4161"` as well.  The PID is the leading four
     * digits of the serial *body* - which is why the last `-` separated segment
     * is used rather than the whole string, so that a renamed client prefix can
     * never shift the digits.  Anything that does not look like a Hoymiles
     * serial yields `""` and the caller falls through to the reading / model
     * heuristics.
     */
    _productCode() {
      const dev = String(this._dev() || "");
      const body = dev.split("-").pop().replace(/[^0-9A-Za-z]/g, "");
      const match = body.match(/^(\d{4})/);
      return match ? match[1] : "";
    }

    /** Model string of this device, from whichever registry entry has one. */
    _deviceModel() {
      const devices = (this._hass && this._hass.devices) || null;
      if (!devices) return "";
      const dev = this._dev();
      const bare = dev.replace(/[^A-Za-z0-9]/g, "");
      let found = "";
      for (const entry of Object.values(devices)) {
        if (!entry) continue;
        const ids = (entry.identifiers || []).map((pair) => String((pair && pair[1]) || ""));
        const names = [entry.name, entry.model_by, entry.default_name]
          .filter(Boolean).map(String);
        const matches = ids.some((id) => id === dev || id === bare)
          || names.some((n) => n.replace(/[^A-Za-z0-9]/g, "") === bare);
        if (!matches) continue;
        if (entry.model) return String(entry.model);
        found = found || "";
      }
      return found;
    }

    /* ----------------------------- render ----------------------------- */

    /**
     * The product photo this unit should be drawn with.
     *
     * An explicit `image` in the card config always wins - that is what lets a
     * dashboard override the artwork without a code change.  Otherwise the SKU
     * picks the cut-out, so the body shows the same number of DC inputs as the
     * nodes drawn below it; a code the table does not know falls back to the
     * resolved port count, and a unit with neither keeps the 2-in-1 default.
     */
    _productImage() {
      const forced = String((this._config && this._config.image) || "").trim();
      if (forced) return forced;
      const code = this._productCode();
      if (code && IV_IMAGE_BY_CODE[code]) return IV_IMAGE_BY_CODE[code];
      return IV_IMAGE_BY_COUNT[this._pvCount()] || IV_IMAGE_DEFAULT;
    }

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
                ${esc(this._text(this._config.title) || this._t("My Home", "我的家"))}
                <span class="dev">${esc(this._dev())}</span>
              </div>` : ""}
            <div class="hright">
              ${this._roleChip(d)}
              ${this._signal(d)}
              ${temp === null ? "" : html`
                <div class="chip">
                  ${this._untrusted(this._sunChip())}<span>${temp}</span>
                </div>`}
            </div>
          </div>
          <div class="wrap" style=${this._wrapStyle()}>
            ${this._healthChip()}
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

    /**
     * The device's role, as a chip in the header.
     *
     * The chip no longer explains a difference in the system schematic - that
     * drawing is identical for every role now, because it shows the house the
     * unit is wired into rather than only the parts the unit can measure.  It
     * still records the fact, because the role does change the Device tab (a
     * micro-inverter in a master/slave pair reports its own ports, not the
     * system totals) and because knowing which unit carries the meter is useful
     * when comparing the two tabs.  Nothing is shown for a stand-alone unit
     * (the overwhelming majority, and `—` would just be noise) and nothing is
     * shown when the firmware has not said, because an empty chip is worse than
     * no chip.
     */
    _roleChip(d) {
      const role = d.role;
      if (!role || role === "single") return null;
      const master = role === "master";
      const text = master ? this._t("Master", "主机") : this._t("Slave", "从机");
      const hint = master
        ? this._t("This unit carries the system meter",
          "本机承担系统电表计量")
        : this._t("Follows the master; its own ports are drawn on the device tab",
          "跟随主机，本机端口见设备页");
      return html`<div class="role ${master ? "master" : "slave"}" title=${hint}>${text}</div>`;
    }

    /**
     * The sun in front of the outdoor temperature.
     *
     * Drawn rather than typed: the emoji renders as a colour cartoon at whatever
     * size and weight the host font picks, which reads as an illustration beside
     * the flat chips around it.  A disc plus eight round-capped rays keeps it an
     * icon - the same optical weight as the signal bars.
     */
    _sunChip() {
      const rays = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => `<line
          x1="12" y1="5" x2="12" y2="2" stroke="#f5a623" stroke-width="1.9"
          stroke-linecap="round" transform="rotate(${deg} 12 12)"/>`).join("");
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"
          aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4.6" fill="#f5a623"/>${rays}</svg>`;
    }

    _wrapStyle() {
      const width = num(this._config.max_width);
      /* ``max_width: 0`` is not "no width" - it is "no cap": the drawing fills
         whatever cell the dashboard gives the card, scaling proportionally.
         The Device tab's card needs exactly that (it is half of a row while
         faults are listed beside it and the whole row when they are not), so
         the migrations write 0 there.  A positive number still caps the
         drawing, and a card with no option at all keeps the System tab's
         original 620 px. */
      if (width > 0) return `max-width:${width}px`;
      if (width === 0 && this._config.max_width != null) {
        if (!this._rowSpanWanted()) return "max-width:none";
        /* The card spans the row and there is no alarm list beside it.  The
           drawing must not grow with the row: same height, only a longer card,
           with the schematic centred in the middle of it.  So the cap is the
           width the drawing had in half a row, measured by `_measureHalfWidth`.
           "50%" is only reached before that first measurement lands (`updated`
           is still to run), and it is a fair guess: half a row is half a card.
           `min()` keeps the drawing inside the card on a phone, where the row
           is narrower than the remembered desktop width. */
        const cap = this._halfWidth > 0 ? `${Math.round(this._halfWidth)}px` : "50%";
        return `max-width:min(100%, ${cap})`;
      }
      return "max-width:620px";
    }

    /**
     * How many alarms the device is currently reporting, or ``null``.
     *
     * ``null`` covers two different situations that must not be drawn as
     * "healthy": the card was never given an alarm entity (the System tab has
     * no single device to ask), and the entity exists but the device has not
     * said anything yet - ``alarm/state`` is not a retained topic, so a fresh
     * restart legitimately has no data.  ``0`` is the only value that earns the
     * green tick.
     */
    _alarmCount() {
      const entityId = this._config && this._config.alarm_entity;
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const items = state.attributes && state.attributes.alarms;
      if (Array.isArray(items)) return items.length;
      const count = num(state.state);
      // `unavailable` / `unknown` parse to 0 through `num`, which would claim
      // the device is fine; the raw state has to be checked first.
      if (state.state === "unavailable" || state.state === "unknown") return null;
      return Number.isFinite(count) ? count : null;
    }

    /**
     * The condition badge: a circled tick, or the vendor app's warning triangle.
     *
     * The alarm state is the G3 dashboard's own glyph - a *filled* red triangle
     * with a white exclamation, sitting in the card's top-left corner - because
     * that is the icon the official app uses for the same fact, and a user who
     * has seen one device's page should not have to read a second convention on
     * the next.  The healthy state keeps the ringed green tick this card has
     * always drawn: it is quiet, it matches the schematic's other ringed icons,
     * and the absence of a warning is not something to shout about.
     *
     * The markup goes through ``_untrusted()`` because it is a raw string.
     */
    _healthChip() {
      const count = this._alarmCount();
      if (count == null) return html``;
      const ok = count === 0;
      const hint = ok
        ? this._t("No active alarms", "当前无告警")
        : `${this._t("Active alarms", "当前告警")}: ${count}`;
      /* A filled triangle reads at 19 px where an outlined one turns to mush,
         so the warning is solid and its exclamation is cut out in the card
         background colour.  The tick stays outlined to match its neighbours. */
      const glyph = ok
        ? "<svg viewBox=\"0 0 24 24\" width=\"19\" height=\"19\" fill=\"none\" "
          + "aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9.2\" "
          + "stroke=\"currentColor\" stroke-width=\"1.9\"/>"
          + "<path d=\"M7.8 12.3l2.9 2.9 5.5-5.9\" stroke=\"currentColor\" "
          + "stroke-width=\"2.1\" stroke-linecap=\"round\" "
          + "stroke-linejoin=\"round\"/></svg>"
        : "<svg viewBox=\"0 0 24 24\" width=\"19\" height=\"19\" fill=\"none\" "
          + "aria-hidden=\"true\"><path d=\"M12 2.6c.66 0 1.27.35 1.6.93l9.1 15.9c.33.58.33 1.29 0 1.87"
          + "-.33.58-.94.93-1.6.93H2.9c-.66 0-1.27-.35-1.6-.93a1.87 1.87 0 010-1.87"
          + "l9.1-15.9c.33-.58.94-.93 1.6-.93z\" fill=\"currentColor\"/>"
          + "<path d=\"M12 7.6v5.6\" stroke=\"#fff\" stroke-width=\"2\" "
          + "stroke-linecap=\"round\"/><circle cx=\"12\" cy=\"16.9\" r=\"1.3\" "
          + "fill=\"#fff\"/></svg>";
      return html`
        <div class="health ${ok ? "ok" : "warn"}" title=${hint}>
          ${this._untrusted(glyph)}
        </div>`;
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
      const quality = bars === 4 ? this._t("Excellent", "优秀")
        : bars === 3 ? this._t("Good", "良好")
          : bars === 2 ? this._t("Fair", "一般")
            : this._t("Weak", "较弱");

      return html`
        <div class="signal" title=${`${this._t("Wi-Fi Signal", "Wi-Fi 信号")}: ${quality}`}>
          ${this._untrusted(this._signalBars(bars))}
          <span>${rssi.toFixed(0)} dBm</span>
        </div>`;
    }

    /**
     * The icon: four bars of increasing height. Geometry and colours match
     * ``hoymiles-g2-battery``'s `_signal()` exactly, so the same reading looks
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

    _svg(d) {
      if (this._isMicroInverter()) return this._svgInverter(d);
      return this._svgSystem(d);
    }
    /**
     * True when the card is asked to draw a micro inverter (HiFlow) rather
     * than the storage schematic.
     *
     * This is deliberately an explicit option and NOT auto-detected.  The same
     * card is used for the `system` view of a storage device *and* of a micro
     * inverter (an RMI can read `system_pv_power` / `system_grid_power` too), so
     * sniffing the serial prefix would silently change the system view as well.
     * `variant: inverter` is opt-in, which keeps those views pixel-identical -
     * only the view that asks for it changes.
     */
    _isMicroInverter() {
      const variant = this._config && this._config.variant;
      return String(variant || "").toLowerCase() === "inverter";
    }

    /**
     * True when this is the **system** view of a micro inverter, which is the
     * storage schematic with a handful of corrections applied.
     *
     * The two drawings are separate (`variant: inverter` picks the Device tab's
     * port layout, this picks the System tab), so a single key cannot mean both
     * - `inverter` must keep meaning "draw the unit's own ports".  Hence the
     * third value: `variant: inverter-system` draws the shared schematic, then
     * lets the three adjustments below apply, because a HiFlow installation
     * differs from a storage one in ways the drawing has to respect:
     *
     * 1. **There is no 光伏2.**  光伏2 is generation from *outside* the system,
     *    which only a metering unit can see.  A HiFlow house has no second
     *    array reported that way, so the node is dead weight: it printed a
     *    permanent `—` on every unit measured.
     * 2. **A negative 负载 is folded into 光伏.**  When the meter reports the
     *    house as exporting (负载 < 0) the energy is not being consumed at all -
     *    it is generation the system did not account for, so it belongs with
     *    the PV figure rather than as a negative load.  Only the *displayed*
     *    number changes; the connector keeps its own reading and direction, so
     *    the streak still travels the way the energy does.
     * 3. **The labels move out of the connectors.**  The storage schematic puts
     *    every caption under its ring, which works because its branches leave
     *    sideways.  On the HiFlow layout the PV1 and 电网 branches drop straight
     *    down from the ring, so the caption sat *on* the line.  There the
     *    captions go above the ring instead, into empty canvas.
     *
     * The storage views (`_build_storage_views`) never set this key, so they
     * keep their exact current drawing.
     */
    _isInverterSystem() {
      const variant = this._config && this._config.variant;
      return String(variant || "").toLowerCase() === "inverter-system";
    }

    /**
     * The micro-inverter drawing: the PV inputs along the bottom, the product
     * photo in the middle, and the 并网端口 above it on the right - the AC
     * output, which is the path the energy takes out of the unit and into the
     * house.
     *
     * That is the same three-branch shape the storage schematic uses (PV in,
     * unit, output out), so the two views read alike.  The streaks carry the
     * direction: they run from the PV ports into the unit, and from the unit
     * out through the 并网端口 while it is producing.  At night the unit draws
     * a standby current, so both reverse.
     *
     * The port reading here is `d.gridPort` - the unit's *own* AC output,
     * positive = energy leaving the unit - and not `d.grid`, which is the
     * system's grid balance with the opposite convention (positive =
     * importing) and belongs to the storage schematic.
     *
     *   pv     producing            node -> unit
     *          consuming (night)    unit -> node    (reverse)
     *   grid   exporting (> 0)      unit -> node    (reverse)
     *          importing (< 0)      node -> unit
     */
    _svgInverter(d) {
      const present = (v) => v !== null && v !== undefined && !Number.isNaN(num(v));
      /* A missing reading prints a dash instead of "0.0 W": the difference
         between "the port is idle" and "the port has not reported yet" matters
         while commissioning a unit. */
      const reading = (v) => (v === null || v === undefined ? "—" : fmtW(v));
      const pvCount = this._pvCount();
      const art = this._productImage();
      const photo = ivPhoto(art);
      const term = ivTerminals(art, photo);
      const pvNodes = [];
      /* The small HiFlow is drawn with two PV ports although the firmware only
         ever reports one figure: see `IV_SPLIT_PV_CODE`.  That variant replaces
         the whole bottom row, so the input-count layout below is skipped. */
      const split = this._splitPv();
      /* The connectors run from their node towards the unit, so each slot has
         to know where it may plug in.  A node on the outer end of the row turns
         sideways into the photo's side edge; a node underneath the photo has no
         room to turn and rises straight into its bottom edge instead.

         The two cheeks are looked up separately rather than sharing one height.
         A two-input body carries an MC4 pair on *each* side, and on the Pro
         2-in-1 they sit at different levels - so a single `pvY` put the
         right-hand connector above or below the plug it was aimed at, and
         aiming at `photo.r` left it short of the plug in the empty strip the
         crop keeps past it. */
      const rowX = IV_NODE_X[pvCount] || IV_NODE_X[1];
      /* Which cheek each slot plugs into.  The artwork decides when it lists its
         plugs (`pvLeftSlots` / `pvRightSlots`): a four-input body carries two
         MC4 pairs on *each* side, so PV1 + PV2 belong to the left cheek and
         PV3 + PV4 to the right, in that order.  Without a list the node's own
         x decides, which is how every other layout works. */
      const leftTotal = term.pvLeftSlots ? term.pvLeftSlots.length : null;
      const slotSide = (i) => {
        if (term.pvSides && term.pvSides[i]) return term.pvSides[i];
        if (leftTotal !== null) return i < leftTotal ? "left" : "right";
        const x = rowX[Math.min(i, rowX.length - 1)];
        if (x < photo.l) return "left";
        return x > photo.r ? "right" : "bottom";
      };
      /* The node follows the cheek it plugs into.  The row is laid out per
         input count and assumes the usual left / both corners / spread order,
         so an artwork that moves a slot to the right cheek (the Pro 1-in-1's
         single DC lead) gets its node mirrored to the matching column instead
         of keeping the left one and dragging the connector across the photo. */
      const slotX = (i) => {
        const x0 = rowX[Math.min(i, rowX.length - 1)];
        return slotSide(i) === "right" && x0 < photo.l ? IV_W - x0 : x0;
      };
      /* How many slots share each cheek, so a side with several strings can be
         spread over the plugs the render actually draws. */
      const sideCount = { left: 0, right: 0, bottom: 0 };
      for (let i = 0; i < pvCount; i += 1) sideCount[slotSide(i)] += 1;
      const sideSeen = { left: 0, right: 0, bottom: 0 };

      if (split) {
        /* Two solar-panel ring nodes stacked on the left, both lit from the one
           figure the unit can report, joined by plain grey lines into a single
           lead that enters the body.  `pvTotal` is every reported channel added
           up (see `_data`), so printing it once beside the junction is the
           honest rendering: the hardware exposes two input channels but
           publishes no way to attribute the power to one of them, and inventing
           a split would be a guess.  What the drawing gains is the shape - two
           panels, one lead into the unit - not a second measurement.

           The rings are the same round nodes as every other branch, and they
           are mirror-symmetric about the lead's height: an off-centre pair read
           as "one input is bigger than the other", the one claim two ports
           reporting the identical figure must not make.  They carry no caption
           of their own - `PV1` / `PV2` over two ports that report the same
           number invited the reader to look for a difference that is not there
           - so only 「PV端口」 names the pair, printed together with its value. */
        const value = d.pvTotal ?? d.pvPorts[0];
        const busX = Math.min(IV_SPLIT_BUS_X, term.pvLeftX - 8);
        /* The lead leaves the bus at the height the artwork puts its MC4 pair,
           so it arrives at the plug the render actually draws.  Clamped so the
           whole symmetric pair - two rings plus half the gap on each side -
           always fits inside the shorter viewBox. */
        const half = IV_SPLIT_GAP / 2;
        const margin = NODE_R + 8;
        const centre = Math.max(
          margin + half,
          Math.min(IV_SPLIT_H - margin - half, term.pvLeftY),
        );
        const cyTop = centre - half;
        const cyBot = centre + half;
        /* The reading and its caption, one block, in the blank the two rings
           leave to the **left** of the merge bar: the figure on top,
           「PV端口」 directly under it, and the pair centred on the lead's own
           height so it lines up with the junction on the bar.  Both lines are
           right-aligned on the bar (`align: "end"`) so they grow *away* from
           it into the notch - centring them on the bar put half the block on
           the far side, where the bus and the lead already are, and stacking
           them above it landed them in the ring band. */
        pvNodes.push({
          kind: "value",
          id: "pv-value",
          x: busX - IV_SPLIT_TEXT_GAP,
          align: "end",
          y: centre - IV_SPLIT_LINE / 2,
          captionY: centre + IV_SPLIT_LINE / 2,
          power: value,
          value: reading(value),
          caption: "PV Port",
          captionZh: "PV端口",
        });
        pvNodes.push({
          kind: "bus",
          id: "pv-bus",
          power: value,
          /* The merge bar itself, drawn but never animated: the two ring runs
             each carry their streak right up to one end of it, and the trunk
             picks the total up from the middle.  See `_beamPlan`. */
          beam: false,
          route: `M${busX} ${cyTop} V${cyBot}`,
        });
        pvNodes.push({
          kind: "lead",
          id: "pv-lead",
          power: value,
          /* The one run that has *merged*: it starts where the bar is and is
             the only connector carrying the combined figure into the unit,
             so it runs in the trunk stage - after both inputs have arrived
             and before the AC lead lights up. */
          stage: 1,
          route: `M${busX} ${centre} H${term.pvLeftX}`,
        });
        for (const [i, cy] of [[0, cyTop], [1, cyBot]]) {
          pvNodes.push({
            kind: "ring",
            id: `pv${i + 1}`,
            x: IV_SPLIT_X,
            y: cy,
            power: value,
            /* Ring rim -> the bus.  The bus vertical already covers the join,
               so the run simply stops on it. */
            route: `M${IV_SPLIT_X + NODE_R} ${cy} H${busX}`,
          });
        }
      }

      if (!split) {
        for (let i = 0; i < pvCount; i += 1) {
          const side = slotSide(i);
          const x = slotX(i);
          const under = side === "bottom";
          const left = side === "left";
          const slots = left ? term.pvLeftSlots : term.pvRightSlots;
          const idx = sideSeen[side];
          sideSeen[side] = idx + 1;
          /* The height this connector stops at on the photo.  A measured plug
             list gives one height per string, so PV1 stops on the upper pair of
             the left cheek and PV2 on the lower one.  Without a list both
             strings of a side would be aimed at the same point and the two
             connectors would sit on top of each other, so they are fanned out
             by `IV_SIDE_STAGGER` instead. */
          let y2 = left ? term.pvLeftY : term.pvRightY;
          if (slots) {
            y2 = slots[Math.min(idx, slots.length - 1)];
          } else if (sideCount[side] > 1) {
            y2 += (idx - (sideCount[side] - 1) / 2) * IV_SIDE_STAGGER;
          }
          pvNodes.push({
            id: `pv${i + 1}`,
            /* A body with a single DC input captions it `PV`, not `PV1`: there
               is no second input for the number to tell apart, and the vendor
               app drops it too once a unit is 一拖一.  The 1650 keeps `PV1` /
               `PV2` because `_splitPv` draws it with two ports. */
            caption: pvCount === 1 ? "PV" : `PV${i + 1}`,
            x,
            y: IV_NODE_ROW_Y,
            /* A one-input body has a single node, so `pvTotal` (every reported
               input added up) is what it prints; several inputs each keep their
               own reading.  See `_data` for why the sum is deliberate. */
            power: pvCount === 1 ? (d.pvTotal ?? d.pvPorts[i]) : d.pvPorts[i],
            route: under
              ? riserRoute({ x, y: IV_NODE_ROW_Y }, term.pvBottom)
              : elbowRoute(
                { x, y: IV_NODE_ROW_Y },
                left ? term.pvLeftX : term.pvRightX,
                y2,
              ),
          });
        }
      }

      /* Every drawn stroke of the input side becomes a route, in the order the
         merge reads: the two ring runs first (stage 0, both arriving at the
         same moment), then the single lead out of the merge bar (stage 1).
         Nodes that carry no stroke at all - the value / caption block - are
         dropped here instead of being emitted as an empty `d="undefined"`. */
      const routes = pvNodes
        .filter((n) => n.route)
        .map((n) => ({
          id: n.id, d: n.route, power: n.power, color: COLORS.pv,
          reverse: num(n.power) < 0,
          /* Inverters have no junction of their own on the AC side: the energy
             goes in at the DC inputs and straight out of the AC lead, so the
             inputs take the first half of the cycle and the output the second.
             The split layout is the exception - it *does* merge, inside the
             drawing, which is why its lead is staged 1. */
          stage: n.stage || 0,
          beam: n.beam !== false,
        }));
      /* The AC output.  Drawn unless explicitly disabled - it is a port of the
         hardware, not an optional reading - and a missing value shows a dash
         rather than removing the branch.

         This layout draws the unit's *own* AC port (`d.gridPort`, positive =
         energy leaving the unit - see `_data`), not the system grid balance
         `d.grid` that the storage schematic uses.  The connector is authored
         from the node towards the unit, so a forward run reads as "into the
         unit"; producing therefore has to be reversed to read as "out of the
         unit", which is the direction the PV energy actually travels. */
      const showGrid = this._config.show_grid !== false;
      const g = present(d.gridPort) ? num(d.gridPort) : 0;
      /* `above` puts the 并网端口 captions over the ring, which is only correct
         while the connector leaves downwards - most of the artwork puts the AC
         lead high on the body, so the line then leaves upwards and the captions
         have to move below it. */
      let gridAbove = true;
      let gridY = IV_NODE_GRID.y;
      if (showGrid) {
        /* The grid connector plugs into the photo's *right* edge, at the height
           the artwork shows its AC lead (`term.gridY`).  Falling back to the
           old estimate for an unknown image: half way between the node's own
           bottom rim and the DC terminal height, which gives the AC output its
           own port with a full elbow instead of overlapping the right-most PV
           input.  The lower clamp keeps a few pixels of vertical run when the
           photo is tall enough to put that midpoint right under the ring. */
        const dcTermY = term.pvLeftY;
        const gridTermY = term.gridY === null
          ? Math.max(
            (IV_NODE_GRID.y + NODE_R + dcTermY) / 2,
            IV_NODE_GRID.y + NODE_R + 8,
          )
          : term.gridY;
        /* The node rides at the port height, so the connector is a plain
           horizontal run straight into the cable the render draws.  A fixed
           node height could not hit every SKU: the small HiFlow exits near mid
           body while the Pro bodies exit high up, a difference of some 40 px
           once scaled.  Keeping the two apart would force an elbow that folds
           back on the ring. */
        gridY = term.gridY === null ? IV_NODE_GRID.y : gridTermY;
        gridAbove = gridY - (NODE_R + 46) > 8;
        routes.push({
          id: "grid",
          d: elbowRoute({ x: IV_NODE_GRID.x, y: gridY }, photo.r, gridTermY),
          power: present(d.gridPort) ? d.gridPort : null,
          /* Amber while the unit is producing (the same colour the PV flow and
             the storage schematic's trunk use, because it *is* the PV energy
             leaving), blue while it draws standby power back from the grid -
             the same blue the storage schematic's grid branch uses.  At a
             standstill neither direction applies, so nothing moves. */
          color: g > 0 ? COLORS.grid_out : COLORS.grid,
          reverse: g > 0,
          /* Energy reaches the AC lead only after it has gone through the
             unit, so the output always runs in the last stage. */
          stage: 2,
        });
      }

      const edges = routes.map((r) => `
        <path class="pf-edge" d="${r.d}" fill="none"
              vector-effect="non-scaling-stroke"/>`).join("");
      const beams = pvNodes.some((n) => present(n.power))
        || (showGrid && present(d.gridPort))
        ? this._beamPlan(routes).map(flowBeam).join("")
        : "";

      const busy = [...d.pvPorts, d.gridPort]
        .some((v) => present(v) && Math.abs(num(v)) >= MIN_FLOW);
      /* The split layout stacks its ports against the body instead of along the
         bottom row, so the strip `IV_H` leaves under that row is empty and the
         drawing can be cropped to its content - which also makes the unit
         itself bigger in the same card. */
      const h = split ? IV_SPLIT_H : IV_H;

      return `<svg viewBox="0 0 ${IV_W} ${h}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        ${this._config.gradient === false
          ? ""
          : `<rect class="pf-bg" x="0" y="0" width="${IV_W}" height="${h}"/>`}
        <clipPath id="${NODE_CLIP_ID}" clipPathUnits="userSpaceOnUse">
          <circle cx="0" cy="0" r="${NODE_CLIP_R}"/>
        </clipPath>
        ${edges}
        ${beams}
        ${this._unitImage(busy, photo)}
        ${this._inverterNodes(d, { pv: pvNodes, grid: true, gridY, gridAbove })}
      </svg>`;
    }

    /** The product photo at the centre of the micro-inverter layout. */
    _unitImage(busy, photo) {
      const art = this._productImage();
      const box = photo || ivPhoto(art);
      return `<image class="pf-body" x="${box.l}" y="${box.t}"
                    width="${box.w}" height="${box.h}"
                    preserveAspectRatio="xMidYMid meet"
                    opacity="${busy || this._config.dim_when_idle === false ? 1 : 0.55}"
                    href="${esc(art)}"/>`;
    }

    /**
     * The nodes of the micro-inverter layout: one per PV input, plus the
     * 并网端口 - the AC output - which is drawn by default, exactly like the
     * grid side of the storage schematic.  `show_grid: false` is the opt-out.
     *
     * The PV captions are `PV1` / `PV2` - the same wording the vendor app and
     * the firmware's own port table use - because these are physical inputs on
     * the unit, not the system level 光伏1 / 光伏2 aggregates of the storage
     * schematic (`_nodes`).  A body with only one DC input is captioned plain
     * `PV`: the caller puts that wording on the node itself, so the drawing and
     * this label can never disagree.
     */
    _inverterNodes(d, opts) {
      const t = (en, zh) => this._t(en, zh);
      const working = (v) => v !== null && v !== undefined
        && Math.abs(num(v)) >= MIN_FLOW;
      const parts = [];
      /* A missing reading prints a dash instead of "0.0 W": the difference
         between "the port is idle" and "the port has not reported yet" matters
         while commissioning a unit. */
      const reading = (v) => (v === null || v === undefined ? "—" : fmtW(v));

      /* `above` puts the two text lines over the ring instead of under it; the
         grid node needs that because its connector leaves downwards. */
      const node = (x, y, icon, on, value, caption, above) => {
        const art = PF_ICONS[`${icon}.${on ? "on" : "off"}`] || "";
        const vy = above ? -(NODE_R + 12) : NODE_R + 26;
        const cy = above ? -(NODE_R + 30) : NODE_R + 46;
        parts.push(`<g class="pf-node" transform="translate(${x} ${y})">
            <image class="pf-ic" x="${-NODE_R}" y="${-NODE_R}"
                   width="${NODE_R * 2}" height="${NODE_R * 2}"
                   clip-path="url(#${NODE_CLIP_ID})" href="${art}"/>
            <text class="pf-v pf-iv" x="0" y="${vy}"
                  text-anchor="middle">${value}</text>
            <text class="pf-c pf-iv-c" x="0" y="${cy}"
                  text-anchor="middle">${esc(caption)}</text>
          </g>`);
      };

      for (const n of opts.pv) {
        /* The one reading of the pair, printed together with its caption:
           `value` on the upper line, 「PV端口」 right under it, the pair centred
           on the junction's own height.  `n.x` is the merge bar *minus* a gap
           and `n.align` is `end`, so both lines end just short of the bar and
           grow leftwards into the notch between the two rings instead of
           straddling the junction.  See `IV_SPLIT_PV_CODE`. */
        if (n.kind === "value") {
          const anchor = n.align || "middle";
          parts.push(`<text class="pf-v pf-iv pf-panel-value" x="${n.x}"
                y="${n.y}" text-anchor="${anchor}" dominant-baseline="middle">${esc(n.value)}</text>`);
          parts.push(`<text class="pf-c pf-iv-c pf-panel-c" x="${n.x}"
                y="${n.captionY}" text-anchor="${anchor}" dominant-baseline="middle">${esc(t(n.caption, n.captionZh))}</text>`);
          continue;
        }
        if (n.kind === "bus" || n.kind === "lead") {
          /* No ring: these are just the two strokes of the merge. */
          continue;
        }
        if (n.kind === "ring") {
          /* One of the two PV rings of the split layout, drawn as the plain
             ring every other branch uses - but **without** a figure or a caption
             under it: the pair reports one number between them, printed once
             with 「PV端口」 beside the bus, so repeating it under both rings would
             suggest two measurements. */
          parts.push(`<g class="pf-node" transform="translate(${n.x} ${n.y})">
              <image class="pf-ic" x="${-NODE_R}" y="${-NODE_R}"
                     width="${NODE_R * 2}" height="${NODE_R * 2}"
                     clip-path="url(#${NODE_CLIP_ID})"
                     href="${PF_ICONS[`pv.${working(n.power) ? "on" : "off"}`] || ""}"/>
            </g>`);
          continue;
        }
        node(n.x, n.y, "pv", working(n.power), reading(n.power),
          t(n.caption, n.caption));
      }
      if (opts.grid) {
        /* No 电网输入 / 电网输出 wording here: the number is absolute and the
           direction is already drawn by the streak, so a caption that moved
           with the sign would contradict it.  The reading is the unit's own AC
           port (`gridPort`), not the system grid balance. */
        node(IV_NODE_GRID.x, opts.gridY === undefined ? IV_NODE_GRID.y : opts.gridY,
          "grid", working(d.gridPort),
          reading(d.gridPort), t("Grid Port", "并网端口"),
          opts.gridAbove !== false);
      }

      return parts.join("");
    }

    _svgSystem(d) {
      /* Which vertical rhythm this drawing uses.  A micro inverter's System tab
         has neither a 微储 nor a 光伏2 branch, so it gets the compact profile
         and its card comes out at the Device tab's height; the storage chart
         keeps the original geometry byte for byte.  See `SYS_FULL` /
         `SYS_COMPACT`. */
      const g = this._isInverterSystem() ? SYS_COMPACT : SYS_FULL;
      const present = (v) => v !== null && v !== undefined && !Number.isNaN(num(v));
      /* A missing reading prints a dash, not "0.0 W".  Until a unit reports for
         the first time every `system_*` entity is `unknown`, and rendering that
         as zero made a silent device look like an idle one. */
      const reading = (v) => (v === null || v === undefined ? "—" : fmtW(v));

      /* The wiring diagram: PV1 / storage run into the inverter's left side, the
         inverter's right side meets a junction on the right edge, and the
         remaining branches fan out from that junction.  Each branch is one
         path, so the travelling streak can simply run along it. */
      /* Direction of every connector, decided in one place.
       *
       * A route is always *written* from its own node towards the inverter /
       * junction, so `reverse: true` means "the power runs from the far end
       * back into this branch's node".  Getting this the wrong way round is
       * very visible: the streak then travels against the energy flow.
       *
       *   pv, pv2      producing            node     -> junction
       *   battery      discharging (>= 0)   node     -> inverter
       *                charging    (<  0)   inverter -> node
       *   grid         importing   (>  0)   grid     -> junction
       *                exporting   (<  0)   junction -> grid
       *   load, plug   consuming   (>= 0)   junction -> node
       */
      const charging = num(d.battery) < 0;
      const hasBattery = present(d.battery);
      const trunk = num(d.pv) + num(d.pv2) + (hasBattery ? num(d.battery) : 0); // W into the junction

      /* Which *stage* of the shared cycle each connector runs in.
       *
       * The three stages are "gather into the unit", "run through it to the
       * junction" and "leave the junction towards the load", and they are what
       * makes the diagram read as one flow of energy rather than seven
       * unrelated animations: a trunk can only light up once the branches
       * feeding it have arrived.
       *
       * Where the junction sits depends on the direction the energy is going,
       * so the stage of a given connector is not fixed.  Energy *enters* the
       * trunk from the unit while the unit is a source (`trunk >= 0`, the usual
       * case) and from the grid while the house is drawing the battery down
       * through it (`trunk < 0`).  The trunk therefore always runs in the
       * middle stage, and everything upstream of it takes the first stage while
       * everything downstream takes the last.
       *
       * The two branches that feed the unit (PV2, and the battery while it is
       * charging) run *towards* it and are drawn left to right, so their travel
       * direction is the same either way round - `reverse` only flips which end
       * the streak starts from.  The stage helpers below are symmetric in
       * `reverse` for exactly that reason. */
      const trunkToJunction = trunk >= 0;
      /* A branch lying left of the unit: stage 0 when it feeds the unit, stage 2
         when the unit feeds it.  Written as one expression because the two
         directions are the two ends of the same wire. */
      const stageLeft = (reverse) => (reverse ? 2 : 0);
      /* A branch right of the junction: it is *upstream* of the trunk when it
         feeds the junction, which is the `trunk < 0` case; otherwise it is
         downstream and runs once the trunk has arrived. */
      const stageRight = (reverse) => {
        if (!reverse) return 0;
        return trunkToJunction ? 2 : 1;
      };

      /* Which branches are *hardware*, not data.
       *
       * Every branch of this schematic is a feature of the machine, and this is
       * the drawing that shows the machine as a whole, so **all of them are
       * always laid out**: a unit that has not reported yet, or one that is part
       * of a master/slave pair, still reads as the same box with the same
       * terminals, and only the numbers go blank.
       *
       * This is deliberate for the master/slave pair too.  The two views have
       * different jobs: the Device tab draws *this unit's own* ports, so there
       * the role decides which are wired, while this one draws the installation
       * around the house - PV1 / PV2 in, storage either side, and on the right
       * the junction everything else meets.  Hiding 负载 / 智能插座 on a slave
       * made the same house look like two different houses, which is what the
       * role chip then had to explain.  Now the chip is the only difference.
       *
       * 智能插座 shares the junction with 电网, 负载 and 光伏2: it is a socket on
       * the same AC bus the grid and the house hang from, so it belongs on that
       * node rather than on a wire of its own. */
      const routes = [
        { id: "pv", d: g.pvRoute, power: d.pv,
          color: COLORS.pv, reverse: num(d.pv) < 0,
          stage: stageLeft(num(d.pv) < 0) },
        ...(hasBattery ? [{ id: "battery", d: g.batteryRoute,
          power: d.battery, color: COLORS.battery, reverse: charging,
          stage: stageLeft(charging) }] : []),
        /* The trunk is the one connector whose stage never changes: it *is* the
           middle of the cycle, the moment everything meets. */
        { id: "trunk", d: `M361 ${g.midY} H594`, power: trunk,
          color: COLORS.pv, reverse: trunk < 0, stage: 1 },
        { id: "grid", d: g.gridRoute, power: d.grid,
          color: num(d.grid) > 0 ? COLORS.grid : COLORS.grid_out,
          reverse: num(d.grid) < 0,
          stage: stageRight(num(d.grid) < 0) },
        { id: "load", d: g.loadRoute, power: d.load,
          color: COLORS.load, reverse: num(d.load) >= 0,
          stage: stageRight(num(d.load) >= 0) },
        { id: "plug", d: g.plugRoute, power: d.smartPlug,
          color: COLORS.sp, reverse: num(d.smartPlug) >= 0,
          stage: stageRight(num(d.smartPlug) >= 0) },
        ...(this._isInverterSystem() ? [] : [{ id: "pv2", d: PV2_ROUTE, power: d.pv2,
          color: COLORS.pv6, reverse: num(d.pv2) < 0,
          stage: stageRight(num(d.pv2) < 0) }]),
      ];

      /* `has_meter: false` in §32 「状态事件」 (see `_data`): this unit takes no
         part in metering, so the firmware cannot tell the grid from the house
         and 电网 / 负载 are drawn as one lumped node - a single circle carrying
         the unit's own AC port reading, the way the vendor's G3 dashboard
         draws it.  It keeps the 电网 slot and its straight connector, which is
         the one that already runs to the junction.

         The 负载 branch is **not** removed alongside it.  It is a different
         quantity from a different source (`grid_on_p` of this unit vs. the
         plant's `sys_load_p`), and 负载 is a terminal of the installation
         rather than a view of the grid - dropping it left the house with no
         load at all on every unit that cannot meter, which is the one thing
         the picture is supposed to show.  Its diagonal connector still ends on
         the junction, so it hangs off the same common node as 光伏 / 电网 /
         智能插座.

         `true` - and "not reported", which is what an older firmware gives -
         leaves the two-node layout exactly as it is, the same "unknown ⇒ draw
         as before" rule `solar2` follows.

         The reading is the unit's own on-grid port (`grid_on_p`, `gridPort`
         here), whose sign runs the *other* way round from the grid balance:
         `< 0` means the unit is drawing from the lump, `> 0` that it is pushing
         energy into it.  That inversion is why the colours are picked from the
         sign here instead of from `d.grid` like the two-node branch does. */
      const merged = d.meter === false;
      /* What the lumped 「电网&负载」 node carries.  `system_load_power` (protocol
         `sys_load_p`) is the *plant's* own load and is the figure the vendor app
         prints on that node, so it wins whenever the installation reports it.
         The unit's own AC port (`gridPort`) is only the fallback: measured on a
         master it reads 0 W while the house is plainly drawing - one live
         payload had `sys_load_p` 98.9 W against `grid_on_p` 0 - and printing
         that zero said the house was idle. */
      const lumped = present(d.load) ? d.load : d.gridPort;
      const combined = merged ? num(lumped) : 0;
      if (merged) {
        const grid = routes.find((r) => r.id === "grid");
        grid.power = lumped;
        grid.color = combined < 0 ? COLORS.grid : COLORS.grid_out;
        grid.reverse = combined >= 0;
        grid.stage = stageRight(combined >= 0);
      }

      /* A **negative** 负载 is not consumption.  The meter reporting the house
         as exporting means the energy left the installation without being used,
         so on a micro inverter's system view those watts are added to the 光伏
         **figure** - one claim in one place, instead of generation sitting next
         to "minus consumption" and the reader having to do the subtraction.

         Only the *number* moves.  The branch itself stays: 负载 is a terminal of
         the installation, not a value, and a house that exports still has a
         house attached to it.  Removing the connector and the ring (as an
         earlier revision did) made the 负载 terminal disappear exactly when the
         installation was producing most, which read as "this unit has no load
         output" rather than as "the load is being served from elsewhere".
         `trunk` is deliberately left alone: it is the energy gathering *at the
         junction*, and the folded watts came from outside the system, so
         counting them there too would double them a second time.

         **Only a reading that is actually negative counts.**  The comparison is
         against a dead band rather than against zero, because the meter is a
         summing device on a house that always draws something: at night, with
         every load switched off, it reports a few tenths of a watt of noise in
         whichever direction the last sample landed (`-0.6 W` measured on an idle
         installation).  Anything inside the dead band is simply an unlit branch,
         not a folded one. */
      const foldedLoad = this._isInverterSystem()
        && present(d.load)
        && num(d.load) < -FOLD_DEAD_BAND;
      const pvValue = foldedLoad ? num(d.pv) + Math.abs(num(d.load)) : d.pv;

      const edges = routes.map((r) => `
        <path class="pf-edge" d="${r.d}" fill="none"
              vector-effect="non-scaling-stroke"/>`).join("");

      const beams = this._beamPlan(routes).map(flowBeam).join("");

      /* One icon per node and the unit in the middle.  The same rule as the
         connectors: the branches the hardware has are always drawn, dim and
         dashed-value until the unit reports, so the schematic keeps its shape
         instead of collapsing to a single stray node.  A branch that exists but
         reads zero is still drawn in its dim variant - exactly like the app. */
      const nodes = this._nodes(d, {
        battery: hasBattery,
        reading,
        /* The figure the 光伏 node prints - the combined one when the load was
           folded in above.  `working()` is applied to this same value there, so
           a house that exports more than it generates shows a lit node rather
           than a dim, grey one carrying a healthy positive number. */
        pvValue,
        /* The figure the lumped 「电网&负载」 node prints on a unit without a
           meter - `sys_load_p` when there is one, the AC port otherwise.  Passed
           in rather than recomputed in `_nodes` so the node and its connector
           can never disagree about which reading they show. */
        gridLoadValue: merged ? lumped : undefined,
        /* The row centres and caption offsets of the profile chosen above, so
           the rings land on the ends of the connectors that were just built. */
        geometry: g,
      });

      /* The unit in the middle works as soon as *anything* flows through it, so
         its artwork is coloured then and dim when the whole system is idle. */
      const busy = [d.pv, d.pv2, d.grid, d.load, d.smartPlug, d.battery]
        .some((v) => present(v) && Math.abs(num(v)) >= MIN_FLOW);

      return `<svg viewBox="0 0 ${VB_W} ${g.vbH}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        ${this._config.gradient === false
          ? ""
          : `<rect x="0" y="0" width="${VB_W}" height="${g.vbH}" fill="#ffffff"/>`}
        <clipPath id="${NODE_CLIP_ID}" clipPathUnits="userSpaceOnUse">
          <circle cx="0" cy="0" r="${NODE_CLIP_R}"/>
        </clipPath>
        ${edges}
        ${beams}
        ${this._inverter(busy, g.unitY)}
        <circle class="pf-junction" cx="${JUNCTION.x}" cy="${g.midY}" r="6"/>
        ${nodes}
      </svg>`;
    }

    /**
     * The unit in the middle: the app's own "plug in a square" artwork, which
     * already carries the frame, the glyph and the pin at the bottom - so
     * nothing is stroked on top of it and there is no separate stem.
     *
     * `busy` picks the coloured or the dim variant, the same two-tone rule the
     * nodes use.  `cy` is the row profile's mid line; the storage drawing and
     * the micro inverter drawing put it in different places (see `SYS_FULL` /
     * `SYS_COMPACT`), so it is passed in rather than read from `INV`.
     */
    _inverter(busy, cy = INV.y) {
      const x = INV.x;
      const half = INV_ICON / 2;
      const art = PF_ICONS[`inverter.${busy ? "on" : "off"}`] || "";
      return `<image class="pf-ic pf-unit" x="${x - half}" y="${cy - half}"
                    width="${INV_ICON}" height="${INV_ICON}" href="${art}"/>`;
    }

    /**
     * The node layer of the storage schematic.
     *
     * Every branch of this drawing is a feature of the installation, so all of
     * them are drawn always - including on a slave, whose own header chip is
     * then the only thing that says it is a follower.  There are two exceptions,
     * and both come from §32 「状态事件」 rather than from a reading:
     * `opts.battery` drops the 微储 node on a model with no storage, and
     * `has_meter: false` replaces 电网 + 负载 with one 「电网&负载」 node, because
     * such a unit cannot tell the two apart.
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
     * way the power went.  It is gone: the streak already says that, and the
     * arrow only added a second, coarser copy of the same information - the user
     * asked for it to be removed.
     */
    _nodes(d, opts) {
      const t = (en, zh) => this._t(en, zh);
      const working = (v) => Math.abs(num(v)) >= MIN_FLOW;
      /* `—` for a reading that does not exist yet, so "not reported" and
         "reported 0 W" stay distinguishable. */
      const reading = opts.reading || ((v) => fmtW(v));
      const parts = [];
      /* A micro inverter's system view needs two departures from the storage
         layout; both are explained in full on `_isInverterSystem`. */
      const inverterSystem = this._isInverterSystem();
      /* The row centres and caption offsets that `_svgSystem` chose for this
         drawing.  Defaulted to the storage profile so a future caller that
         forgets to pass it cannot silently move a ring off its connector. */
      const geo = opts.geometry || SYS_FULL;
      /* What the 光伏 node prints.  It equals `d.pv` on every view but a micro
         inverter's system view showing a negative 负载, where the caller has
         already added those watts in (`_svgSystem`).  Read here rather than
         recomputed so the node and the removal of the 负载 branch can never
         disagree about whether the fold happened. */
      const pvReading = opts.pvValue === undefined ? d.pv : opts.pvValue;

      /* `above` puts the value / caption *over* the ring instead of under it.
         The storage schematic never needs it (every one of its branches leaves
         its ring sideways), but a HiFlow draws 光伏1 and 电网 with a connector
         dropping straight out of the ring, so the caption used to sit right on
         top of the line. Moving it above the ring lands it in empty canvas and
         the connector stays legible. */
      const node = (x, y, icon, on, value, caption, above = false) => {
        const art = PF_ICONS[`${icon}.${on ? "on" : "off"}`] || "";
        /* The caption placement comes from the profile: the storage rings need
           the wider offsets there, the micro inverter's tighter rows do not. */
        const cap = above ? geo.capTop : geo.capBot;
        const vy = cap.v;
        const cy = cap.c;
        parts.push(`<g class="pf-node" transform="translate(${x} ${y})">
            <image class="pf-ic" x="${-NODE_R}" y="${-NODE_R}"
                   width="${NODE_R * 2}" height="${NODE_R * 2}"
                   clip-path="url(#${NODE_CLIP_ID})" href="${art}"/>
            <text class="pf-v" x="0" y="${vy}"
                  text-anchor="middle">${value}</text>
            <text class="pf-c" x="0" y="${cy}"
                  text-anchor="middle">${esc(caption)}</text>
          </g>`);
      };

      /* Every branch of the schematic is drawn unconditionally (see
         `_svgSystem`), so the only thing `opts` still decides is whether the
         storage node exists - it is the one branch that is genuinely absent on a
         micro inverter with no battery.

         The two PV captions carry a qualifier because the words 光伏1 / 光伏2
         mean something *different* here than they do on the Device tab, where
         「PV1」..「PV4」 are the unit's own DC connectors.  Here 光伏1 is the
         generation of the devices in this system and 光伏2 is generation from
         outside it; a reader who takes 光伏2 for "the second connector" would
         misread the house.  The parenthesis is short enough to fit under the
         node and says it without a legend.  On a micro inverter there is no
         光伏2 at all (`_isInverterSystem`), so the qualifier on 光伏1 has
         nothing left to distinguish it from - it is dropped there. */
      node(NODE_COL_L, geo.rowTop, "pv", working(pvReading),
        reading(pvReading),
        inverterSystem ? t("PV", "光伏") : t("PV1 (in system)", "光伏1（系统内）"),
        inverterSystem);
      if (opts.battery) {
        node(NODE_COL_L, geo.rowBot, "battery", working(d.battery),
          `${reading(d.battery)}${d.soc === null ? "" : `　${num(d.soc).toFixed(2)}%`}`,
          t("Storage", "微储"));
      }

      /* A micro inverter's installation has no 光伏2 branch: see
         `_isInverterSystem`.  Leaving it out of the node layer as well as out of
         `routes` is what keeps the two layers agreeing - a node without a
         connector would have hung in empty canvas. */
      if (!inverterSystem) {
        node(NODE_COL_M, geo.rowTop, "pv", working(d.pv2),
          reading(d.pv2), t("PV2 (external)", "光伏2（系统外）"));
      }
      if (d.meter === false) {
        /* No meter: one lumped 「电网&负载」 node where 电网 used to be.  It has
           no 电网输入 / 电网输出 pill - the reading cannot be attributed to
           either side of a border the firmware cannot see - and it prints the
           magnitude, so the number matches the vendor app's own dashboard.
           What it prints is the plant's `sys_load_p` when that is reported (see
           `_svgSystem`), the unit's AC port only as a fallback. */
        const lumped = opts.gridLoadValue === undefined
          ? d.gridPort
          : opts.gridLoadValue;
        node(NODE_COL_R, geo.rowTop, "gridload", working(lumped),
          reading(lumped), t("Grid & Load", "电网&负载"), inverterSystem);
      } else {
        const g = num(d.grid);
        const importing = g > 0;
        /* The caption follows the *reading*, never the role: this view draws the
           installation, so a unit without a meter has to be labelled the same
           way as one with it or the picture would say master/slave twice (once
           here and once in the header chip).  The sign is already normalised to
           the grid convention in `_data` - including its own-port fallback,
           which negates `grid_on_p` - so "positive means importing" holds for
           both cases and the wording stays true.

           A micro inverter's installation keeps the plain 「电网」 wording at
           every sign: that node is one port of the house (the meter border),
           and the direction is already carried by the streak and the colour of
           the connector.  A caption that flipped between 输入 and 输出 repeated
           the same information in words and, on a system whose reading
           oscillates around zero, made the label flicker. */
        // At ~0 W neither direction is true, so the node just says 电网.
        const caption = inverterSystem || Math.abs(g) < MIN_FLOW
          ? t("Grid", "电网")
          : (importing ? t("Grid In", "电网输入") : t("Grid Out", "电网输出"));
        node(NODE_COL_R, geo.rowTop, "grid", working(d.grid),
          reading(d.grid), caption, inverterSystem);
      }
      /* 负载 is drawn in **both** layouts and at every sign, including the
         negative one.  A negative reading means the house is exporting, and
         those watts are already credited to 光伏 (`_svgSystem` passes the
         combined figure as `opts.pvValue`) - but that is a change to a
         *number*, not a reason to take a terminal out of the schematic.  The
         branch is part of the installation, so it stays, carrying its own
         (negative) reading.  On a unit that cannot meter it keeps its place
         next to the lumped node as well: see `_svgSystem`. */
      node(NODE_COL_M, geo.rowBot, "load", working(d.load),
        reading(d.load), t("Load", "负载"));
      node(NODE_COL_R, geo.rowBot, "plug", working(d.smartPlug),
        reading(d.smartPlug), t("Smart Plug", "智能插座"));

      return parts.join("");
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
          <ha-textfield label="language (auto|en|zh, auto follows Home Assistant)"
            .value=${config.language || ""} @change=${this._changed("language")}></ha-textfield>
          <ha-textfield label="temperature_entity" .value=${config.temperature_entity || ""}
            @change=${this._changed("temperature_entity")}></ha-textfield>
          <ha-textfield label="alarm_entity (optional - draws the condition badge)"
            .value=${config.alarm_entity || ""}
            @change=${this._changed("alarm_entity")}></ha-textfield>
          <ha-textfield label="max_width (px)" .value=${config.max_width || ""}
            @change=${this._changed("max_width")}></ha-textfield>
          <ha-textfield label="flow_speed (default 1, 0.5 = slower)"
            .value=${config.flow_speed === undefined ? "" : String(config.flow_speed)}
            @change=${this._changed("flow_speed")}></ha-textfield>
          <ha-textfield
            label="variant (auto|inverter - 'inverter' draws the HiFlow PV inputs layout)"
            .value=${config.variant || ""} @change=${this._changed("variant")}></ha-textfield>
          <ha-textfield
            label="pv_count (1-4 - PV inputs of a micro inverter, empty = auto)"
            .value=${config.pv_count === undefined ? "" : String(config.pv_count)}
            @change=${this._changed("pv_count")}></ha-textfield>
          <ha-textfield
            label="image (product photo URL, empty = follow the SKU)"
            .value=${config.image || ""} @change=${this._changed("image")}></ha-textfield>
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
          <label class="sw">
            <ha-switch .checked=${config.show_grid !== false}
              @change=${this._toggle("show_grid")}></ha-switch>
            <span>show_grid (inverter layout: draw the grid port output node)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.dim_when_idle === false}
              @change=${(event) => {
                const config2 = { ...(this._config || {}), dim_when_idle: !event.target.checked };
                this._config = config2;
                this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: config2 } }));
              }}></ha-switch>
            <span>dim the unit photo when nothing flows</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-g2-power-flow-editor")) {
    customElements.define("hoymiles-g2-power-flow-editor", HoymilesPowerFlowEditor);
  }
  if (!customElements.get("hoymiles-g2-power-flow")) {
    customElements.define("hoymiles-g2-power-flow", HoymilesPowerFlow);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-g2-power-flow")) {
    window.customCards.push({
      type: "hoymiles-g2-power-flow",
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
