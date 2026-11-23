"""Constants for the micro inverter family of the Hoymiles integration.

Everything here belongs to the grid-tied HiFlow micro inverters (PID ``1650`` /
``4160`` / ``4161`` / ``4162``).  It is a subpackage of the storage integration on
purpose: the two families share the MQTT transport and nothing else, so the
inverter code lives in its own namespace and is only imported when a config entry
carries an inverter PID (see ``const.device_family`` in the parent package).

All MQTT topics follow《禾迈微储MQTT协议开发指南》V0.5.1.
``dev_id`` is ``"<client_prefix>-<SN>"`` (or just the SN when no prefix is set).
"""

from __future__ import annotations

from typing import Final

# The domain is the *integration's* domain, not the subpackage's: entities,
# devices, services and the ``hass.data`` bucket all belong to the one integration
# the user installed.  The PID, not the import path, decides which code path runs.
# This is the standalone ``hoymiles_g2`` package, so the symbols the
# subpackage version re-exported from its parent package are defined below,
# lifted verbatim from this package's own history.
DOMAIN: Final = "hoymiles_g2"
# Was re-exported from the parent package; the standalone package owns it.
CONF_CREATE_DASHBOARD: Final = "create_dashboard"

MANUFACTURER: Final = "Hoymiles"
NAME: Final = "Hoymiles MS-G2"

CONF_DEV_ID: Final = "dev_id"

# ---------------------------------------------------------------------------
# Region / time zone
# ---------------------------------------------------------------------------
# The unit has no clock this integration can read, and Home Assistant's own
# time zone describes where the *server* runs, not where the roof is.  A unit
# installed two time zones away from its Home Assistant therefore rolls its own
# 「今日」 counters over at a midnight nobody on this side can see, and every
# timestamp the cards print is off by the same offset.
#
# The choice lives in the config entry's **options** (one per device, not one per
# browser) because the coordinator needs it: deciding that an outage crossed
# midnight is a comparison of calendar *days*, and the day has to be the day at
# the roof.  The toolbar switch only writes it; see
# ``inverter/www/hoymiles-g2-region.js`` and the ``set_region`` service.
CONF_REGION: Final = "region"
# Empty means "follow the Home Assistant installation's time zone", which is what
# every entry that predates this option gets - and the right answer for the
# common case of a unit on the same premises as Home Assistant.
DEFAULT_REGION: Final = ""

# The regions the toolbar offers, as ``(IANA name, English label, 中文标签)``.
#
# Deliberately a fixed list rather than every zone of the tz database: the list
# is what a dropdown can show, and these are the markets the firmware ships to.
# A zone outside it can still be set through the service / the options flow,
# which validates against ``zoneinfo`` rather than against this tuple - the list
# is a convenience, not the contract.
REGION_CHOICES: Final = (
    ("Asia/Shanghai", "China (UTC+8)", "中国 (UTC+8)"),
    ("Asia/Hong_Kong", "Hong Kong (UTC+8)", "香港 (UTC+8)"),
    ("Asia/Taipei", "Taiwan (UTC+8)", "台湾 (UTC+8)"),
    ("Asia/Tokyo", "Japan (UTC+9)", "日本 (UTC+9)"),
    ("Asia/Seoul", "Korea (UTC+9)", "韩国 (UTC+9)"),
    ("Asia/Singapore", "Singapore (UTC+8)", "新加坡 (UTC+8)"),
    ("Asia/Bangkok", "Thailand (UTC+7)", "泰国 (UTC+7)"),
    ("Asia/Jakarta", "Indonesia (UTC+7)", "印尼 (UTC+7)"),
    ("Asia/Kolkata", "India (UTC+5:30)", "印度 (UTC+5:30)"),
    ("Asia/Dubai", "UAE (UTC+4)", "阿联酋 (UTC+4)"),
    ("Australia/Sydney", "Australia East (UTC+10/11)", "澳洲东部 (UTC+10/11)"),
    ("Australia/Perth", "Australia West (UTC+8)", "澳洲西部 (UTC+8)"),
    ("Europe/London", "United Kingdom (UTC+0/1)", "英国 (UTC+0/1)"),
    ("Europe/Berlin", "Germany (UTC+1/2)", "德国 (UTC+1/2)"),
    ("Europe/Amsterdam", "Netherlands (UTC+1/2)", "荷兰 (UTC+1/2)"),
    ("Europe/Madrid", "Spain (UTC+1/2)", "西班牙 (UTC+1/2)"),
    ("Europe/Rome", "Italy (UTC+1/2)", "意大利 (UTC+1/2)"),
    ("Europe/Warsaw", "Poland (UTC+1/2)", "波兰 (UTC+1/2)"),
    ("Europe/Athens", "Greece (UTC+2/3)", "希腊 (UTC+2/3)"),
    ("America/New_York", "US Eastern (UTC-5/-4)", "美国东部 (UTC-5/-4)"),
    ("America/Chicago", "US Central (UTC-6/-5)", "美国中部 (UTC-6/-5)"),
    ("America/Denver", "US Mountain (UTC-7/-6)", "美国山地 (UTC-7/-6)"),
    ("America/Los_Angeles", "US Pacific (UTC-8/-7)", "美国太平洋 (UTC-8/-7)"),
    ("America/Sao_Paulo", "Brazil (UTC-3)", "巴西 (UTC-3)"),
    ("Africa/Johannesburg", "South Africa (UTC+2)", "南非 (UTC+2)"),
)

