"""Constants for the Hoymiles Micro Storage integration.

All MQTT topics follow《禾迈微储MQTT协议开发指南》V0.5.1.
``dev_id`` is ``"<client_prefix>-<SN>"`` (or just the SN when no prefix is set).
"""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "hoymiles"
MANUFACTURER: Final = "Hoymiles"
NAME: Final = "Hoymiles Micro Storage"

CONF_DEV_ID: Final = "dev_id"

PLATFORMS: Final = ["sensor", "binary_sensor"]

# ---------------------------------------------------------------------------
# Topic templates (device -> HA state, HA -> device command)
# ---------------------------------------------------------------------------
T_QUICK_STATE: Final = "homeassistant/sensor/{dev_id}/quick/state"
T_DEVICE_STATE: Final = "homeassistant/sensor/{dev_id}/device/state"
T_SYSTEM_STATE: Final = "homeassistant/sensor/{dev_id}/system/state"

T_EMS_MODE_CMD: Final = "homeassistant/select/{dev_id}/ems_mode/command"
T_SWITCH_SET: Final = "homeassistant/switch/{dev_id}/set"
T_REBOOT: Final = "homeassistant/button/{dev_id}/reboot/trigger"
T_POWER_CTRL_SET: Final = "homeassistant/number/{dev_id}/power_ctrl/set"
T_OUTPUT_POWER_SET: Final = "homeassistant/number/{dev_id}/output_power/set"

T_TOU_DAY_SET: Final = "homeassistant/sensor/{dev_id}/tou_day_plan/set"
T_TOU_WEEK_SET: Final = "homeassistant/sensor/{dev_id}/tou_week_plan/set"
T_TOU_GET: Final = "homeassistant/sensor/{dev_id}/tou_plan/get"
T_TOU_DAY_ACK: Final = "homeassistant/sensor/{dev_id}/tou_day_plan/ack"
T_TOU_WEEK_ACK: Final = "homeassistant/sensor/{dev_id}/tou_week_plan/ack"
T_TOU_STATUS: Final = "homeassistant/sensor/{dev_id}/tou_plan/status"

# Discovery topic used for auto-discovery in the config flow.
T_DISCOVERY: Final = "homeassistant/switch/+/config"

# ---------------------------------------------------------------------------
# EMS modes
# ---------------------------------------------------------------------------
EMS_MODE_GENERAL: Final = "general"
EMS_MODE_MQTT_CTRL: Final = "mqtt_ctrl"
EMS_MODE_TOU: Final = "tou_plan"
EMS_MODES: Final = [EMS_MODE_GENERAL, EMS_MODE_MQTT_CTRL, EMS_MODE_TOU]

# ---------------------------------------------------------------------------
# TOU limits (protocol §16)
# ---------------------------------------------------------------------------
TOU_DAY_IDX_MAX: Final = 8
TOU_PLAN_MAX: Final = 12
TOU_TS_MAX: Final = 96
TOU_SOC_MIN: Final = 10
TOU_SOC_MAX: Final = 100
TOU_POWER_MIN: Final = 100
TOU_TS_SLOT_MIN: Final = 15  # one slot == 15 minutes
TOU_MODES: Final = [1, 2, 4]
TOU_WEEKDAYS: Final = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# ---------------------------------------------------------------------------
# Coordinator data keys
# ---------------------------------------------------------------------------
SRC_QUICK: Final = "quick"
SRC_DEVICE: Final = "device"
SRC_SYSTEM: Final = "system"
SRC_TOU_STATUS: Final = "tou_status"
SRC_TOU_DAY_ACK: Final = "tou_day_ack"
SRC_TOU_WEEK_ACK: Final = "tou_week_ack"

# TOU ack status codes (protocol §17 / §19)
TOU_DAY_ACK_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "too many segments",
    3: "time range overlap",
    4: "mode out of range",
    5: "ts/te out of range",
    6: "sh/sl out of range",
    7: "pc/pd out of range",
    8: "day_idx out of range",
    9: "ts greater than te",
    10: "tou_plan not set",
}

TOU_WEEK_ACK_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "week out of range",
    3: "week overlap",
    4: "day_idx out of range",
    5: "day_idx not configured",
    6: "tou_plan not set",
}

TOU_GET_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "week out of range",
}

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
FRONTEND_URL: Final = "/hoymiles_static"

# Frontend assets bundled in ``www/`` and auto-injected as ES modules.
# Add new cards here; ``__init__._async_register_frontend`` walks this tuple.
CARD_FILENAME: Final = "hoymiles-tou-editor.js"
SANKEY_CARD_FILENAME: Final = "hoymiles-energy-sankey.js"
FRONTEND_ASSETS: Final = (CARD_FILENAME, SANKEY_CARD_FILENAME)

CARD_URL: Final = f"{FRONTEND_URL}/{CARD_FILENAME}"

# ---------------------------------------------------------------------------
# Sankey card defaults
# ---------------------------------------------------------------------------
# Statistics query period used by the energy sankey card.
SANKEY_PERIOD: Final = "day"
