# Hoymiles Official for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2023.8%2B-41BDF5.svg)](https://www.home-assistant.io)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Bring a **Hoymiles Micro Storage** system into Home Assistant — with a visual editor for
**time-of-use (TOU) charge/discharge plans** and **eight purpose-built Lovelace cards**
that mirror the layout of the Hoymiles app.

**English** · [简体中文](README.zh-Hans.md)

| Where to go next | |
|---|---|
| Install and use it | this page |
| Every card option, in full | **[docs/CARDS.md](docs/CARDS.md)** |
| MQTT topics, firmware discovery patches, entity list | **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** |
| Publishing a release / maintaining this repo | **[DEPLOY.md](DEPLOY.md)** |

---

## Highlights

- **Plain MQTT, no cloud.** The integration reuses Home Assistant's own MQTT
  integration (`dependencies: ["mqtt"]`) — no second broker, no account, no cloud hop.
  Everything stays on your LAN.
- **Reads the device's real topics.** Entities are created from `quick/state` (1 s),
  `device/state` (5 min) and `system/state` (5 min), following the
  *Hoymiles Micro Storage MQTT Protocol Development Guide V0.5.1*.
- **Fixes what the firmware gets wrong — without a firmware update.** Some firmware
  builds publish MQTT discovery payloads that Home Assistant rejects outright. The
  integration rewrites those payloads on the fly and republishes them retained. It is
  idempotent: once the firmware is fixed, the patch becomes a no-op.
- **TOU plan editor.** Configure `day1`…`day8`, assign a day plan to each weekday, push
  them, then switch EMS mode to `tou_plan` — from a native options wizard *or* from a
  visual card.
- **Eight bundled Lovelace cards**, registered as frontend modules automatically, so
  there is no manual "add resource" step. All of them are self-drawn SVG with
  **no CDN and no third-party card** — they work offline.
- **Follows the UI language.** All eight cards use the language of the Home Assistant
  user viewing them (`hass.language`), so one dashboard reads correctly for an
  English and a Chinese user at the same time. Pin a card with `language: en` or
  `language: zh` only when you need to.
- **Honest availability.** If the device stops pushing, entities turn `unavailable`
  within 2 minutes instead of showing stale numbers forever.

## Compatibility

| Item | Requirement |
|---|---|
| **Home Assistant** | 2023.8 or newer (declared in `hacs.json`) |
| **Required integration** | Home Assistant **MQTT**, pointed at the same broker as the device |
| **Devices** | MS-A2 · HiBattery 4020 X · HiBattery 1920 AC |
| **Firmware** | Must publish MQTT discovery under the `homeassistant/` prefix |
| **Recorder** | Optional — only needed by the history chart and the energy sankey |

> Different models report different data. The cards degrade gracefully: a value the
> device never publishes simply does not render.

---

## Installation

### Option A — HACS (recommended)

1. **HACS → Integrations → ⋮ (top right) → Custom repositories**
2. Repository: `https://github.com/hoymiles-ha/ha` — Category: **Integration**
3. Search for **Hoymiles Official** and click **Download**
4. **Restart Home Assistant Core completely** (not just "Reload config entry")

> Why a full restart: the newly downloaded Python modules have to be re-imported.
> Reloading the config entry alone will not load new code.

### Option B — Manual

Copy the whole `custom_components/hoymiles/` folder into your Home Assistant
configuration directory:

```
/config/custom_components/hoymiles/
```

Then **restart Home Assistant completely**.

Typical ways to get the files onto a Raspberry Pi / HAOS box:

- **HAOS / Supervised** — install the Samba share or SSH add-on and browse to
  `\\<host>\config\custom_components\`
- **HA Core / Docker** — `cp -r hoymiles /config/custom_components/` or `docker cp`

### Prerequisites

- Home Assistant **2023.8+**
- The **MQTT integration** installed, configured and connected
- The device connected to the *same* broker, publishing discovery on `homeassistant/...`

---

## Adding your device

**Settings → Devices & Services → Add Integration → search "Hoymiles Official".**

The integration scans retained `homeassistant/switch/+/config` topics and lists every
device it finds in a dropdown, so you normally just pick one. You can also type the
`dev_id` by hand (for example `MSA-280520260806`).

The `dev_id` is `<client_prefix>-<SN>`, or just the SN when no prefix is configured.

---

## Quick start

Once the device is added you get entities plus eight cards. A minimal dashboard:

```yaml
type: vertical-stack
cards:
  - type: custom:hoymiles-power-flow
    dev_id: MSA-280520260806

  - type: custom:hoymiles-battery
    dev_id: MSA-280520260806

  - type: grid
    columns: 3
    square: false
    cards:
      - type: custom:hoymiles-gauge
        entity: sensor.msa_280520260806_system_pv_energy_today
        name: PV today
        unit: kWh
        scale: 0.001
        icon: ☀️
        max: 10
      - type: custom:hoymiles-gauge
        entity: sensor.msa_280520260806_battery_discharge_energy_today
        name: Discharged
        unit: kWh
        scale: 0.001
        icon: 🔋
      - type: custom:hoymiles-gauge
        entity: sensor.msa_280520260806_battery_charge_energy_today
        name: Charged
        unit: kWh
        scale: 0.001
        icon: ⚡
```

> Neither card sets `language`, so both follow the **viewing user's** UI language.
> The gauge tiles are the exception — their wording is your own `name`, so write
> those in whichever language you want. See
> [docs/CARDS.md](docs/CARDS.md#how-the-language-is-chosen).

Configuring a TOU plan, either way works:

- **Native wizard** — device card → **Configure** → *Edit day plan* / *Edit week plan* /
  *Get current plan* / *Set EMS mode* / *Reboot device*
- **Card** — `type: custom:hoymiles-tou-editor`. It only renders the editor while EMS
  mode is `tou_plan`; set `require_tou_mode: false` to disable that gate.

---

## The eight cards

| Card | What it does |
|---|---|
| `custom:hoymiles-power-flow` | Home illustration with live PV / storage / grid / load power and animated flow |
| `custom:hoymiles-battery` | Battery stack drawn to match the *actual* pack count (1–4), with per-pack SOC & temperature |
| `custom:hoymiles-pack-list` | Compact pack list — SOC bar, temperature, heating flag |
| `custom:hoymiles-history-chart` | Day / month / year curves with date navigation, reads long-term statistics |
| `custom:hoymiles-gauge` | Single-value gauge with range switching (e.g. Wh → kWh) |
| `custom:hoymiles-control` | On/off, EMS mode, power, per-phase output, TOU fetch, reboot |
| `custom:hoymiles-tou-editor` | Visual TOU plan editor |
| `custom:hoymiles-energy-sankey` | Energy-flow sankey built from long-term statistics |

Each card is rooted at `ha-card`, is self-drawn SVG, and needs no CDN.

**→ Complete option reference for every card: [docs/CARDS.md](docs/CARDS.md)**

> Cards are injected as frontend modules when the integration starts. If the UI does not
> pick up a change, hard-refresh the browser (`Ctrl` + `F5`).

---

## Services

| Service | Purpose |
|---|---|
| `hoymiles.set_tou_day_plan` | Push the day plan for one of `day1`…`day8` |
| `hoymiles.set_tou_week_plan` | Map weekdays to day plans |
| `hoymiles.get_tou_plan` | Query the device's current plan |
| `hoymiles.set_ems_mode` | Switch EMS mode (`general` / `mqtt_ctrl` / `tou_plan`) |
| `hoymiles.set_phase_output_power` | Set A/B/C phase output limits in one call |
| `hoymiles.reboot` | Restart the device |

Target the device with **one** of:

- `device_id` — pick from the device dropdown in the UI (recommended, auto-completes)
- `dev_id` — the identifier string, e.g. `MSA-280520260806`

```yaml
service: hoymiles.set_tou_day_plan
data:
  dev_id: MSA-280520260806
  day_idx: 1
  day_plan:
    - {mode: 1, ts: 0, te: 5, sh: 55, sl: 10, pc: 1000, pd: 1000}
    - {mode: 4, ts: 5, te: 96, sh: 55, sl: 10, pc: 1000, pd: 1000}