PLATFORMS: Final = ["sensor", "binary_sensor", "number"]

# ---------------------------------------------------------------------------
# Topic templates (device -> HA state, HA -> device command)
# ---------------------------------------------------------------------------
T_QUICK_STATE: Final = "homeassistant/sensor/{dev_id}/quick/state"
T_DEVICE_STATE: Final = "homeassistant/sensor/{dev_id}/device/state"
T_SYSTEM_STATE: Final = "homeassistant/sensor/{dev_id}/system/state"
# Only published by micro inverters (HiFlow / RMI-).  Never seen on a storage
# unit, and the payload shape is not documented in the protocol guide.
T_ALARM_STATE: Final = "homeassistant/sensor/{dev_id}/alarm/state"
# Retained ``{"supported_topics": {...}}`` inventory the firmware publishes on
# connect.  It is the only reliable way to tell which topics a given model
# actually implements, see ``CAPABILITIES`` below.
T_ATTRIBUTES: Final = "homeassistant/sensor/{dev_id}/attributes"
# Protocol §32 「状态事件」: the unit's role in the system plus the flags that
# describe the whole installation.  Published right after the connection is up
# and then only when something changes, so it is event driven, not a heartbeat.
T_EVENT_STATE: Final = "homeassistant/sensor/{dev_id}/event/state"

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

# Liveness wildcard used by the config flow.  ``quick/state`` is pushed once a
# second while the device is connected, so it - unlike the retained discovery
# configs - tells a currently reachable device apart from a stale one.
T_QUICK_WILDCARD: Final = "homeassistant/sensor/+/quick/state"

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

# Broadcast topic the firmware subscribes to ("HA online notice", protocol §2).
# Reading ``online`` is what makes a device rebuild its discovery payloads and
# re-publish its own MQTT/MQTTS topics for this round; ``offline`` means Home
# Assistant is going away and may be ignored.  Every device family - storage and
# inverter alike - subscribes to it, so the topic carries no device id.
#
# Home Assistant publishes this itself when its MQTT integration starts, but a
# device that was unreachable at that moment has missed it until the next
# restart.  Sending it once per config-entry setup closes that window.
T_HA_STATUS: Final = "homeassistant/status"

# State topic owned by the integration for the EMS mode select.  The firmware
# select has no state_topic of its own, so it would read "unknown" after every
# HA restart.  This topic carries the last commanded value (retained) and is
# refined by the mode the device reports in ``system/state``.
#
# It cannot point at ``system/state`` directly: that topic is only pushed every
# 5 minutes, and the bundled TOU card gates its UI on the select state, so a
# freshly issued command would take up to 5 minutes to show up.
T_EMS_MODE_STATE: Final = "hoymiles/{dev_id}/ems_mode/state"

# Running state of the power-control keep-alive (see keepalive.py), retained so
# a dashboard reload reads the truth instead of guessing from a local timer.
T_POWER_CTRL_KEEPALIVE: Final = "hoymiles/{dev_id}/power_ctrl/keepalive"

# Period bounds for the keep-alive.  ``power_ctrl`` is a lease the firmware drops
# after roughly 60 s, so the floor is short enough to stay well inside it and the
# ceiling is only a guard against a typo; the default sits comfortably between.
POWER_CTRL_KEEPALIVE_MIN_S: Final = 5
POWER_CTRL_KEEPALIVE_MAX_S: Final = 3600
POWER_CTRL_KEEPALIVE_DEFAULT_S: Final = 30
# The firmware's own hold time, used for user facing hints only.
POWER_CTRL_LEASE_SECONDS: Final = 60

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
SRC_ALARM: Final = "alarm"
# Integration-owned, not a device topic: the running state of the power-control
# keep-alive, so an entity can expose it to dashboards and automations.
SRC_KEEPALIVE: Final = "keepalive"
# Protocol §32 「状态事件」.
SRC_EVENT: Final = "event"

