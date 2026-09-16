"""Adapt the firmware's MQTT discovery payloads to Home Assistant's schemas.

The firmware registers a handful of entities itself through MQTT discovery
(see 《禾迈微储MQTT协议开发指南》§1, §3, §5, §6, §8).  Some of those payloads do
not satisfy Home Assistant's per-domain schema, or they miss keys that are
needed for a good user experience (statistics, availability, ...).

Changing a payload normally means re-flashing the device, but discovery is
nothing more than a **retained payload on a topic**.  The integration therefore
patches the payload in place: it subscribes to the discovery topics of its own
device, rewrites the JSON when something is off and republishes it with
``retain=True``.

Every patch is **idempotent and guarded**: a payload that is already compliant is
left untouched and *not* republished.  That makes this layer a no-op as soon as
the firmware itself is fixed, and it can be deleted then.

Patches
-------
``switch/<dev_id>``
    * add ``command_topic`` when it is missing.  Firmware <= 1.3.101 commented
      the key out, which made Home Assistant reject the whole payload with
      ``required key not provided @ data['command_topic']``.
    * remove ``state_topic`` when there is no ``value_template``.  The referenced
      topic (``device/state``) carries a nested JSON document, so the switch
      could never resolve to ``ON``/``OFF`` and its state stayed ``unknown``
      forever.  The entity becomes optimistic, which matches the hardware:
      ``ON`` wakes the device, ``OFF`` puts it to sleep, and there is no
      readable power state to report.
``select/<dev_id>/ems_mode``
    * add ``state_topic`` pointing at an integration owned topic.  The firmware
      select has no state topic at all, so it read ``unknown`` after every Home
      Assistant restart.  ``coordinator.py`` keeps that topic in sync with the
      last commanded value and with the mode the device reports in
      ``system/state``.
``sensor/<dev_id>/soc``, ``sensor/<dev_id>/bat_p``
    * add ``state_class: measurement`` so Home Assistant records long term
      statistics for them.
``number/<dev_id>/phase_output_power``
    * add ``command_template``.  The firmware expects
      ``{"phase_a":..,"phase_b":..,"phase_c":..}``, but a plain ``number``
      entity can only publish the slider value, which made the entity unusable.
      The template wraps the value and applies it to all three phases; per phase
      control is offered by ``number.py`` and ``hoymiles.set_phase_output_power``.
``number/<dev_id>/power_ctrl``, ``number/<dev_id>/output_power``,
``button/<dev_id>/reboot``
    * functionally untouched, only made availability aware.

All patched payloads
    * get ``availability_topic`` + ``payload_available`` /
      ``payload_not_available``.  ``coordinator.py`` keeps that topic in sync
      with the data it receives, so the firmware entities turn ``unavailable``
      when the device stops pushing data instead of showing a stale value.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback

from . import mqtt_util
from .const import (
    DISCOVERY_PREFIX,
    PAYLOAD_AVAILABLE,
    PAYLOAD_NOT_AVAILABLE,
    T_AVAILABILITY,
    T_EMS_MODE_STATE,
    T_FIRMWARE_DISCOVERY,
    T_SWITCH_SET,
)

_LOGGER = logging.getLogger(__name__)

# A ``number`` command template that turns the slider value into the JSON object
# the firmware parses in ``HmMqttApplyPhaseOutputPowerPayload``.
PHASE_COMMAND_TEMPLATE = (
    '{"phase_a":{{ value }},"phase_b":{{ value }},"phase_c":{{ value }}}'
)

# A patch returns True when it modified the payload.
PatchFn = Callable[[str, dict[str, Any]], bool]


def _patch_switch(dev_id: str, payload: dict[str, Any]) -> bool:
    """Fix the ``switch`` discovery payload (P0-1)."""
    changed = False

    if not payload.get("command_topic"):
        payload["command_topic"] = T_SWITCH_SET.format(dev_id=dev_id)
        changed = True

    # Only drop the state topic when the payload cannot extract ON/OFF from it -
    # if the firmware ever ships a proper value_template we keep it.
    if payload.get("state_topic") and not payload.get("value_template"):
        payload.pop("state_topic", None)
        changed = True

    return changed


def _patch_ems_mode(dev_id: str, payload: dict[str, Any]) -> bool:
    """Make the EMS mode select keep its value across restarts (P1-1)."""
    if payload.get("state_topic") or payload.get("value_template"):
        return False

    payload["state_topic"] = T_EMS_MODE_STATE.format(dev_id=dev_id)
    return True


def _patch_measurement(dev_id: str, payload: dict[str, Any]) -> bool:
    """Enable statistics for soc / bat_p (P1-2)."""
    del dev_id
    if payload.get("state_class"):
        return False

    payload["state_class"] = "measurement"
    return True


def _patch_phase_output(dev_id: str, payload: dict[str, Any]) -> bool:
    """Make the firmware's phase output number usable (P0-2)."""
    del dev_id
    if payload.get("command_template"):
        return False

    payload["command_template"] = PHASE_COMMAND_TEMPLATE
    return True


