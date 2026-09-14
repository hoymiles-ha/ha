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
    hass: HomeAssistant, *, timeout: float = 3.0
) -> list[str]:
    """Collect device ids from retained discovery topics.

    The firmware publishes ``homeassistant/switch/<dev_id>/config`` on connect,
    so simply subscribing for a few seconds surfaces every reachable device.
    """
    if mqtt is None:  # pragma: no cover
        return []

    from .const import T_DISCOVERY  # noqa: PLC0415  (avoid cycles at import time)

    found: set[str] = set()

    def _message_received(msg: Any) -> None:
        parts = msg.topic.split("/")
        if len(parts) >= 4 and parts[2]:
            found.add(parts[2])

    unsub = await mqtt.async_subscribe(hass, T_DISCOVERY, _message_received, 1)
    try:
        await asyncio.sleep(timeout)
    finally:
        unsub()

    return sorted(found)


__all__ = [
    "DOMAIN",
    "async_discover_dev_ids",
    "async_publish",
    "async_wait_for_message",
    "dumps",
    "topic",
]