# ---------------------------------------------------------------------------
# System role (protocol §32 「状态事件」 -> ``role``)
# ---------------------------------------------------------------------------
# ``single``  - a stand-alone unit.  It owns the meter and the smart plug itself,
#               so its ``system/*`` view is complete.
# ``master``  - the head of a master/slave pair.  It reads the meter on behalf
#               of the whole installation, so its ``system/*`` view is complete
#               too and it looks exactly like a ``single`` unit to a card.
# ``slave``   - a follower.  ``has_meter`` / ``has_plug`` / ``has_solar2`` are
#               all ``false`` for it by definition (the protocol marks them
#               「从机不支持」), the firmware publishes no usable ``sys_*``
#               aggregates, and only its own ``device/*`` readings can be drawn.
ROLE_SINGLE: Final = "single"
ROLE_MASTER: Final = "master"
ROLE_SLAVE: Final = "slave"
ROLES: Final = (ROLE_SINGLE, ROLE_MASTER, ROLE_SLAVE)
# Spellings seen in the field for the follower role.  The protocol guide says
# ``slave``; at least one build publishes ``servant``.  Both are normalised to
# ``ROLE_SLAVE`` in one place (``HoymilesCoordinator.role``) so no consumer ever
# has to know about the alias.
ROLE_ALIASES: Final = {"servant": ROLE_SLAVE}

# ---------------------------------------------------------------------------
# Device capabilities
# ---------------------------------------------------------------------------
# The firmware's model names are not a contract, and two products share this
# protocol: a micro storage unit (MSA-, "HiBattery 4020 X") and a micro inverter
# (RMI-, "HiFlow").  Gating on a model string would break as soon as a new SKU
# appears, so the retained ``attributes`` payload is used instead: it declares
# exactly which topics the firmware implements.
#
#   storage unit : quick, device, system, tou_day_plan, tou_get, tou_week_plan,
#                  switch_ctrl, ems_mode, power_ctrl, output_power, reboot
#   micro inverter: quick, device, alarm_state, switch_ctrl, ems_mode,
#                  power_ctrl, output_power, reboot, factory_reset,
#                  reset_ble_pin_code
#
# A capability is therefore "the firmware publishes this topic", established by
# either of two witnesses - everything the inverter lacks (battery, packs,
# system level energy, TOU) falls out of that:
#
#   declared  the retained ``attributes`` inventory, plus every discovery object
#             the firmware publishes for itself (``discovery_override.py``)
#   observed  a state topic that actually delivered a message (see
#             ``SOURCE_CAPABILITY``)
#
# Both are retained on the broker, so an offline device keeps exactly the entity
# set of its last connection.  No local persistence is needed: the broker is the
# store.
CAP_QUICK_STATE: Final = "quick_state"
CAP_DEVICE_STATE: Final = "device_state"
CAP_SYSTEM_STATE: Final = "system_state"
CAP_ALARM_STATE: Final = "alarm_state"
CAP_EVENT_STATE: Final = "event_state"
CAP_TOU: Final = "tou_get"
# Not a ``supported_topics`` entry: the multi phase output limit is only visible
# as its own discovery object, so ``discovery_override.py`` reports it instead.
CAP_PHASE_OUTPUT: Final = "phase_output_power"

# Capabilities that only gate *commands*, never entity creation: the firmware
# registers its own entities for them through MQTT discovery.  They still have
# to be tracked, because publishing to a topic a device never announced looks
# exactly like a successful call while nothing happens - see ``services.py``.
#
# The name is what both carriers use: the ``supported_topics`` key *and* the
# discovery object name (``button/<dev_id>/reboot`` -> ``reboot``).
CAP_SWITCH: Final = "switch_ctrl"
CAP_EMS_MODE: Final = "ems_mode"
CAP_POWER_CTRL: Final = "power_ctrl"
CAP_OUTPUT_POWER: Final = "output_power"
CAP_REBOOT: Final = "reboot"
CAP_FACTORY_RESET: Final = "factory_reset"
CAP_RESET_BLE_PIN: Final = "reset_ble_pin_code"
CAP_TOU_DAY_PLAN: Final = "tou_day_plan"
CAP_TOU_WEEK_PLAN: Final = "tou_week_plan"

