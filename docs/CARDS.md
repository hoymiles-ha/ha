# Card reference

Complete option list for the eight Lovelace cards bundled with the
`hoymiles` custom integration.

**English** · [简体中文](CARDS.zh-Hans.md)

---

## How the cards are loaded

The integration registers all eight cards as frontend modules when it starts, so
there is **no "add resource" step** and no CDN is used. Add a card with
**Add card → Manual** and paste YAML, or add it directly to a dashboard YAML file.

After the integration is installed and Home Assistant has restarted, the cards
appear as `custom:hoymiles-*`.

> Changed a card file? Hard-refresh the browser (`Ctrl` + `F5`).

## Options shared by every card

| Option | Type | Description |
|---|---|---|
| `dev_id` | string | Device identifier, `<client_prefix>-<SN>` (e.g. `MSA-280520260806`). Required on all cards except the gauge, which is entity-driven. |
| `language` | `en` \| `zh` \| `de` | **Optional override.** The cards normally use the language picked in the toolbar switch (English by default); set this only to pin one card to a language. |
| `title` | string | Card heading. Defaults are per-card (see below). |
| `show_title` | bool | Set `false` to hide the heading (and, on some cards, the device SN). |

How `dev_id` is used: the card derives the entity ids it needs from it
(`sensor.<dev_id_slug>_<suffix>`). When your entities do not follow that pattern,
override them individually with the card's `entities:` map.

### How the language is chosen

Three languages are supported: **English**, **Simplified Chinese** and **German**.

1. **There is one language switch, in the Home Assistant toolbar** - at the left end
   of the row that holds the add / search / assist / edit buttons, so it is visible
   on every view of every dashboard this integration generates. Pick `English`,
   `中文` or `Deutsch` and the choice applies to *every* card on the page at once.
   It is stored in the browser (`localStorage["hoymiles.language"]`), so it
   survives a reload and follows the browser to the other dashboards.
2. **English is the default.** A card deliberately does **not** follow the Home
   Assistant UI language any more: a dashboard is often shared, displayed on a wall
   panel, or screenshotted for someone else, so the person reading it decides.
3. An explicit `language: en` / `language: zh` / `language: de` in the card config
   still wins over the switch, for the one card you never want translated.
4. Because the language is resolved per render, picking a language updates every
   card immediately - no page reload and no config change.

> Switching a card reloads the wording, not the data: the readings keep updating
> after the switch.

> The switch lives in the toolbar, which belongs to Home Assistant rather than to a
> card. It is injected by `hoymiles-lang.js`, one of the files this integration
> registers at startup; on pages outside a Lovelace dashboard there is no toolbar
> of that shape and no switch either.

> Strings that have no German wording yet fall back to English instead of showing
> a blank, so a partial translation is never worse than none.

> `hoymiles-gauge` is the exception — it has no built-in wording at all. Every word
> on it comes from your own `name` / `label` / `icon`, so it never needs translating.
> Give `name` a map and it follows the language like everything else:
>
> ```yaml
> name:
>   en: PV today
>   zh: 今日发电
>   de: PV heute
> ```

### Making your own text follow the language too

The language rule above covers the wording *inside* the cards. The text **you** write
in YAML - card titles, series names, gauge names, `balancer_label` - is yours, so the
card cannot translate it. It can, however, pick between the languages you supply:
write a **map** instead of a string.

```yaml
type: custom:hoymiles-history-chart
# instead of:  title: History
title:
  en: History
  zh: 历史数据
series:
  - entity: sensor.x_pv_power
    name:
      en: PV power
      zh: 发电功率
```

The card looks up the resolved language (`en`, `zh` or `de`). A map that is missing
the current language falls back to `en`, then to whichever entry exists, so a partial
map is never blank. A plain string keeps working exactly as before, which is why every
existing dashboard is unaffected.

Supported on these options:

| Card | Options that accept a map |
|---|---|
| all cards | `title` |
| `hoymiles-history-chart` | `title`, `series[].name` |
| `hoymiles-gauge` | `name`, `label` |
| `hoymiles-energy-sankey` | `title`, `balancer_label` |

> Because the visual card editor holds plain strings, a map shows there as an empty
> field and the label says `accepts an en/zh map`. Edit those options in the YAML
> editor (⋮ → *Edit in YAML*) rather than the visual one.

> Home Assistant's own cards - `markdown`, and the view/tab titles - belong to HA, not
> to this integration, so their text cannot follow the language. Keep those
> language-neutral, or pick one language for them.

### Why the view tabs cannot follow the language

Home Assistant resolves a view's tab label from `view.title` **without any
localization**:

```js
// home-assistant/frontend - src/data/lovelace/config/view.ts
computeViewTitle = (view, index) => view.title ?? (view.path ? titleCase(view.path) : String(index));
```

Contrast with HA's built-in Energy panel, which localizes its own tab titles by
generating the view from a *strategy* (`hass.localize(...)`) - a mechanism that
needs the whole view to come from JavaScript, so it is not worth coupling a
dashboard to it just for a label.

Two things follow, both easy to get wrong:

1. **A `view.title` is a fixed string.** There is no per-user language for it, and
   nothing on the client can rewrite it when the toolbar switch changes - so the
   dashboards this integration generates keep the three titles in English
   (`System`, `Device`, `Control`). If you want a tab that reads correctly for
   both audiences, write it bilingually yourself - for example
   `System status / 系统状态` - or use a neutral heading inside the view
   (emoji + device SN).
2. **Setting `icon` hides the title.** HA renders *either* the icon *or* the title
   unless you ask for both:

   ```js
   const icon_and_title = view.show_icon_and_title && view.icon && view.title;
   const icon_only = view.icon && !icon_and_title;
   ```

   So a view with an `icon` but no `show_icon_and_title: true` shows **only the
   icon** - the title survives merely as a tooltip. Add the flag when you want the
   icon and the label side by side.

---

## 1. `custom:hoymiles-power-flow`

Draws the system as a **wiring diagram**, the way the vendor app's system
screen does: one icon per branch, the unit in the middle, the grid tie point as
a junction dot, and thick rounded connectors with one streak of light travelling
along each live one. The icons are the app's own artwork, embedded in the card.

```
⬜ PV1 ──┐                    ┌── ⬜ PV2
         ├── ▣ unit ───── ● ── ── ⬜ grid
⬜ storage ┘                  └── ⬜ load
                               └── ⬜ smart plug
```

