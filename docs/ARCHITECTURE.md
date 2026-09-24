# Architecture

How the `hoymiles` integration talks to the device: topics, the firmware
discovery patches, the entity model and the availability logic.

**English** · [简体中文](ARCHITECTURE.zh-Hans.md)

---

## Module map

| File | Responsibility |
|---|---|
| `__init__.py` | Config entry setup, frontend asset registration, service registration |
| `manifest.json` | Domain, version, dependencies (`mqtt`, `http`, `frontend`) |
| `const.py` | Topic templates, constants, TOU reply codes, card asset list |
| `mqtt_util.py` | Publish/subscribe helpers and device auto-discovery |
| `coordinator.py` | Push-based `DataUpdateCoordinator` plus availability tracking |
| `discovery_override.py` | Rewrites the firmware's MQTT discovery payloads |
| `sensor.py` | State sensors, plus TOU echo and acknowledgement sensors |
| `binary_sensor.py` | Heating states |
| `number.py` | Per-phase output power (integration-local entity) |
| `config_flow.py` | Device discovery and setup |
| `options_flow.py` | TOU configuration wizard |
| `services.py` / `services.yaml` | The `hoymiles.*` services |
| `strings.json` / `translations/` | UI strings (`en`, `zh-Hans`) |
| `brand/` | `icon.png` (256×256) and `logo.png` (657×256) |
| `www/` | The eight Lovelace cards, plain ES modules |

## Topic model

`<dev_id>` is `<mqtt_param.client_prefix>-<SN>`, or just the SN when the device is
configured without a prefix.

The device publishes **plain MQTT topics** — there is no proprietary envelope, and
the integration does not invent one. It subscribes:

| Topic | Payload | Cadence |
|---|---|---|
| `device/quick/state` (via `quick/state`) | Flat JSON, live values | 1 s |
| `device/state` | Nested JSON, slower-moving values | 5 min |
| `system/state` | System-level values, **master / standalone units only** | 5 min |
| `hoymiles/<dev_id>/tou_day_plan/ack` | Day-plan acknowledgement | on demand |
| `hoymiles/<dev_id>/tou_week_plan/ack` | Week-plan acknowledgement | on demand |
| `hoymiles/<dev_id>/tou_plan/status` | Current plan report | on demand |
| `homeassistant/+/<dev_id>/config` | The firmware's own discovery payloads | on connect |

Everything is per the *Hoymiles Micro Storage MQTT Protocol Development Guide
V0.5.1*.

## Division of labour with the firmware's discovery

The firmware already registers these entities over MQTT discovery, and the
integration **deliberately does not duplicate them**:

| Entity | Discovery topic |
|---|---|
| Device on/off | `homeassistant/switch/<dev_id>/config` |
| EMS mode | `homeassistant/select/<dev_id>/ems_mode/config` |
| Power control | `homeassistant/number/<dev_id>/power_ctrl/config` |
| SOC / battery power | `homeassistant/sensor/<dev_id>/soc|bat_p/config` |
| Output power / per-phase output power | `homeassistant/number/<dev_id>/output_power|phase_output_power/config` |
| Reboot | `homeassistant/button/<dev_id>/reboot/config` |

Consequently the integration **does not create** `soc` or `bat_power` entities, so
the same value never appears twice in the UI.

## Patching the firmware's discovery payloads

Some firmware builds hard-code discovery payloads that do not satisfy the Home
Assistant schema for their own domain — for example a `switch` without a
`command_topic`, or a `soc`/`bat_p` sensor without `state_class`. Since discovery
is **just a retained message on a topic**, the integration subscribes to
`homeassistant/+/<dev_id>/config`, rewrites the payload when needed, and
republishes it with `retain=True`. **No firmware update is required.** The
implementation is in `discovery_override.py`.

