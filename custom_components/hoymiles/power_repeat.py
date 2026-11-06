"""Server side repeat of the MQTT power setpoint.

Why the timer lives here and not in the card
--------------------------------------------
``power_ctrl`` is a lease, not a setting: the firmware drops it unless the same
value is re-published at least once a minute (protocol §14), and then goes back
to regulating the charge and discharge power on its own.

The bundled card used to own that timer - a ``setTimeout`` inside the web
component.  Every navigation in Lovelace throws the view's elements away, so
``disconnectedCallback()`` cleared the timeout and the setpoint died with the
card, while the switch on screen still said "on".  The same happened whenever
the browser throttled a background tab, which it does to every timer of a page
that is not visible.

Keeping the timer next to the state it protects fixes all of that: it survives
page changes, a closed browser and a sleeping phone, and it is the same for
every client that looks at the dashboard.

Deliberately **not** restored across a Home Assistant restart.  The device does
not keep the setpoint across one either, so resurrecting a stale value would
command hardware the user can no longer see - after a restart the switch reads
"off" and the setpoint has to be sent again on purpose.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from . import mqtt_util
from .const import DOMAIN, T_POWER_CTRL_SET

_LOGGER = logging.getLogger(__name__)

# Stored in ``hass.data[DOMAIN]`` next to the ``_services_registered`` flags.
DATA_KEY: str = "_power_ctrl_repeat"


@dataclass
class PowerRepeat:
    """One device's re-publish job."""

    dev_id: str
    value: int
    interval: int
    last_sent: datetime
    cancel: Callable[[], None] | None = None


class PowerRepeatManager:
    """One re-publish job per device, keyed by ``dev_id``."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._items: dict[str, PowerRepeat] = {}

    # ------------------------------------------------------------------ query

    def active(self, dev_id: str) -> PowerRepeat | None:
        """The running job for a device, if any."""
        return self._items.get(dev_id)

    def snapshot(self, dev_id: str) -> dict[str, Any]:
        """Everything the card needs to draw the countdown.

        ``next_in`` is computed here rather than in the browser: it is the only
        place that knows when the last publish really happened, and a countdown
        derived from a timestamp the client guesses is exactly how the old
        version ended up saying "next in 0 s" while nothing was running.
        """
        item = self._items.get(dev_id)
        if item is None:
            return {"active": False, "dev_id": dev_id}
        due = item.last_sent + timedelta(seconds=item.interval)
        remaining = (due - dt_util.utcnow()).total_seconds()
        return {
            "active": True,
            "dev_id": dev_id,
            "value": item.value,
            "interval": item.interval,
            "next_in": max(0, int(remaining + 0.999)),
            "last_sent": item.last_sent.isoformat(),
        }

    # ------------------------------------------------------------------ write

    async def async_start(self, dev_id: str, value: int, interval: int) -> None:
        """Start (or restart) the repeat, publishing ``value`` once right away."""
        await self.async_stop(dev_id)

        item = PowerRepeat(
            dev_id=dev_id,
            value=value,
            interval=interval,
            last_sent=dt_util.utcnow(),
        )
        self._items[dev_id] = item

        # Send before arming: a user pressing Send expects the value on the
        # broker now, not one interval from now.
        await self._async_publish(item)

        async def _tick(_now: datetime) -> None:
            await self._async_tick(item)

        item.cancel = async_track_time_interval(
            self.hass, _tick, timedelta(seconds=interval)
        )
        _LOGGER.debug(
            "power_ctrl %s W for %s will be re-published every %s s",
            value,
            dev_id,
            interval,
        )

    async def async_stop(self, dev_id: str) -> bool:
        """Cancel the job for one device; returns whether one was running."""
        item = self._items.pop(dev_id, None)
        if item is None:
            return False
        if item.cancel is not None:
            item.cancel()
            item.cancel = None
        _LOGGER.debug("power_ctrl repeat for %s stopped", dev_id)
        return True

    async def async_stop_all(self) -> None:
        """Cancel every job (integration unload)."""
        for dev_id in list(self._items):
            await self.async_stop(dev_id)

    # ---------------------------------------------------------------- private

    async def _async_tick(self, item: PowerRepeat) -> None:
        # The entry may have been replaced by a newer start already; publishing
        # a superseded value would fight the job that replaced it.
        if self._items.get(item.dev_id) is not item:
            return
        await self._async_publish(item)

    async def _async_publish(self, item: PowerRepeat) -> None:
        try:
            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_POWER_CTRL_SET, item.dev_id),
                str(item.value),
            )
        except Exception:  # noqa: BLE001 - a failed tick must not kill the job
            # Keep the job alive: the next tick retries. `last_sent` is left
            # alone so the countdown shows the value as overdue instead of
            # pretending it went out.
            _LOGGER.warning(
                "Could not publish power_ctrl %s W for %s",
                item.value,
                item.dev_id,
                exc_info=True,
            )
            return
        item.last_sent = dt_util.utcnow()


def get_manager(hass: HomeAssistant) -> PowerRepeatManager:
    """Return the manager for this Home Assistant instance, creating it once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    manager = domain_data.get(DATA_KEY)
    if not isinstance(manager, PowerRepeatManager):
        manager = PowerRepeatManager(hass)
        domain_data[DATA_KEY] = manager
    return manager