# The capability a received *state* topic proves.
#
# This is the second, independent half of the capability set.  The retained
# ``attributes`` inventory is what the firmware *says* it implements; a message
# that actually lands is what it *does*.  Recording both means
#
#   * a device whose inventory is missing from the broker still grows the
#     entities for every topic it demonstrably publishes, and
#   * a topic it never publishes is never assumed, so nothing extra appears on
#     the page (the reported problem: a micro inverter that only talks MQTTS
#     publishes a strictly smaller topic set, yet used to get the storage and
#     TOU entities as well).
#
# Deliberately no default: an empty set means "nothing known", not "everything".
SOURCE_CAPABILITY: Final = {
    SRC_QUICK: CAP_QUICK_STATE,
    SRC_DEVICE: CAP_DEVICE_STATE,
    SRC_SYSTEM: CAP_SYSTEM_STATE,
    SRC_ALARM: CAP_ALARM_STATE,
    SRC_EVENT: CAP_EVENT_STATE,
    SRC_TOU_STATUS: CAP_TOU,
    SRC_TOU_DAY_ACK: CAP_TOU_DAY_PLAN,
    SRC_TOU_WEEK_ACK: CAP_TOU_WEEK_PLAN,
}

# ---------------------------------------------------------------------------
# PV input count
# ---------------------------------------------------------------------------
# ``PID_PV_COUNT``, ``INVERTER_PIDS``, ``STORAGE_PIDS``, ``KNOWN_PIDS``,
# ``PV_COUNT_BY_CODE``, ``PV_COUNT_MAX`` and the ``serial_pid`` /
# ``is_inverter_dev_id`` / ``pv_count_from_dev_id`` helpers are imported from
# the parent package: the PID model is what decides *which* code path serves a
# device, so it has to live where the dispatch happens.  Re-exported here
# because every module below spells ``from .const import ...``.

# Mirrors ``IV_PV_COUNT_BY_CODE`` in ``www/hoymiles-g2-power-flow.js``; keep
# both tables in sync (see ``docs/hoymiles_g2-hiflow.md``).
PID_PV_COUNT: Final[dict[str, int]] = {
    "1650": 1,  # HiFlow, single input
    "4160": 1,  # HiFlow Pro 1-in-1
    "4161": 2,  # HiFlow Pro 2-in-1
    "4162": 4,  # HiFlow Pro 4-in-1
}
# Every PID above is a grid-tied micro inverter.  Storage units carry a
# different PID and are recognised by *not* being in this set - the firmware
# reports their port count as ``pv_num`` instead.  ``2800`` is the only storage
# PID seen in the field (``MSA-2800...``); a unit with an unlisted PID can still
# be added by typing its serial, because the config flow accepts custom values.
INVERTER_PIDS: Final[frozenset[str]] = frozenset(PID_PV_COUNT)
STORAGE_PIDS: Final[frozenset[str]] = frozenset({"2800"})
# What the config flow will offer on its own.  Deliberately a closed set: the
# discovery wildcard also matches unrelated devices that publish under
# ``homeassistant/``, and offering those would be noise in the picker.
KNOWN_PIDS: Final[frozenset[str]] = INVERTER_PIDS | STORAGE_PIDS
# Storage units do not publish a fixed port count in their serial; the firmware
# reports ``pv_num`` instead.  Four is the documented maximum, so it is used as
# the default whenever the count cannot be derived up front.
PV_COUNT_MAX: Final = 4

# Kept under its old name because the cards' JS mirrors this table and the docs
# refer to it; it is the same mapping as :data:`PID_PV_COUNT`.
PV_COUNT_BY_CODE: Final[dict[str, int]] = PID_PV_COUNT


def serial_body(dev_id: str) -> str:
    """Return the serial without its (user changeable) client prefix.

    ``RMI-4161A0209FF6`` -> ``"4161A0209FF6"``, and a bare ``4161A0209FF6`` is
    returned unchanged.  Splitting on ``-`` and keeping the last part survives
    any prefix the user configures, including one that itself contains ``-``.
    """
    return dev_id.split("-")[-1].strip()


def serial_pid(dev_id: str) -> str | None:
    """Return the four digit product id at the start of the serial, if any.

    ``RMI-4161A0209FF6`` -> ``"4161"`` and ``MSA-280024180016`` -> ``"2800"``.
    The prefix plays no part: only the serial body is inspected.
    """
    digits = serial_body(dev_id)[:4]
    if len(digits) != 4 or not digits.isdigit():
        return None
    return digits


