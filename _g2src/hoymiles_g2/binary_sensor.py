"""Binary sensor entities for the Hoymiles Micro Storage integration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CAP_SYSTEM_STATE, DOMAIN, MANUFACTURER, SRC_DEVICE, SRC_QUICK
from .coordinator import HoymilesCoordinator
from .entity_gate import async_add_gated_entities


def _quick(field: str) -> Callable[[dict], Any]:
    def _fn(data: dict[str, Any]) -> Any:
        payload = data.get(SRC_QUICK)
        if not isinstance(payload, dict):
            return None
        return payload.get(field)

    return _fn


def _pack_heat(index: int) -> Callable[[dict], Any]:
    def _fn(data: dict[str, Any]) -> Any:
        payload = data.get(SRC_DEVICE)
        if not isinstance(payload, dict):
            return None
        packs = payload.get("packs")
        if not isinstance(packs, list) or len(packs) <= index:
            return None
        item = packs[index]
        return item.get("heat") if isinstance(item, dict) else None

    return _fn


@dataclass(frozen=True)
class HoymilesBinarySensorDescription(BinarySensorEntityDescription):
    """Binary sensor description with a value extractor."""

    value_fn: Callable[[dict[str, Any]], Any] | None = None
    # Capability the firmware must have declared for this entity to be created.
    requires: str | None = None


BINARY_SENSOR_DESCRIPTIONS: tuple[HoymilesBinarySensorDescription, ...] = (
    # Heating only exists on a battery - a micro inverter has none, so every
    # sensor here is gated on the storage capability.
    HoymilesBinarySensorDescription(
        key="heating",
        name="Heating",
        device_class=BinarySensorDeviceClass.HEAT,
        value_fn=_quick("heat"),
        requires=CAP_SYSTEM_STATE,
    ),
    HoymilesBinarySensorDescription(
        key="system_heating",
        name="System Heating",
        device_class=BinarySensorDeviceClass.HEAT,
        value_fn=_quick("sys_heat"),
        requires=CAP_SYSTEM_STATE,
    ),
    HoymilesBinarySensorDescription(
        key="pack1_heating", name="Pack 1 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(0),
        requires=CAP_SYSTEM_STATE,
    ),
    HoymilesBinarySensorDescription(
        key="pack2_heating", name="Pack 2 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(1),
        requires=CAP_SYSTEM_STATE,
    ),
    HoymilesBinarySensorDescription(
        key="pack3_heating", name="Pack 3 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(2),
        requires=CAP_SYSTEM_STATE,
    ),
    HoymilesBinarySensorDescription(
        key="pack4_heating", name="Pack 4 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(3),
        requires=CAP_SYSTEM_STATE,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the binary sensors from a config entry."""
    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    dev_id: str = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    await coordinator.async_wait_for_capabilities()

    # All six heating sensors read a storage unit's ``quick/state`` / ``packs``,
    # so a micro inverter gets none of them - and any that do become justified
    # later (a device whose retained payloads arrive after this point) are added
    # by the gate.
    def _build() -> list[HoymilesBinarySensor]:
        return [
            HoymilesBinarySensor(coordinator, dev_id, description)
            for description in BINARY_SENSOR_DESCRIPTIONS
            if description.requires is None
            or coordinator.has_capability(description.requires)
        ]

    def _stale() -> set[str]:
        """Heating keys the device cannot report (no storage ``quick/state``)."""
        return {
            description.key
            for description in BINARY_SENSOR_DESCRIPTIONS
            if description.requires is not None
            and not coordinator.has_capability(description.requires)
        }

    async_add_gated_entities(
        coordinator,
        async_add_entities,
        _build,
        entry,
        hass=hass,
        domain="binary_sensor",
        stale=_stale,
    )


class HoymilesBinarySensor(CoordinatorEntity[HoymilesCoordinator], BinarySensorEntity):
    """A push-updated binary sensor fed by the MQTT coordinator."""

    _attr_has_entity_name = True
    entity_description: HoymilesBinarySensorDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesBinarySensorDescription,
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
        return self.coordinator.available

    @property
    def is_on(self) -> bool | None:
        """Return the current state."""
        value_fn = self.entity_description.value_fn
        if value_fn is None:
            return None
        value = value_fn(self.coordinator.data or {})
        if value is None:
            return None
        return bool(value)
