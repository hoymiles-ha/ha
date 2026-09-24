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
| `language` | `zh` \| `en` | **Follows Home Assistant.** Leave it out and the card uses the language of the HA user viewing it (any `zh-*` code selects Chinese). Set it only to pin one card to a language. |
| `title` | string | Card heading. Defaults are per-card (see below). |
| `show_title` | bool | Set `false` to hide the heading (and, on some cards, the device SN). |

How `dev_id` is used: the card derives the entity ids it needs from it
(`sensor.<dev_id_slug>_<suffix>`). When your entities do not follow that pattern,
override them individually with the card's `entities:` map.

### How the language is chosen

1. An explicit `language: en` / `language: zh` in the card config wins. Use it only
   to pin one card to a language.
2. Otherwise the card follows the **Home Assistant user's** language, which each
   user sets in **Profile → Language**. Any code starting with `zh` (`zh-Hans`,
   `zh-Hant`, `zh-Hans-CN`) selects Chinese; everything else selects English.
3. Because it is resolved per render, changing the profile language updates every
   card live — no reload and no config change.

> This is why a shared dashboard reads correctly for an English and a Chinese user
> at the same time: the language is a property of the viewer, not of the card.

> `hoymiles-gauge` is the exception — it has no built-in wording at all. Every word
> on it comes from your own `name` / `label` / `icon`, so it never needs translating.

---

## 1. `custom:hoymiles-power-flow`

Draws the home as an illustration and overlays live PV / storage / grid / load
power, matching the vendor app's home screen. Pearls flow along each connector
proportional to that branch's power.

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
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `temperature_entity` | entity id | — | Outdoor temperature shown next to the title. |
| `show_rssi` | bool | `true` | Wi-Fi signal fan in the top-right corner. |
| `show_extras` | bool | `true` | The *PV2* / *smart plug* chips in the top-left corner. |
| `gradient` | bool | `true` | Draw the light gradient backdrop. |
| `max_width` | number (px) | `620` | Maximum width of the illustration; it stays centred. |
| `flow_speed` | number | `1` | Speed multiplier for the moving pearls. `0.5` is calmer, `2` is faster. |
| `has_meter` | `auto` \| `true` \| `false` | `auto` | Whether a grid meter is installed. `auto` treats a non-zero `sys_grid_p` as proof a meter exists; see `meter_zero_samples`. |
| `meter_zero_samples` | number | `10` | In `auto` mode, how many consecutive zero grid readings are needed before concluding there is no meter. Readings arrive once per second, so the default is ~10 s. |
| `entities` | map | — | Entity overrides, keyed by suffix (see below). |

### Data sources

All values come from plain entity states — **the recorder is not required**.

| Node | Entity suffix (`sensor.<dev>_…`) |
|---|---|
| PV | `system_pv_power` (falls back to `pv_power`) |
| Storage | `system_battery_power` (negative = charging) + `system_soc` |
| Grid | `system_grid_power` (positive = importing) |
| Load | `system_load_power` |
| PV2 chip | `system_pv2_power` |
| Smart plug chip | `system_smart_plug_power` |
| Status chip | `battery_status` (`standby` / `charge` / `discharge` / `lock`) |
| Signal fan | `rssi` (dBm) |

### Behaviour notes

- A connector only shows moving pearls when that branch carries **≥ 5 W**. Pearl
  colour follows the branch, and speed rises with power.
- Travel time is computed from the **path length**, so a short stub and a long
  line look like the same speed. At 1059 W the PV connector (about 325 px) takes
  roughly 3.8 s. Tune the whole card with `flow_speed`.
- The storage chip shows the real battery state; the grid chip shows
  **importing / exporting**.
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
- **The two small chips (PV2 / smart plug)** cover the two branches the
  illustration has no node for. The device computes load as:

  ```
  load = grid + plug + PV2 − smart_plug
  ```

  so those two branches are part of `load` but have no node of their own — which
  is why the four big numbers alone do not add up. A chip appears only when its
  reading is **non-zero** (an idle branch has no business taking up space), and
  the other chip moves up rather than leaving a gap. Set `show_extras: false` to
  remove the pair.
- Override individual entities with the suffix-keyed `entities:` map:

  ```yaml
  entities:
    system_pv_power: sensor.my_pv_power
    system_battery_power: sensor.my_battery_power
    system_grid_power: sensor.my_grid_power
    grid_on_power: sensor.my_grid_on_power
    system_load_power: sensor.my_load_power
    soc: sensor.my_soc
    battery_status: sensor.my_battery_status
    rssi: sensor.my_rssi
    system_pv2_power: sensor.my_system_pv2_power
    system_smart_plug_power: sensor.my_system_smart_plug_power
  ```

### Meter vs. no meter

The device-side data cannot distinguish the grid from the house when no meter is
installed, so the card renders two layouts:

- **Meter installed** (`sys_grid_p` non-zero) — four nodes; the grid node shows
  the meter reading with an *importing / exporting* pill, and the house load
  gets its own callout in the top-right corner.
- **No meter** — the load callout and its connector are dropped, and the
  bottom-right node becomes *Grid & load*, showing the device-level on-grid port
  power (`grid_on_p`).