```

> ⚠️ `target.device` is **not** supported — Home Assistant forbids the device filter
> there. Use the `device_id` field (device selector) as shown above.

---

## Entities

| Platform | Source | Examples |
|---|---|---|
| `sensor` | `quick/state` (1 s, all roles) | `PV Power`, `Grid On Power`, `Battery Status`, `System SOC` |
| `sensor` | `device/state` (5 min, all roles) | `Grid On Voltage`, `Inverter Power`, `PV1 Power`, `Pack 1 SOC`, `Battery Temperature` |
| `sensor` | `system/state` (5 min, master / standalone only) | `System PV Energy Today`, `Battery Charge Energy Today`, `EMS Mode (Device)` |
| `sensor` | TOU topics | `TOU Plan Status`, `TOU Day Plan Ack`, `TOU Week Plan Ack` |
| `binary_sensor` | `quick/state`, `device/state` | `Heating`, `System Heating`, `Pack N Heating` |
| `number` | integration-local | `Phase A/B/C Output Power` |

For the full topic map, the firmware discovery patches and the availability logic, see
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Updates

Updates are handled by HACS. After a vendor release:

- HACS checks at most once every **48 hours**; **Home Assistant also checks on every start**
- When a new version exists you get a badge in the HACS sidebar, an `update` entity under
  **Settings → System → Updates**, and a notification
- Click **Update**, then **restart Home Assistant Core**

> The 48-hour interval is hard-coded in HACS — it is not a configurable option. To check
> immediately, restart Home Assistant, reload the HACS panel, or call
> `homeassistant.update_entity` on the `update` entity (fine in an automation, but do not
> overdo it or GitHub will rate-limit you).

Manual installs are **not** upgraded automatically — copy the files again and restart.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| No devices listed when adding the integration | Check the MQTT integration is configured and points at the same broker; the device must have connected and sent its retained discovery |
| Entities stay `unknown` | Confirm the `dev_id` case matches the topics exactly; `system/state` is published by master / standalone units only |
| Card not found | The integration injects the frontend module at startup — hard-refresh the browser if you see a stale version |
| TOU write returns `10` | The device is not in `tou_plan` mode. Call `hoymiles.set_ems_mode` first |
| Log: `Invalid config for [switch.mqtt]` | The firmware republished its own outdated payload on reconnect; the patch lands milliseconds later. Harmless if the entity works |
| Log: `mode: textarea` / `does not generate unique IDs` | The first is a stale firmware leftover that this integration cleans up automatically; the second affects devices this integration does not manage and needs a firmware update |
| Switch state shows `unknown` | By design — the entity is optimistic because the hardware has no readable on/off state |
| All entities `unavailable` | The device is not pushing. `quick/state` silence for 2 minutes marks it offline |
| After adding a `state_topic`, the entity does not follow | Home Assistant does not rebuild subscriptions for existing entities — do a **full restart** |
| A cloud-downloaded integration does nothing | Check the minimum version requirement, or fall back to "copy files + restart" |

More troubleshooting, including HACS icon and release quirks, is in
**[DEPLOY.md](DEPLOY.md)**.

---

## Repository layout

```
hoymiles-ha/
├── hacs.json                     HACS metadata
├── README.md                     this file (English)
├── README.zh-Hans.md             Chinese edition
├── DEPLOY.md                     release / maintenance runbook
├── docs/
│   ├── CARDS.md                  full card option reference
│   └── ARCHITECTURE.md           MQTT topics, discovery patches, entity model
├── scripts/                      brand artwork generator
└── custom_components/hoymiles/
    ├── __init__.py               entry point / frontend asset registration
    ├── manifest.json
    ├── const.py                  topic templates, constants, reply codes
    ├── mqtt_util.py              MQTT publish/subscribe + device auto-discovery
    ├── coordinator.py            push-based DataUpdateCoordinator + availability
    ├── discovery_override.py     firmware discovery payload patching
    ├── sensor.py                 state sensors + TOU echo/ack sensors
    ├── binary_sensor.py          heating states
    ├── number.py                 per-phase output power
    ├── config_flow.py            device discovery & setup
    ├── options_flow.py           TOU configuration wizard
    ├── services.py               hoymiles.* services
    ├── services.yaml
    ├── strings.json
    ├── translations/             en / zh-Hans
    ├── brand/                    icon.png + logo.png
    └── www/                      the eight Lovelace cards (JS)
```

## License

MIT — see [LICENSE](LICENSE).