| Topic | Patch | Why |
|---|---|---|
| `switch/<dev_id>` | Add `command_topic`; drop `state_topic` when there is no `value_template` | Firmware ≤ 1.3.101 omits `command_topic`, and Home Assistant rejects the whole payload. Its `state_topic` points at `device/state`, a nested JSON document, so the switch state can never resolve to `ON`/`OFF`. Dropping it turns the entity optimistic, which matches the hardware (`ON` wakes, `OFF` sleeps — there is no readable switch state) |
| `select/<dev_id>/ems_mode` | Add `state_topic` (an integration-maintained topic) | The firmware ships no state topic, so the entity reads `unknown` after every Home Assistant restart |
| `sensor/<dev_id>/soc`, `bat_p` | Add `state_class: measurement` | Without it no long-term statistics (LTS) are produced |
| `number/<dev_id>/phase_output_power` | Add `command_template` | The firmware wants `{"phase_a":..,"phase_b":..,"phase_c":..}`, but a `number` entity sends a bare number by default — the entity is unusable without this |
| All of the above | Add `availability_topic` | Entities turn `unavailable` when the device stops pushing instead of showing stale values |
| `text/<dev_id>/tou_day1..8`, `tou_week_plan` | **Delete** (empty retained payload) | Legacy TOU text entities from older firmware. `"mode": "textarea"` is not a legal value, so they **log an error on every Home Assistant start**. Current firmware publishes `sensor/<dev_id>/tou_day_plan/set` instead, and Home Assistant never successfully created these entities — so cleaning up costs nothing |

> The patch is **idempotent and conditional**: a compliant payload is *not*
> republished, so once the firmware is fixed this layer becomes a no-op and can
> be deleted.
>
> Deleted legacy configs behave the same way — once removed the retained message
> is gone and **is not republished**. If a device running old firmware sends it
> again, it is deleted again (self-healing).
>
> ⚠️ **Side effect:** the firmware republishes its own (old) payload on every
> reconnect, so Home Assistant may log one error *before* the patch lands. Seeing
> `Invalid config for [switch.mqtt]` in the log while the entity works fine is
> expected. Conversely, uninstalling the integration does not leave the device
> broken: a single reconnect restores the firmware's own payload — self-healing
> in both directions.
>
> The `availability_topic` and the EMS state topic both live under the
> `hoymiles/<dev_id>/…` namespace and therefore cannot collide with firmware
> topics.
>
> ⚠️ Home Assistant **does not rebuild subscriptions for entities that already
> exist**. Adding a subscription key such as `state_topic` to an existing entity
> requires a **full Home Assistant restart** (`mqtt.reload` may not be enough). If
> the device happens to reconnect exactly while Home Assistant starts, and Home
> Assistant reads the unpatched payload first, individual entities will not follow
> their state topic until the next restart.

### Switch entity firmware support

Adding `command_topic` only makes Home Assistant **stop rejecting** the payload.
Whether the switch actually works depends on the firmware:

| Firmware | `…/switch/…/config` | Subscribes `…/switch/…/set` | Behaviour |
|---|---|---|---|
| ≤ 1.3.101 | No `command_topic` | ✗ not subscribed | The entity appears after patching, but commands do nothing |
| Next release and later | Complete | ✓ subscribed | On/off works (`ON` wakes, `OFF` sleeps) |

## Entity model

| Platform | Source | Examples |
|---|---|---|
| `sensor` | `quick/state` (1 s, all roles) | `PV Power`, `Grid On Power`, `Battery Status`, `System SOC` |
| `sensor` | `device/state` (5 min, all roles) | `Grid On Voltage`, `Inverter Power`, `PV1 Power`, `Pack 1 SOC`, `Battery Temperature` |
| `sensor` | `system/state` (5 min, master / standalone only) | `System PV Energy Today`, `Battery Charge Energy Today`, `EMS Mode (Device)` |
| `sensor` | TOU topics | `TOU Plan Status`, `TOU Day Plan Ack`, `TOU Week Plan Ack` |
| `binary_sensor` | `quick/state`, `device/state` | `Heating`, `System Heating`, `Pack N Heating` |
| `number` | Integration-local | `Phase A/B/C Output Power` |

