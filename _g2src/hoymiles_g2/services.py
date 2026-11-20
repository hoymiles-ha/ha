"""Service handlers for the Hoymiles Micro Storage integration.

Services publish to the raw MQTT topics defined by《禾迈微储MQTT协议开发指南》.
They are the building block used by the bundled Lovelace card and can also be
called directly from automations / scripts.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.const import ATTR_DEVICE_ID
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from . import mqtt_util
from .const import (
    CAP_EMS_MODE,
    CAP_FACTORY_RESET,
    CAP_OUTPUT_POWER,
    CAP_PHASE_OUTPUT,
    CAP_POWER_CTRL,
    CAP_REBOOT,
    CAP_RESET_BLE_PIN,
    CAP_SWITCH,
    CAP_TOU,
    CAP_TOU_DAY_PLAN,
    CAP_TOU_WEEK_PLAN,
    DOMAIN,
    PHASE_A,
    PHASE_B,
    PHASE_C,
    PHASE_POWER_MAX,
    PHASE_POWER_MIN,
    POWER_CTRL_KEEPALIVE_DEFAULT_S,
    POWER_CTRL_KEEPALIVE_MAX_S,
    POWER_CTRL_KEEPALIVE_MIN_S,
    T_EMS_MODE_CMD,
    T_PHASE_OUTPUT_POWER_SET,
    T_REBOOT,
    T_TOU_DAY_SET,
    T_TOU_GET,
    T_TOU_WEEK_SET,
    TOU_DAY_IDX_MAX,
    TOU_MODES,
    TOU_PLAN_MAX,
    TOU_POWER_MIN,
    TOU_SOC_MAX,
    TOU_SOC_MIN,
    TOU_TS_MAX,
    TOU_WEEKDAYS,
    is_inverter_dev_id,
    CONF_REGION,
    REGION_CHOICES,
)

_LOGGER = logging.getLogger(__name__)

ATTR_DEV_ID = "dev_id"

SERVICE_SET_TOU_DAY_PLAN = "set_tou_day_plan"
SERVICE_SET_TOU_WEEK_PLAN = "set_tou_week_plan"
SERVICE_GET_TOU_PLAN = "get_tou_plan"
SERVICE_SET_EMS_MODE = "set_ems_mode"
SERVICE_SET_PHASE_OUTPUT_POWER = "set_phase_output_power"
SERVICE_REBOOT = "reboot"
SERVICE_START_POWER_CTRL_KEEPALIVE = "start_power_ctrl_keepalive"
SERVICE_STOP_POWER_CTRL_KEEPALIVE = "stop_power_ctrl_keepalive"
# The five opt-in curves of the Device view.  Two services because the switch
# card needs the current state to render as well as a way to change it; the
# Options Flow has a `hass` of its own and reads `lovelace` directly.
SERVICE_GET_OPTIONAL_CHARTS = "get_optional_charts"
SERVICE_SET_OPTIONAL_CHARTS = "set_optional_charts"
# The region (time zone) the device's day is measured in.  Two services for the
# same reason as the charts above: the toolbar switch needs the choice list and
# the current value to render, and a way to change it.  Stored in the config
# entry's options because the coordinator makes server-side decisions with it -
# a per-browser value could not decide whether an outage crossed midnight.
SERVICE_GET_REGION = "get_region"
SERVICE_SET_REGION = "set_region"

DAY_PLAN_ITEM = vol.Schema(
    {
        vol.Required("mode"): vol.In(TOU_MODES),
        vol.Required("ts"): vol.All(vol.Coerce(int), vol.Range(min=0, max=TOU_TS_MAX)),
        vol.Required("te"): vol.All(vol.Coerce(int), vol.Range(min=0, max=TOU_TS_MAX)),
        vol.Optional("sh", default=55): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_SOC_MIN, max=TOU_SOC_MAX)
        ),
        vol.Optional("sl", default=10): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_SOC_MIN, max=TOU_SOC_MAX)
        ),
        vol.Optional("pc", default=1000): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_POWER_MIN)
        ),
        vol.Optional("pd", default=1000): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_POWER_MIN)
        ),
    }
)

WEEK_PLAN_ITEM = vol.Schema(
    {
        vol.Required("week"): vol.All(cv.ensure_list, [vol.In(TOU_WEEKDAYS)]),
        vol.Required("day_idx"): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=TOU_DAY_IDX_MAX)
        ),
    }
)

DEVICE_FIELDS: dict[Any, Any] = {
    vol.Optional(ATTR_DEV_ID): cv.string,
    vol.Optional(ATTR_DEVICE_ID): cv.string,
}

SCHEMA_SET_TOU_DAY_PLAN = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("day_idx"): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=TOU_DAY_IDX_MAX)
        ),
        vol.Required("day_plan"): vol.All(
            cv.ensure_list, vol.Length(min=1, max=TOU_PLAN_MAX), [DAY_PLAN_ITEM]
        ),
    }
)

SCHEMA_SET_TOU_WEEK_PLAN = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("week_plan"): vol.All(
            cv.ensure_list, vol.Length(min=1, max=7), [WEEK_PLAN_ITEM]
        ),
    }
)

SCHEMA_GET_TOU_PLAN = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("week"): vol.In(TOU_WEEKDAYS),
    }
)

SCHEMA_SET_EMS_MODE = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("mode"): vol.In(["general", "mqtt_ctrl", "tou_plan"]),
    }
)

SCHEMA_REBOOT = vol.Schema({**DEVICE_FIELDS})

SCHEMA_START_POWER_CTRL_KEEPALIVE = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("power"): vol.Coerce(float),
        vol.Optional(
            "period", default=POWER_CTRL_KEEPALIVE_DEFAULT_S
        ): vol.All(
            vol.Coerce(int),
            vol.Range(
                min=POWER_CTRL_KEEPALIVE_MIN_S, max=POWER_CTRL_KEEPALIVE_MAX_S
            ),
        ),
    }
)

SCHEMA_STOP_POWER_CTRL_KEEPALIVE = vol.Schema({**DEVICE_FIELDS})

# The five opt-in Device-view curves.  `charts` is a free ``{key: bool}`` object
# rather than five named booleans, so adding a sixth chart does not change this
# schema; unknown keys are ignored by the handler and the five known ones are
# read with an explicit ``False`` default.
SCHEMA_GET_OPTIONAL_CHARTS = vol.Schema({**DEVICE_FIELDS})

SCHEMA_SET_OPTIONAL_CHARTS = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("charts"): dict,
    }
)

SCHEMA_GET_REGION = vol.Schema({**DEVICE_FIELDS})

# ``region`` is free text, not an enum of REGION_CHOICES: the list is a
# convenience for the dropdown, and a unit installed somewhere the list does not
# cover (or a Home Assistant installed without the full tz database) must still
# be settable.  ``""`` means "follow Home Assistant".
SCHEMA_SET_REGION = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required(CONF_REGION): vol.Any(cv.string, None),
    }
)


_PHASE_POWER = vol.All(
    vol.Coerce(int), vol.Range(min=PHASE_POWER_MIN, max=PHASE_POWER_MAX)
)

# The firmware only accepts a complete {"phase_a":..,"phase_b":..,"phase_c":..}
# object (protocol §15), so all three phases are mandatory here.
SCHEMA_SET_PHASE_OUTPUT_POWER = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required(PHASE_A): _PHASE_POWER,
        vol.Required(PHASE_B): _PHASE_POWER,
        vol.Required(PHASE_C): _PHASE_POWER,
    }
)


def _find_coordinator(hass: HomeAssistant, dev_id: str) -> Any | None:
    """Return the loaded coordinator for a device id, if there is one."""
    for entry_data in hass.data.get(DOMAIN, {}).values():
        if isinstance(entry_data, dict) and entry_data.get("dev_id") == dev_id:
            return entry_data.get("coordinator")
    return None


def _find_entry_data(hass: HomeAssistant, dev_id: str) -> dict[str, Any] | None:
    """Return the ``hass.data`` record of a loaded device."""
    for entry_data in hass.data.get(DOMAIN, {}).values():
        if isinstance(entry_data, dict) and entry_data.get("dev_id") == dev_id:
            return entry_data
    return None


def _resolve_dev_id(hass: HomeAssistant, data: dict[str, Any]) -> str:
    """Resolve a device id from ``dev_id`` or a HA device registry id."""
    dev_id = data.get(ATTR_DEV_ID)
    if dev_id:
        return str(dev_id)

    device_id = data.get(ATTR_DEVICE_ID)
    if not device_id:
        raise vol.Invalid(f"Either '{ATTR_DEV_ID}' or '{ATTR_DEVICE_ID}' is required")

    registry = dr.async_get(hass)
    device = registry.async_get(device_id)
    if device is None:
        raise vol.Invalid(f"Unknown device_id: {device_id}")

    domain_data = hass.data.get(DOMAIN, {})
    for entry_id in device.config_entries:
        entry_data = domain_data.get(entry_id)
        if isinstance(entry_data, dict) and entry_data.get("dev_id"):
            return entry_data["dev_id"]

    raise vol.Invalid(f"device_id {device_id} does not belong to a Hoymiles entry")


def _require_capability(hass: HomeAssistant, dev_id: str, capability: str) -> None:
    """Refuse a command the device has never shown any sign of supporting.

    Publishing to a topic the firmware does not subscribe to is indistinguishable
    from success: the broker accepts it, nothing happens, and the caller has no
    way to tell.  That is the other half of the reported problem - a device that
    connects over MQTTS publishes a strictly smaller topic set, so the page must
    not offer controls for those topics *and* the services must not silently
    accept them.

    Only a *known* capability set is enforced.  A device that has not been heard
    from at all yet keeps the benefit of the doubt, otherwise a command issued
    right after a Home Assistant restart would fail for no reason.
    """
    coordinator = _find_coordinator(hass, dev_id)
    if coordinator is None or not coordinator.capabilities_known:
        return
    if coordinator.has_capability(capability):
        return

    raise HomeAssistantError(
        f"{dev_id} does not publish the '{capability}' topic, so this command "
        "would be ignored by the device. Known topics: "
        f"{', '.join(sorted(coordinator.capabilities)) or 'none'}"
    )


def _inverter_entries(hass: HomeAssistant) -> list[tuple[str, Any]]:
    """Every configured micro-inverter entry as ``(dev_id, entry)``.

    Ordered by entry creation, so the first element is stable across reloads.
    Only inverter PIDs are returned: a storage unit shares the ``hoymiles``
    domain but has nothing to do with the region switch, and rewriting its
    options would be a change nobody asked for.
    """
    from .const import CONF_DEV_ID  # noqa: PLC0415

    found: list[tuple[str, Any]] = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        dev_id = str(entry.data.get(CONF_DEV_ID, ""))
        if dev_id and is_inverter_dev_id(dev_id):
            found.append((dev_id, entry))
    return found


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration services once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_services_registered"):
        return
    domain_data["_services_registered"] = True

    async def _handle_set_tou_day_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_TOU_DAY_PLAN)
        payload = {
            "day_idx": int(call.data["day_idx"]),
            "day_plan": [
                {
                    "mode": int(item["mode"]),
                    "ts": int(item["ts"]),
                    "te": int(item["te"]),
                    "sh": int(item["sh"]),
                    "sl": int(item["sl"]),
                    "pc": int(item["pc"]),
                    "pd": int(item["pd"]),
                }
                for item in call.data["day_plan"]
            ],
        }
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_DAY_SET, dev_id), payload
        )

    async def _handle_set_tou_week_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_TOU_WEEK_PLAN)
        payload = {
            "week_plan": [
                {
                    "week": list(item["week"]),
                    "day_idx": int(item["day_idx"]),
                }
                for item in call.data["week_plan"]
            ]
        }
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_WEEK_SET, dev_id), payload
        )

    async def _handle_get_tou_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_TOU)
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_GET, dev_id), {"week": call.data["week"]}
        )

    async def _handle_set_ems_mode(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_EMS_MODE)
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_EMS_MODE_CMD, dev_id), str(call.data["mode"])
        )

    async def _handle_set_phase_output_power(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_PHASE_OUTPUT)
        values = {
            PHASE_A: int(call.data[PHASE_A]),
            PHASE_B: int(call.data[PHASE_B]),
            PHASE_C: int(call.data[PHASE_C]),
        }

        coordinator = _find_coordinator(hass, dev_id)
        if coordinator is not None:
            await coordinator.async_set_phase_outputs(values)
            return

        # Entry not loaded (or a dev_id typed by hand): publish directly.
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_PHASE_OUTPUT_POWER_SET, dev_id), values
        )

    async def _handle_reboot(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_REBOOT)
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_REBOOT, dev_id), "RESTART"
        )

    async def _handle_start_power_ctrl_keepalive(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_capability(hass, dev_id, CAP_POWER_CTRL)
        entry_data = _find_entry_data(hass, dev_id)
        if entry_data is None:
            raise vol.Invalid(f"Device {dev_id} is not loaded")

        keepalive = entry_data.get("keepalive")
        if keepalive is None:
            raise vol.Invalid(f"Device {dev_id} has no power control keep-alive")

        await keepalive.async_start(call.data["power"], call.data.get("period"))

    async def _handle_stop_power_ctrl_keepalive(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        entry_data = _find_entry_data(hass, dev_id)
        if entry_data is None:
            raise vol.Invalid(f"Device {dev_id} is not loaded")

        keepalive = entry_data.get("keepalive")
        if keepalive is None:
            raise vol.Invalid(f"Device {dev_id} has no power control keep-alive")

        await keepalive.async_stop()

    async def _handle_get_region(call: ServiceCall) -> dict[str, Any]:
        from . import region  # noqa: PLC0415

        choices = [
            {"value": value, "label_en": label_en, "label_zh": label_zh}
            for value, label_en, label_zh in REGION_CHOICES
        ]
        ha_zone = str(hass.config.time_zone)

        # ``dev_id`` is optional on purpose: the toolbar switch is one control
        # for the whole installation, and requiring a device there would mean
        # the browser has to know which inverter a dashboard happens to show.
        # Without it the answer describes the *installation*: the choice of the
        # first inverter entry (all of them are written together by
        # ``set_region``), plus the list and HA's own zone.
        raw = call.data.get(ATTR_DEV_ID) or call.data.get(ATTR_DEVICE_ID)
        if raw:
            dev_id = _resolve_dev_id(hass, dict(call.data))
            entry = region.entry_of(hass, dev_id)
            if entry is None:
                raise HomeAssistantError(f"Device {dev_id} is not loaded")
            return {
                "dev_id": dev_id,
                "region": region.zone_name(entry),
                "ha_zone": ha_zone,
                "choices": choices,
            }

        entries = _inverter_entries(hass)
        if not entries:
            raise HomeAssistantError("No micro-inverter entry is configured")
        dev_id, entry = entries[0]

        # ``ha_zone`` lets the switch label the default entry with something
        # meaningful ("跟随 Home Assistant (Asia/Shanghai)") instead of a bare
        # "default"; the browser cannot read the server's zone otherwise.
        return {
            "dev_id": dev_id,
            "region": region.zone_name(entry),
            "ha_zone": ha_zone,
            "choices": choices,
        }


    async def _handle_set_region(call: ServiceCall) -> dict[str, Any]:
        from . import region  # noqa: PLC0415

        raw_region = call.data.get(CONF_REGION)
        wanted = raw_region.strip() if isinstance(raw_region, str) else ""

        # Reject an unresolvable name instead of storing it: it would silently
        # fall back to the server zone and look like the setting was ignored.
        if wanted and region.resolve(wanted) is None:
            raise HomeAssistantError(
                f"{wanted!r} is not a time zone this system knows "
                "(expected an IANA name such as 'Asia/Shanghai')"
            )

        # An explicit ``dev_id`` targets that one device (the options flow);
        # without one the switch writes every inverter entry, which is what
        # "one roof, one time zone" means and keeps the toolbar control global.
        if call.data.get(ATTR_DEV_ID) or call.data.get(ATTR_DEVICE_ID):
            dev_id = _resolve_dev_id(hass, dict(call.data))
            entry = region.entry_of(hass, dev_id)
            if entry is None:
                raise HomeAssistantError(f"Device {dev_id} is not loaded")
            targets = [(dev_id, entry)]
        else:
            targets = _inverter_entries(hass)
            if not targets:
                raise HomeAssistantError("No micro-inverter entry is configured")

        applied: list[str] = []
        for dev_id, entry in targets:
            previous = region.zone_name(entry)
            if wanted != previous:
                # Options, not data: these are user preferences that modify
                # behaviour rather than describe the hardware, and
                # ``async_update_entry`` with options does not count as a
                # reconfiguration.
                hass.config_entries.async_update_entry(
                    entry, options={**entry.options, CONF_REGION: wanted}
                )
                _LOGGER.info(
                    "Hoymiles %s: region changed %s -> %s",
                    dev_id,
                    previous or "Home Assistant",
                    wanted or "Home Assistant",
                )

            coordinator = _find_coordinator(hass, dev_id)
            if coordinator is not None and hasattr(coordinator, "async_apply_region"):
                await coordinator.async_apply_region()
            applied.append(dev_id)

        first = targets[0]
        return {
            "dev_id": first[0],
            "region": region.zone_name(first[1]),
            "ha_zone": str(hass.config.time_zone),
            "dev_ids": applied,
        }


    async def _handle_get_optional_charts(call: ServiceCall) -> dict[str, Any]:
        from . import lovelace  # noqa: PLC0415

        dev_id = _resolve_dev_id(hass, dict(call.data))
        if not is_inverter_dev_id(dev_id):
            raise vol.Invalid(f"Device {dev_id} has no optional charts")

        # ``{key: since}`` - the card only needs to know which keys are on, but
        # the instant is handed out as well so a caller can show when a curve
        # started.  The stored dashboard is the source of truth.
        charts = await lovelace.async_get_optional_charts(hass, dev_id)
        return {"dev_id": dev_id, "charts": dict(charts)}

    async def _handle_set_optional_charts(call: ServiceCall) -> dict[str, Any]:
        from . import lovelace  # noqa: PLC0415

        dev_id = _resolve_dev_id(hass, dict(call.data))
        if not is_inverter_dev_id(dev_id):
            raise vol.Invalid(f"Device {dev_id} has no optional charts")

        # Every key defaults to False, *not* to its current value: this service
        # is a whole-state write (the card sends all five every time), and a
        # default of "unchanged" would make it impossible to switch a chart
        # off by leaving its key out.
        charts = call.data.get("charts") or {}
        wanted = {key: bool(charts.get(key)) for key in lovelace.OPTIONAL_CHARTS}

        if not await lovelace.async_set_optional_charts(hass, dev_id, wanted):
            raise HomeAssistantError(
                f"The dashboard of {dev_id} could not be written"
            )
        return {"dev_id": dev_id, "charts": await lovelace.async_get_optional_charts(hass, dev_id)}

    hass.services.async_register(
        DOMAIN, SERVICE_SET_TOU_DAY_PLAN, _handle_set_tou_day_plan, SCHEMA_SET_TOU_DAY_PLAN
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_TOU_WEEK_PLAN, _handle_set_tou_week_plan, SCHEMA_SET_TOU_WEEK_PLAN
    )
    hass.services.async_register(
        DOMAIN, SERVICE_GET_TOU_PLAN, _handle_get_tou_plan, SCHEMA_GET_TOU_PLAN
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_EMS_MODE, _handle_set_ems_mode, SCHEMA_SET_EMS_MODE
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_PHASE_OUTPUT_POWER,
        _handle_set_phase_output_power,
        SCHEMA_SET_PHASE_OUTPUT_POWER,
    )
    hass.services.async_register(DOMAIN, SERVICE_REBOOT, _handle_reboot, SCHEMA_REBOOT)
    hass.services.async_register(
        DOMAIN,
        SERVICE_START_POWER_CTRL_KEEPALIVE,
        _handle_start_power_ctrl_keepalive,
        SCHEMA_START_POWER_CTRL_KEEPALIVE,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_STOP_POWER_CTRL_KEEPALIVE,
        _handle_stop_power_ctrl_keepalive,
        SCHEMA_STOP_POWER_CTRL_KEEPALIVE,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_OPTIONAL_CHARTS,
        _handle_get_optional_charts,
        SCHEMA_GET_OPTIONAL_CHARTS,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_OPTIONAL_CHARTS,
        _handle_set_optional_charts,
        SCHEMA_SET_OPTIONAL_CHARTS,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_REGION,
        _handle_get_region,
        SCHEMA_GET_REGION,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_REGION,
        _handle_set_region,
        SCHEMA_SET_REGION,
        supports_response=SupportsResponse.OPTIONAL,
    )
