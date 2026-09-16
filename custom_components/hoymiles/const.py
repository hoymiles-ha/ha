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

PLATFORMS: Final = ["sensor", "binary_sensor", "number"]

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
T_PHASE_OUTPUT_POWER_SET: Final = "homeassistant/number/{dev_id}/phase_output_power/set"

T_TOU_DAY_SET: Final = "homeassistant/sensor/{dev_id}/tou_day_plan/set"
T_TOU_WEEK_SET: Final = "homeassistant/sensor/{dev_id}/tou_week_plan/set"
T_TOU_GET: Final = "homeassistant/sensor/{dev_id}/tou_plan/get"
T_TOU_DAY_ACK: Final = "homeassistant/sensor/{dev_id}/tou_day_plan/ack"
T_TOU_WEEK_ACK: Final = "homeassistant/sensor/{dev_id}/tou_week_plan/ack"
T_TOU_STATUS: Final = "homeassistant/sensor/{dev_id}/tou_plan/status"

# Discovery topic used for auto-discovery in the config flow.
T_DISCOVERY: Final = "homeassistant/switch/+/config"

# ---------------------------------------------------------------------------
# Firmware discovery patching (see discovery_override.py)
# ---------------------------------------------------------------------------
DISCOVERY_PREFIX: Final = "homeassistant"

# Catches every discovery config the firmware publishes for one device.
#
# Two patterns are required because the discovery topic depth depends on the
# platform: the "node" level is only present when the payload addresses one
# specific object.
#   homeassistant/<component>/<dev_id>/config           e.g. switch
#   homeassistant/<component>/<dev_id>/<object>/config  e.g. sensor, number
FIRMWARE_DISCOVERY_TOPICS: Final = (
    "homeassistant/+/{dev_id}/config",
    "homeassistant/+/{dev_id}/+/config",
)

# Discovery objects an older firmware used to publish and the current one does
# not.  Their retained configs linger on the broker and Home Assistant rejects
# them on every start (``"mode": "textarea"`` is not a valid TextMode), so they
# are deleted on sight.
#
# Nothing is lost: the TOU plan is exposed through
# ``sensor/<dev_id>/tou_day_plan/set`` and ``sensor/<dev_id>/tou_week_plan/set``
# instead, and Home Assistant never managed to create entities for these
# payloads in the first place.
LEGACY_DISCOVERY_OBJECTS: Final = (
    "text/{dev_id}/tou_day1",
    "text/{dev_id}/tou_day2",
    "text/{dev_id}/tou_day3",
    "text/{dev_id}/tou_day4",
    "text/{dev_id}/tou_day5",
    "text/{dev_id}/tou_day6",
    "text/{dev_id}/tou_day7",
    "text/{dev_id}/tou_day8",
    "text/{dev_id}/tou_week_plan",
)

# Availability topic owned by the integration.  It is only referenced by the
# patched discovery payloads, so it never collides with firmware topics.
T_AVAILABILITY: Final = "hoymiles/{dev_id}/availability"
PAYLOAD_AVAILABLE: Final = "online"
PAYLOAD_NOT_AVAILABLE: Final = "offline"

# State topic owned by the integration for the EMS mode select.  The firmware
# select has no state_topic of its own, so it would read "unknown" after every
# HA restart.  This topic carries the last commanded value (retained) and is
# refined by the mode the device reports in ``system/state``.
#
# It cannot point at ``system/state`` directly: that topic is only pushed every
# 5 minutes, and the bundled TOU card gates its UI on the select state, so a
# freshly issued command would take up to 5 minutes to show up.
T_EMS_MODE_STATE: Final = "hoymiles/{dev_id}/ems_mode/state"

# ---------------------------------------------------------------------------
# Multi phase output power (protocol §8 command, §15 payload)
# ---------------------------------------------------------------------------
PHASE_A: Final = "phase_a"
PHASE_B: Final = "phase_b"
PHASE_C: Final = "phase_c"
PHASES: Final = (PHASE_A, PHASE_B, PHASE_C)
PHASE_POWER_MIN: Final = 100
PHASE_POWER_MAX: Final = 2500
PHASE_POWER_STEP: Final = 1

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

# ---------------------------------------------------------------------------
# Availability / staleness (protocol §22 pushes every 1 s, §23/§24 every 5 min)
# ---------------------------------------------------------------------------
# How often the availability watchdog re-evaluates source freshness.
AVAILABILITY_WATCHDOG_SECONDS: Final = 30

# A ``system/state`` report arriving right after an EMS mode command may still
# carry the previous mode (the topic is only pushed every 5 minutes).  Such
# reports are ignored for this long so the select does not flip back.
EMS_MODE_ECHO_GUARD_SECONDS: Final = 30

# A source is alive while its last message is younger than its window.
# Event driven topics (TOU ack/status) are excluded on purpose.
SOURCE_STALE_SECONDS: Final = {
    SRC_QUICK: 120,
    SRC_DEVICE: 660,
    SRC_SYSTEM: 660,
}

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
