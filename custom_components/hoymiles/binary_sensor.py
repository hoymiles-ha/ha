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

from .const import DOMAIN, MANUFACTURER, SRC_DEVICE, SRC_QUICK
from .coordinator import HoymilesCoordinator


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


BINARY_SENSOR_DESCRIPTIONS: tuple[HoymilesBinarySensorDescription, ...] = (
    HoymilesBinarySensorDescription(
        key="heating",
        name="Heating",
        device_class=BinarySensorDeviceClass.HEAT,
        value_fn=_quick("heat"),
    ),
    HoymilesBinarySensorDescription(
        key="system_heating",
        name="System Heating",
        device_class=BinarySensorDeviceClass.HEAT,
        value_fn=_quick("sys_heat"),
    ),
    HoymilesBinarySensorDescription(
        key="pack1_heating", name="Pack 1 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(0),
    ),
    HoymilesBinarySensorDescription(
        key="pack2_heating", name="Pack 2 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(1),
    ),
    HoymilesBinarySensorDescription(
        key="pack3_heating", name="Pack 3 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(2),
    ),
    HoymilesBinarySensorDescription(
        key="pack4_heating", name="Pack 4 Heating",
        device_class=BinarySensorDeviceClass.HEAT, value_fn=_pack_heat(3),
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

    async_add_entities(
        HoymilesBinarySensor(coordinator, dev_id, description)
        for description in BINARY_SENSOR_DESCRIPTIONS
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
        )

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