The two readings use **opposite sign conventions** (`sys_grid_p` is positive while
importing, `grid_on_p` is negative because the firmware treats power flowing
*into* the unit as negative). The card normalises both to "am I importing?"
before drawing. A node carrying no power gets no pill at all — not a *standby*
chip.

---

## 2. `custom:hoymiles-battery`

Draws the physical battery stack module by module, so the picture always matches
how many packs are actually installed (1–4), each with its own SOC and
temperature callout alternating left / right.

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
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `show_history` | bool | `true` | Optional history section (needs the recorder). |
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
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
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
    color: "#22c55e"
  - entity: sensor.x_system_battery_power
    name: 放电[+]/充电[-]
    color: "#4a90d9"
```

| Option | Type | Default | Description |
|---|---|---|---|
| `series` | list | — | **Required.** One entry per curve: `entity`, `name`, `color`. |
| `dev_id` | string | — | Optional when every series names an explicit `entity`. |
| `title` | string | — | Card heading. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `range` | `day` \| `month` \| `year` | `day` | Initial time range. |
| `height` | number (px) | `330` | SVG height. |
| `unit` | string | — | Y-axis unit label. Auto-promotes to kW above 1.5 kW. |
| `zero_line` | bool | `true` | Draw the zero line. |
| `symmetric` | bool | `true` | `false` draws a bottom-up axis from min to max — use it for SOC. |
| `min` / `max` | number | — | Fixed axis limits. |
| `span` | number | — | Fixed half-range when `symmetric` is on. |
| `sync_group` | string | — | Cards sharing a group share their time window (range + date). |
| `show_toolbar` | bool | `true` | `false` hides this card's own time controls — use it on the followers. |

### Behaviour notes

- **Data comes from `recorder/statistics_during_period`** (long-term statistics),
  so no administrator rights are needed and the database file is never touched.
- The time selector matches the vendor app: a date pill (`‹` `›` around the date)
  top-left, a day/month/year dropdown top-right, and rounded pill legends below
  the curve.
- Axis ticks pick their decimal places from the actual step, so a 1.25 kW step
  shows `1.25` instead of rounding to `1`.
- Fixing `span` / `min` / `max` keeps the same scale across different days, which
  makes side-by-side comparison possible.
- **Click a legend entry to highlight that curve** — the selected curve thickens
  and brightens while the others fade back. Click it again (or click the chart)
  to clear. The tooltip dims faded curves to match.
- **Hovering shows a guide line and a tooltip at the same instant on every chart
  in the same `sync_group`** (for example *History* driving *Battery SOC*).
  Matching is by timestamp, so charts with different bucket sizes or data gaps
  still line up.
- `show_toolbar: false` plus `sync_group` gives you a dashboard where one chart
  controls and the others follow.
- A card removes itself from its group when it is deleted, leaving nothing behind.

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
| `icon` | string | — | Emoji / glyph shown next to the title. |
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
icon: ☀️
label: 自发自用率
percent_numerator: sensor.msa_280520260806_system_pv_energy_today
percent_subtract: sensor.msa_280520260806_grid_on_energy_out_total
percent_denominator: sensor.msa_280520260806_system_pv_energy_today
```

Self-consumption = *PV energy − exported energy* ÷ *PV energy*.

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
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `show_power_ctrl` | bool | `true` | `false` hides the *Power control* row. |
| `show_phase` | bool | `true` | `false` hides the *Per-phase output power* row. |
| `show_topics` | bool | `false` | Show the MQTT topic under each row (debugging). |
| `subtitle` | bool | `true` | `false` hides the grey line next to the title. |

### Rows and topics

| Row | Protocol topic | Notes |
|---|---|---|
| Device on/off | `switch/<dev_id>/set` | `ON` / `OFF` |
| EMS mode | `select/<dev_id>/ems_mode/command` | `general` / `mqtt_ctrl` / `tou_plan`; unsupported options are greyed out |
| Power control | `number/<dev_id>/power_ctrl/set` | Only effective in `mqtt_ctrl` mode; must be sent at least once a minute |
| Output power | `number/<dev_id>/output_power/set` | Full-load output ceiling (W) |
| Per-phase output power | `number/<dev_id>/phase_output_power/set` | Sent as `{"phase_a":..,"phase_b":..,"phase_c":..}` |
| Fetch TOU plan | `sensor/<dev_id>/tou_plan/get` | The reply is published on `tou_plan/status` |
| Reboot | `button/<dev_id>/reboot/trigger` | Sends `RESTART` after a confirmation |

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
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `require_tou_mode` | bool | `true` | The editor only renders while EMS mode is `tou_plan`. Set `false` to disable that gate. |
| `ems_entity` | entity id | auto | Override the entity used to read EMS mode. |
| `status_entity` | entity id | auto | Override the entity used to read the plan status. |
| `day_ack_entity` | entity id | auto | Override the day-plan acknowledgement entity. |
| `week_ack_entity` | entity id | auto | Override the week-plan acknowledgement entity. |

### Behaviour notes

- A day is a list of segments with `mode` / `ts` / `te` / `sh` / `sl` / `pc` / `pd`.
  `ts` and `te` are quarter-hour slots, `0`–`96`.
- Modes: `1` force charge, `2` PV charge, `4` discharge.
- The card writes `day1`…`day8`, then the week plan, then switches EMS mode to
  `tou_plan`, then reads the current day back.
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
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
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
