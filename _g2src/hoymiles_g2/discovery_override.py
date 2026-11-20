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

Stale configs
    * every discovery object listed in
      :data:`const.LEGACY_DISCOVERY_OBJECTS` is **deleted** (empty retained
      payload) instead of patched.  An older firmware shipped a ``text`` entity
      per TOU day (``tou_day1`` .. ``tou_day8``) plus ``tou_week_plan``, using
      ``"mode": "textarea"`` - not a valid Home Assistant ``TextMode``, so the
      config was rejected on every single start.  The current firmware exposes
      the TOU plan through ``sensor/<dev_id>/tou_day_plan/set`` instead, so
      nothing is lost by removing them.

All patched payloads
    * get ``availability_topic`` + ``payload_available`` /
      ``payload_not_available``.  ``coordinator.py`` keeps that topic in sync
      with the data it receives, so the firmware entities turn ``unavailable``
      when the device stops pushing data instead of showing a stale value.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback

from . import mqtt_util
from .const import (
    CAP_EMS_MODE,
    CAP_FACTORY_RESET,
    CAP_OUTPUT_POWER,
    CAP_PHASE_OUTPUT,
    CAP_POWER_CTRL,
    CAP_REBOOT,
    CAP_RESET_BLE_PIN,
    CAP_SWITCH,
    DISCOVERY_PREFIX,
    FIRMWARE_DISCOVERY_TOPICS,
    LEGACY_DISCOVERY_OBJECTS,
    PAYLOAD_AVAILABLE,
    PAYLOAD_NOT_AVAILABLE,
    T_AVAILABILITY,
    T_EMS_MODE_STATE,
    T_SWITCH_SET,
)

_LOGGER = logging.getLogger(__name__)

# Seconds to wait after the device has proven it is talking to us before any
# retained config is deleted.  Deleting one is irreversible from our side (only
# the firmware can bring it back, and only by reconnecting), so the burst that
# carries the device's own topic set gets time to finish first.
PRUNE_DELAY_SECONDS: float = 20.0

# How long the echo of our own discovery publish is expected to come back.  The
# broker delivers it within milliseconds, but the publish is fire-and-forget, so
# the window is generous while still being short enough that a guard left behind
# by a broker that does not echo can never swallow the device's next publish.
OWN_PUBLISH_GRACE_SECONDS: float = 10.0

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
    """Point the EMS mode select at a topic that is actually published (P1-1).

    The firmware's retained discovery ships
    ``state_topic: hoymiles/<SN>/ems_mode/state`` but never publishes on it, so
    the select renders as ``unknown`` forever - the presence of a ``state_topic``
    is therefore *not* a reason to skip the patch.  Only the integration's own
    topic carries the mode, so the topic is rewritten unless it already is ours,
    which keeps the patch idempotent.
    """
    if payload.get("value_template"):
        # A template means the firmware extracts the mode from a payload it
        # really does send; leave that alone.
        return False

    wanted = T_EMS_MODE_STATE.format(dev_id=dev_id)
    if payload.get("state_topic") == wanted:
        return False

    payload["state_topic"] = wanted
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


def _removed_objects(dev_id: str) -> frozenset[str]:
    """Discovery object paths that are stale and must be deleted."""
    return frozenset(obj.format(dev_id=dev_id) for obj in LEGACY_DISCOVERY_OBJECTS)


def _object_path(topic: str) -> str | None:
    """Return ``<component>/<node>/<object>`` for a discovery topic."""
    prefix = f"{DISCOVERY_PREFIX}/"
    suffix = "/config"
    if not topic.startswith(prefix) or not topic.endswith(suffix):
        return None
    return topic[len(prefix) : -len(suffix)]


def _node_id(topic: str) -> str | None:
    """Return the node id (the serial) a discovery topic addresses."""
    path = _object_path(topic)
    if path is None:
        return None
    parts = path.split("/")
    if len(parts) < 2:
        return None
    return parts[1]


def _capability_objects(dev_id: str) -> tuple[tuple[str, str], ...]:
    """Discovery objects that prove a capability, as ``(path, capability)``.

    Only capabilities from ``supported_topics`` are listed: those are the ones
    the firmware states in a payload it re-publishes completely on every
    connection, so a key missing from that list is a real absence.  A discovery
    object on its own never proves absence - the firmware never withdraws one -
    which is why deletion is driven by the inventory and not by silence.
    """
    return (
        (f"switch/{dev_id}", CAP_SWITCH),
        (f"select/{dev_id}/ems_mode", CAP_EMS_MODE),
        (f"number/{dev_id}/phase_output_power", CAP_PHASE_OUTPUT),
        (f"number/{dev_id}/power_ctrl", CAP_POWER_CTRL),
        (f"number/{dev_id}/output_power", CAP_OUTPUT_POWER),
        (f"button/{dev_id}/reboot", CAP_REBOOT),
        (f"button/{dev_id}/factory_reset", CAP_FACTORY_RESET),
        (f"button/{dev_id}/reset_ble_pin_code", CAP_RESET_BLE_PIN),
    )