def is_inverter_dev_id(dev_id: str) -> bool:
    """True when this serial belongs to a grid-tied micro inverter.

    Recognition is by PID, so it works for any client prefix the user chooses.
    A serial whose PID is unknown is treated as storage, which is the
    conservative answer: storage layouts never draw a PV port the unit lacks.
    """
    pid = serial_pid(dev_id)
    return pid is not None and pid in INVERTER_PIDS


def pv_count_from_dev_id(dev_id: str) -> int | None:
    """Return how many PV inputs this unit has, or ``None`` when unknown.

    ``RMI-4161A0209FF6`` -> ``"4161"`` -> ``2``.  A serial that is not a known
    inverter PID returns ``None`` so the caller can fall back to the firmware's
    own ``pv_num`` or to the maximum.
    """
    pid = serial_pid(dev_id)
    if pid is None:
        return None
    return PID_PV_COUNT.get(pid)


# ---------------------------------------------------------------------------
# Product family
# ---------------------------------------------------------------------------
# Only a fallback - the firmware's own discovery carries a precise model string
# (``HiFlow Pro``) which the coordinator prefers when it can find one.
#
# This is keyed by **PID**, not by the serial prefix.  The prefix is a user
# setting (see the PID block above), so ``MODEL_BY_PREFIX`` could only ever
# recognise the default spelling; a device renamed to ``GARAGE-4161...`` would
# have lost its model entirely.  ``inverter`` / ``storage`` are used because the
# PID set only distinguishes those two families.
MODEL_BY_FAMILY: Final[dict[str, str]] = {
    "inverter": "HiFlow",
    "storage": "HiBattery",
}


def model_from_dev_id(dev_id: str) -> str | None:
    """Return the product family implied by the serial's PID, if known."""
    pid = serial_pid(dev_id)
    if pid is None:
        # Unknown PID: the serial is not one we can classify, so claim nothing
        # rather than guessing a family from a prefix the user controls.
        return None
    return MODEL_BY_FAMILY["inverter" if pid in INVERTER_PIDS else "storage"]

# ---------------------------------------------------------------------------
# Availability / staleness (protocol §22 pushes every 1 s, §23/§24 every 5 min)
# ---------------------------------------------------------------------------
# How often the availability watchdog re-evaluates source freshness.  Short
# against the one minute window below, so a disconnected device is noticed
# between 60 and 75 seconds after its last message instead of up to 90.
AVAILABILITY_WATCHDOG_SECONDS: Final = 15

# A ``system/state`` report arriving right after an EMS mode command may still
# carry the previous mode (the topic is only pushed every 5 minutes).  Such
# reports are ignored for this long so the select does not flip back.
EMS_MODE_ECHO_GUARD_SECONDS: Final = 30

# One minute without a per-second ``quick/state`` frame means the device is not
# talking to the broker any more.
QUICK_STALE_SECONDS: Final = 60

# How long a freshly set up entry may wait for its first ``quick/state`` before
# the retained ``online`` it inherited from the previous run is distrusted.
# Without this a device that was already unplugged when Home Assistant started
# would keep the retained verdict forever, because nothing ever contradicts it.
AVAILABILITY_STARTUP_GRACE_SECONDS: Final = 90

