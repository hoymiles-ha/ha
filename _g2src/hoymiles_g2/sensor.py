"""Sensor entities for the Hoymiles Micro Storage integration.

These entities reproduce the state fields the firmware pushes on
``quick/state`` (1 s, all roles), ``device/state`` (5 min, all roles),
``system/state`` (5 min, master/single only), ``event/state`` (on connect and
on change, all roles) plus the TOU ack/status topics.

``soc`` and ``bat_power`` are intentionally *not* re-created here because the
firmware already registers them through MQTT discovery.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable, Final

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    PERCENTAGE,
    EntityCategory,
    UnitOfElectricCurrent,
    UnitOfElectricPotential,
    UnitOfEnergy,
    UnitOfFrequency,
    UnitOfPower,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import (
    ALARM_CODE_RANGES,
    ALARM_CODES,
    ALARM_CODES_ZH,
    ALARM_MAX,
    CAP_ALARM_STATE,
    CAP_DEVICE_STATE,
    CAP_QUICK_STATE,
    CAP_SYSTEM_STATE,
    CAP_TOU,
    DOMAIN,
    MANUFACTURER,
    PV_COUNT_MAX,
    ROLE_ALIASES,
    ROLE_MASTER,
    ROLE_SLAVE,
    ROLES,
    SRC_ALARM,
    SRC_DEVICE,
    SRC_EVENT,
    SRC_KEEPALIVE,
    SRC_QUICK,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    TOU_DAY_ACK_STATUS,
    TOU_GET_STATUS,
    TOU_WEEK_ACK_STATUS,
    is_inverter_dev_id,
)
from .coordinator import HoymilesCoordinator
from .entity_gate import async_add_gated_entities

_LOGGER = logging.getLogger(__name__)

# How long a restored alarm list stays trustworthy.  ``alarm/state`` is not
# retained, so a restart leaves the entity with nothing to read until the next
# alarm fires; the last snapshot is shown instead.  A day-old list, however,
# would claim that alarms are still active that were cleared while Home
# Assistant was down, which is worse than admitting we do not know.
ALARM_RESTORE_MAX_AGE: Final = timedelta(days=1)

# ---------------------------------------------------------------------------
# value_fn helpers
# ---------------------------------------------------------------------------


def _payload(data: dict[str, Any], source: str) -> dict[str, Any]:
    value = data.get(source)
    return value if isinstance(value, dict) else {}


def q(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from quick/state."""

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_QUICK).get(field, default)

    return _fn


def d(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from device/state."""

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_DEVICE).get(field, default)

    return _fn


def s(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from system/state."""

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_SYSTEM).get(field, default)

    return _fn


def _role_value(data: dict[str, Any]) -> str | None:
    """The unit's role in the installation, normalised, or ``None``.

    §32 is the only carrier of ``role``: ``single`` (stand-alone), ``master``
    (head of a master/slave pair) or ``slave`` (follower).  A follower is
    published as ``servant`` by at least one build, so the alias is resolved
    here instead of in every consumer.  An unknown spelling is reported as
    ``None`` rather than passed through: a dash on the dashboard is honest, an
    invented role is not.
    """
    value = _payload(data, SRC_EVENT).get("role")
    if not isinstance(value, str):
        return None
    role = value.strip().lower()
    role = ROLE_ALIASES.get(role, role)
    return role if role in ROLES else None


def _role_attrs(data: dict[str, Any]) -> dict[str, Any]:
    """The whole ``event/state`` snapshot as attributes.

    Everything the payload carries is exposed, because the power flow card reads
    it straight off this entity: the three capability flags decide which
    branches exist in the drawing, and ``switch`` / ``ems_mode`` / the power
    limits are useful on a dashboard without creating an entity for each of the
    twenty odd fields the protocol defines.

    No interpretation happens here - a flag the firmware did not send is simply
    absent, which the card reads as "unknown" instead of ``false``.
    """
    return dict(_payload(data, SRC_EVENT))


# Documented order of the ``grid`` array in device/state (protocol §23).
GRID_TYPES: Final = ("grid_on", "grid_off", "inv")