- **The unit in the middle works as soon as anything flows through it**, so its
  artwork is the coloured one then and the dim one when the whole system is idle.
```yaml
type: custom:hoymiles-power-flow
dev_id: MSA-280520260806
title: 我的家
language: zh
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized *My home* | Heading text. |
| `show_title` | bool | `true` | `false` hides the title and the device SN, leaving only the signal icon. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `temperature_entity` | entity id | — | Outdoor temperature shown next to the title. |
| `show_rssi` | bool | `true` | Wi-Fi signal fan in the top-right corner. |
| `gradient` | bool | `true` | Draw the plain **white** backdrop the schematic sits on. `false` leaves the card background instead — pair it with a light theme, since the diagram's text colours are fixed. |
| `max_width` | number (px) | `620` | Maximum width of the illustration; it stays centred. |
| `flow_speed` | number | `1` | Speed multiplier for the flow streak. `0.5` is calmer, `2` is faster. |
| `entities` | map | — | Entity overrides, keyed by suffix (see below). |

### Data sources

All values come from plain entity states — **the recorder is not required** — and
every branch reads the 1 s *quick state* system entity, the same numbers the
vendor app's system page shows:

| Node | Entity suffix (`sensor.<dev>_…`) |
|---|---|
| PV1 (top-left) | `sys_pv_p` |
| PV2 (top-right) | `sys_pv2_p` |
| Grid (right) | `sys_grid_p` (positive = importing) |
| Load (bottom-right) | `sys_load_p` |
| Smart plug (bottom-right, below load) | `sys_sp_p` |
| Storage (bottom-left) | `sys_bat_p` (negative = charging), falls back to `bat_p`; SOC from `sys_soc` |
| Status | `battery_status` (`standby` / `charge` / `discharge` / `lock`) |
| Signal fan | `rssi` (dBm) |

### Behaviour notes

- **A branch that carries power (`|P| >= 5 W`) is drawn in colour; an idle one
  uses the grey variant of the same icon**, which is how the app says "nothing
  happening here" without you having to read the number.
- A branch whose entity is **missing** (a slave unit reports no system level
  values) is left out entirely, together with its connector.
- The grid caption follows the flow: *Grid in* while importing, *Grid out*
  while exporting, plain *Grid* at ~0 W — it does not claim a direction it
  cannot see.
- The two diagonal branches (PV2 and load) are plain connectors - there is no
  direction arrow anywhere in the picture.  Which way the power goes is shown
  by the moving streak, and only by it.
- The connector itself keeps its grey colour.  A branch that carries
  **≥ 5 W** gets **one** streak of light travelling along it, from one end to
  the other - a white head with a tail that fades out behind it.  It is only
  ever one streak: a repeating pattern would put two or three on a long line,
  which reads as decoration instead of something being sent.
- The streak always travels **with** the energy: out of PV1 / PV2, out of a
  discharging battery, in from a charging grid, back into a charging battery,
  out of the inverter when it feeds the house and back into it when the grid
  or the PV2 branch charges the battery, and into the load / smart plug.
  It takes the branch colour, and speed rises with power.
- Travel time is computed from the **path length**, so a short stub and a long
  line look like the same speed - between roughly 1 s and 4 s for one trip,
  after which the streak starts again from the near end.  Tune the whole card
  with `flow_speed`.
- The pulse is a **CSS animation**, not a script: it keeps running while the
  card is off screen or the dashboard tab is switched, so it can never come
  back frozen.  A rebuild (the drawing is regenerated when a reading changes)
  resumes it exactly where it was.
- **The RSSI fan** uses four ascending bars; the number of lit bars indicates
  quality, with the `-21 dBm` reading next to it. Hovering shows a
  description:

  | RSSI | Bars lit |
  |---|---|
  | ≥ −55 dBm | 4 (excellent) |
  | ≥ −65 dBm | 3 (good) |
  | ≥ −75 dBm | 2 (fair) |
  | < −75 dBm | 1 (weak) |

  Hidden automatically when the device does not report `rssi`; disable with
  `show_rssi: false`.
- Override individual entities with the suffix-keyed `entities:` map:

  ```yaml
  entities:
    system_pv_power: sensor.my_pv_power
    system_battery_power: sensor.my_battery_power
    system_grid_power: sensor.my_grid_power
    system_load_power: sensor.my_load_power
    system_smart_plug_power: sensor.my_system_smart_plug_power
    soc: sensor.my_soc
    battery_status: sensor.my_battery_status
    rssi: sensor.my_rssi
  ```

### Sign conventions

`sys_grid_p` is **positive while importing** and the storage power is
**negative while charging**; the card normalises both before drawing. A node
carrying no power gets a grey ring — never a *standby* chip.

---

## 2. `custom:hoymiles-battery`

Draws the physical battery stack module by module, so the picture always matches
how many packs are actually installed (1–4), each with its own SOC and
temperature callout alternating left / right. The illustration follows the
product photos: one body with a single light-to-dark gradient, thin seams
between the modules, the brand badge on the first module, and a dark head
drawing the hardware's **display bar** — the power symbol, the PV reading with
its SOLAR caption, the SOC between two chevrons, and the battery reading with
its BATTERY caption. The drawn unit is a clean rectangle: no side panel, no
feet.

  - SOLAR and BATTERY show **this unit's own** `pv_power` / `bat_power` (the
    panel depicts the device itself); the corner callouts keep the system level
    readings. The values are shown as they are — no zero padding — and clamp at
    four digits (9999 W).
  - **The chevrons are the charge / discharge indicator**: charging draws the
    left one, discharging the right one, both in white, and an idle battery
    draws neither. Charging is negative battery power, matching the firmware.

The head module is also where the **host temperature** is called out.

Four corner callouts sit around the drawing: PV, the on-grid port, the battery
and the off-grid port. Their icons are drawn rather than pasted in — PV is an
amber **sun with eight round-capped rays**, so it belongs to the same family as
the flat single-colour status glyphs instead of looking like an emoji; the
on-grid port keeps its plate-and-plug drawing, simply drawn larger (36 viewBox
units against the sun's 28) so the plate, the body and the stem stay apart at
the size the card actually uses.

```yaml
type: custom:hoymiles-battery
dev_id: MSA-280520260806
title: HiBattery 4020 X
language: zh
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | detected model | Overrides the model read from the device registry. |
| `show_title` | bool | `true` | `false` hides the heading. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `show_history` | bool | `true` | Optional history section (needs the recorder). |
| `show_host_temp` | bool | `true` | `false` hides the head unit temperature. |
| `max_width` | number (px) | `560` | Maximum width of the illustration. |
| `alarm_entity` | entity id | — | Shows a bell next to the title while this entity is `on`. |
| `entities` | map | — | Entity overrides (see below). |