# A source is alive while its last message is younger than its window.
# Event driven topics (TOU ack/status, and ``event/state`` which is only pushed
# on connect and on change) are excluded on purpose: giving them a window would
# declare a healthy device offline the moment nothing changed for long enough.
#
# Only ``quick/state`` is listed: it is the sole proof of life, because it is
# pushed once a second.  ``device/state`` and ``system/state`` arrive every five
# minutes, so any window over them has to be generous - and 11 minutes over them
# was exactly what kept an unplugged device looking online.
SOURCE_STALE_SECONDS: Final = {
    SRC_QUICK: QUICK_STALE_SECONDS,
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

# ---------------------------------------------------------------------------
# Alarms (protocol §27)
# ---------------------------------------------------------------------------
# ``alarm/state`` carries the complete list of alarms that have not ended yet:
#
#   {"alarm": [{"code": "141", "time": "26-01-01 20:20"}], "alarm_num": 1}
#
# Two things about it are easy to get wrong and are handled by the sensor:
#
#   - the topic is **not retained** and is only published when the list changes,
#     so after a Home Assistant restart the entity has nothing to read until the
#     next alarm fires - possibly for days;
#   - the code arrives as a **string**, and the same number means different
#     things on a storage unit and on a micro inverter.
#
# Only a micro inverter declares ``alarm_state`` in its ``supported_topics``
# inventory (verified live on RMI-4161 and RMI-1650), so the inverter appendix
# below is the one that applies.  A code that is not listed is shown as its raw
# number rather than being dropped or guessed.
ALARM_MAX: Final = 20

ALARM_CODES: Final = {
    121: "Over Temperature Protection",
    123: "Standby Mode Enabled by Remote Control",
    125: "Grid Configuration Parameter Error",
    127: "Firmware Error",
    128: "Hardware Configuration Information Error",
    130: "Offline",
    141: "Grid Overvoltage",
    142: "Grid Overvoltage (10 Min Mean Value)",
    143: "Grid Undervoltage",
    144: "Grid Overfrequency",
    145: "Grid Underfrequency",
    146: "High RoCoF",
    147: "No Voltage on Grid Port",
    148: "Grid Disconnection",
    149: "Island Detected",
    151: "Severe Grid Wave Distortion",
    181: "Abnormal Insulation Impedance",
    183: "Abnormal Relay",
    184: "Abnormal Input Paralleling Wiring",
    205: "MPPT-A Input Overvoltage",
    206: "MPPT-B Input Overvoltage",
    207: "MPPT-A Input Undervoltage",
    208: "MPPT-B Input Undervoltage",
    209: "PV1 No Input",
    210: "PV2 No Input",
    211: "PV3 No Input",
    212: "PV4 No Input",
    213: "PV1 & PV2 Abnormal Wiring",
    214: "PV3 & PV4 Abnormal Wiring",
    215: "PV1 Input Overvoltage",
    216: "PV1 Input Undervoltage",
    217: "PV2 Input Overvoltage",
    218: "PV2 Input Undervoltage",
    219: "PV3 Input Overvoltage",
    220: "PV3 Input Undervoltage",
    221: "PV4 Input Overvoltage",
    222: "PV4 Input Undervoltage",
    229: "Relay Inner Side Overvoltage",
    231: "PV1 Arcing Fault",
    232: "PV2 Arcing Fault",
    233: "PV3 Arcing Fault",
    234: "PV4 Arcing Fault",
    241: "PV Input Wiring Abnormality: PV1 Reverse Connection",
    242: "PV Input Wiring Abnormality: PV2 Reverse Connection",
    243: "PV Input Wiring Abnormality: Cross Connection Case 1",
    244: "PV Input Wiring Abnormality: Cross Connection Case 2",
    301: "Hardware Error Code 301",
    302: "Hardware Error Code 302",
    303: "Hardware Error Code 303",
    304: "Hardware Error Code 304",
    305: "Hardware Error Code 305",
    306: "Hardware Error Code 306",
    307: "Hardware Error Code 307",
    308: "Hardware Error Code 308",
    309: "Hardware Error Code 309",
    310: "Hardware Error Code 310",
    311: "Hardware Error Code 311",
    312: "Hardware Error Code 312",
    313: "Hardware Error Code 313",
    314: "Hardware Error Code 314",
    316: "BOOSTA Internal Short Circuit Failure",
    317: "BOOSTB Internal Short Circuit Failure",
    318: "BOOSTA Overcurrent Protection Failure",
    319: "BOOSTB Overcurrent Protection Failure",
    320: "BOOSTC Internal Short Circuit Failure",
    321: "BOOSTD Internal Short Circuit Failure",
    322: "BOOSTC Overcurrent Protection Failure",
    323: "BOOSTD Overcurrent Protection Failure",
    324: "Arcing Lock-Up",
    413: "Software Version Mismatch",
    414: "Abnormal Master-Slave System Configuration",
    415: "Sys File Abnormal",
}

# The same table in Chinese, keyed by the same code.
#
# Kept as a parallel dict rather than as a ``{code: (en, zh)}`` mapping so the
# English table above stays byte-identical to the protocol appendix - that is
# the text support quotes back and the string a web search matches.  A code
# missing here falls back to English alone, so a partially translated release
# degrades to the old single-language list instead of printing an empty name.
ALARM_CODES_ZH: Final = {
    121: "过温保护",
    123: "远程控制开启待机模式",
    125: "电网配置参数错误",
    127: "固件错误",
    128: "硬件配置信息错误",
    130: "离线",
    141: "电网过压",
    142: "电网过压（10 分钟平均值）",
    143: "电网欠压",
    144: "电网过频",
    145: "电网欠频",
    146: "频率变化率（RoCoF）超限",
    147: "并网端口无电压",
    148: "电网断开",
    149: "检测到孤岛",
    151: "电网波形严重畸变",
    181: "绝缘阻抗异常",
    183: "继电器异常",
    184: "输入并联接线异常",
    205: "MPPT-A 输入过压",
    206: "MPPT-B 输入过压",
    207: "MPPT-A 输入欠压",
    208: "MPPT-B 输入欠压",
    209: "PV1 无输入",
    210: "PV2 无输入",
    211: "PV3 无输入",
    212: "PV4 无输入",
    213: "PV1 与 PV2 接线异常",
    214: "PV3 与 PV4 接线异常",
    215: "PV1 输入过压",
    216: "PV1 输入欠压",
    217: "PV2 输入过压",
    218: "PV2 输入欠压",
    219: "PV3 输入过压",
    220: "PV3 输入欠压",
    221: "PV4 输入过压",
    222: "PV4 输入欠压",
    229: "继电器内侧过压",
    231: "PV1 电弧故障",
    232: "PV2 电弧故障",
    233: "PV3 电弧故障",
    234: "PV4 电弧故障",
    241: "PV 输入接线异常：PV1 反接",
    242: "PV 输入接线异常：PV2 反接",
    243: "PV 输入接线异常：交叉接线情况 1",
    244: "PV 输入接线异常：交叉接线情况 2",
    301: "硬件错误码 301",
    302: "硬件错误码 302",
    303: "硬件错误码 303",
    304: "硬件错误码 304",
    305: "硬件错误码 305",
    306: "硬件错误码 306",
    307: "硬件错误码 307",
    308: "硬件错误码 308",
    309: "硬件错误码 309",
    310: "硬件错误码 310",
    311: "硬件错误码 311",
    312: "硬件错误码 312",
    313: "硬件错误码 313",
    314: "硬件错误码 314",
    316: "BOOSTA 内部短路故障",
    317: "BOOSTB 内部短路故障",
    318: "BOOSTA 过流保护故障",
    319: "BOOSTB 过流保护故障",
    320: "BOOSTC 内部短路故障",
    321: "BOOSTD 内部短路故障",
    322: "BOOSTC 过流保护故障",
    323: "BOOSTD 过流保护故障",
    324: "电弧锁定",
    413: "软件版本不匹配",
    414: "主从系统配置异常",
    415: "系统文件异常",
}

# Codes the document describes as a family rather than as one number.  Each
# entry carries both names, because the range and the single code are decoded by
# the same two lookups in ``sensor.alarm_name`` / ``sensor.alarm_name_zh``.
ALARM_CODE_RANGES: Final = (
    (400, 409, "Smart Device Offline", "智能设备离线"),
    (420, 429, "Sys Comm Abnormal", "系统通信异常"),
    (1055, 1056, "Fan Abnormal", "风扇异常"),
    (1511, 1520, "Sys Comm Abnormal", "系统通信异常"),
    (2101, 2110, "Smart Device Offline", "智能设备离线"),
)

TOU_GET_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "week out of range",
}

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
FRONTEND_URL: Final = "/hoymiles_g2_static"

