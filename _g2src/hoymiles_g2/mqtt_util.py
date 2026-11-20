"""Shared MQTT helpers for the Hoymiles integration."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

try:  # pragma: no cover - depends on HA version
    from homeassistant.components import mqtt
except ImportError:  # pragma: no cover
    mqtt = None  # type: ignore[assignment]


def topic(template: str, dev_id: str) -> str:
    """Render a topic template for a given device id."""
    return template.format(dev_id=dev_id)


def dumps(payload: Any) -> str:
    """Serialise a payload to compact JSON (or pass strings through)."""
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def payload_to_text(payload: Any) -> str | None:
    """Normalise a received MQTT payload into a stripped ``str``.

    Home Assistant hands over a ``str`` for every payload that decodes as UTF-8
    and ``bytes`` only for the rest, so both must be accepted - calling
    ``.decode()`` unconditionally raises ``AttributeError`` on the common path.

    Returns ``None`` for undecodable or empty payloads; an empty payload is the
    MQTT way of deleting a retained message, not a value to act upon.
    """
    if isinstance(payload, bytes):
        try:
            payload = payload.decode()
        except UnicodeDecodeError:
            return None

    if not isinstance(payload, str):
        return None

    text = payload.strip()
    return text or None


async def async_publish(
    hass: HomeAssistant,
    topic_str: str,
    payload: Any,
    *,
    qos: int = 1,
    retain: bool = False,
) -> None:
    """Publish a payload through the Home Assistant MQTT integration."""
    if mqtt is None:  # pragma: no cover
        raise RuntimeError("The MQTT integration is not available")
    await mqtt.async_publish(hass, topic_str, dumps(payload), qos, retain)


async def async_wait_for_message(
    hass: HomeAssistant,
    topic_str: str,
    *,
    timeout: float = 5.0,
    qos: int = 1,
) -> dict[str, Any] | None:
    """Subscribe to a topic, wait for the first JSON message, then unsubscribe.

    Returns the parsed payload, or ``None`` on timeout / parse failure.  This is
    used by the options flow and services to await an ack from the device.
    """
    if mqtt is None:  # pragma: no cover
        raise RuntimeError("The MQTT integration is not available")

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any] | None] = loop.create_future()

    def _message_received(msg: Any) -> None:
        if future.done():
            return
        try:
            future.set_result(json.loads(msg.payload))
        except (ValueError, TypeError):
            future.set_result(None)

    unsub = await mqtt.async_subscribe(hass, topic_str, _message_received, qos)

    try:
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        _LOGGER.debug("Timeout waiting for a message on %s", topic_str)
        return None
    finally:
        unsub()


async def async_discover_dev_ids(
    hass: HomeAssistant, *, timeout: float = 5.0
) -> list[str]:
    """Collect device ids that are alive on the broker right now.

    Two subscriptions are needed, and the second one is what makes this honest:

    * ``homeassistant/switch/<dev_id>/config`` is the discovery config.  It is
      **retained**, so the broker keeps it forever - a device that has been
      unplugged for weeks still shows up here.  It therefore only provides
      *candidates*.
    * ``homeassistant/sensor/<dev_id>/quick/state`` is pushed once a second and
      is **not** retained.  Receiving one proves the device is talking to the
      broker right now, so that is what a candidate has to do to be returned.

    A device is thus only offered while its per-second stream is running; once
    it stops, the candidate list goes back to the retained configs and the dead
    device drops out.

    ``<dev_id>`` is ``"<client_prefix>-<SN>"``.  The prefix is a **user
    setting** - it is the MQTT client prefix and may be renamed to anything - so
    a device must never be recognised by it.  It is recognised by the **PID**
    instead: the four digits at the start of the serial (``1650`` / ``4160`` /
    ``4161`` / ``4162`` for the inverters, ``2800`` for the storage units).
    Only serials whose PID can be read are offered, which also keeps unrelated
    MQTT devices that publish under ``homeassistant/`` out of the picker.

    The **full** id is returned, prefix included, because that prefix is part of
    every topic the device publishes and therefore part of every topic this
    integration has to talk to.  It is only the *recognition* that ignores it.
    """
    if mqtt is None:  # pragma: no cover
        return []

    from .const import (  # noqa: PLC0415
        KNOWN_PIDS,
        T_DISCOVERY,
        T_QUICK_WILDCARD,
        serial_pid,
    )

    candidates: set[str] = set()
    alive: set[str] = set()

    def _recognise(dev_id: str, topic_str: str) -> bool:
        pid = serial_pid(dev_id)
        if pid is None or pid not in KNOWN_PIDS:
            _LOGGER.debug(
                "Skipping %s: product id %r not recognised", topic_str, pid
            )
            return False
        return True

    def _on_config(msg: Any) -> None:
        # ``homeassistant/<component>/<dev_id>/config`` -> parts[2] is the id.
        # Deeper discovery topics (``.../<dev_id>/soc/config``) still carry the
        # same id in parts[2], and a wildcard the firmware did not expand would
        # be rejected by the PID check below.
        parts = str(msg.topic).split("/")
        if len(parts) < 4 or not parts[2]:
            return
        if _recognise(parts[2], msg.topic):
            candidates.add(parts[2])

    def _on_quick(msg: Any) -> None:
        # ``homeassistant/sensor/<dev_id>/quick/state`` -> parts[2] is the id.
        parts = str(msg.topic).split("/")
        if len(parts) >= 4 and parts[2] and parts[3] == "quick":
            alive.add(parts[2])

    unsub_config = await mqtt.async_subscribe(hass, T_DISCOVERY, _on_config, 1)
    unsub_quick = await mqtt.async_subscribe(hass, T_QUICK_WILDCARD, _on_quick, 0)
    try:
        await asyncio.sleep(timeout)
    finally:
        unsub_config()
        unsub_quick()

    if not alive:
        _LOGGER.debug(
            "Discovered %d device id(s) on retained configs but none is sending "
            "quick/state right now",
            len(candidates),
        )

    return sorted(alive)


__all__ = [
    "DOMAIN",
    "async_discover_dev_ids",
    "async_publish",
    "async_wait_for_message",
    "dumps",
    "payload_to_text",
    "topic",
]