> The `sys_*` fields in `system/state` and `quick/state` are published by master /
> standalone units only; on a slave these entities stay `unknown`.
>
> `pv_num` / `pvs` are not published on PID `0x2806` models, so `PV1..PV4 Power`
> stay `unknown` there.

## Availability

Every entity carries an availability check. When `quick/state` has not arrived for
more than **2 minutes** (or `device/state` / `system/state` for more than
**11 minutes**), the integration sets `hoymiles/<dev_id>/availability` to
`offline`. **Both the firmware-discovery entities and the integration's own
entities** then go `unavailable`, so stale values are never presented as current.
Pushing resumes → the state flips back to `online` automatically.

## The EMS mode state topic

Because early firmware provided no `state_topic` for `ems_mode`, the integration
maintains a **retained state topic** of its own at
`hoymiles/<dev_id>/ems_mode/state`:

- As soon as anyone publishes to `…/ems_mode/command`, the integration echoes it
  there, so the UI and cards refresh immediately.
- It also follows `ems_mode` inside `system/state` — the device's real running mode
  — and corrects itself, so a device-side timeout back to `general` is reflected.

Why not point `state_topic` straight at `system/state`: that topic only arrives
every 5 minutes, and the TOU editor gates on the select state, which would leave
the editor stuck for up to 5 minutes after switching to `tou_plan`.

## Per-phase output power

Three-phase limit devices **do not read back** the limit, so `Phase A/B/C Output
Power` shows the *last value written*, restored across Home Assistant restarts.
Any phase that was never set falls back to the protocol lower bound of 100 W and
logs a warning — use `hoymiles.set_phase_output_power` to set all three at once
and avoid that.

The firmware's own `phase_output_power` entity also becomes usable once the
`command_template` patch is applied; its semantics are that **one value applies to
all three phases** (the firmware only accepts the complete three-phase JSON).

## Model detection (for per-model layouts)

The device registry entry carries a `model`, and the firmware's MQTT discovery
payload sets `device.model`. Observed values:

| Device | `device.model` |
|---|---|
| `MSA-2805…` | `HiBattery 4020 X` |
| `MSA-2800…` | `MS-A2` |
| (third variant) | `HiBattery 1920 AC` |

Two important caveats:

1. **Only the firmware's discovery entries carry a model.** The integration's own
   `DeviceInfo` entries have `model: null`. The battery card reads the model from
   the *device registry*, which is what makes `title` default to `HiBattery 4020 X`
   on our test unit.
2. **`DeviceInfo` is written to the device registry only when an entity is first
   added** (`entity_platform._async_add_entity`). Mutating it later does not
   propagate. To backfill a model, capture it from `payload["device"]["model"]` in
   `discovery_override._on_discovery_message` and apply it with
   `device_registry.async_update_device(model=...)` once the discovery message
   arrives.

Models also differ substantially in **how much they publish**: an `MSA-2800`
series unit publishes roughly 3–7 objects where an `MSA-2805` publishes around 95.
The integration creates a fixed entity list regardless, so a smaller model will
have many entities that never receive data — cards must degrade gracefully rather
than assume every entity is populated (the power-flow card's chip and meter logic
is an existing example of that approach).

## Diagnostics

Watch the raw traffic with the Mosquitto clients:

```bash
# everything for one device
mosquitto_sub -h <broker> -v -t 'homeassistant/#'
mosquitto_sub -h <broker> -v -t 'device/#' -t 'system/#'

# only the patched discovery payloads
mosquitto_sub -h <broker> -v -t 'homeassistant/+/<dev_id>/config'
```

Relevant log lines and their meaning are listed in the troubleshooting table of
the [README](../README.md#troubleshooting).