# Frontend assets bundled in ``www/`` and auto-injected as ES modules.
# Add new cards here; ``__init__._async_register_frontend`` walks this tuple.
#
# ``I18N_CARD_FILENAME`` is first on purpose: it defines ``window.HoymilesG2I18n``
# and every card below resolves its language through it, so the module must be
# evaluated before the cards are defined.
I18N_CARD_FILENAME: Final = "hoymiles-g2-i18n.js"
CARD_FILENAME: Final = "hoymiles-g2-tou-editor.js"
SANKEY_CARD_FILENAME: Final = "hoymiles-g2-energy-sankey.js"
POWER_FLOW_CARD_FILENAME: Final = "hoymiles-g2-power-flow.js"
BATTERY_CARD_FILENAME: Final = "hoymiles-g2-battery.js"
HISTORY_CHART_CARD_FILENAME: Final = "hoymiles-g2-history-chart.js"
GAUGE_CARD_FILENAME: Final = "hoymiles-g2-gauge.js"
CONTROL_CARD_FILENAME: Final = "hoymiles-g2-control.js"
PACK_LIST_CARD_FILENAME: Final = "hoymiles-g2-pack-list.js"
ALARM_CARD_FILENAME: Final = "hoymiles-g2-alarm.js"
# The five opt-in curves of the Device view, switchable from that page itself.
CHART_OPTIONS_CARD_FILENAME: Final = "hoymiles-g2-chart-options.js"
# The region (time zone) switch of the toolbar.  Toolkit-level rather than a
# card: it decides which calendar day the backend calls "today", so it has to
# be reachable from every dashboard, and its value lives in the config entry's
# options rather than in ``localStorage``.  See ``region.py``.
REGION_SWITCH_FILENAME: Final = "hoymiles-g2-region.js"
# The language switch of the micro-inverter dashboards.  A separate control from
# the region one on purpose: the language is a per-browser reading preference,
# the region is a per-device fact.  The storage package injects its own
# ``hoymiles-lang.js``, which is not present when only micro inverters are set up.
LANG_SWITCH_FILENAME: Final = "hoymiles-g2-lang.js"
FRONTEND_ASSETS: Final = (
    I18N_CARD_FILENAME,
    # Both switches label themselves in the current card language, so they come
    # right after i18n; the language one first, because the region switch places
    # itself to the right of whatever language control it finds.
    LANG_SWITCH_FILENAME,
    REGION_SWITCH_FILENAME,
    CARD_FILENAME,
    SANKEY_CARD_FILENAME,
    POWER_FLOW_CARD_FILENAME,
    BATTERY_CARD_FILENAME,
    HISTORY_CHART_CARD_FILENAME,
    GAUGE_CARD_FILENAME,
    CONTROL_CARD_FILENAME,
    PACK_LIST_CARD_FILENAME,
    ALARM_CARD_FILENAME,
    CHART_OPTIONS_CARD_FILENAME,
)