def grid(index: int, field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read ``grid[index].<field>`` from device/state (0=on, 1=off, 2=inv).

    Entries are matched by their ``type`` field instead of by position, so the
    energy dashboard and the statistics built on these sensors keep working even
    if the firmware ever reorders or filters the array.  The documented order is
    only used as a fallback for entries without a ``type``.
    """

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("grid")
        if not isinstance(items, list):
            return default

        wanted = GRID_TYPES[index] if 0 <= index < len(GRID_TYPES) else None
        if wanted is not None:
            for item in items:
                if isinstance(item, dict) and item.get("type") == wanted:
                    return item.get(field, default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get(field, default)

        return default

    return _fn


def _pv_entry(data: dict[str, Any], index: int) -> dict[str, Any] | None:
    """Return the ``pvs[]`` entry for port ``index`` (0-based), if present.

    Ports are matched by ``id`` (1-based in the protocol) and only fall back to
    the array position, so a missing entry cannot shift the value of every
    following port.
    """
    items = _payload(data, SRC_DEVICE).get("pvs")
    if not isinstance(items, list):
        return None

    for item in items:
        if isinstance(item, dict) and item.get("id") == index + 1:
            return item

    if len(items) > index and isinstance(items[index], dict):
        return items[index]

    return None


def pv(index: int, default: Any = None) -> Callable[[dict], Any]:
    """Read the power of PV port ``index`` (0-based).

    ``quick/state`` is the 1 s topic and a micro inverter puts the same per port
    readings there as ``pv1_p`` / ``pv2_p`` (``pvs[].p`` in ``device/state`` is
    the identical number, only published every 5 minutes).  The 1 s value
    therefore wins whenever present, which is what makes the Device tab's power
    flow card and the port gauges move in step with the System tab instead of
    lagging by up to five minutes.

    ``pPv<n>`` is accepted as an alias: that is how the protocol document spells
    the field, and accepting both means a unit that ever emits either spelling
    still gets the fast reading.

    A storage unit has no ``pv<n>_p`` fields at all, so it falls straight
    through to ``pvs[]`` and keeps its previous behaviour.
    """
    port = index + 1
    live_fields = (f"pv{port}_p", f"pPv{port}")

    def _fn(data: dict[str, Any]) -> Any:
        live = _payload(data, SRC_QUICK)
        for field in live_fields:
            value = live.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
        entry = _pv_entry(data, index)
        return default if entry is None else entry.get("p", default)

    return _fn


def grid_port(default: Any = None) -> Callable[[dict], Any]:
    """Read the micro inverter's own AC output from the 1 s topic.

    The unit reports it as ``grid_on_p`` and repeats it as ``grid[0].p`` in the
    5 min ``device/state``.  Reading the slow copy made the 并网端口 node trail
    the System tab by up to five minutes, and it was frequently ``unknown`` for
    the first minutes after a reboot, which printed a dash on the diagram.

    ``pAc`` is accepted as an alias (the spelling used by the protocol
    document).  ``grid[0].p`` stays as the last resort so an older firmware that
    sends neither field still gets a reading.
    """
    quick_fields = ("grid_on_p", "pAc")
    slow = grid(0, "p", default)

    def _fn(data: dict[str, Any]) -> Any:
        live = _payload(data, SRC_QUICK)
        for field in quick_fields:
            value = live.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
        return slow(data)

    return _fn


def pv_energy(index: int, field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read an energy counter of PV port ``index`` from device/state.

    A micro inverter reports the per port energy as ``ed`` (today) and ``et``
    (lifetime) inside ``pvs[]``; a storage unit leaves both out and reports the
    equivalent totals in ``system/state`` instead.  This is therefore the only
    source of a PV energy figure on a model without ``system_state``.
    """

    def _fn(data: dict[str, Any]) -> Any:
        entry = _pv_entry(data, index)
        return default if entry is None else entry.get(field, default)

    return _fn


def _pv_energy_sum(data: dict[str, Any], field: str) -> Any:
    """Sum an energy counter over every ``pvs[]`` entry, ``None`` when absent.

    The port count varies per model (a HiFlow micro inverter typically has two),
    so the total is summed over whatever the payload actually contains rather
    than over a fixed number of ports.  An entry that omits the field simply does
    not contribute, and a payload with no usable entry yields ``None`` so the
    sensor stays ``unknown`` instead of reporting a misleading ``0``.
    """
    items = _payload(data, SRC_DEVICE).get("pvs")
    if not isinstance(items, list):
        return None

    total = 0
    seen = False
    for item in items:
        if not isinstance(item, dict):
            continue
        value = item.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        total += value
        seen = True

    return total if seen else None


def pv_energy_total(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Sum an energy counter of every PV port from device/state."""

    def _fn(data: dict[str, Any]) -> Any:
        total = _pv_energy_sum(data, field)
        return default if total is None else total

    return _fn


def _pv_power_sum(data: dict[str, Any]) -> Any:
    """Sum the live power of **every** PV port the payload reports.

    The Device tab draws one node per physical input, but the vendor app - and
    therefore the number a user compares against - shows the array as a whole,
    i.e. ``PV1 + PV2``.  This entity is that sum, so the card never has to add
    up entities itself and a model with four inputs needs no special case.

    It is a straight sum, with one measured caveat worth writing down: a
    **single-input** body (``1650`` HiFlow 800, one MPPT) still publishes *both*
    ``pv1_p`` and ``pv2_p`` in ``quick/state``, carrying the *same* number in
    them frame for frame - measured over 45 s on three units (``4.8 / 4.8``,
    ``4.3 / 4.3``, ``4.0 / 4.0``).  The firmware mirrors the one reading into
    both fields rather than leaving the second empty.  Summing therefore doubles
    that unit's wattage, which is what the vendor app does as well and what was
    explicitly asked for here ("相加：永远显示 PV1+PV2"), so the dedupe that a
    naive reading of the data would suggest is deliberately **not** applied.
    A real multi-input body is unaffected: each port tracks its own string
    (measured, ``RMI-4161A020A0F6`` ``14.8 / 14.5``; ``RMI-4162A0211FDE``
    ``17.6 / 15.2 / 15.6 / 0.0``) and the sum is simply the whole array.

    ``None`` when nothing reports a value at all, so the sensor stays ``unknown``
    instead of claiming a hard ``0`` for a unit that has not spoken yet.
    """
    live = _payload(data, SRC_QUICK)
    total = None
    for port in range(1, PV_COUNT_MAX + 1):
        value = live.get(f"pv{port}_p")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            value = live.get(f"pPv{port}")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        total = value if total is None else total + value

    if total is not None:
        return total

    # No 1 s reading (an older firmware, or a payload that has not arrived
    # yet): fall back to the 5 min ``pvs[]`` array, which carries the identical
    # numbers one entry per port.
    items = _payload(data, SRC_DEVICE).get("pvs")
    if not isinstance(items, list):
        return None

    for item in items:
        if not isinstance(item, dict):
            continue
        value = item.get("p")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        total = value if total is None else total + value

    return total


def s_or_pv(field: str, pv_field: str) -> Callable[[dict], Any]:
    """Read a field from system/state, falling back to the ``pvs[]`` sum.

    A storage unit reports its daily PV energy as ``pv_e`` in ``system/state``;
    a micro inverter has no such topic at all and instead publishes ``ed`` (today)
    per port.  Reading both keeps one entity meaningful on either model rather
    than leaving it ``unknown`` on the model that lacks the topic.
    """

    def _fn(data: dict[str, Any]) -> Any:
        value = _payload(data, SRC_SYSTEM).get(field)
        if value is not None:
            return value
        return _pv_energy_sum(data, pv_field)

    return _fn


def pack(index: int, field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read ``packs[index].<field>`` from device/state (0-based).

    Packs are matched by ``id`` (1-based in the protocol), so a missing pack
    cannot shift the values of the remaining ones.
    """

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("packs")
        if not isinstance(items, list):
            return default

        for item in items:
            if isinstance(item, dict) and item.get("id") == index + 1:
                return item.get(field, default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get(field, default)

        return default

    return _fn


def _ack(source: str, table: dict[int, str]):
    """Build a value_fn for an ack/status topic (returns a readable string)."""

    def _fn(data: dict[str, Any]) -> str | None:
        payload = _payload(data, source)
        status = payload.get("status")
        if status is None:
            return None
        try:
            code = int(status)
        except (TypeError, ValueError):
            return str(status)
        text = table.get(code, "unknown")
        return f"{code} - {text}"

    return _fn


def _ems_mode_value(data: dict[str, Any]) -> Any:
    """Read the running EMS mode from whichever report carrier has it.

    A storage unit publishes ``system/state`` and puts ``ems_mode`` there; a
    micro inverter has no ``system/state`` at all and reports the same field
    inside ``device/state``.  Reading only one of them leaves half the supported
    models stuck at "unknown", so both are consulted - ``system/state`` wins
    because it is the master role's authoritative view.
    """
    for source in (SRC_SYSTEM, SRC_DEVICE):
        value = _payload(data, source).get("ems_mode")
        if isinstance(value, str) and value:
            return value
    return None


def _tou_status_value(data: dict[str, Any]) -> str | None:
    payload = _payload(data, SRC_TOU_STATUS)
    status = payload.get("status")
    if status is None:
        return None
    try:
        code = int(status)
    except (TypeError, ValueError):
        return str(status)
    week = payload.get("week")
    day_idx = payload.get("day_idx")
    text = TOU_GET_STATUS.get(code, "unknown")
    if code == 0 and week is not None:
        return f"{week} day{day_idx} - {text}"
    return f"{code} - {text}"


def _keepalive_value(data: dict[str, Any]) -> str:
    """Return the keep-alive's running state as a readable string."""
    payload = _payload(data, SRC_KEEPALIVE)
    if not payload:
        return "off"
    if payload.get("enabled") is True:
        return "on"
    if payload.get("error"):
        return "error"
    return "off"


def _keepalive_attrs(data: dict[str, Any]) -> dict[str, Any]:
    """Expose the full keep-alive payload, which is what the card reads."""
    return _payload(data, SRC_KEEPALIVE)


def _tou_attrs(source: str) -> Callable[[dict], dict[str, Any]]:
    def _fn(data: dict[str, Any]) -> dict[str, Any]:
        payload = _payload(data, source)
        attrs: dict[str, Any] = {}
        if payload.get("status") is not None:
            attrs["status"] = payload["status"]
        if payload.get("err_msg") is not None:
            attrs["err_msg"] = payload["err_msg"]
        if isinstance(payload.get("day_plan"), list):
            attrs["day_plan"] = payload["day_plan"]
        if payload.get("week") is not None:
            attrs["week"] = payload["week"]
        if payload.get("day_idx") is not None:
            attrs["day_idx"] = payload["day_idx"]
        return attrs

    return _fn


# ---------------------------------------------------------------------------
# Alarms (protocol §27)
# ---------------------------------------------------------------------------
def alarm_name(code: int) -> str | None:
    """Return the documented English text for one alarm code, or ``None``.

    The code table is the micro inverter appendix: it is the family that
    declares ``alarm_state`` at all.  A range the document describes as a family
    (``400-409``: smart device offline) is resolved before giving up, and a code
    outside every table stays unnamed rather than being guessed at.
    """
    if code in ALARM_CODES:
        return ALARM_CODES[code]
    for low, high, text, _zh in ALARM_CODE_RANGES:
        if low <= code <= high:
            return text
    return None


def alarm_name_zh(code: int) -> str | None:
    """Return the documented Chinese text for one alarm code, or ``None``.

    Parallel to :func:`alarm_name` and resolved from the same two tables.  A
    code the Chinese table does not carry returns ``None`` so the caller can
    fall back to the English name instead of printing a blank.
    """
    if code in ALARM_CODES_ZH:
        return ALARM_CODES_ZH[code]
    for low, high, _en, zh in ALARM_CODE_RANGES:
        if low <= code <= high:
            return zh
    return None


def _alarm_code(value: Any) -> int | None:
    """Parse one alarm code, which the firmware sends as a string."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _alarm_items(data: dict[str, Any]) -> list[dict[str, Any]] | None:
    """The decoded alarm list, or ``None`` when the device never published one.

    ``None`` and an empty list mean two different things and the distinction is
    the whole point of this function: an empty list is the device saying "nothing
    is wrong right now", while ``None`` means "this device has not told us" - an
    older firmware without the topic at all, or a unit that has not alarmed since
    Home Assistant started, because ``alarm/state`` is not retained.  Collapsing
    the two would let the card claim a fault-free device it knows nothing about.
    """
    payload = data.get(SRC_ALARM)
    if not isinstance(payload, dict):
        return None
    items = payload.get("alarm")
    if not isinstance(items, list):
        # A report with a count but no list (or a shape change) is still a
        # report: treat it as "no alarms listed" rather than as no data.
        return []

    decoded: list[dict[str, Any]] = []
    for item in items[:ALARM_MAX]:
        if not isinstance(item, dict):
            continue
        code = _alarm_code(item.get("code"))
        if code is None:
            continue
        # Both names are always present: ``name`` stays the protocol's English
        # text (unchanged, so an existing automation reading it keeps working)
        # and ``name_zh`` carries the translation.  A code with no Chinese entry
        # repeats the English one rather than going blank.
        name = alarm_name(code)
        name_zh = alarm_name_zh(code) or name
        # ``sn`` names the device an alarm is about, and it is the *only* field
        # that makes a 「智能设备离线」 report actionable: that alarm (code 400-409
        # / 2101-2110, see ``ALARM_CODE_RANGES``) is raised by the gateway on
        # behalf of a *subordinate* device, so without the serial the message
        # says "something went offline" and nothing more.  Measured payload:
        # ``{"alarm_num": 1, "alarm": [{"sn": "B0B21C195978",
        # "time": "26-11-19 09:47", "code": "402"}]}``.  Every alarm item is
        # shaped the same way, so the field is carried for all codes - a code
        # that is about the unit itself simply reports that unit's own serial.
        sn = item.get("sn")
        if not isinstance(sn, str) or not sn.strip():
            sn = None
        else:
            sn = sn.strip()
        decoded.append(
            {
                "code": code,
                "time": item.get("time"),
                "sn": sn,
                "name": name or f"Unknown alarm {code}",
                "name_en": name or f"Unknown alarm {code}",
                "name_zh": name_zh or f"未知告警 {code}",
            }
        )

    # Newest first: the device appends in the order the alarms were raised, and
    # the one that just happened is what the card is opened for.
    decoded.reverse()
    return decoded


def _alarm_summary(items: list[dict[str, Any]]) -> str:
    """One line naming every active alarm, in both languages.

    The Chinese name comes first because the entity's friendly name and the
    dashboard are Chinese in the target install, and the English one is kept
    beside it so the line can be quoted straight back into the protocol
    appendix.  When the two are identical the repetition is dropped.
    """
    parts = []
    for item in items:
        zh = item.get("name_zh")
        en = item.get("name_en") or item.get("name")
        if zh and en and zh != en:
            parts.append(f"{item['code']} {zh} / {en}")
        else:
            parts.append(f"{item['code']} {en or zh}")
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Entity description
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HoymilesSensorDescription(SensorEntityDescription):
    """Sensor description with a value extractor and optional attributes."""

    value_fn: Callable[[dict[str, Any]], Any] | None = None
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    # Capability the firmware must have declared for this entity to be created.
    # ``None`` means "always create" - used for the fields every model sends.
    requires: str | None = None
    # Capability the firmware must NOT have declared.  A few fields exist only on
    # the models that *lack* a topic - the per port energy counters live in
    # ``pvs[]`` and are only sent by a micro inverter, which is exactly the model
    # that has no ``system/state``.  Expressed as an absence so it keeps working
    # if a future storage model ever starts sending them.
    requires_absent: str | None = None
    # Skip the device watchdog for entities whose value comes from the
    # integration rather than from the device.  An offline device must not make
    # the keep-alive state unreadable, because the card uses it to decide whether
    # the lease is being held - exactly when that matters most.
    ignores_device_availability: bool = False
    # 1-based PV input this entity belongs to.  A port the unit does not have is
    # never created, so a 2-input HiFlow Pro no longer gets two permanently
    # ``unknown`` sensors.  ``None`` means "not a per-port entity".
    pv_port: int | None = None
    # True for a 「今日」 counter, i.e. a reading the *device* rolls over at its own
    # midnight.  A unit that was off the network across midnight republishes the
    # day it went offline on its first message back, and nothing in the payload
    # says so - see ``HoymilesCoordinator.today_counters_stale``.  Such a reading
    # is reported as ``0`` while that verdict stands, so 今日发电 resets by itself
    # instead of showing yesterday's yield until the device catches up.
    today_counter: bool = False


_POWER = {
    "device_class": SensorDeviceClass.POWER,
    "native_unit_of_measurement": UnitOfPower.WATT,
    "state_class": SensorStateClass.MEASUREMENT,
}
_ENERGY = {
    "device_class": SensorDeviceClass.ENERGY,
    "native_unit_of_measurement": UnitOfEnergy.WATT_HOUR,
    "state_class": SensorStateClass.TOTAL_INCREASING,
}
_VOLTAGE = {
    "device_class": SensorDeviceClass.VOLTAGE,
    "native_unit_of_measurement": UnitOfElectricPotential.VOLT,
    "state_class": SensorStateClass.MEASUREMENT,
}
_CURRENT = {
    "device_class": SensorDeviceClass.CURRENT,
    "native_unit_of_measurement": UnitOfElectricCurrent.AMPERE,
    "state_class": SensorStateClass.MEASUREMENT,
}
_FREQUENCY = {
    "device_class": SensorDeviceClass.FREQUENCY,
    "native_unit_of_measurement": UnitOfFrequency.HERTZ,
    "state_class": SensorStateClass.MEASUREMENT,
}
_TEMPERATURE = {
    "device_class": SensorDeviceClass.TEMPERATURE,
    "native_unit_of_measurement": UnitOfTemperature.CELSIUS,
    "state_class": SensorStateClass.MEASUREMENT,
}
_SOC = {
    "device_class": SensorDeviceClass.BATTERY,
    "native_unit_of_measurement": PERCENTAGE,
    "state_class": SensorStateClass.MEASUREMENT,
}
_REACTIVE_POWER = {
    "device_class": SensorDeviceClass.REACTIVE_POWER,
    "native_unit_of_measurement": "var",
    "state_class": SensorStateClass.MEASUREMENT,
}


SENSOR_DESCRIPTIONS: tuple[HoymilesSensorDescription, ...] = (
    # ---------------- quick/state : device level (1 s) ----------------
    # A micro inverter (HiFlow) publishes ``quick/state`` too, but only with the
    # five ``sys_*`` aggregates - it has no battery and no per-port grid powers,
    # so these four would sit at "unknown" forever.  They are gated on the
    # ``system_state`` capability, which exactly the storage units declare.
    HoymilesSensorDescription(
        key="pv_power", name="PV Power", value_fn=q("pv_p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_on_power", name="Grid On Power", value_fn=q("grid_on_p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_power", name="Grid Off Power", value_fn=q("grid_off_p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="battery_status", name="Battery Status", value_fn=q("bat_sts"),
        requires=CAP_SYSTEM_STATE
    ),
    # ---------------- quick/state : system level (master/single) ----------------
    HoymilesSensorDescription(
        key="system_pv_power", name="System PV Power", value_fn=q("sys_pv_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_plug_power", name="System Plug Power", value_fn=q("sys_plug_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_battery_power", name="System Battery Power", value_fn=q("sys_bat_p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="system_grid_power", name="System Grid Power", value_fn=q("sys_grid_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_load_power", name="System Load Power", value_fn=q("sys_load_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_smart_plug_power", name="System Smart Plug Power", value_fn=q("sys_sp_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_soc", name="System SOC", value_fn=q("sys_soc"),
        requires=CAP_SYSTEM_STATE, **_SOC
    ),
    HoymilesSensorDescription(
        key="system_pv2_power", name="System PV2 Power", value_fn=q("sys_pv2_p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="system_eps_power", name="System EPS Power", value_fn=q("sys_eps_p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    # ---------------- device/state : battery & signal (5 min) ----------------
    HoymilesSensorDescription(
        key="battery_voltage", name="Battery Voltage", value_fn=d("bat_v"),
        requires=CAP_SYSTEM_STATE, **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="battery_current", name="Battery Current", value_fn=d("bat_i"),
        requires=CAP_SYSTEM_STATE, **_CURRENT
    ),
    HoymilesSensorDescription(
        key="battery_temperature", name="Battery Temperature", value_fn=d("bat_temp"),
        requires=CAP_SYSTEM_STATE, **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="rssi",
        name="RSSI",
        value_fn=d("rssi"),
        device_class=SensorDeviceClass.SIGNAL_STRENGTH,
        native_unit_of_measurement="dBm",
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    # ---------------- device/state : grid on (index 0) ----------------
    HoymilesSensorDescription(
        key="grid_on_voltage", name="Grid On Voltage", value_fn=grid(0, "v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="grid_on_current", name="Grid On Current", value_fn=grid(0, "i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="grid_on_frequency", name="Grid On Frequency", value_fn=grid(0, "f"), **_FREQUENCY
    ),
    HoymilesSensorDescription(
        key="grid_on_power_5m", name="Grid On Power (5 min)", value_fn=grid(0, "p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_on_reactive_power", name="Grid On Reactive Power", value_fn=grid(0, "q"), **_REACTIVE_POWER
    ),
    # The grid array of a micro inverter has a single ``grid_on`` entry and no
    # ``ein``/``eout``/``etin``/``etout``, so everything below needs the storage
    # capability as well.
    HoymilesSensorDescription(
        key="grid_on_energy_in_today", name="Grid On Energy In Today", value_fn=grid(0, "ein"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_out_today", name="Grid On Energy Out Today", value_fn=grid(0, "eout"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_in_total", name="Grid On Energy In Total", value_fn=grid(0, "etin"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_out_total", name="Grid On Energy Out Total", value_fn=grid(0, "etout"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    # ---------------- device/state : grid off (index 1) ----------------
    HoymilesSensorDescription(
        key="grid_off_voltage", name="Grid Off Voltage", value_fn=grid(1, "v"),
        requires=CAP_SYSTEM_STATE, **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="grid_off_current", name="Grid Off Current", value_fn=grid(1, "i"),
        requires=CAP_SYSTEM_STATE, **_CURRENT
    ),
    HoymilesSensorDescription(
        key="grid_off_frequency", name="Grid Off Frequency", value_fn=grid(1, "f"),
        requires=CAP_SYSTEM_STATE, **_FREQUENCY
    ),
    HoymilesSensorDescription(
        key="grid_off_power_5m", name="Grid Off Power (5 min)", value_fn=grid(1, "p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_reactive_power", name="Grid Off Reactive Power", value_fn=grid(1, "q"),
        requires=CAP_SYSTEM_STATE, **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_in_today", name="Grid Off Energy In Today", value_fn=grid(1, "ein"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_out_today", name="Grid Off Energy Out Today", value_fn=grid(1, "eout"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_in_total", name="Grid Off Energy In Total", value_fn=grid(1, "etin"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_out_total", name="Grid Off Energy Out Total", value_fn=grid(1, "etout"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    # ---------------- device/state : inverter (index 2, no frequency) ----------------
    HoymilesSensorDescription(
        key="inv_voltage", name="Inverter Voltage", value_fn=grid(2, "v"),
        requires=CAP_SYSTEM_STATE, **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="inv_current", name="Inverter Current", value_fn=grid(2, "i"),
        requires=CAP_SYSTEM_STATE, **_CURRENT
    ),
    HoymilesSensorDescription(
        key="inv_power", name="Inverter Power", value_fn=grid(2, "p"),
        requires=CAP_SYSTEM_STATE, **_POWER
    ),
    HoymilesSensorDescription(
        key="inv_reactive_power", name="Inverter Reactive Power", value_fn=grid(2, "q"),
        requires=CAP_SYSTEM_STATE, **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="inv_energy_in_today", name="Inverter Energy In Today", value_fn=grid(2, "ein"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_out_today", name="Inverter Energy Out Today", value_fn=grid(2, "eout"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_in_total", name="Inverter Energy In Total", value_fn=grid(2, "etin"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_out_total", name="Inverter Energy Out Total", value_fn=grid(2, "etout"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    # ---------------- quick/state : micro inverter AC port (1 s) ----------
    # A micro inverter reports its own AC output as ``grid_on_p`` on the 1 s
    # topic and repeats it as ``grid[0].p`` in the 5 min ``device/state``.  The
    # entity used to look for ``pAc``, which the firmware never sends, so it read
    # the slow copy at best and stayed ``unknown`` whenever that copy was older
    # than the availability window - which is why the 并网端口 node of the Device
    # tab showed a dash while the System tab was live.  ``grid_port()`` reads the
    # 1 s field first and keeps ``grid[0].p`` as the fallback.
    #
    # Gated on the *absence* of ``system_state`` because that field only exists
    # on a micro inverter - a storage unit describes the same port with
    # ``grid_on_power`` and must not get a second entity for it.
    HoymilesSensorDescription(
        key="grid_port_power", name="Grid Port Power", value_fn=grid_port(),
        requires_absent=CAP_SYSTEM_STATE, **_POWER
    ),
    # ---------------- device/state : PV ports ----------------
    # One entity per *physical* input.  How many a unit has is derived from the
    # SKU in its serial (``pv_count_from_dev_id``) and refined by the firmware's
    # own ``pv_num``, so a 2-input HiFlow Pro creates only PV1 / PV2.  The card
    # keeps working either way: it decides its layout from the serial's product
    # code as well, so removing the phantom ports does not change the drawing.
    #
    # ``pv_total_power`` is the sum over the ports that reported, which is the
    # figure the Device tab prints on its single PV node and the one the vendor
    # app shows for the array.  It is a separate entity rather than an addition
    # in the card so that the value is also usable in automations and history
    # charts, and so a 4-input body needs no per-model special case.  See
    # ``_pv_power_sum`` for why a single-input unit legitimately counts its one
    # MPPT twice here.
    HoymilesSensorDescription(
        key="pv_total_power", name="PV Total Power",
        value_fn=_pv_power_sum, **_POWER
    ),
    HoymilesSensorDescription(
        key="pv1_power", name="PV1 Power", value_fn=pv(0), pv_port=1, **_POWER
    ),
    HoymilesSensorDescription(
        key="pv2_power", name="PV2 Power", value_fn=pv(1), pv_port=2, **_POWER
    ),
    HoymilesSensorDescription(
        key="pv3_power", name="PV3 Power", value_fn=pv(2), pv_port=3, **_POWER
    ),
    HoymilesSensorDescription(
        key="pv4_power", name="PV4 Power", value_fn=pv(3), pv_port=4, **_POWER
    ),
    # ---------------- device/state : per port PV energy (micro inverter) -------
    # Only the micro inverter firmware puts ``ed`` / ``et`` inside ``pvs[]``; a
    # storage unit reports the same information in ``system/state`` and leaves
    # both fields out.  Gated on the absence of that topic so the two sets of
    # energy sensors never overlap.  The *total* today figure is not repeated
    # here - ``system_pv_energy_today`` already falls back to the ``pvs[]`` sum.
    HoymilesSensorDescription(
        key="pv_energy_total", name="PV Energy Total",
        value_fn=pv_energy_total("et"),
        requires_absent=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv1_energy_today", name="PV1 Energy Today",
        value_fn=pv_energy(0, "ed"),
        requires_absent=CAP_SYSTEM_STATE, pv_port=1, today_counter=True, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv2_energy_today", name="PV2 Energy Today",
        value_fn=pv_energy(1, "ed"),
        requires_absent=CAP_SYSTEM_STATE, pv_port=2, today_counter=True, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv3_energy_today", name="PV3 Energy Today",
        value_fn=pv_energy(2, "ed"),
        requires_absent=CAP_SYSTEM_STATE, pv_port=3, today_counter=True, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv4_energy_today", name="PV4 Energy Today",
        value_fn=pv_energy(3, "ed"),
        requires_absent=CAP_SYSTEM_STATE, pv_port=4, today_counter=True, **_ENERGY
    ),
    # ---------------- device/state : packs ----------------
    HoymilesSensorDescription(
        key="pack_count", name="Pack Count", value_fn=d("pack_num"),
        requires=CAP_SYSTEM_STATE,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    HoymilesSensorDescription(
        key="pack1_soc", name="Pack 1 SOC", value_fn=pack(0, "soc"),
        requires=CAP_SYSTEM_STATE, **_SOC
    ),
    HoymilesSensorDescription(
        key="pack1_temperature", name="Pack 1 Temperature", value_fn=pack(0, "temp"),
        requires=CAP_SYSTEM_STATE, **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack2_soc", name="Pack 2 SOC", value_fn=pack(1, "soc"),
        requires=CAP_SYSTEM_STATE, **_SOC
    ),
    HoymilesSensorDescription(
        key="pack2_temperature", name="Pack 2 Temperature", value_fn=pack(1, "temp"),
        requires=CAP_SYSTEM_STATE, **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack3_soc", name="Pack 3 SOC", value_fn=pack(2, "soc"),
        requires=CAP_SYSTEM_STATE, **_SOC
    ),
    HoymilesSensorDescription(
        key="pack3_temperature", name="Pack 3 Temperature", value_fn=pack(2, "temp"),
        requires=CAP_SYSTEM_STATE, **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack4_soc", name="Pack 4 SOC", value_fn=pack(3, "soc"),
        requires=CAP_SYSTEM_STATE, **_SOC
    ),
    HoymilesSensorDescription(
        key="pack4_temperature", name="Pack 4 Temperature", value_fn=pack(3, "temp"),
        requires=CAP_SYSTEM_STATE, **_TEMPERATURE
    ),
    # ---------------- system/state : daily energy (master/single) ----------------
    # These read ``system/state`` only, so a model without that topic would show
    # ``unknown`` forever.  Gate them like the rest of the storage fields, except
    # for the PV total below, which a micro inverter can also answer from
    # ``pvs[].ed``.
    HoymilesSensorDescription(
        key="system_pv_energy_today", name="System PV Energy Today",
        value_fn=s_or_pv("pv_e", "ed"), today_counter=True, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="system_pv2_energy_today", name="System PV2 Energy Today", value_fn=s("pv2_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="battery_charge_energy_today", name="Battery Charge Energy Today", value_fn=s("chg_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="battery_discharge_energy_today", name="Battery Discharge Energy Today", value_fn=s("dchg_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="plug_output_energy_today", name="Plug Output Energy Today", value_fn=s("plug_out_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="plug_input_energy_today", name="Plug Input Energy Today", value_fn=s("plug_in_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="eps_output_energy_today", name="EPS Output Energy Today", value_fn=s("eps_out_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    HoymilesSensorDescription(
        key="eps_input_energy_today", name="EPS Input Energy Today", value_fn=s("eps_in_e"),
        requires=CAP_SYSTEM_STATE, **_ENERGY
    ),
    # A storage unit reports the running mode in ``system/state``; a micro
    # inverter has no such topic and puts it in ``device/state`` instead, so the
    # extractor has to look at both.  Not gated: every model reports a mode.
    HoymilesSensorDescription(
        key="ems_mode_running", name="EMS Mode (Device)", value_fn=_ems_mode_value
    ),
    # ---------------- event/state : role in the installation (protocol §32) ----
    # Deliberately NOT capability gated: ``event_state`` is not a key of the
    # retained ``supported_topics`` inventory (verified live on an RMI-4161,
    # whose inventory lists only quick_state, device_state, alarm_state,
    # switch_ctrl, output_power, power_ctrl, ems_mode and reboot), so gating on
    # it would hide the entity on exactly the models that do publish the topic.
    # The whole snapshot rides along as attributes - that is what the power flow
    # card reads to decide which branches the drawing has.
    HoymilesSensorDescription(
        key="system_role",
        name="System Role",
        icon="mdi:account-supervisor",
        value_fn=_role_value,
        attrs_fn=_role_attrs,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    # ---------------- TOU ----------------
    HoymilesSensorDescription(
        key="tou_plan_status",
        name="TOU Plan Status",
        value_fn=_tou_status_value,
        attrs_fn=_tou_attrs(SRC_TOU_STATUS),
        requires=CAP_TOU,
    ),
    HoymilesSensorDescription(
        key="tou_day_ack",
        name="TOU Day Plan Ack",
        value_fn=_ack(SRC_TOU_DAY_ACK, TOU_DAY_ACK_STATUS),
        attrs_fn=_tou_attrs(SRC_TOU_DAY_ACK),
        requires=CAP_TOU,
    ),
    HoymilesSensorDescription(
        key="tou_week_ack",
        name="TOU Week Plan Ack",
        value_fn=_ack(SRC_TOU_WEEK_ACK, TOU_WEEK_ACK_STATUS),
        attrs_fn=_tou_attrs(SRC_TOU_WEEK_ACK),
        requires=CAP_TOU,
    ),
    # Integration-owned, not a device topic: whether the power-control lease is
    # being held, and how often. The control card reads it back so a dashboard
    # reload shows the truth instead of guessing from a local timer.
    HoymilesSensorDescription(
        key="power_ctrl_keepalive",
        name="Power Control Keep-alive",
        icon="mdi:timer-sync-outline",
        value_fn=_keepalive_value,
        attrs_fn=_keepalive_attrs,
        ignores_device_availability=True,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the sensors from a config entry."""
    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    dev_id: str = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    # Which topics the firmware implements decides which sensors make sense; the
    # retained inventory usually arrives within milliseconds.
    await coordinator.async_wait_for_capabilities()

    pv_ports = coordinator.pv_count

    def _wanted(description: HoymilesSensorDescription) -> bool:
        if (description.requires is not None
                and not coordinator.has_capability(description.requires)):
            return False
        if (description.requires_absent is not None
                and coordinator.has_capability(description.requires_absent)):
            return False
        # A per-port entity is only created for an input the unit actually has.
        if description.pv_port is not None and description.pv_port > pv_ports:
            return False
        return True

    def _build() -> list[HoymilesSensor]:
        """Every sensor the capability set justifies *right now*.

        Re-evaluated whenever a topic arrives for the first time, so a device
        that was silent (or that only publishes a reduced topic set over MQTTS)
        ends up with exactly the entities its own payloads prove - and grows
        them the moment it publishes something new.
        """
        return [
            HoymilesSensor(coordinator, dev_id, description)
            for description in SENSOR_DESCRIPTIONS
            if _wanted(description)
        ]

    # The alarm list cannot be a plain :class:`HoymilesSensor` because
    # ``alarm/state`` is not retained: after a restart the topic is silent until
    # the next alarm, so the entity has to restore its last snapshot instead of
    # sitting at ``unknown`` for days.  Gated on the declared capability, which
    # only a micro inverter carries.
    def _build_with_alarm() -> list[Any]:
        entities: list[Any] = list(_build())
        if coordinator.has_capability(CAP_ALARM_STATE):
            entities.append(HoymilesAlarmSensor(coordinator, dev_id))
        # The installation wide 今日发电 figure.  Not a description: its value
        # comes from other units' coordinators, not from this unit's payload.
        entities.append(HoymilesPlantTodaySensor(coordinator, dev_id))
        # ... and its lifetime sibling, for the same reason.
        entities.append(HoymilesPlantEnergyTotalSensor(coordinator, dev_id))
        return entities

    def _stale() -> set[str]:
        """Sensor keys this device does not publish the topic for.

        Returns the keys whose ``requires`` capability is missing, plus the ones
        whose ``requires_absent`` capability *is* present, plus every PV port
        beyond what the unit reports.  Called by the gate once a capability is
        known, so a merely-offline device is left alone.
        """
        keys: set[str] = set()
        for port in range(pv_ports + 1, PV_COUNT_MAX + 1):
            keys.add(f"pv{port}_power")
            keys.add(f"pv{port}_energy_today")

        for description in SENSOR_DESCRIPTIONS:
            if description.pv_port is not None:
                continue  # handled by the port loop above
            if description.requires is not None and not coordinator.has_capability(
                description.requires
            ):
                keys.add(description.key)
            elif description.requires_absent is not None and coordinator.has_capability(
                description.requires_absent
            ):
                keys.add(description.key)
        return keys

    async_add_gated_entities(
        coordinator,
        async_add_entities,
        _build_with_alarm,
        entry,
        hass=hass,
        domain="sensor",
        stale=_stale,
    )


class HoymilesSensor(CoordinatorEntity[HoymilesCoordinator], SensorEntity):
    """A push-updated sensor fed by the MQTT coordinator."""

    _attr_has_entity_name = True
    entity_description: HoymilesSensorDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_{description.key}"
        self._attr_name = description.name
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
            model=coordinator.device_model,
        )

    @property
    def available(self) -> bool:
        """Return True while the device is still pushing data."""
        if self.entity_description.ignores_device_availability:
            return True
        return self.coordinator.available

    @property
    def native_value(self) -> Any:
        """Return the current value."""
        value_fn = self.entity_description.value_fn
        if value_fn is None:
            return None
        value = value_fn(self.coordinator.data or {})
        if (
            value is not None
            and self.entity_description.today_counter
            and self.coordinator.today_counters_stale
        ):
            # The device came back on a later day still carrying the counters
            # from the day it went offline.  ``0`` is the honest figure for
            # "today so far" - the unit has produced nothing since it was
            # reachable - and it keeps 今日发电 from showing last night's total
            # until the firmware rolls its own counter over.  ``None`` is left
            # alone: that means "never reported", not "reported yesterday".
            return 0
        return value

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return the raw payload fields for ack/status sensors."""
        attrs_fn = self.entity_description.attrs_fn
        if attrs_fn is None:
            return None
        attrs = attrs_fn(self.coordinator.data or {})
        return attrs or None


class HoymilesAlarmSensor(
    CoordinatorEntity[HoymilesCoordinator], RestoreEntity, SensorEntity
):
    """The alarms the device has not cleared yet (protocol §27).

    The state is the *count*, so an automation can trigger on
    ``numeric_state above: 0``, and the alarms themselves are attributes.  The
    device replaces the whole list on every change and keeps at most
    :data:`ALARM_MAX` of them, so this is a snapshot, not a history.

    Two details drive the shape of this class:

    * ``alarm/state`` is **not retained** and is only published when the list
      changes.  After a Home Assistant restart there is nothing to read until
      the next alarm fires - possibly for days - so the last snapshot is
      restored and shown until a new report arrives.
    * ``unknown`` and ``0`` are not the same claim.  A device that has never
      published the topic reports ``None`` (unknown), never ``0``; only a report
      that really listed nothing reports ``0``.
    """

    _attr_has_entity_name = True
    _attr_name = "Active Alarms"
    _attr_icon = "mdi:alert-circle-outline"

    def __init__(self, coordinator: HoymilesCoordinator, dev_id: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_active_alarms"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
            model=coordinator.device_model,
        )
        # Filled in by ``async_added_to_hass``; ``None`` means there is nothing
        # to fall back to, which is the honest "this device never told us".
        self._restored: list[dict[str, Any]] | None = None
        self._restored_count: int | None = None

    async def async_added_to_hass(self) -> None:
        """Restore the last alarm list across a restart."""
        await super().async_added_to_hass()

        last = await self.async_get_last_state()
        if last is None or last.state in ("unknown", "unavailable"):
            return
        if dt_util.utcnow() - last.last_updated > ALARM_RESTORE_MAX_AGE:
            return

        items = last.attributes.get("alarms")
        if not isinstance(items, list):
            return

        self._restored = [item for item in items if isinstance(item, dict)]
        try:
            self._restored_count = int(float(last.state))
        except (TypeError, ValueError):
            self._restored_count = len(self._restored)

    @property
    def _alarms(self) -> list[dict[str, Any]] | None:
        """The live list, the restored one, or ``None`` when never reported."""
        live = _alarm_items(self.coordinator.data or {})
        return live if live is not None else self._restored

    @property
    def native_value(self) -> int | None:
        """Number of alarms still active, or ``None`` before any report."""
        payload = (self.coordinator.data or {}).get(SRC_ALARM)
        if not isinstance(payload, dict):
            return self._restored_count
        count = payload.get("alarm_num")
        if isinstance(count, int) and not isinstance(count, bool):
            return count
        alarms = _alarm_items(self.coordinator.data or {})
        return None if alarms is None else len(alarms)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """The decoded alarm list, plus a one-line summary.

        With no list at all the attributes stay **empty** on purpose: an empty
        ``alarms`` list would read as "nothing is wrong", which is a claim this
        entity cannot make.  The card keys off the missing attribute and says
        "no data" instead.
        """
        alarms = self._alarms
        if alarms is None:
            return {}
        return {
            "alarms": alarms,
            "codes": [item["code"] for item in alarms],
            "summary": _alarm_summary(alarms),
        }


class HoymilesPlantTodaySensor(CoordinatorEntity[HoymilesCoordinator], SensorEntity):
    """Today's PV yield of the **whole installation**, not of one unit.

    The firmware answers "how much did the roof make today" per unit: every
    HiFlow publishes its own ``pvs[].ed`` (and the master, additionally, its
    ``system/state``), and nothing anywhere in the protocol adds them up.  That
    is measured, not assumed - the three units on the test installation report
    387 Wh / 148 Wh / 613 Wh on the same afternoon, so the master's own figure
    is its share, not the total.

    Because the dashboard's System tab describes the installation, its 今日发电
    gauge has to show the total, which means this integration has to do the
    adding.  The grouping comes from protocol §32 「状态事件」, the only place
    the firmware states its role: members are the master and every unit that
    announced ``role: slave``.  The protocol carries **no** plant / station /
    parent identifier at all (verified by dumping the retained ``event/state``
    of all six units - the payload holds ``role``, ``switch`` and
    ``output_power``, plus ``ems_mode`` / ``has_meter`` / ``has_plug`` on a
    master, and nothing else), so "the same installation" can only mean "the
    master and its followers".  Two independent installations under one Home
    Assistant would therefore each count every follower; the alternative - a
    user-configured grouping - would be a real feature, and this is not the
    place to invent it.

    A unit that is not a master answers with just its own figure, which is the
    truthful answer for a standalone ("single") unit and a partial one for a
    follower that somehow renders the System tab.

    Reads the other units' coordinators directly rather than their entities: the
    coordinator is the source those entities are built from, so this cannot
    depend on the entity registry being populated yet, and it cannot be confused
    by a user who renamed ``sensor.<slug>_system_pv_energy_today``.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_native_unit_of_measurement = UnitOfEnergy.WATT_HOUR
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_name = "Plant PV Energy Today"

    def __init__(self, coordinator: HoymilesCoordinator, dev_id: str) -> None:
        super().__init__(coordinator)
        self._dev_id = dev_id
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_plant_pv_energy_today"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
            model=coordinator.device_model,
        )

    @property
    def available(self) -> bool:
        """Yes while this unit talks; the followers are reported separately."""
        return self.coordinator.available

    @property
    def native_value(self) -> float | None:
        """``master + followers`` in Wh, or just this unit when it is not one."""
        own = _today_of(self.coordinator)
        if self.coordinator.role != ROLE_MASTER:
            return own

        total: float | None = None
        for dev_id, other in _inverter_coordinators(self.hass):
            if dev_id == self._dev_id:
                value = own
            elif other.role == ROLE_SLAVE:
                value = _today_of(other)
            else:
                continue
            if value is None:
                continue
            total = value if total is None else total + value
        return total

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Which units were added up, so the number can be checked.

        An aggregated figure with no way to see its parts is the kind of thing
        that gets distrusted and then hard-coded around.  The list is also what
        reveals the grouping rule's limit: a second installation's followers
        would appear here too.
        """
        members: list[str] = []
        own = _today_of(self.coordinator)
        for dev_id, other in _inverter_coordinators(self.hass):
            if dev_id == self._dev_id or other.role == ROLE_SLAVE:
                members.append(dev_id)
        stale = sorted(
            dev_id
            for dev_id, other in _inverter_coordinators(self.hass)
            if dev_id == self._dev_id or other.role == ROLE_SLAVE
            if getattr(other, "today_counters_stale", False)
        )
        attrs: dict[str, Any] = {
            "role": self.coordinator.role,
            "members": sorted(members),
            "own": own,
            "grouping": "master + role=slave units",
        }
        if stale:
            # The parts whose contribution was clamped to 0 because they came
            # back from an outage still holding the previous day's counters.
            # Without this the total would look like a real drop to 0 with no
            # explanation - and a statistics graph would record that as yield.
            attrs["stale_members"] = stale
        return attrs


class HoymilesPlantEnergyTotalSensor(
    CoordinatorEntity[HoymilesCoordinator], SensorEntity
):
    """Lifetime PV yield of the **whole installation**, not of one unit.

    The sibling of :class:`HoymilesPlantTodaySensor`, and it exists for the same
    reason: the firmware answers "how much has the roof ever made" one unit at a
    time.  ``pvs[].et`` is a per-port lifetime counter, the protocol adds nothing
    up, and the System tab's 总发电量 therefore used to show the master's share -
    on the test installation 2 944 Wh of a true 6 100 Wh, i.e. less than half,
    with no hint that it was a part.

    The grouping is the same one the daily sensor documents at length: master
    plus every unit that announced ``role: slave`` (protocol §32).  A unit that
    is not a master answers with just its own figure.

    Unlike ``ed``, ``et`` needs no stale-counter correction: it is a lifetime
    figure that survives outages, so a member that was offline for a week still
    contributes the right number when it comes back.  A gap in the middle of the
    curve is a unit not reporting, never a reset.

    **The published value is exactly what the units report, resets included.**
    ``et`` is not guaranteed monotonic: clearing a unit back to factory defaults
    zeroes it, and this sensor then follows that to ~0 and climbs again.  That is
    deliberate - zeroing the counter is a real command with a real meaning
    ("forget the total"), so the entity has to agree with the vendor app and with
    the unit's own screen.  Banking the pre-reset energy to keep the line
    monotonic was tried and rejected for that reason; the recorder still shows
    the reset as a one-off drop, which is the honest record of what happened.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_native_unit_of_measurement = UnitOfEnergy.WATT_HOUR
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_name = "Plant PV Energy Total"

    def __init__(self, coordinator: HoymilesCoordinator, dev_id: str) -> None:
        super().__init__(coordinator)
        self._dev_id = dev_id
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_plant_pv_energy_total"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
            model=coordinator.device_model,
        )

    @property
    def available(self) -> bool:
        """Yes while this unit talks; the followers are reported separately."""
        return self.coordinator.available

    def _members(self) -> list[tuple[str, HoymilesCoordinator]]:
        """This unit plus every follower, in registry order."""
        return [
            (dev_id, other)
            for dev_id, other in _inverter_coordinators(self.hass)
            if dev_id == self._dev_id or other.role == ROLE_SLAVE
        ]

    @property
    def native_value(self) -> float | None:
        """``master + followers`` in Wh, or just this unit when it is not one."""
        own = _lifetime_of(self.coordinator)
        if self.coordinator.role != ROLE_MASTER:
            return own

        total: float | None = None
        for dev_id, other in self._members():
            value = own if dev_id == self._dev_id else _lifetime_of(other)
            if value is None:
                continue
            total = value if total is None else total + value
        return total

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Which units were added up, so the number can be checked."""
        parts: dict[str, float] = {}
        for dev_id, other in self._members():
            value = _lifetime_of(other)
            if value is not None:
                parts[dev_id] = value
        return {
            "role": self.coordinator.role,
            "members": sorted(parts),
            "own": _lifetime_of(self.coordinator),
            "parts": parts,
            "grouping": "master + role=slave units",
        }


def _today_of(coordinator: HoymilesCoordinator) -> float | None:
    """Today's PV energy of one unit, by the same rule its own sensor uses.

    Includes the stale-counter correction, so the plant total falls back to
    ``0`` for a unit that was offline across midnight instead of carrying
    yesterday's figure into the System tab's 今日发电 gauge.  A member's own
    coordinator decides that, not the master's: the outage is per unit.
    """
    if getattr(coordinator, "today_counters_stale", False):
        return 0.0
    value = s_or_pv("pv_e", "ed")(coordinator.data or {})
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _lifetime_of(coordinator: HoymilesCoordinator) -> float | None:
    """Lifetime PV energy of one unit, by the same rule its own sensor uses.

    No stale-counter correction here, and none is possible: ``et`` is a
    monotonic lifetime counter that the firmware keeps across outages, so a unit
    that was offline for a week still reports the right figure when it returns.
    Only the *daily* counter (``ed``) is reset by a midnight the unit may miss.
    """
    value = pv_energy_total("et")(coordinator.data or {})
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _inverter_coordinators(
    hass: HomeAssistant | None,
) -> list[tuple[str, HoymilesCoordinator]]:
    """Every micro-inverter coordinator this integration has set up.

    ``hass.data[DOMAIN]`` holds one entry per config entry and both product
    families share the key, so the serial's PID decides which is which.  A
    storage unit is never a candidate: it has its own battery-side totals and no
    ``role`` at all.
    """
    if hass is None:
        return []
    found: list[tuple[str, HoymilesCoordinator]] = []
    for entry_data in (hass.data.get(DOMAIN) or {}).values():
        if not isinstance(entry_data, dict):
            continue
        coordinator = entry_data.get("coordinator")
        dev_id = entry_data.get("dev_id")
        if not isinstance(dev_id, str) or coordinator is None:
            continue
        if not is_inverter_dev_id(dev_id):
            continue
        found.append((dev_id, coordinator))
    return found