def _patch_plain(dev_id: str, payload: dict[str, Any]) -> bool:
    """No functional change, only availability is added."""
    del dev_id, payload
    return False


def _patch_availability(dev_id: str, payload: dict[str, Any]) -> bool:
    """Add an availability topic driven by the integration (P1-4)."""
    if payload.get("availability_topic") or payload.get("availability"):
        return False

    payload["availability_topic"] = T_AVAILABILITY.format(dev_id=dev_id)
    payload["payload_available"] = PAYLOAD_AVAILABLE
    payload["payload_not_available"] = PAYLOAD_NOT_AVAILABLE
    return True


def _managed_patches(dev_id: str) -> dict[str, PatchFn]:
    """Discovery object paths (``<component>/<node>/<object>``) we manage."""
    return {
        f"switch/{dev_id}": _patch_switch,
        f"select/{dev_id}/ems_mode": _patch_ems_mode,
        f"sensor/{dev_id}/soc": _patch_measurement,
        f"sensor/{dev_id}/bat_p": _patch_measurement,
        f"number/{dev_id}/phase_output_power": _patch_phase_output,
        f"number/{dev_id}/power_ctrl": _patch_plain,
        f"number/{dev_id}/output_power": _patch_plain,
        f"button/{dev_id}/reboot": _patch_plain,
    }


def _object_path(topic: str) -> str | None:
    """Return ``<component>/<node>/<object>`` for a discovery topic."""
    prefix = f"{DISCOVERY_PREFIX}/"
    suffix = "/config"
    if not topic.startswith(prefix) or not topic.endswith(suffix):
        return None
    return topic[len(prefix) : -len(suffix)]


class FirmwareDiscoveryPatcher:
    """Keep the device's retained discovery payloads HA compliant."""

    def __init__(self, hass: HomeAssistant, dev_id: str) -> None:
        self.hass = hass
        self.dev_id = dev_id
        self._patches = _managed_patches(dev_id)
        self._unsub: Callable[[], None] | None = None
        # Last payload we published per discovery topic, used to stop ourselves
        # from republishing the same correction in a loop.
        self._published: dict[str, str] = {}

    async def async_setup(self) -> None:
        """Subscribe to the discovery topics of this device."""
        if mqtt_util.mqtt is None:  # pragma: no cover - mqtt is a dependency
            _LOGGER.warning("MQTT integration unavailable, discovery patching disabled")
            return

        topic = T_FIRMWARE_DISCOVERY.format(dev_id=self.dev_id)
        self._unsub = await mqtt_util.mqtt.async_subscribe(
            self.hass, topic, self._on_discovery_message, 1
        )
        _LOGGER.debug("Watching firmware discovery topics on %s", topic)

    @callback
    def async_shutdown(self) -> None:
        """Stop watching discovery topics."""
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    @callback
    def _on_discovery_message(self, msg: Any) -> None:
        """Rewrite a firmware discovery payload when it is not compliant."""
        path = _object_path(msg.topic)
        if path is None:
            return

        patch = self._patches.get(path)
        if patch is None:
            return

        try:
            payload = json.loads(msg.payload)
        except (ValueError, TypeError):
            _LOGGER.warning(
                "Ignoring non JSON discovery payload on %s: %s", msg.topic, msg.payload
            )
            return

        if not isinstance(payload, dict):
            return

        # Both patches must run - no short circuit, they touch different keys.
        changed = patch(self.dev_id, payload)
        changed = _patch_availability(self.dev_id, payload) or changed
        if not changed:
            return

        rendered = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        if self._published.get(path) == rendered:
            return

        # Remember before publishing so the echo of our own message is ignored.
        self._published[path] = rendered
        self.hass.async_create_task(self._async_republish(msg.topic, rendered, path))

    async def _async_republish(self, topic: str, payload: str, path: str) -> None:
        """Publish the corrected payload, retained so it survives HA restarts."""
        try:
            await mqtt_util.async_publish(self.hass, topic, payload, qos=1, retain=True)
        except Exception:  # noqa: BLE001 - never break the entry on a publish error
            self._published.pop(path, None)
            _LOGGER.warning("Unable to patch discovery payload on %s", topic, exc_info=True)
            return

        _LOGGER.info("Patched MQTT discovery payload on %s", topic)


__all__ = [
    "PHASE_COMMAND_TEMPLATE",
    "FirmwareDiscoveryPatcher",
]