CARD_URL: Final = f"{FRONTEND_URL}/{CARD_FILENAME}"

# Images bundled in ``www/`` and served next to the cards.
#
# These are published as static files only - unlike ``FRONTEND_ASSETS`` they are
# never injected with ``add_extra_js_url``, because a PNG is not a module. The
# cards reference them as ``{FRONTEND_URL}/<name>``.
HIFLOW_IMAGE_FILENAME: Final = "hiflow.png"
# The HiFlow Pro 2-in-1 (RMI-4161) product photo drawn in the middle of the
# power-flow schematic. It is a transparent cut-out, so the connectors can run
# up to the body instead of stopping at a white rectangle.
HIFLOW_PRO_IMAGE_FILENAME: Final = "hiflow-pro-2in1.png"
# One cut-out per SKU, matched to the port count the card draws. ``hiflow.png``
# is the older HiFlow art; ``hiflow-800.png`` is the HiFlow 800 (SKU 1650) that
# superseded it, and the Pro series gets its own 1-in / 4-in artwork so the
# number of visible inputs on the photo matches the number of nodes below it.
HIFLOW_800_IMAGE_FILENAME: Final = "hiflow-800.png"
HIFLOW_PRO_1IN1_IMAGE_FILENAME: Final = "hiflow-pro-1in1.png"
HIFLOW_PRO_4IN1_IMAGE_FILENAME: Final = "hiflow-pro-4in1.png"
FRONTEND_IMAGES: Final = (
    HIFLOW_IMAGE_FILENAME,
    HIFLOW_PRO_IMAGE_FILENAME,
    HIFLOW_800_IMAGE_FILENAME,
    HIFLOW_PRO_1IN1_IMAGE_FILENAME,
    HIFLOW_PRO_4IN1_IMAGE_FILENAME,
)

HIFLOW_IMAGE_URL: Final = f"{FRONTEND_URL}/{HIFLOW_IMAGE_FILENAME}"
HIFLOW_PRO_IMAGE_URL: Final = f"{FRONTEND_URL}/{HIFLOW_PRO_IMAGE_FILENAME}"
HIFLOW_800_IMAGE_URL: Final = f"{FRONTEND_URL}/{HIFLOW_800_IMAGE_FILENAME}"
HIFLOW_PRO_1IN1_IMAGE_URL: Final = f"{FRONTEND_URL}/{HIFLOW_PRO_1IN1_IMAGE_FILENAME}"
HIFLOW_PRO_4IN1_IMAGE_URL: Final = f"{FRONTEND_URL}/{HIFLOW_PRO_4IN1_IMAGE_FILENAME}"

# ---------------------------------------------------------------------------
# Sankey card defaults
# ---------------------------------------------------------------------------
# Statistics query period used by the energy sankey card.
SANKEY_PERIOD: Final = "day"
