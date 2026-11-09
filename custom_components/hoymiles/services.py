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
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from . import mqtt_util
from .const import (
    DOMAIN,
    PHASE_A,
    PHASE_B,
    PHASE_C,
    PHASE_POWER_MAX,
    PHASE_POWER_MIN,
    POWER_CTRL_MAX,
    POWER_CTRL_MIN,
    POWER_CTRL_REPEAT_DEFAULT_S,
    POWER_CTRL_REPEAT_MAX_S,
    POWER_CTRL_REPEAT_MIN_S,
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
)
from .dashboard import RESULT_UNAVAILABLE, async_create_device_dashboard
from .power_repeat import get_manager as get_repeat_manager

_LOGGER = logging.getLogger(__name__)

ATTR_DEV_ID = "dev_id"

SERVICE_SET_TOU_DAY_PLAN = "set_tou_day_plan"
SERVICE_SET_TOU_WEEK_PLAN = "set_tou_week_plan"
SERVICE_GET_TOU_PLAN = "get_tou_plan"
SERVICE_SET_EMS_MODE = "set_ems_mode"
SERVICE_SET_PHASE_OUTPUT_POWER = "set_phase_output_power"
SERVICE_REBOOT = "reboot"
SERVICE_CREATE_DASHBOARD = "create_dashboard"
SERVICE_SET_POWER_CTRL = "set_power_ctrl"
SERVICE_STOP_POWER_CTRL = "stop_power_ctrl"
SERVICE_GET_POWER_CTRL = "get_power_ctrl"

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

# ``overwrite`` rebuilds the bundled layout over an existing dashboard; without
# it an existing dashboard (and every edit made to it) is left untouched.
SCHEMA_CREATE_DASHBOARD = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Optional("overwrite", default=False): cv.boolean,
    }
)

_PHASE_POWER = vol.All(
    vol.Coerce(int), vol.Range(min=PHASE_POWER_MIN, max=PHASE_POWER_MAX)
)

# The setpoint is a lease the firmware renews only while it keeps arriving, so
# the service always carries the repeat interval - there is no "send once"
# flavour of it here.  A raw one-off publish is still what `mqtt.publish` is.
SCHEMA_SET_POWER_CTRL = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("value"): vol.All(
            vol.Coerce(int), vol.Range(min=POWER_CTRL_MIN, max=POWER_CTRL_MAX)
        ),
        vol.Optional(
            "interval", default=POWER_CTRL_REPEAT_DEFAULT_S
        ): vol.All(
            vol.Coerce(int),
            vol.Range(min=POWER_CTRL_REPEAT_MIN_S, max=POWER_CTRL_REPEAT_MAX_S),
        ),
    }
)

SCHEMA_POWER_CTRL_ONLY = vol.Schema({**DEVICE_FIELDS})

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


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration services once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_services_registered"):
        return
    domain_data["_services_registered"] = True

    async def _handle_set_tou_day_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
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
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_GET, dev_id), {"week": call.data["week"]}
        )

    async def _handle_set_ems_mode(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_EMS_MODE_CMD, dev_id), str(call.data["mode"])
        )

    async def _handle_set_phase_output_power(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
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
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_REBOOT, dev_id), "RESTART"
        )

    async def _handle_create_dashboard(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        result = await async_create_device_dashboard(
            hass, dev_id, overwrite=bool(call.data.get("overwrite", False))
        )
        if result == RESULT_UNAVAILABLE:
            _LOGGER.warning("Could not create a dashboard for %s", dev_id)
        else:
            _LOGGER.info("Dashboard for %s: %s", dev_id, result)

    async def _handle_set_power_ctrl(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await get_repeat_manager(hass).async_start(
            dev_id, int(call.data["value"]), int(call.data["interval"])
        )

    async def _handle_stop_power_ctrl(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await get_repeat_manager(hass).async_stop(dev_id)

    async def _handle_get_power_ctrl(call: ServiceCall) -> dict[str, Any]:
        """Report the running job so a freshly opened card can restore itself."""
        dev_id = _resolve_dev_id(hass, dict(call.data))
        return get_repeat_manager(hass).snapshot(dev_id)

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
        SERVICE_CREATE_DASHBOARD,
        _handle_create_dashboard,
        SCHEMA_CREATE_DASHBOARD,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_POWER_CTRL,
        _handle_set_power_ctrl,
        SCHEMA_SET_POWER_CTRL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_STOP_POWER_CTRL,
        _handle_stop_power_ctrl,
        SCHEMA_POWER_CTRL_ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_POWER_CTRL,
        _handle_get_power_ctrl,
        SCHEMA_POWER_CTRL_ONLY,
        supports_response=SupportsResponse.ONLY,
    )