| `entities` key | Meaning |
|---|---|
| `pack_count` | Number of installed packs |
| `pv` | PV power |
| `grid_on` | On-grid port power |
| `grid_off` | Off-grid / EPS port power |
| `battery` | Battery power |
| `battery_status` | Battery status |
| `soc` | System SOC |
| `pack<N>_soc` | Per-pack SOC |
| `pack<N>_temperature` | Per-pack temperature |
| `battery_temperature` | Firmware's own battery temperature (head temperature fallback) |

### Behaviour notes

- **The title defaults to the model in the device registry** — in our test unit
  that is `HiBattery 4020 X`, taken from the firmware's MQTT discovery
  `device.model`. Different model, no config change; an explicit `title` wins.
- Pack count prefers the `pack_count` sensor (from `pack_num` in
  `device/state`) and falls back to counting how many `pack1_soc`…`pack4_soc`
  actually report a value. The upper bound is 4, matching the firmware's own
  truncation.
- Per-pack values use `pack<i>_soc` / `pack<i>_temperature`; the surrounding
  powers use `pv_power`, `grid_on_power`, `grid_off_power`, `battery_power`.
- **The head unit temperature is the average of the installed packs**, drawn as
  one more callout in the same style as the per-pack ones — the head has no
  sensor of its own, so the vendor app shows the same measure. Packs that report
  no temperature are skipped, and if none of them do the firmware's
  `battery_temperature` (`bat_temp`) is used instead. `show_host_temp: false`
  removes the callout.
- The signal bars next to the title are derived from `rssi` (dBm).
- The history section (optional) reads long-term statistics via
  `recorder/statistics_during_period`, plotting pack SOC and summarising charge /
  discharge energy for the range. If the recorder is off you only get a notice —
  the rest of the card still works.

---

## 3. `custom:hoymiles-pack-list`

A compact alternative to the battery illustration: one row per pack, SOC bar on
the left, SOC percentage and heating flag on the right. Pack count follows the
same rule as the battery card.

```yaml
type: custom:hoymiles-pack-list
dev_id: MSA-280520260806
language: zh
title: 电池电量
columns: 2
show_temperature: false
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized *Battery* | Heading text. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `columns` | number | `1` | Lay the rows out in N columns. Omit for a single column. |
| `show_temperature` | bool | `true` | `false` shows SOC only, dropping the ℃ reading. |

---

## 4. `custom:hoymiles-history-chart`

Day / month / year curves with date navigation, drawn like the vendor app's
history pages. Positive values stack upward from the zero line and negative
values stack downward, so a charge/discharge sensor reads naturally on both sides
of the axis.

```yaml
type: custom:hoymiles-history-chart
dev_id: MSA-280520260806
title: 历史数据
language: zh
range: day
height: 330
unit: W
series:
  - entity: sensor.x_pv_power
    name: 发电功率
    color: "#f59e0b"
  - entity: sensor.x_system_battery_power
    name: 放电[+]/充电[-]
    color: "#22c55e"
```

The bundled dashboard follows the vendor app's palette: **yellow** production,
**green** battery (power and SOC), **blue** grid & load, `#64748b` for the grey
slot on the per-port chart, and `#0ea5e9` / `#a855f7` as the third and fourth
battery pack. Four or more curves that stack must differ in hue *and* lightness,
or they merge into one ribbon at 34 % fill.

| Option | Type | Default | Description |
|---|---|---|---|
| `series` | list | — | **Required.** One entry per curve: `entity`, `name`, `color`. |
| `dev_id` | string | — | Optional when every series names an explicit `entity`. |
| `title` | string | — | Card heading. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `range` | `day` \| `month` \| `year` | `day` | Initial time range. |
| `height` | number (px) | `330` | SVG height. |
| `unit` | string | — | Y-axis unit label. Kept as-is (whole watts) until the range passes 10 000, then promoted to kW / MW. |
| `zero_line` | bool | `true` | Draw the zero line. |
| `symmetric` | bool | `true` | `false` draws a bottom-up axis from min to max — use it for SOC. |
| `stack` | bool | = `symmetric` | `false` overlays the curves instead of stacking them. Leave it off for a *level* (SOC, temperature) **and for independent measurements** (PV / battery / grid). Only stack series that really are parts of one total (per-PV-port power, per-phase power). |
| `min` / `max` | number | — | Fixed axis limits. |
| `span` | number | — | Pins the half-range when `symmetric` is on. Omit it and the axis fits the data instead. |
| `sync_group` | string | — | Cards sharing a group share their time window (range + date). |
| `show_toolbar` | bool | `true` | `false` hides this card's own time controls — use it on the followers. |
| `skip_empty` | bool | `true` | Drop a series that recorded nothing in the period. Lets one dashboard describe hardware of any size: a unit with a single battery pack shows one curve instead of four, and an unused PV port stops pretending to sit at 0 W. A series that is genuinely 0 still records rows, so it stays. |
| `count_entity` | string | — | The sensor that reports how many of the listed series really exist, e.g. `sensor.<dev>_pack_count`. Only the first *n* series are drawn, so the number of curves follows the hardware instead of the template — and it matches the battery illustration on the power-flow card. Unknown / missing state means "no limit": the chart then falls back to `skip_empty`, which is the right answer for a device that is silent. |
| `zoom` | bool | `true` | `false` disables the scroll-to-zoom / drag-to-pan gesture. |

### Behaviour notes

- **Data comes from `recorder/statistics_during_period`** (long-term statistics),
  so no administrator rights are needed and the database file is never touched.
- The time selector matches the vendor app: a date pill (`‹` `›` around the date)
  top-left, a day/month/year dropdown top-right, and rounded pill legends below
  the curve.
- Axis ticks pick their decimal places from the actual step, so a 1.25 kW step
  shows `1.25` instead of rounding to `1`.
