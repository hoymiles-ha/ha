"""Data coordinator for the Hoymiles Micro Storage integration.

The firmware pushes state over MQTT; this coordinator subscribes to the topics
and fans the decoded JSON out to the entities.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from . import mqtt_util
from .const import (
    AVAILABILITY_WATCHDOG_SECONDS,
    DOMAIN,
    EMS_MODE_ECHO_GUARD_SECONDS,
    EMS_MODES,
    PAYLOAD_AVAILABLE,
    PAYLOAD_NOT_AVAILABLE,
    PHASE_POWER_MIN,
    PHASES,
    SOURCE_STALE_SECONDS,
    SRC_DEVICE,
    SRC_QUICK,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    T_AVAILABILITY,
    T_DEVICE_STATE,
    T_EMS_MODE_CMD,
    T_EMS_MODE_STATE,
    T_PHASE_OUTPUT_POWER_SET,
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


def _payload_to_text(payload: Any) -> str | None:
    """Normalise an MQTT payload into a stripped ``str``.

    Home Assistant hands over a ``str`` for every payload that decodes as UTF-8
    and ``bytes`` only for the rest, so both must be accepted - calling
    ``.decode()`` unconditionally raises ``AttributeError`` on the common path.
    """
    if isinstance(payload, bytes):
        try:
            payload = payload.decode()
        except UnicodeDecodeError:
            return None

    if not isinstance(payload, str):
        return None

    return payload.strip().strip('"')


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
        # Last commanded per phase output limit (protocol §15).  Populated from
        # the command topic itself, so values written by the firmware entity or
        # by any other client are picked up too.
        self.phase_output: dict[str, int] = {}
        # Last EMS mode we published, and when a command was issued.  Both drive
        # the state topic of the firmware's (otherwise optimistic) select.
        self._ems_mode_state: str | None = None
        self._ems_mode_command_time = 0.0
        self._unsubscribes: list[Any] = []
        self._last_seen: dict[str, float] = {}
        # None = no verdict yet.  Staying available until proven silent keeps a
        # Home Assistant restart from blanking out every entity instantly.
        self._available: bool | None = None

    # ------------------------------------------------------------------
    # availability
    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        """Return True unless the device was proven to have gone silent."""
        return self._available is not False

    @property
    def availability_topic(self) -> str:
        """Topic the patched discovery payloads subscribe to."""
        return mqtt_util.topic(T_AVAILABILITY, self.dev_id)

    async def async_setup(self) -> None:
        """Subscribe to all device topics and start the availability watchdog."""
        for key, template, qos in SUBSCRIPTIONS:
            unsub = await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(template, self.dev_id),
                self._make_handler(key),
                qos,
            )
            self._unsubscribes.append(unsub)

        # Watching our own command topic lets the per phase numbers learn about
        # values produced elsewhere (firmware entity, scripts, ...).
        self._unsubscribes.append(
            await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(T_PHASE_OUTPUT_POWER_SET, self.dev_id),
                self._handle_phase_output,
                1,
            )
        )

        # Likewise for the EMS mode: the select's own state topic is fed from
        # here, so a command must be echoed no matter who sent it.
        self._unsubscribes.append(
            await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(T_EMS_MODE_CMD, self.dev_id),
                self._handle_ems_mode_command,
                1,
            )
        )

        self._unsubscribes.append(
            async_track_time_interval(
                self.hass,
                self._async_watchdog,
                timedelta(seconds=AVAILABILITY_WATCHDOG_SECONDS),
            )
        )

        # Mark the coordinator as healthy so CoordinatorEntity is available.
        self.async_set_updated_data(dict(self.data))

    async def async_shutdown(self) -> None:
        """Cancel all subscriptions and leave a usable retained state."""
        for unsub in self._unsubscribes:
            unsub()
        self._unsubscribes.clear()

        # The patched discovery payloads keep pointing at our availability topic
        # even after this entry is gone.  Publishing "online" while the device was
        # online leaves those entities usable instead of stranding them in
        # "unavailable" forever.
        if self._available:
            try:
                await mqtt_util.async_publish(
                    self.hass,
                    self.availability_topic,
                    PAYLOAD_AVAILABLE,
                    qos=1,
                    retain=True,
                )
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Unable to publish final availability", exc_info=True)

    # ------------------------------------------------------------------
    # multi phase output power (protocol §15)
    # ------------------------------------------------------------------
    @callback
    def _handle_phase_output(self, msg: Any) -> None:
        """Track the per phase limits published on the command topic."""
        try:
            payload = json.loads(msg.payload)
        except (ValueError, TypeError):
            return
        if not isinstance(payload, dict):
            return

        updated = False
        for phase in PHASES:
            value = payload.get(phase)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            if self.phase_output.get(phase) != int(value):
                self.phase_output[phase] = int(value)
                updated = True

        if updated:
            self.async_set_updated_data(dict(self.data))

    @callback
    def restore_phase_output(self, phase: str, value: int) -> None:
        """Seed one phase from restored state (no MQTT traffic)."""
        if self.phase_output.get(phase) == value:
            return
        self.phase_output[phase] = value
        self.async_set_updated_data(dict(self.data))

    async def async_set_phase_output(self, phase: str, value: int) -> None:
        """Set one phase, keeping the other two at their last known value."""
        await self.async_set_phase_outputs({phase: value})

    async def async_set_phase_outputs(self, values: dict[str, int]) -> None:
        """Publish a complete phase output power command (protocol §15).

        The firmware rejects a partial payload, so every phase is always sent.
        """
        payload: dict[str, int] = {}
        unknown: list[str] = []

        for phase in PHASES:
            if phase in values:
                payload[phase] = int(values[phase])
                continue
            known = self.phase_output.get(phase)
            if known is None:
                unknown.append(phase)
                payload[phase] = PHASE_POWER_MIN
            else:
                payload[phase] = int(known)

        if unknown:
            _LOGGER.warning(
                "Phase output power: %s had no known value yet and defaults to %s W. "
                "Set all three phases, or use hoymiles.set_phase_output_power, for "
                "full control.",
                ", ".join(unknown),
                PHASE_POWER_MIN,
            )

        await mqtt_util.async_publish(
            self.hass,
            mqtt_util.topic(T_PHASE_OUTPUT_POWER_SET, self.dev_id),
            payload,
        )

        # Optimistic update: the broker echo also lands in _handle_phase_output,
        # but this keeps the UI responsive when the echo is delayed.
        self.phase_output.update(payload)
        self.async_set_updated_data(dict(self.data))

    # ------------------------------------------------------------------
    # EMS mode select state (protocol §3 / §12)
    # ------------------------------------------------------------------
    @callback
    def _handle_ems_mode_command(self, msg: Any) -> None:
        """Echo a commanded EMS mode onto the select's state topic."""
        mode = _payload_to_text(msg.payload)
        if mode is None:
            return

        if mode not in EMS_MODES:
            return

        self._ems_mode_command_time = time.monotonic()
        if mode == self._ems_mode_state:
            return

        self.hass.async_create_task(self._async_publish_ems_mode_state(mode))

    async def _async_sync_ems_mode_state(self, mode: str) -> None:
        """Follow the mode the device actually reports in system/state."""
        if mode not in EMS_MODES or mode == self._ems_mode_state:
            return

        # A ``system/state`` tick landing right after a command can still carry
        # the previous mode; waiting for the next one avoids a flip back.
        if (
            time.monotonic() - self._ems_mode_command_time
        ) < EMS_MODE_ECHO_GUARD_SECONDS:
            return

        await self._async_publish_ems_mode_state(mode)

    async def _async_publish_ems_mode_state(self, mode: str) -> None:
        """Publish the EMS mode, retained so it survives a HA restart."""
        self._ems_mode_state = mode
        try:
            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_EMS_MODE_STATE, self.dev_id),
                mode,
                qos=1,
                retain=True,
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to publish the EMS mode state", exc_info=True)

    # ------------------------------------------------------------------
    # availability internals
    # ------------------------------------------------------------------
    async def _async_watchdog(self, _now: Any = None) -> None:
        """Mark the device unavailable once every source went stale."""
        if self._evaluate_availability() is False and self._available is not False:
            await self._async_publish_availability(False)

    @callback
    def _evaluate_availability(self) -> bool | None:
        """Return True/False, or None when nothing can be concluded yet."""
        now = time.monotonic()

        for source, window in SOURCE_STALE_SECONDS.items():
            last_seen = self._last_seen.get(source)
            if last_seen is not None and (now - last_seen) <= window:
                return True

        # Never seen anything at all: leave the retained value alone instead of
        # declaring a healthy device offline right after Home Assistant started.
        if not self._last_seen:
            return None

        return False

    async def _async_publish_availability(self, available: bool) -> None:
        """Publish an availability change and refresh the entities."""
        self._available = available
        payload = PAYLOAD_AVAILABLE if available else PAYLOAD_NOT_AVAILABLE

        try:
            await mqtt_util.async_publish(
                self.hass, self.availability_topic, payload, qos=1, retain=True
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to publish availability", exc_info=True)
            return

        _LOGGER.info("Hoymiles %s is now %s", self.dev_id, payload)
        self.async_set_updated_data(dict(self.data))

    # ------------------------------------------------------------------
    # state topics
    # ------------------------------------------------------------------
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

            if key in SOURCE_STALE_SECONDS:
                self._last_seen[key] = time.monotonic()

            data = dict(self.data)
            data[key] = payload
            self.async_set_updated_data(data)

            # A fresh message can only ever flip the verdict to available; the
            # watchdog is responsible for the opposite direction.
            if key in SOURCE_STALE_SECONDS and self._available is not True:
                self.hass.async_create_task(self._async_publish_availability(True))

            if key == SRC_SYSTEM:
                mode = payload.get("ems_mode")
                if isinstance(mode, str):
                    self.hass.async_create_task(self._async_sync_ems_mode_state(mode))

        return _handler
