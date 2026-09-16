"""Sensor entities for the Hoymiles Micro Storage integration.

These entities reproduce the state fields the firmware pushes on
``quick/state`` (1 s, all roles), ``device/state`` (5 min, all roles) and
``system/state`` (5 min, master/single only) plus the TOU ack/status topics.

``soc`` and ``bat_power`` are intentionally *not* re-created here because the
firmware already registers them through MQTT discovery.
"""

from __future__ import annotations

from dataclasses import dataclass
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
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    DOMAIN,
    MANUFACTURER,
    SRC_DEVICE,
    SRC_QUICK,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    TOU_DAY_ACK_STATUS,
    TOU_GET_STATUS,
    TOU_WEEK_ACK_STATUS,
)
from .coordinator import HoymilesCoordinator

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


def pv(index: int, default: Any = None) -> Callable[[dict], Any]:
    """Read the power of PV port ``index`` (0-based) from device/state.

    Ports are matched by ``id`` (1-based in the protocol), so a missing entry
    cannot shift the value of every following port.
    """

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("pvs")
        if not isinstance(items, list):
            return default

        for item in items:
            if isinstance(item, dict) and item.get("id") == index + 1:
                return item.get("p", default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get("p", default)

        return default

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
# Entity description
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HoymilesSensorDescription(SensorEntityDescription):
    """Sensor description with a value extractor and optional attributes."""

    value_fn: Callable[[dict[str, Any]], Any] | None = None
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None


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
    HoymilesSensorDescription(
        key="pv_power", name="PV Power", value_fn=q("pv_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_on_power", name="Grid On Power", value_fn=q("grid_on_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_power", name="Grid Off Power", value_fn=q("grid_off_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="battery_status", name="Battery Status", value_fn=q("bat_sts")
    ),
    # ---------------- quick/state : system level (master/single) ----------------
    HoymilesSensorDescription(
        key="system_pv_power", name="System PV Power", value_fn=q("sys_pv_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_plug_power", name="System Plug Power", value_fn=q("sys_plug_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_battery_power", name="System Battery Power", value_fn=q("sys_bat_p"), **_POWER
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
        key="system_soc", name="System SOC", value_fn=q("sys_soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="system_pv2_power", name="System PV2 Power", value_fn=q("sys_pv2_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_eps_power", name="System EPS Power", value_fn=q("sys_eps_p"), **_POWER
    ),
    # ---------------- device/state : battery & signal (5 min) ----------------
    HoymilesSensorDescription(
        key="battery_voltage", name="Battery Voltage", value_fn=d("bat_v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="battery_current", name="Battery Current", value_fn=d("bat_i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="battery_temperature", name="Battery Temperature", value_fn=d("bat_temp"), **_TEMPERATURE
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
    HoymilesSensorDescription(
        key="grid_on_energy_in_today", name="Grid On Energy In Today", value_fn=grid(0, "ein"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_out_today", name="Grid On Energy Out Today", value_fn=grid(0, "eout"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_in_total", name="Grid On Energy In Total", value_fn=grid(0, "etin"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_out_total", name="Grid On Energy Out Total", value_fn=grid(0, "etout"), **_ENERGY
    ),
    # ---------------- device/state : grid off (index 1) ----------------
    HoymilesSensorDescription(
        key="grid_off_voltage", name="Grid Off Voltage", value_fn=grid(1, "v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="grid_off_current", name="Grid Off Current", value_fn=grid(1, "i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="grid_off_frequency", name="Grid Off Frequency", value_fn=grid(1, "f"), **_FREQUENCY
    ),
    HoymilesSensorDescription(
        key="grid_off_power_5m", name="Grid Off Power (5 min)", value_fn=grid(1, "p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_reactive_power", name="Grid Off Reactive Power", value_fn=grid(1, "q"), **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_in_today", name="Grid Off Energy In Today", value_fn=grid(1, "ein"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_out_today", name="Grid Off Energy Out Today", value_fn=grid(1, "eout"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_in_total", name="Grid Off Energy In Total", value_fn=grid(1, "etin"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_out_total", name="Grid Off Energy Out Total", value_fn=grid(1, "etout"), **_ENERGY
    ),
    # ---------------- device/state : inverter (index 2, no frequency) ----------------
    HoymilesSensorDescription(
        key="inv_voltage", name="Inverter Voltage", value_fn=grid(2, "v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="inv_current", name="Inverter Current", value_fn=grid(2, "i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="inv_power", name="Inverter Power", value_fn=grid(2, "p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="inv_reactive_power", name="Inverter Reactive Power", value_fn=grid(2, "q"), **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="inv_energy_in_today", name="Inverter Energy In Today", value_fn=grid(2, "ein"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_out_today", name="Inverter Energy Out Today", value_fn=grid(2, "eout"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_in_total", name="Inverter Energy In Total", value_fn=grid(2, "etin"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_out_total", name="Inverter Energy Out Total", value_fn=grid(2, "etout"), **_ENERGY
    ),
    # ---------------- device/state : PV ports ----------------
    HoymilesSensorDescription(
        key="pv1_power", name="PV1 Power", value_fn=pv(0), **_POWER
    ),
    HoymilesSensorDescription(
        key="pv2_power", name="PV2 Power", value_fn=pv(1), **_POWER
    ),
    HoymilesSensorDescription(
        key="pv3_power", name="PV3 Power", value_fn=pv(2), **_POWER
    ),
    HoymilesSensorDescription(
        key="pv4_power", name="PV4 Power", value_fn=pv(3), **_POWER
    ),
    # ---------------- device/state : packs ----------------
    HoymilesSensorDescription(
        key="pack_count", name="Pack Count", value_fn=d("pack_num"),
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    HoymilesSensorDescription(
        key="pack1_soc", name="Pack 1 SOC", value_fn=pack(0, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack1_temperature", name="Pack 1 Temperature", value_fn=pack(0, "temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack2_soc", name="Pack 2 SOC", value_fn=pack(1, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack2_temperature", name="Pack 2 Temperature", value_fn=pack(1, "temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack3_soc", name="Pack 3 SOC", value_fn=pack(2, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack3_temperature", name="Pack 3 Temperature", value_fn=pack(2, "temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack4_soc", name="Pack 4 SOC", value_fn=pack(3, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack4_temperature", name="Pack 4 Temperature", value_fn=pack(3, "temp"), **_TEMPERATURE
    ),
    # ---------------- system/state : daily energy (master/single) ----------------
    HoymilesSensorDescription(
        key="system_pv_energy_today", name="System PV Energy Today", value_fn=s("pv_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="system_pv2_energy_today", name="System PV2 Energy Today", value_fn=s("pv2_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="battery_charge_energy_today", name="Battery Charge Energy Today", value_fn=s("chg_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="battery_discharge_energy_today", name="Battery Discharge Energy Today", value_fn=s("dchg_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="plug_output_energy_today", name="Plug Output Energy Today", value_fn=s("plug_out_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="plug_input_energy_today", name="Plug Input Energy Today", value_fn=s("plug_in_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="eps_output_energy_today", name="EPS Output Energy Today", value_fn=s("eps_out_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="eps_input_energy_today", name="EPS Input Energy Today", value_fn=s("eps_in_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="ems_mode_running", name="EMS Mode (Device)", value_fn=s("ems_mode")
    ),
    # ---------------- TOU ----------------
    HoymilesSensorDescription(
        key="tou_plan_status",
        name="TOU Plan Status",
        value_fn=_tou_status_value,
        attrs_fn=_tou_attrs(SRC_TOU_STATUS),
    ),
    HoymilesSensorDescription(
        key="tou_day_ack",
        name="TOU Day Plan Ack",
        value_fn=_ack(SRC_TOU_DAY_ACK, TOU_DAY_ACK_STATUS),
        attrs_fn=_tou_attrs(SRC_TOU_DAY_ACK),
    ),
    HoymilesSensorDescription(
        key="tou_week_ack",
        name="TOU Week Plan Ack",
        value_fn=_ack(SRC_TOU_WEEK_ACK, TOU_WEEK_ACK_STATUS),
        attrs_fn=_tou_attrs(SRC_TOU_WEEK_ACK),
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

    async_add_entities(
        HoymilesSensor(coordinator, dev_id, description)
        for description in SENSOR_DESCRIPTIONS
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
        )

    @property
    def available(self) -> bool:
        """Return True while the device is still pushing data."""
        return self.coordinator.available

    @property
    def native_value(self) -> Any:
        """Return the current value."""
        value_fn = self.entity_description.value_fn
        if value_fn is None:
            return None
        return value_fn(self.coordinator.data or {})

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return the raw payload fields for ack/status sensors."""
        attrs_fn = self.entity_description.attrs_fn
        if attrs_fn is None:
            return None
        attrs = attrs_fn(self.coordinator.data or {})
        return attrs or None