- The axis and the tooltip always share one unit. Prefixes only kick in at
  **10 k**: a 88 W load reads `88 W`, not `0.09 kW` — the old 1.5 kW threshold
  gave ~100 W resolution and flattened exactly the variation worth seeing.
- **The y axis fits whatever is on screen.** The range is measured from the
  visible buckets, rounded up to a round number, so an idle 90 W evening fills
  the chart instead of flattening into a hairline under a fixed ±2500 W axis.
  Zooming refits it too — that is the point of zooming in. Fixing `span` /
  `min` / `max` pins the scale instead, which keeps side-by-side comparison
  across days possible when you need it. A stretch of pure zeros falls back to
  the whole period's peak so the axis never collapses to ±1 W.
- **"Round number" uses a fine ladder, not 1 / 2 / 5 / 10.** The coarse steps
  wasted up to 5x the data range: a day that dipped to 2.2 kW got a ±5 kW axis
  and the curve was squeezed into the lower fifth, which reads as "nothing
  happened". The ladder is `1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10^n`, so
  the waste is at most about 1.33x while every rung is still a multiple of 125
  and the five labels (`max`, `max/2`, `0`, `-max/2`, `-max`) stay exact to at
  most two decimals. A 2 154 W peak now gives ±2 500 W with
  `2500 / 1250 / 0 / -1250 / -2500`, not ±5 000 W.
- **Stacking is for parts of a total, not for readings that happen to be near
  each other.** Three 88 W readings drawn as a stack put the second curve at
  88..176 W and the third at 176..264 W, so curves with *identical* values ended
  up one above the other instead of on top of each other, and the top of the axis
  read as a sum nobody asked for. `PV power` / `Battery` / `Grid & load` are three
  independent measurements, so the bundled power charts set `stack: false`.
  Stacking stays right where the sum is the point: the per-PV-port chart (all
  ports together are the whole array) and per-phase power.
- **A *level* must never stack** either: three packs at 81 % would be drawn at
  0..81 %, 81..162 % and 162..243 %, so on a 0..100 axis only the first pack stays
  visible. `symmetric: false` (the SOC / temperature axis) therefore overlays by
  default; `stack: true` / `false` overrides either way.
- **The legend is a set of switches.** Clicking a chip hides just that curve;
  the others stay exactly as they were. So switching `PV power` off leaves
  `Battery` and `Grid & load` drawn, and switching it on again brings it back.
  A switched-off curve is removed from the chart (not dimmed), disappears from
  the tooltip, and the remaining curves are re-stacked from the zero line so a
  band is never left floating above an axis it no longer touches.
  Its chip turns into a hollow ring in its series colour and fades, so "off" is
  readable apart from "drawn". The style of a curve never changes: it keeps the
  same colour, stroke width and fill opacity whether or not its neighbours are
  on, which is what makes a curve with the same value look identical in both
  states. Switching every curve off leaves an empty plot with its axes; click
  the chart area to switch them all back on.
- **Overlapping areas blend, overlapping lines do not.** All the shaded areas are
  painted first, so two series with the same value show a mixed shade where they
  meet (green over blue → teal) — that is how the vendor app shows an overlap.
  The strokes are then painted one series at a time, in `series` order, so the
  last one wins where two values coincide: `PV power`, then `Battery`, then
  `Grid & load` means a blue line on top of a green one.
- **The line is drawn across the whole period, including the zero stretches.** A
  series sitting at 0 W still has a value, so it is stroked along the zero line
  instead of vanishing. (Breaking the stroke wherever a band had no height is what
  once left the flat parts of the day blank, and left a stray dot at the edge.)
- **A pane where nothing ever rose above zero still draws a baseline.** Four PV
  ports that produced nothing all day are flat, and a stacked chart has no band
  height to stroke - so the baseline itself is drawn in each series colour
  instead of leaving an empty box that looks like a broken chart.
- **Scroll to zoom the time axis.** The wheel zooms around the pointer (the
  instant under the cursor stays put), drag pans sideways, and a double click
  restores the whole period. While zoomed a small *Zoomed / Reset* badge sits in
  the corner. The data is not refetched: the card already holds the whole
  period and simply draws a sub-range of it, so zooming is instant. The y axis
  refits to the visible window, so zooming actually enlarges the detail.
  Set `zoom: false` to turn the gesture off.
- **Hovering shows a guide line and a tooltip at the same instant on every chart
  in the same `sync_group`** (for example *History* driving *Battery SOC*).
  Matching is by timestamp, so charts with different bucket sizes or data gaps
  still line up.
- `show_toolbar: false` plus `sync_group` gives you a dashboard where one chart
  controls and the others follow.
- A card removes itself from its group when it is deleted, leaving nothing behind.

### Naming, and splitting grid from load

Series names carry **no `[+]/[-]` suffix**. A signed power curve already says which
way the energy flows (positive = out, negative = in) and the number is the
magnitude, so the bundled charts read `Battery` and `Grid & load`. The long form
(`To grid & load [+]/From grid & load [-]`) was wider than the legend and got
truncated in the tooltip.

Without a grid meter the firmware reports **one** number for `grid_on_power`,
which is grid **and** load together — it cannot be separated after the fact. Once
the meter topics exist there are two independent measurements, and the chart
becomes four curves; only the `series` list changes:

```yaml
series:
  - entity: sensor.x_pv_power          # yellow
    name: PV power
    color: "#f59e0b"
  - entity: sensor.x_bat_power         # green
    name: Battery
    color: "#22c55e"
  - entity: sensor.x_grid_power        # blue
    name: Grid
    color: "#3b82f6"
  - entity: sensor.x_load_power        # rose: 4th hue, far from the other three
    name: Load
    color: "#db2777"
```

Keep the axes in mind: a signed `Grid` (export negative, import positive) and an
always-positive `Load` do **not** sum to the old combined curve, so do not stack
them — either draw them with `symmetric: false` on separate panes, or accept them
as two independent curves. Splitting is a data change, not a card change: nothing
in this card assumes the number of series.

---

## 5. `custom:hoymiles-gauge`

