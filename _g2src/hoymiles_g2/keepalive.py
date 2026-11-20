"""Server side keep-alive for the power-control lease (protocol §13).

``power_ctrl`` is a *lease*, not a setting: the firmware honours the value for
roughly a minute and then silently falls back to ``output_power``.  Holding a
power limit therefore means re-publishing it on a period - a single send always
ends up looking like "the device ignored me after a while".

The bundled card used to do that with a browser ``setTimeout``.  That works
exactly while the dashboard stays open in the foreground and dies the moment the
user navigates away, closes the tab or lets the phone sleep - which is precisely
when the lease needs to be held.  This module keeps the beat inside Home
Assistant instead: it survives page navigation and browser restarts, and it
publishes its own running state to a retained topic so every dashboard shows the
same truth after a reload.

Two deliberate limitations:

* No persistence across a Home Assistant restart.  A value re-imposed days later
  would be a surprise, so arming it is always an explicit act.
* It stops itself when the device is switched away from ``mqtt_ctrl``.  Every
  other EMS mode ignores ``power_ctrl``, so continuing would only add broker
  traffic and leave a stale value waiting to be applied the moment somebody
  switches back.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Callable

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from . import mqtt_util
from .const import (
    EMS_MODE_MQTT_CTRL,
    POWER_CTRL_KEEPALIVE_DEFAULT_S,
    POWER_CTRL_KEEPALIVE_MAX_S,
    POWER_CTRL_KEEPALIVE_MIN_S,
    POWER_CTRL_LEASE_SECONDS,
    T_POWER_CTRL_KEEPALIVE,
    T_POWER_CTRL_SET,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .coordinator import HoymilesCoordinator

_LOGGER = logging.getLogger(__name__)

# Publishing can fail for a moment while Home Assistant rebuilds the MQTT
# connection, so a single error must not kill the beat.  After this many in a row
# the keep-alive gives up and says so, instead of hammering a broker that is not
# there and pretending it is holding the value.
MAX_CONSECUTIVE_ERRORS = 5


def clamp_period(raw: Any) -> int:
    """Return a usable period in seconds.

    Anything unparsable falls back to the default rather than stopping the beat:
    a bad number in a dashboard field must never be the reason a lease lapses.
    """
    try:
        value = int(round(float(raw)))
    except (TypeError, ValueError):
        return POWER_CTRL_KEEPALIVE_DEFAULT_S
    if value <= 0:
        return POWER_CTRL_KEEPALIVE_DEFAULT_S
    return min(max(value, POWER_CTRL_KEEPALIVE_MIN_S), POWER_CTRL_KEEPALIVE_MAX_S)


class PowerCtrlKeepAlive:
    """Re-publish one device's ``power_ctrl`` value on a fixed period."""

    def __init__(
        self,
        hass: HomeAssistant,
        dev_id: str,
        coordinator: HoymilesCoordinator | None = None,
        *,
        on_change: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._hass = hass
        self._dev_id = dev_id
        self._coordinator = coordinator
        self._on_change = on_change

        self._unsub: Callable[[], None] | None = None
        self._enabled = False
        self._power: float | None = None
        self._period = POWER_CTRL_KEEPALIVE_DEFAULT_S
        self._count = 0
        self._last_at: int | None = None  # epoch milliseconds
        self._error: str | None = None
        self._errors_in_a_row = 0

    # ------------------------------------------------------------------
    # state
    # ------------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        """Return True while the beat is running."""
        return self._enabled

    @property
    def period(self) -> int:
        """Period in seconds (meaningful while enabled)."""
        return self._period

    @property
    def power(self) -> float | None:
        """The wattage being held, if any."""
        return self._power

    def as_dict(self) -> dict[str, Any]:
        """Return the published running state."""
        return {
            "enabled": self._enabled,
            "period": self._period,
            "power": self._power,
            "count": self._count,
            "last_at": self._last_at,
            "error": self._error,
        }

    # ------------------------------------------------------------------
    # control
    # ------------------------------------------------------------------
    async def async_start(self, power: float, period: Any) -> dict[str, Any]:
        """Start (or retune) the beat and send the first value straight away."""
        new_power = float(power)
        # Retuning an active beat (the period field changed) must not look like
        # a fresh start: resetting the counter would make the dashboard claim
        # "sent once" after a value that had already been held for minutes.
        # Only a new target or a restart from idle resets the bookkeeping.
        same_target = self._enabled and self._power == new_power

        self._power = new_power
        self._period = clamp_period(period)
        self._errors_in_a_row = 0
        self._error = None

        # The interval is baked into the tracker, so a new period means a new
        # tracker.  Doing it unconditionally keeps start() and retune() one path.
        self._async_cancel_timer()
        self._enabled = True
        if not same_target:
            self._count = 0
            self._last_at = None

        if self._period >= POWER_CTRL_LEASE_SECONDS:
            # Not an error: the user may genuinely want a slow beat.  But the
            # value will lapse for the tail of every period, so say so rather
            # than let it look like the device is misbehaving again.
            _LOGGER.warning(
                "Power control keep-alive for %s runs every %ss, which is at or "
                "beyond the firmware's ~%ss lease - the value will lapse between "
                "sends",
                self._dev_id,
                self._period,
                POWER_CTRL_LEASE_SECONDS,
            )

        # Send before scheduling: the user just pressed the switch and expects
        # the device to react now, not one period from now.
        await self._async_tick()
        if self._enabled:
            self._async_schedule()
        return self.as_dict()

    async def async_publish_initial_state(self) -> None:
        """Publish the idle state once, so a dashboard has something to read.

        Called at setup.  Without it the entity exists but carries no
        attributes until the first start, and the card would render its default
        guess instead of the truth.
        """
        await self._async_publish_state()

    async def async_stop(self, reason: str | None = None) -> dict[str, Any]:
        """Stop the beat and publish the final state."""
        was_enabled = self._enabled
        self._async_cancel_timer()
        self._enabled = False
        self._errors_in_a_row = 0
        if reason:
            self._error = reason
        if was_enabled:
            _LOGGER.debug(
                "Power control keep-alive for %s stopped%s",
                self._dev_id,
                f" ({reason})" if reason else "",
            )
        await self._async_publish_state()
        return self.as_dict()

    async def async_shutdown(self) -> None:
        """Tear down on entry unload, leaving a truthful retained state."""
        self._async_cancel_timer()
        if not self._enabled:
            return
        self._enabled = False
        self._error = "integration unloaded"
        await self._async_publish_state()

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _async_schedule(self) -> None:
        self._unsub = async_track_time_interval(
            self._hass, self._async_handle_tick, timedelta(seconds=self._period)
        )

    def _async_cancel_timer(self) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    async def _async_handle_tick(self, _now: Any = None) -> None:
        """Interval callback: one publish, then either keep going or stop."""
        if not self._enabled:
            return
        await self._async_tick()
        if not self._enabled:
            self._async_cancel_timer()

    async def _async_tick(self) -> None:
        """Publish the value once and update the running state."""
        if not self._enabled:
            return

        # Leaving mqtt_ctrl makes the value a no-op.  Stopping is friendlier than
        # publishing into the void, and it means a stale power limit cannot be
        # re-imposed the moment somebody switches back.
        mode = getattr(self._coordinator, "ems_mode", None)
        if mode is not None and mode != EMS_MODE_MQTT_CTRL:
            await self.async_stop(f"EMS mode is {mode}, not {EMS_MODE_MQTT_CTRL}")
            return

        if self._power is None:  # pragma: no cover - start() always sets it
            await self.async_stop("no power value")
            return

        try:
            await mqtt_util.async_publish(
                self._hass,
                mqtt_util.topic(T_POWER_CTRL_SET, self._dev_id),
                str(int(self._power)),
            )
        except Exception as err:  # noqa: BLE001 - never kill the beat on one error
            self._errors_in_a_row += 1
            self._error = str(err)
            _LOGGER.debug(
                "Power control keep-alive for %s could not publish (%s/%s)",
                self._dev_id,
                self._errors_in_a_row,
                MAX_CONSECUTIVE_ERRORS,
                exc_info=True,
            )
            if self._errors_in_a_row >= MAX_CONSECUTIVE_ERRORS:
                await self.async_stop(f"publish failed: {err}")
                return
            await self._async_publish_state()
            return

        self._errors_in_a_row = 0
        self._error = None
        self._count += 1
        self._last_at = int(time.time() * 1000)
        await self._async_publish_state()

    async def _async_publish_state(self) -> None:
        """Publish the running state, retained, for every dashboard to read."""
        payload = self.as_dict()
        try:
            await mqtt_util.async_publish(
                self._hass,
                mqtt_util.topic(T_POWER_CTRL_KEEPALIVE, self._dev_id),
                payload,
                qos=1,
                retain=True,
            )
        except Exception:  # noqa: BLE001 - bookkeeping must never raise
            _LOGGER.debug(
                "Unable to publish the keep-alive state for %s",
                self._dev_id,
                exc_info=True,
            )
        if self._on_change is not None:
            try:
                self._on_change(payload)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Keep-alive state callback failed", exc_info=True)