def _legacy_node_ids(dev_id: str) -> tuple[str, ...]:
    """Other node ids the same physical unit published discovery under.

    ``RMI-<SN>`` is the current scheme; some firmware builds registered the very
    same unit as ``MI-<SN>``, and those retained configs recreate a second set
    of entities on every Home Assistant start.  Only ids that keep the serial
    intact are considered, so this can never reach another device.
    """
    if dev_id.startswith("RMI-") and len(dev_id) > 4:
        return (f"MI-{dev_id[4:]}",)
    return ()


class FirmwareDiscoveryPatcher:
    """Keep the device's retained discovery payloads HA compliant.

    Termination relies on every patch being **idempotent**: republishing a
    corrected payload makes the device echo it back to us, the patch functions
    then find nothing left to do and stay silent.

    Deliberately *no* "already published" cache: the firmware republishes its
    own retained config on every MQTT reconnect, which overwrites the corrected
    payload on the broker. Such a cache would then suppress the repair and leave
    the broker parked on the unpatched version.
    """

    def __init__(self, hass: HomeAssistant, dev_id: str) -> None:
        self.hass = hass
        self.dev_id = dev_id
        self._patches = _managed_patches(dev_id)
        self._removed = _removed_objects(dev_id)
        self._unsubs: list[Callable[[], None]] = []
        # Discovery objects seen for this device.  Some capabilities have no
        # ``supported_topics`` entry at all (the multi phase output limit is one),
        # so the presence of their discovery object is the only signal.  Reported
        # through ``on_object`` so the coordinator can gate entities on it.
        self.on_object: Callable[[str, bool], None] | None = None
        self._seen_objects: set[str] = set()
        # Where each discovery config we saw actually lives, so a stale one can be
        # deleted at its real topic.  Keyed by ``<node>/<component>/<object>``
        # rather than by path, because the same object may be replayed under a
        # retired node id.
        self._object_topics: dict[str, str] = {}
        # ``node_id`` -> every object path seen for it.
        self._node_objects: dict[str, set[str]] = {}
        # Topics the firmware published **live** since this patcher started.
        # A retained replay must never be used to justify deleting or keeping
        # anything on its own.
        self._live_topics: set[str] = set()
        # Topics **we** are about to publish, with the monotonic time after which
        # the guard no longer applies.  MQTT delivers our own retained publish
        # back to our own subscription with ``retain=0`` - identical to a genuine
        # device publish - so without this the corrected payload we just wrote
        # would look like the device announcing that object right now.  Expiry
        # matters: the broker may not echo at all, and a stale entry would then
        # swallow the device's own next live publish of that topic.
        self._own_publishes: dict[str, float] = {}
        # The connection whose stale configs were already pruned.  0 = never,
        # which no real session can be (it starts at 1).
        self._pruned_session: int = 0
        self._prune_pending: bool = False

    async def async_setup(self) -> None:
        """Subscribe to the discovery topics of this device.

        Both the 4 level (``switch``) and the 5 level (``sensor``, ``number``,
        ``select``, ...) discovery topics are watched - missing one of them
        silently leaves that platform unpatched.
        """
        if mqtt_util.mqtt is None:  # pragma: no cover - mqtt is a dependency
            _LOGGER.warning("MQTT integration unavailable, discovery patching disabled")
            return

        # Subscribe for every node id this unit has used: the current serial plus
        # the retired ``MI-<SN>`` scheme some builds registered it under.  Without
        # the retired ids those retained configs are invisible here, so their
        # entities would be recreated on every start and never cleaned up.
        node_ids = (self.dev_id, *_legacy_node_ids(self.dev_id))
        topics: list[str] = []
        for node in node_ids:
            for pattern in FIRMWARE_DISCOVERY_TOPICS:
                topics.append(pattern.format(dev_id=node))

        for topic in topics:
            unsub = await mqtt_util.mqtt.async_subscribe(
                self.hass, topic, self._on_discovery_message, 1
            )
            self._unsubs.append(unsub)
            _LOGGER.debug("Watching firmware discovery topics on %s", topic)

    @callback
    def async_shutdown(self) -> None:
        """Stop watching discovery topics."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()

    @callback
    def _report_object(self, path: str, live: bool) -> None:
        """Tell the listener that a discovery object exists for this device.

        Only a **live** publish counts as a capability.  The broker replays every
        retained config to each new subscriber, so a config that merely came
        back was published by some earlier connection - possibly days ago, by a
        different firmware build, or over MQTTS by a unit that now links over
        plain MQTT.  Using it as proof is what left ``factory_reset``,
        ``reset_ble_pin_code`` and the ``switch`` object on a device that
        publishes none of them: they were patched onto the broker once and
        replayed on every start ever since.

        The object is still patched when it is replayed (that keeps the broker
        consistent), but it no longer grants an entity.
        """
        if not live:
            return
        if path in self._seen_objects:
            return
        self._seen_objects.add(path)

        if self.on_object is None:
            return
        # Resolve the capability from the very table the cleanup uses, so both
        # directions agree.  Deriving it from ``parts[2]`` only worked for the
        # 5-level objects and silently ignored ``switch`` (which is addressed as
        # ``switch/<dev_id>``); and the retired ``MI-`` node id never matches
        # that table, so a ghost config cannot justify a ghost entity.
        capability = dict(_capability_objects(self.dev_id)).get(path)
        if capability is None:
            return
        self.on_object(capability, True)

    @callback
    def _on_discovery_message(self, msg: Any) -> None:
        """Rewrite or delete a firmware discovery payload when it is not right."""
        path = _object_path(msg.topic)
        if path is None:
            return

        node = _node_id(msg.topic)
        if node is not None:
            # Key by node and *path* together (``<node>|<path>``) so the node can
            # be recovered exactly.  A plain ``/`` join is ambiguous - ``path``
            # already contains ``/`` - and splitting it back apart silently
            # produced an empty stale list, which is why nothing was ever pruned.
            self._object_topics[f"{node}|{path}"] = msg.topic
            self._node_objects.setdefault(node, set()).add(path)

        # ``retain`` separates the two kinds of delivery: True is the broker
        # playing back what it already had, False is this connection publishing
        # something new.  Only the second may justify an entity.
        live = getattr(msg, "retain", True) is False
        if live and self._is_own_publish(msg.topic):
            # The echo of a payload this integration wrote.  It says nothing
            # about what the device implements, so it is neither proof of a
            # capability nor a reason to keep an object alive.
            return
        if live:
            self._live_topics.add(msg.topic)

        # An empty payload is how a retained config gets deleted - either by us
        # a moment ago or by somebody else.  Nothing left to do, and skipping
        # early also keeps the echo of our own deletion out of the JSON parser.
        text = mqtt_util.payload_to_text(msg.payload)
        if text is None:
            return

        if path in self._removed:
            self.hass.async_create_task(self._async_remove(msg.topic))
            return

        self._report_object(path, live)

        patch = self._patches.get(path)
        if patch is None:
            return

        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            _LOGGER.warning("Ignoring non JSON discovery payload on %s: %s", msg.topic, text)
            return

        if not isinstance(payload, dict):
            return

        # Both patches must run - no short circuit, they touch different keys.
        changed = patch(self.dev_id, payload)
        changed = _patch_availability(self.dev_id, payload) or changed
        if not changed:
            # Already compliant, or this is the echo of our own correction.
            return

        rendered = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        self.hass.async_create_task(self._async_republish(msg.topic, rendered))

    @callback
    def _is_own_publish(self, topic: str) -> bool:
        """True when ``topic`` is the echo of a payload we just wrote.

        Consumed on first match: one publish produces at most one echo.  Expired
        entries are dropped rather than trusted, because a broker that does not
        echo would otherwise leave the guard armed forever and hide the device's
        own next publish of that topic.
        """
        deadline = self._own_publishes.pop(topic, None)
        return deadline is not None and time.monotonic() < deadline

    @callback
    def _mark_own_publish(self, topic: str) -> None:
        """Remember that the next live delivery on ``topic`` is ours."""
        self._own_publishes[topic] = time.monotonic() + OWN_PUBLISH_GRACE_SECONDS

    async def _async_republish(self, topic: str, payload: str) -> None:
        """Publish the corrected payload, retained so it survives HA restarts."""
        self._mark_own_publish(topic)
        try:
            await mqtt_util.async_publish(self.hass, topic, payload, qos=1, retain=True)
        except Exception:  # noqa: BLE001 - never break the entry on a publish error
            self._own_publishes.pop(topic, None)
            _LOGGER.warning("Unable to patch discovery payload on %s", topic, exc_info=True)
            return

        _LOGGER.info("Patched MQTT discovery payload on %s", topic)

    async def _async_remove(self, topic: str) -> None:
        """Delete a stale retained discovery config.

        An empty retained payload is the documented way to remove a discovery
        message from the broker; the topic then simply does not exist any more
        and drops out of the device's discovery topic set.
        """
        self._mark_own_publish(topic)
        try:
            await mqtt_util.async_publish(self.hass, topic, "", qos=1, retain=True)
        except Exception:  # noqa: BLE001 - never break the entry on a publish error
            self._own_publishes.pop(topic, None)
            _LOGGER.warning("Unable to remove stale discovery config on %s", topic, exc_info=True)
            return

        _LOGGER.info("Removed stale MQTT discovery config on %s", topic)

    # ------------------------------------------------------------------
    # pruning stale retained configs
    # ------------------------------------------------------------------
    @callback
    def async_schedule_prune(self, source: Callable[[], int]) -> None:
        """Delete the retained configs this connection did not publish.

        The rule is the device's own behaviour, not the ``supported_topics`` list:
        when the firmware connects it publishes **its whole discovery topic set**
        in one burst, and that burst - not the list - is what Home Assistant should
        mirror.  The list is demonstrably incomplete (it omits objects the device
        really does publish), so using it as the keep-set dropped working entities
        while keeping dead ones.

        Everything the burst did not include is therefore left over from an
        earlier connection: the broker keeps retained configs forever and replays
        them to every new subscriber, so without this a feature the firmware
        dropped keeps its entities forever, and a retired node id (``MI-<SN>``)
        comes back on every single restart.

        ``source`` yields the connection number.  Deduplication happens
        *synchronously* because the caller is a coordinator listener that fires
        every second: without the early return, one sleeping prune task per update
        would pile up.
        """
        try:
            session = source()
        except Exception:  # noqa: BLE001 - a caller bug must not break setup
            return
        if self._prune_pending or self._pruned_session == session:
            return
        self._prune_pending = True
        self.hass.async_create_task(
            self._async_prune(source, session),
            f"{DISCOVERY_PREFIX} prune stale configs for {self.dev_id}",
        )

    async def _async_prune(self, source: Callable[[], int], session: int) -> None:
        """Wait for the connect burst to settle, then delete what it left out."""
        try:
            await asyncio.sleep(PRUNE_DELAY_SECONDS)
            if source() != session:
                # The device connected while we were waiting, so the evidence this
                # pass would use belongs to a different connection.  Hand over to
                # a fresh pass - simply returning would lose it for good, because
                # the new connection's own scheduling attempt was rejected by
                # ``_prune_pending`` while this task was still alive.
                self._prune_pending = False
                self.async_schedule_prune(source)
                return
            # Mark this connection as handled even when there is nothing to do,
            # so an offline device cannot schedule a fresh pass on every tick.
            self._pruned_session = session
            if not self._live_topics:
                # Nothing was published live, so the device is not connected and
                # every config here came from the broker's replay.  Absence of a
                # live publish proves nothing about the device - deleting on it
                # would wipe a working setup the moment it went offline.
                _LOGGER.debug(
                    "No live discovery config seen for %s, skipping prune",
                    self.dev_id,
                )
                return

            # What the device itself announced this connection is the keep-set.
            live = set(self._live_topics)
            # Only objects this integration has an opinion about may be deleted.
            # Everything else on the discovery topic belongs to the firmware
            # (``sensor/<SN>/soc``, ``sensor/<SN>/bat_p``, ...) and is none of our
            # business - those entities are the device's own and must survive.
            managed = {path for path, _ in _capability_objects(self.dev_id)}
            retired_nodes = set(_legacy_node_ids(self.dev_id))

            stale: list[str] = []
            for key, topic in sorted(self._object_topics.items()):
                if topic in live:
                    # The device published this object on this very connection.
                    continue
                node, _, path = key.partition("|")
                if node in retired_nodes or (node == self.dev_id and path in managed):
                    stale.append(topic)

            removed = 0
            for topic in stale:
                await self._async_remove(topic)
                removed += 1

            # The evidence belonged to the connection just handled.  Clearing it
            # means the next connection is judged only on what it publishes, so a
            # reconnect that dropped objects loses the entities they justified.
            self._live_topics.clear()

            _LOGGER.warning(
                "Pruned %d stale discovery configs for %s (connection %d, "
                "%d objects published live: %s)",
                removed,
                self.dev_id,
                session,
                len(live),
                ", ".join(sorted(live)),
            )
        except Exception:  # noqa: BLE001 - pruning is never worth breaking setup
            _LOGGER.debug("Pruning discovery configs failed", exc_info=True)
        finally:
            self._prune_pending = False


__all__ = [
    "PHASE_COMMAND_TEMPLATE",
    "FirmwareDiscoveryPatcher",
]