A stat tile: title and icon on top, big value in the middle, and one green arc at
the bottom filled by the value's share of `min`…`max`, with the percentage printed
inside the arc.

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_battery_charge_energy_today
name: 今日充电量
unit: kWh
scale: 0.001
max: 10
min: 0
decimals: 2
icon: ⚡
label: 自发自用率
color: "#22c55e"
```

| Option | Type | Default | Description |
|---|---|---|---|
| `entity` | entity id | — | **Required.** Drives the big readout. |
| `name` | string | entity name | Title. |
| `unit` | string | entity unit | Display unit. |
| `scale` | number | `1` | Multiplier applied before display. `0.001` turns Wh into kWh. |
| `max` | number | — | Upper limit **in display units**. Omit to let the arc grow with the value. |
| `min` | number | `0` | Lower limit. |
| `decimals` | number | `2` | Decimal places in the readout. |
| `icon` | string | — | Either a **name from the icon set** (see below) or any text / emoji, which is drawn as text. |
| `label` | string | — | Caption under the percentage. |
| `color` | CSS colour | `#22c55e` | Arc colour. |
| `show_arc` | bool | `true` | `false` drops the arch and its percentage, leaving a plain readout. |

### Ratio mode

When the interesting number is a ratio between entities rather than a share of an
invented ceiling, give the arc its own source. The big readout still shows
`entity`; only the arc and its percentage come from the ratio.

| Option | Description |
|---|---|
| `percent_numerator` | Required for ratio mode. |
| `percent_subtract` | Optional, taken off the numerator. |
| `percent_denominator` | Optional, defaults to the numerator. |

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_system_pv_energy_today
name: 今日发电量
unit: kWh
scale: 0.001
icon: panel
label: 自发自用率
percent_numerator: sensor.msa_280520260806_system_pv_energy_today
percent_subtract: sensor.msa_280520260806_grid_on_energy_out_total
percent_denominator: sensor.msa_280520260806_system_pv_energy_today
```

Self-consumption = *PV energy − exported energy* ÷ *PV energy*.

### Built-in icons

`icon:` also accepts one of these names instead of an emoji. Each glyph is drawn
as a single-colour SVG on a **soft tinted circle**, so the three summary tiles
share one shape while each still says what it counts. Any other string
(including an emoji) still renders as text, so old configs keep working.

| Name | Looks like | Meant for |
|---|---|---|
| `panel` | amber four-cell PV module on a stand, on a pale amber disc | energy produced today (default) |
| `sun` | amber sun with eight rays | production, more abstract |
| `cycle` | **two** blue arrows circling a solid dot, on a pale blue disc | energy **discharged** today (default) |
| `battery` | green battery with a terminal and a bolt, on a pale green disc | energy **charged** today (default) |
| `dot` | neutral filled circle | fallback |

`batOut` and `batIn` are kept as aliases for `cycle` and `battery`: a dashboard
written before the redesign keeps its look without being regenerated.

`cycle` is deliberately **two** arcs with one arrowhead each, not one ring with a
single head: a lone head reads as "refresh", two reads as energy going round and
coming back. The two arcs are symmetrical (156° of sweep, 12° of gap) and the
body is a single stroke, so it survives being drawn 22 px wide.

The tint is `rgba(..., .16)` rather than a solid pastel, so the same badge looks
right on a white card and on a dark theme — a solid `#fef3c7` chip becomes a
glowing disc the moment the theme flips.

```yaml
# switching is a one-word edit
icon: panel      # or sun
icon: cycle
icon: battery
```

### Behaviour notes

- Percentage = `(value − min) / (max − min) × 100`, rounded to a whole number,
  clamped to 0–100 %.
- While the entity has no data yet the arc is still drawn empty and the value and
  percentage read `—`, so the card never turns into a blank space.
- Set `max: 100` and point it at a SOC sensor for a battery-percentage tile.

---

## 6. `custom:hoymiles-control`

Every command in section 10–20 of the MQTT protocol guide, as buttons and inputs.
Commands are published **straight to the protocol topics** (qos 1, retain false),
so the card keeps working even if a discovery entity is missing or offers a
narrower option list than the protocol allows. Current values are read back from
the matching entities when they exist.

