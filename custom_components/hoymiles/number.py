"""Multi phase output power numbers for the Hoymiles Micro Storage integration.

The firmware describes ``phase_output_power`` as a plain ``number`` entity
(protocol §8) but expects a JSON object on its command topic (protocol §15)::

    {"phase_a": 800, "phase_b": 800, "phase_c": 800}

A native ``number`` entity can only publish a single scalar, so the firmware
entity is unusable unless its ``command_template`` wraps the value - which
``discovery_override.py`` does, applying one value to **all three** phases.

This platform adds per phase control:

* one ``number`` entity per phase (``phase_a`` / ``phase_b`` / ``phase_c``);
* setting one phase publishes the **complete** JSON object, keeping the other two
  phases at their last known value, because the firmware rejects a partial
  payload (``Invalid phase_x value``);
* the last known values come from the coordinator, which watches the command
  topic itself - so values written by the firmware entity (or by anything else
  on the broker) are picked up as well;
* ``hoymiles.set_phase_output_power`` sets all three atomically.

⚠️ The device never reports the configured per phase limits back, so the value
shown here is the last value that was *commanded*.  Until a phase has been set at
least once it has no known value and defaults to ``PHASE_POWER_MIN`` (100 W) -
a warning is logged whenever that happens.
"""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.number import (
    NumberEntity,
    NumberEntityDescription,
    NumberMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    DOMAIN,
    MANUFACTURER,
    PHASE_A,
    PHASE_B,
    PHASE_C,
    PHASE_POWER_MAX,
    PHASE_POWER_MIN,
    PHASE_POWER_STEP,
)
from .coordinator import HoymilesCoordinator


@dataclass(frozen=True)
class HoymilesPhaseNumberDescription(NumberEntityDescription):
    """Number description carrying the protocol field name of the phase."""

    phase: str = ""


NUMBER_DESCRIPTIONS: tuple[HoymilesPhaseNumberDescription, ...] = (
    HoymilesPhaseNumberDescription(
        key="phase_a_output_power", name="Phase A Output Power", phase=PHASE_A
    ),
    HoymilesPhaseNumberDescription(
        key="phase_b_output_power", name="Phase B Output Power", phase=PHASE_B
    ),
    HoymilesPhaseNumberDescription(
        key="phase_c_output_power", name="Phase C Output Power", phase=PHASE_C
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the per phase output power numbers."""
    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    dev_id: str = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    async_add_entities(
        HoymilesPhaseNumber(coordinator, dev_id, description)
        for description in NUMBER_DESCRIPTIONS
    )


class HoymilesPhaseNumber(
    CoordinatorEntity[HoymilesCoordinator], NumberEntity, RestoreEntity
):
    """One phase of the device's multi phase output power limit."""

    _attr_has_entity_name = True
    _attr_native_min_value = PHASE_POWER_MIN
    _attr_native_max_value = PHASE_POWER_MAX
    _attr_native_step = PHASE_POWER_STEP
    _attr_native_unit_of_measurement = UnitOfPower.WATT
    # No device_class on purpose: ``NumberDeviceClass`` only exists from Home
    # Assistant 2024.1 and hacs.json keeps 2023.8 as the minimum version.
    _attr_mode = NumberMode.BOX
    entity_description: HoymilesPhaseNumberDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesPhaseNumberDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._phase = description.phase
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
    def native_value(self) -> float | None:
        """Return the last commanded value for this phase."""
        value = self.coordinator.phase_output.get(self._phase)
        return None if value is None else float(value)

    async def async_added_to_hass(self) -> None:
        """Restore the last value so a restart does not lose the other phases."""
        await super().async_added_to_hass()

        last_state = await self.async_get_last_state()
        if last_state is None or last_state.state in ("unknown", "unavailable", ""):
            return

        try:
            value = int(float(last_state.state))
        except (TypeError, ValueError):
            return

        self.coordinator.restore_phase_output(self._phase, value)

    async def async_set_native_value(self, value: float) -> None:
        """Publish the new limit for this phase."""
        await self.coordinator.async_set_phase_output(self._phase, int(round(value)))
