"""Data coordinator for the Hoymiles Micro Storage integration.

The firmware pushes state over MQTT; this coordinator subscribes to the topics
and fans the decoded JSON out to the entities.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from . import mqtt_util
from .const import (
    DOMAIN,
    SRC_DEVICE,
    SRC_QUICK,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    T_DEVICE_STATE,
    T_QUICK_STATE,
    T_SYSTEM_STATE,
    T_TOU_DAY_ACK,
    T_TOU_STATUS,
    T_TOU_WEEK_ACK,
)

_LOGGER = logging.getLogger(__name__)

# (coordinator data key, topic template, qos)
SUBSCRIPTIONS: tuple[tuple[str, str, int], ...] = (
    (SRC_QUICK, T_QUICK_STATE, 0),
    (SRC_DEVICE, T_DEVICE_STATE, 1),
    (SRC_SYSTEM, T_SYSTEM_STATE, 1),
    (SRC_TOU_STATUS, T_TOU_STATUS, 1),
    (SRC_TOU_DAY_ACK, T_TOU_DAY_ACK, 1),
    (SRC_TOU_WEEK_ACK, T_TOU_WEEK_ACK, 1),
)


class HoymilesCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Push-driven coordinator backed by MQTT subscriptions."""

    def __init__(self, hass: HomeAssistant, dev_id: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}-{dev_id}",
            update_interval=None,
        )
        self.dev_id = dev_id
        self.data = {}
        self._unsubscribes: list[Any] = []

    async def async_setup(self) -> None:
        """Subscribe to all device topics."""
        for key, template, qos in SUBSCRIPTIONS:
            unsub = await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(template, self.dev_id),
                self._make_handler(key),
                qos,
            )
            self._unsubscribes.append(unsub)

        # Mark the coordinator as healthy so CoordinatorEntity is available.
        self.async_set_updated_data(dict(self.data))

    async def async_shutdown(self) -> None:
        """Cancel all subscriptions."""
        for unsub in self._unsubscribes:
            unsub()
        self._unsubscribes.clear()

    @callback
    def _make_handler(self, key: str):
        @callback
        def _handler(msg: Any) -> None:
            try:
                payload = json.loads(msg.payload)
            except (ValueError, TypeError):
                _LOGGER.debug("Invalid JSON on %s: %s", msg.topic, msg.payload)
                return
            if not isinstance(payload, dict):
                return
            data = dict(self.data)
            data[key] = payload
            self.async_set_updated_data(data)

        return _handler