```yaml
type: custom:hoymiles-control
dev_id: MSA-280520260806
language: zh
title: 设备控制
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized *Control* | Card heading. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `show_power_ctrl` | bool | `true` | `false` hides the *Target power* row. |
| `show_phase` | bool | `true` | `false` hides the *Per-phase limit* row. |
| `show_log` | bool | `true` | `false` hides the *MQTT log* row (the log itself is off by default). |
| `show_topics` | bool | `false` | Show the MQTT topic under each row (debugging). |
| `subtitle` | bool | `true` | `false` hides the grey line next to the title. |

### Rows and topics

| Row | Protocol topic | Notes |
|---|---|---|
| Device on/off | `switch/<dev_id>/set` | `ON` / `OFF` |
| EMS mode | `select/<dev_id>/ems_mode/command` | `general` / `mqtt_ctrl` / `tou_plan`; unsupported options are greyed out |
| Target power | `number/<dev_id>/power_ctrl/set` | Signed setpoint: **+ discharges, − charges**. Only effective in `mqtt_ctrl` mode; must be sent at least once a minute, otherwise the device falls back to its own control |
| Max output | `number/<dev_id>/output_power/set` | Output ceiling (W). It caps the output, it does not change the power right now |
| Per-phase limit | `number/<dev_id>/phase_output_power/set` | Per phase ceiling (A / B / C), sent as `{"phase_a":..,"phase_b":..,"phase_c":..}` |
| Fetch TOU plan | `sensor/<dev_id>/tou_plan/get` | The reply is published on `tou_plan/status` |
| Reboot | `button/<dev_id>/reboot/trigger` | Sends `RESTART` after a confirmation |
| MQTT log | *(subscribes only, sends nothing)* | Off by default; on, it streams what the device reports and what HA sends |

### The setpoint timer runs inside Home Assistant

`power_ctrl` is a **lease, not a setting**: the firmware keeps the value only while
the message keeps arriving and reverts to its own control about a minute after the
last send. The **Every N s** switch next to *Send* therefore does **not** own a
`setTimeout` in the browser — it calls the integration:

| Service | Behaviour |
|---|---|
| `hoymiles.set_power_ctrl` | Publish `value` now, then again every `interval` seconds |
| `hoymiles.stop_power_ctrl` | Cancel the job (the device reverts within ~60 s) |
| `hoymiles.get_power_ctrl` | Returns `{active, value, interval, next_in}` |

Why it has to work that way: a timer inside the card dies with the card, and
Lovelace destroys a view's elements on every page change. Leaving the Control view
used to stop the re-sends while the switch still read "on" — the device had already
given up. With the timer in Home Assistant, page changes, a closed browser and a
throttled background tab make no difference, and every client sees the same state.

Two consequences worth knowing:

- The repeat is **not** restored after a Home Assistant restart. The device has
  dropped the setpoint by then anyway, so the switch comes back off instead of
  quietly commanding hardware.
- Switching it off really stops the server job, so the device is released rather
  than left pinned to a setpoint nobody can see.
- **Leaving `mqtt_ctrl` stops the repeat.** A setpoint only means something in
  MQTT control, and in `general` / `tou_plan` the device derives the power
  itself, so the job is cancelled the moment the mode changes - whoever changed
  it (this card, `hoymiles.set_ems_mode`, an automation, or the device timing
  out on its own). Coming back starts from a **blank draft**: 0 W, the default
  interval and an armed switch, rather than the setpoint used last time.


### The setpoint timer runs in Home Assistant

`power_ctrl` is a **lease, not a setting**: the firmware keeps the value only
while it keeps arriving, and falls back to its own regulation about a minute
after the last message. The *Every N s* switch next to the Send button therefore
does **not** own a timer in the browser — it calls the integration:

| Service | What it does |
|---|---|
| `hoymiles.set_power_ctrl` | Publish `value` now, then re-publish it every `interval` seconds |
| `hoymiles.stop_power_ctrl` | Stop re-publishing; the device reverts within about a minute |
| `hoymiles.get_power_ctrl` | Report `{active, value, interval, next_in}` (a response, so templates and the card can read it) |

Why it matters: a `setTimeout` inside the card died with the card, and Lovelace
destroys the view's elements on every navigation. Leaving the Control page used
to stop the refresh while the switch on screen still read "on" — the device had
already fallen back. A timer in Home Assistant survives page changes, a closed
browser and a throttled background tab, and every client sees the same state.

Two things to know:

- The repeat **stops when Home Assistant restarts**. The device has dropped the
  value by then anyway, so the card comes back with the switch off rather than
  silently commanding hardware again.
- Turning the switch off asks first, and it really stops the job — the device is
  released, not left pinned to a setpoint nobody can see.


### MQTT log

The last row of *Plan & maintenance* is an **MQTT log**, **off by default**. Turning it
on subscribes to two wildcards over the Home Assistant websocket (the
`mqtt/subscribe` command) and interleaves both directions on one timeline:

| Wildcard | Carries |
|---|---|
| `homeassistant/+/<dev_id>/#` | what the device publishes (`quick/state` every second, `device/state`, `system/state`, `tou_plan/status`, the discovery configs) plus what HA sends (`set`, `command`, `trigger`, `get`) |
| `hoymiles/<dev_id>/#` | the integration's own topics (`availability`, the EMS mode echo) |

- Direction is read off the topic: the command side (`/set`, `/command`,
  `/trigger`, `/get`) is *HA → device*, everything else on those trees is
  *device → HA*, and the `hoymiles/` family belongs to this end as well.
- Every row shows the time, a direction badge, the topic with the boilerplate
  stripped (`sensor/quick/state`; the full topic is the tooltip) and the payload,
  pretty printed when it is JSON and truncated when it is long.
- The list keeps the **latest 200 messages** (a `quick/state` a second is about
  three minutes), counts what it dropped, and scrolls to the newest message
  unless you have scrolled up to read.
- While it is off **nothing is subscribed**, so the card costs nothing; leaving
  the view unsubscribes and coming back resumes it.
- We could not make this cheaper: `mqtt/subscribe` is **admin-only** in Home
  Assistant, so a non-admin user sees an explanation instead of a stream.

### Behaviour notes

- Range hints such as `-1000 ~ 1000 W` prefer the entity's `min` / `max`
  attributes, falling back to protocol defaults.
- The layout follows the iOS settings idiom: rounded groups, small grey section
  headers (**Power & mode / Power settings / Plan & maintenance**), rows of
  icon + name + right-aligned control, and hairlines that stop short of the card
  edge. On/off and EMS mode use segmented controls; reboot is red.
- **Power on/off is slow** — the firmware has to bring the PCS (and the packs)
  down or up. The card shows the requested state as *pending* for up to 5 s until
  the device reports it, then keeps a tick visible for a moment.
- MQTT topics are hidden by default because they are engineering detail that
  crowds out the content; enable `show_topics: true` when debugging.
- The **MQTT log** (see above) is a per-card switch, not a global one: it is off
  until you turn it on, and `show_log: false` removes the row entirely.

---

## 7. `custom:hoymiles-tou-editor`

The visual TOU plan editor. It talks to the device through the integration
services (`hoymiles.set_tou_day_plan`, `set_tou_week_plan`, `get_tou_plan`,
`set_ems_mode`) and falls back to `mqtt.publish` if the integration is somehow
absent.

```yaml
type: custom:hoymiles-tou-editor
dev_id: MSA-280520260806
language: zh
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized | Card heading. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `require_tou_mode` | bool | `true` | The editor only renders while EMS mode is `tou_plan`. Set `false` to disable that gate. |
| `ems_entity` | entity id | auto | Override the entity used to read EMS mode. |
| `status_entity` | entity id | auto | Override the entity used to read the plan status. |
| `day_ack_entity` | entity id | auto | Override the day-plan acknowledgement entity. |
| `week_ack_entity` | entity id | auto | Override the week-plan acknowledgement entity. |

### Two levels: day plans and the week plan (read this first)

TOU is **two layers of data** on the device. Missing one of them means nothing
ever runs:

```
Day plan day1..day8   a list of segments, e.g. "09:00-11:00 force charge 400 W"
        ↑ referenced by
