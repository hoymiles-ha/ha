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
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from . import mqtt_util
from .const import (
    DOMAIN,
    T_EMS_MODE_CMD,
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

_LOGGER = logging.getLogger(__name__)

ATTR_DEV_ID = "dev_id"

SERVICE_SET_TOU_DAY_PLAN = "set_tou_day_plan"
SERVICE_SET_TOU_WEEK_PLAN = "set_tou_week_plan"
SERVICE_GET_TOU_PLAN = "get_tou_plan"
SERVICE_SET_EMS_MODE = "set_ems_mode"
SERVICE_REBOOT = "reboot"

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

    async def _handle_reboot(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_REBOOT, dev_id), "RESTART"
        )

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
    hass.services.async_register(DOMAIN, SERVICE_REBOOT, _handle_reboot, SCHEMA_REBOOT)