Week plan Mon..Sun    which day plan each weekday uses
```

**A day plan that no weekday points at is stored but never executed.** This is the
most common reason a save "does nothing": an all-blank week table looks
already-configured, so edits to a day plan change nothing. The card therefore
never presents a blank table as fact - it shows how much it actually knows about
the device, and refuses to send a table whose mapping it has not established.

### How to set it up

1. **Press Read.** Reading is an explicit action: it replaces everything on screen
   with what the device holds, so opening the card never does it behind your back.
   A configured device answers all seven weekdays; a device with no plan answers
   `tou plan not configured` once and the card stops there.
2. **Edit a day plan.** Pick a `day1`..`day8` tab and use *+ Add segment*.

   | Field | Meaning |
   |---|---|
   | Mode | `Force charge` (grid + PV), `PV charge` (PV only), `Discharge` (self-consumption, discharge allowed) |
   | Start / End | The time window, picked from a list at 15-minute resolution |
   | sh% / sl% | Charge-stop SOC / discharge-stop SOC (a new segment defaults to `100` / `10`) |
   | pc W | Charge power ceiling (defaults to `1000`) |
   | pd W | Discharge power ceiling (defaults to `1000`) |

   > **Segments are chained.** A segment's start can only be picked at or after the previous
   > segment's end, and a new segment continues exactly where the last one stopped. Moving one
   > end drags the following segments along, so "end before start" and "overlapping ranges" —
   > the two things the device rejects — cannot be produced.
   >
   > **An end of `24:00` fills the day**: *+ Add segment* greys out as soon as any segment ends
   > there. To run one segment for the whole day, set its end to `24:00`.

3. **Fill in the week plan.** Give every weekday you care about a `dayN`. The
   dropdown labels each day plan with its segment count, or `empty` — the device
   rejects a mapping onto an empty day plan, and the card blocks it up front.
4. Press **Save & Activate**. The card sends things in the order the firmware
   demands:

   ```
   switch to tou_plan  →  day1..day8  →  week plan  →  read the day back to verify
   ```

   > The order cannot be reversed. The firmware's `HmMqttIsTouConfigReady()`
   > requires EMS to be **already** in `tou_plan` before it accepts a plan;
   > otherwise the day plan answers `ack 10`, the week plan answers `ack 6`, and
   > both payloads are dropped.

5. A **progress dialog** covers the page while the save runs, showing one row per
   step: `Check the plan` → `Switch EMS` → `Send day plans (n)` → `Send week plan`
   → `Verify the device holds the plan`. On success it shows a green tick and
   **closes itself**; on failure or timeout it shows the reason with a red mark and
   a *Close* button, and stays open.

   > *Read* uses the same dialog and walks the seven weekdays, turning each into
   > `Mon -> day1 · 2 segments`. Reading costs 2–5 s per weekday; a device with no
   > plan at all is answered in about a second, because the first refusal says the
   > whole device is empty and there is nothing left to ask.

   > A full save (seven day plans + the week plan + the read-back check) takes
   > about **50 s**, because every read-back costs 2–5 s on this device.

### Not read, or nothing to read

The banner above the table is text only — it says how much is actually known, and
never repeats the two buttons that are already in the action bar. Three answers
call for different actions:

| State (next to Read / Send) | What it means | What you can do |
|---|---|---|
| `Not read from the device yet` | nothing has been asked yet | *Read*, or start building a schedule |
| `Device has no plan yet` | the device answered `tou plan not configured` - it really holds no plan | build the schedule and press *Send* |
| `Loaded from the device` | all seven weekdays answered | edit and send |

Editing is what unlocks an overwrite: as soon as a segment is added or changed,
the state becomes `New plan - replaces the device's` and *Send* goes through.
Sending an untouched blank table is still refused, because it would silently
erase a plan you cannot see. A **partial** read (some weekdays answered, some did
not) cannot be bypassed by editing at all: read again first, or the weekdays that
failed would be unmapped on the device.

### Unsaved edits are protected

As soon as anything is edited without being saved an `unsaved changes` chip
appears, and *Reload from device* turns into *Discard & reload* — a second click
is needed before the draft is replaced with what the device holds.

### Chained segments and 24:00

- Start and end are **dropdowns**, not free text. A start only offers slots at or after the
  previous segment's end; an end only offers slots later than its own start, up to `24:00`.
- A later start is still selectable (that leaves a gap), but a start **inside** the previous
  segment never is — so ack 3 (overlap) is impossible. An end that is not later than its own
  start is impossible too, so ack 9 cannot happen either.
- `24:00` is an end-only label for firmware slot `96`. It is never rendered as `00:00` again —
  that spelling is exactly what caused the old "store 96, show 00:00, save 0, ack 9" bug.
- Deleting a segment in the middle leaves the following ones on their own times (a gap is
  legal); nothing is silently rewritten.

### Outside every segment

When the clock is not inside any segment the device falls back to
**self-consumption** (`work_mode=2`); inside a segment it runs that segment's
`mode` (`work_mode=3`). A day plan covering only 09:00-11:00 therefore runs
self-consumption for the other 22 hours — that is correct, not a failure.

### An end of 24:00 finishes the day

**Superseded by the `24:00` dropdown described above.** The end time is now picked directly as
`24:00`; there is no longer any "type 00:00 to mean midnight" ambiguity.

> The early build had a real bug here: the device stored `te=96`, the native time control showed
> `00:00`, and saving it again turned it into `te=0`, which the device rejected with **day ack 9**.
> That is gone now.

### Firmware rules the card now checks before sending

The card validates the draft locally with the same rules, naming the exact row
(`day3 #2`) and the problem, instead of shipping the payload and getting a raw
code back:

| Rule | Ack when violated |
|---|---|
| `ts < te` for every segment (end after start) | `9` |
| `ts` and `te` inside `0..96` | `5` |
| Segments within one day must not overlap | `3` |
| At most 12 segments per day plan | `2` |
| Charging segments (mode 1/2) need `sh` in 10..100 | `6` |
| Discharging segments (mode 4) need `sl` in 10..100 | `6` |
| `pc`/`pd` at most `packs × 2500 W` | `7` |

### Ack codes

The Status row now renders `code · meaning`, e.g.
`day ack: 9 · end must be later than start`.

| day ack | Meaning | week ack | Meaning |
|---|---|---|---|
| 0 | success | 0 | success |
| 1 | general error | 1 | general error |
| 2 | too many segments (max 12) | 2 | weekday name invalid |
| 3 | time ranges overlap | 3 | a weekday is mapped twice |
| 4 | mode out of range | 4 | day_idx out of range |
| 5 | start/end out of range | 5 | the mapped day plan is empty |
| 6 | sh%/sl% out of range | 6 | EMS is not in tou_plan mode |
| 7 | pc/pd out of range | | |
| 8 | day_idx out of range | | |
| 9 | end must be later than start | | |
| 10 | EMS is not in tou_plan mode | | |

> **A rejected save leaves the device untouched.** The card now says so
> explicitly ("the plan on the device was NOT changed") instead of reporting a
> generic "saved and activated".

### What the three modes actually do

| Mode | Firmware constant | Real behaviour |
|---|---|---|
| Force charge `mode=1` | `EMS_BAT_CHG_FIRST` | Grid + PV charge the battery until `sh%` |
| PV charge `mode=2` | `EMS_PV_CHG` | PV only, never draws from the grid |
| Discharge `mode=4` | `EMS_SELF_USE` | **Not force-export.** Self-consumption with discharge allowed; `pd` is only a ceiling |

> A "discharge" segment often outputs only tens of watts because it *means*
> self-consumption: with no meter the load is whatever the on-grid port is
> serving, so a 91 W load draws 91 W. That is not a bug.

> `pc` has a physical limit: with a single pack (`pack_count=1`) charging is
> capped at 500 W, so 800 or 1200 still delivers 500 W.

### ⚠ Read-back used to lie (now handled)

The attributes of `tou_plan/status` **only refresh on a successful get reply**. On a
timeout, a failed get, or when EMS is not in `tou_plan`
(`{"status":1,"err_msg":"general error"}`) the HA entity **keeps the previous
attributes**, so the old card showed a stale plan and it looked like the
configuration had been rolled back — it had not, it was reading a cache.

`_fetchPlan()` now validates both `last_updated` **and** the `week` field in the
reply, and reports *no reply from the device* instead of passing a stale value off
as a fresh one.

### Behaviour notes

- A day is a list of segments with `mode` / `ts` / `te` / `sh` / `sl` / `pc` / `pd`.
  `ts` and `te` are quarter-hour slots, `0`–`96`.
- Modes: `1` force charge, `2` PV charge, `4` discharge.
- The plan editor has its own UI config editor, so it can also be added and
  configured graphically from the dashboard.

> **Why the EMS gate exists.** Early firmware shipped no `state_topic` for
> `ems_mode`, so the integration maintains a **retained state topic** of its own
> at `hoymiles/<dev_id>/ems_mode/state`:
>
> - as soon as anyone publishes to `…/ems_mode/command`, the integration echoes
>   it to that topic, so the UI and cards refresh immediately;
> - it also follows `ems_mode` inside `system/state` (the device's real running
>   mode, on a 5-minute cycle) and corrects itself, so a device-side timeout back
>   to `general` shows up.
>
> Why not just point `state_topic` at `system/state`: that topic only arrives
> every 5 minutes, and this card gates on the select state, which would leave the
> editor stuck for up to 5 minutes after switching to `tou_plan`.

---

## 8. `custom:hoymiles-energy-sankey`

A source → sink energy-flow sankey built from long-term statistics.

```yaml
type: custom:hoymiles-energy-sankey
dev_id: MSA-280520260806
title: 能量流
language: zh
range: today
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized | Card heading. |
| `language` | `en` \| `zh` \| `de` | *toolbar switch* | Pin this card to one language, or leave it out to follow the toolbar switch (English until someone picks otherwise). `zh-Hans` / `zh-Hant` / `zh-CN` all select Chinese; `de-AT` / `de-CH` select German. |
| `range` | `today` \| `7d` \| `30d` \| `month` | `today` | Time range. |
| `balancer_label` | string | localized | Name of the *Loss* / *Unmetered* residual node. |
| `show_toolbar` | bool | `true` | `false` hides the range switcher. |
| `ribbon_gap` | number (px) | `3` | White gap between ribbons. |
| `ribbon_opacity` | number | `0.5` | Ribbon opacity, 0–1. |
| `icons` | map | — | Per-node emoji overrides, e.g. `pv: "☀️"`. |
| `statistics` | string \| list \| map | — | Override the default `statistic_id`s. A value may be a single id or a list; multiple ids are summed. |

### Data source

The card calls Home Assistant's official WebSocket statistics endpoint:

```
recorder/statistics_during_period
  statistic_ids: [...]       # this device's energy sensors
  period: "day"
  units: {energy: "kWh"}     # unit conversion done server-side
  types: ["change"]          # HA's already-computed delta for the range
```

Therefore:

- The recorder **database file is never touched** — no SQLite reads, no exposure
  to schema migrations.
- **No administrator rights** are required (`statistics_during_period` is not
  admin-gated).
- Only the recorder integration is needed, and it is part of `default_config`.
- Rendering is hand-rolled SVG with **no CDN**, so it works offline.

### Interaction

Click a ribbon to highlight that single flow, or click a node box to highlight
every ribbon touching it. The rest of the diagram dims and a detail panel lists
the involved flows. Click the same target again (or empty space) to clear. This
is view state only — the numbers never change.

### About the "Loss / Unmetered" node

A sankey requires conservation, but the device meters every port **separately**
(conversion losses, sampling phase, unmetered loads all create a difference).
Rather than normalising and scaling the flows, the card draws the difference as
an explicit node — a positive residual becomes *Loss*, a negative one becomes
*Unmetered* — which keeps the diagram conserved and every ribbon truthful.

### Rendering caveat

Each side is a single column of node boxes. Because the device meters each port
separately, the routing behind the ribbons is **not measured**: it is estimated by
spreading each source over the sinks proportionally (iterative proportional
fitting), forbidding impossible loops such as battery-discharge →
battery-charge. Read the ribbons as a best-effort attribution, not as metered
truth.

### Relationship to the official Energy dashboard

Home Assistant's Energy dashboard has a sankey-style *Energy distribution* card,
but its nodes are fixed to **solar / grid / battery / home**. For comparison you
can configure it as follows:

| Slot | Suggested entity |
|---|---|
| Solar | `sensor.<dev>_system_pv_energy_today` |
| Grid consumption | `sensor.<dev>_grid_on_energy_in_total` |
| Return to grid | `sensor.<dev>_grid_on_energy_out_total` |
| Battery charge | `sensor.<dev>_battery_charge_energy_today` |
| Battery discharge | `sensor.<dev>_battery_discharge_energy_today` |

> **Prefer the `*_total` cumulative sensors** (`grid_on_*` / `inv_*` with `etin` /
> `etout`). The `*_today` sensors reset every day, and Home Assistant reads a
> cross-day drop **after a long outage** as a device reset, losing the deltas in
> between. Cumulative sensors do not have that problem.

The device-specific **EPS / smart plug / off-grid** ports do not fit the official
model — that is what this card is for.
