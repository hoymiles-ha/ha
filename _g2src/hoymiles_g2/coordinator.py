"""Data coordinator for the Hoymiles Micro Storage integration.

The firmware pushes state over MQTT; this coordinator subscribes to the topics
and fans the decoded JSON out to the entities.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import (
    async_track_point_in_time,
    async_track_time_interval,
)
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from . import mqtt_util, region
from .const import (
    AVAILABILITY_STARTUP_GRACE_SECONDS,
    AVAILABILITY_WATCHDOG_SECONDS,
    DOMAIN,
    EMS_MODE_ECHO_GUARD_SECONDS,
    EMS_MODES,
    PAYLOAD_AVAILABLE,
    PAYLOAD_NOT_AVAILABLE,
    PHASE_POWER_MIN,
    PHASES,
    PV_COUNT_MAX,
    ROLE_ALIASES,
    ROLES,
    SOURCE_CAPABILITY,
    SOURCE_STALE_SECONDS,
    SRC_ALARM,
    SRC_DEVICE,
    SRC_EVENT,
    SRC_KEEPALIVE,
    SRC_QUICK,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    T_ALARM_STATE,
    T_ATTRIBUTES,
    T_AVAILABILITY,
    T_DEVICE_STATE,
    T_EMS_MODE_CMD,
    T_EMS_MODE_STATE,
    T_EVENT_STATE,
    T_PHASE_OUTPUT_POWER_SET,
    T_QUICK_STATE,
    T_SYSTEM_STATE,
    T_TOU_DAY_ACK,
    T_TOU_STATUS,
    T_TOU_WEEK_ACK,
    model_from_dev_id,
    pv_count_from_dev_id,
)

_LOGGER = logging.getLogger(__name__)

# (coordinator data key, topic template, qos)
SUBSCRIPTIONS: tuple[tuple[str, str, int], ...] = (
    (SRC_QUICK, T_QUICK_STATE, 0),
    (SRC_DEVICE, T_DEVICE_STATE, 1),
    (SRC_SYSTEM, T_SYSTEM_STATE, 1),
    (SRC_EVENT, T_EVENT_STATE, 1),
    (SRC_ALARM, T_ALARM_STATE, 1),
    (SRC_TOU_STATUS, T_TOU_STATUS, 1),
    (SRC_TOU_DAY_ACK, T_TOU_DAY_ACK, 1),
    (SRC_TOU_WEEK_ACK, T_TOU_WEEK_ACK, 1),
)

# How long platform setup waits for the retained payloads that tell it which
# topics this device actually has.  Both carriers are retained on the broker
# (``attributes`` and every state topic the firmware publishes itself), so on a
# healthy connection the answer arrives within a few hundred milliseconds; the
# timeout only costs time on a broker that lost them, in which case the device
# simply gets no entities until its first message - see ``capabilities``.
CAPABILITIES_TIMEOUT_SECONDS: Final = 3.0


def _today_counter_of(payload: dict[str, Any]) -> float | None:
    """Sum of the per-port 「今日」 energy counters in one ``device/state``.

    The firmware reports today's yield per PV input (``pvs[].ed``, Wh) and has no
    aggregate of its own, so the sum over whatever the payload contains is the
    number ``system_pv_energy_today`` / ``pv<n>_energy_today`` / the plant gauge
    are all built from.  ``None`` when the payload carries no usable entry, which
    keeps "this build does not report it" out of the accounting below.
    """
    items = payload.get("pvs")
    if not isinstance(items, list):
        return None

    total = 0.0
    seen = False
    for item in items:
        if not isinstance(item, dict):
            continue
        value = item.get("ed")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        total += float(value)
        seen = True
    return total if seen else None


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
        # When setup finished, so the ``None`` verdict below can expire.
        self._startup_time = time.monotonic()
        # None = no verdict yet.  Staying available until proven silent keeps a
        # Home Assistant restart from blanking out every entity instantly.
        self._available: bool | None = None
        # Capabilities this device actually has, in three parts, each with a
        # different lifetime:
        #
        #   _inventory  the ``supported_topics`` list from the retained
        #               ``attributes`` payload.  Replaced WHOLESALE on every
        #               message, because the firmware re-publishes its complete
        #               list each time it connects: if a reconnect advertises
        #               fewer topics (a device that linked over MQTTS instead of
        #               plain MQTT does exactly that), the set has to be allowed
        #               to shrink or the page keeps claiming features it no
        #               longer has.
        #   _declared   extras proven outside that list - the multi phase output
        #               limit and the ``button`` / ``switch`` objects only exist
        #               as their own discovery config.  Only a config the
        #               firmware published **live** counts (see
        #               ``discovery_override.py``): the broker replays retained
        #               configs to every new subscriber, and one of those may be
        #               days old - published by another build, or over MQTTS by
        #               a unit that is now on plain MQTT.  Cleared when the
        #               device goes silent, so it describes this connection.
        #   _observed   every state topic that delivered a live message.  Cleared
        #               when a NEW session starts, so it describes the current
        #               connection rather than the union of all of them.
        #
        # There is deliberately no "assume everything" default: that fallback is
        # what put a storage unit's TOU and battery entity set on a micro
        # inverter that never publishes those topics.  An empty set now means
        # "nothing known yet", and the first message fills it in.
        self._inventory: set[str] = set()
        self._declared: set[str] = set()
        self._observed: set[str] = set()
        # True once the device published anything *live* on this MQTT
        # connection.  A retained payload the broker replayed when we subscribed
        # is history, so it does not count.  Destructive cleanup waits for this
        # flag: it is the difference between "the device is talking to us right
        # now" and "the broker still remembers what it said once".
        self._live_seen: bool = False
        # True once THIS connection published its own ``supported_topics``
        # payload.  ``attributes`` is published exactly once per MQTT connection,
        # so a live copy of it is the one unambiguous "the device just connected"
        # marker the firmware gives us - a retained replay of the same payload is
        # merely the last connection's declaration.
        self._inventory_live: bool = False
        # When that live ``attributes`` was last seen, to tell a genuine
        # reconnect apart from the same connection re-announcing itself.
        self._attributes_live_at: float = 0.0
        # Incremented every time the device announces a NEW connection.  The
        # entity gate hangs its one-shot reconciliation off this, so the registry
        # is reconciled once per CONNECTION and never on a timer.
        self.session: int = 1
        self._capabilities_ready = asyncio.Event()
        # Cached product name.  ``None`` = not resolved yet, ``""`` = resolved to
        # nothing (so the registry is not scanned again on every access).
        self._model: str | None = None
        # Local calendar day the device's 「今日」 counters were last known to
        # describe.  ``None`` until this process watched the unit go silent.  See
        # ``today_counters_stale``.
        self._offline_day: dt_util.dt.date | None = None
        # True once this process saw the device go silent and then come back on a
        # later local calendar day.  While it is set, every 「今日」 counter this
        # unit reports still describes the day it went offline, so the sensors
        # answer ``0`` instead of last night's figure.
        self._today_stale: bool = False
        # The 「今日」 figure the device came back with.  It is the reference a
        # genuine rollover is detected against: the counter has to fall *below*
        # it before the verdict above can be cleared.
        self._today_returned_value: float | None = None
        # The counter as it stood just before the device went silent.  Comparing
        # the figure it comes back with against this is what tells "kept
        # yesterday's total" apart from "rolled over by itself while it was off
        # the network" - the second case needs no correction at all.
        self._today_offline_value: float | None = None
        # The local day the verdict above was made on.  Reaching the *next* day
        # with a live device means any rollover has to have happened by now, so
        # the flag is released unconditionally - the only thing worse than a
        # missed reset is one that never lets go.
        self._today_stale_day: dt_util.dt.date | None = None
        # The region this midnight timer was armed for, so a region change can
        # re-arm it without comparing timestamps.  See ``_async_arm_day_timer``.
        self._day_timer_zone: str | None = None
        # The last region day the timer fired for, so the one-off fire after a
        # restart on the same day does not stamp a verdict twice.
        self._day_timer_day: dt_util.dt.date | None = None
        # Cancel handle for the midnight timer, and the instant it was armed for
        # (``None`` = not armed).  See ``_async_arm_day_timer``.
        self._day_timer_unsub: Any = None
        self._day_timer_fire_at: Any = None

    # ------------------------------------------------------------------
    # region (time zone)
    # ------------------------------------------------------------------
    @property
    def region_tz(self) -> Any:
        """The time zone the device's day is measured in, or ``None``.

        ``None`` means "follow Home Assistant", which is what an entry with no
        region option gets.  Read from the config entry on every access rather
        than cached in ``__init__``: the toolbar switch and the options flow both
        change it while the device is already set up, and a cached copy would
        keep the old day until the next restart.
        """
        return region.tz_of(region.entry_of(self.hass, self.dev_id))

    @property
    def region_name(self) -> str:
        """The configured region (``""`` = follow Home Assistant)."""
        return region.zone_for_dev_id(self.hass, self.dev_id)

    def _today_date(self) -> Any:
        """Which calendar day it is at the device, not at the server."""
        return region.today(self.region_tz)

    @callback
    def _async_arm_day_timer(self) -> None:
        """(Re-)arm the timer that fires at the device's next local midnight.

        The reconnect path can only notice a day change *after* the fact, and only
        if the unit went offline.  A unit that stays reachable the whole time -
        the normal case for a roof unit that never loses Wi-Fi - would keep
        showing yesterday's 「今日发电」 until the firmware deigned to reset its
        own counter, which on at least one SKU is many minutes after midnight.
        Firing on the region's midnight is what the user asked for: 「根据时区的
        零点主动清零」.

        Re-armed on every region change, because the instant is a property of the
        zone, and on every setup, because a restart in the middle of the day must
        still catch tonight's midnight.
        """
        zone_name = self.region_name
        if self._day_timer_unsub is not None:
            same_zone = self._day_timer_zone == zone_name
            if same_zone and self._day_timer_fire_at is not None:
                return
            self._day_timer_unsub()
            self._day_timer_unsub = None
        self._day_timer_zone = zone_name

        fire_at = region.next_midnight(self.region_tz)
        self._day_timer_fire_at = fire_at
        self._day_timer_unsub = async_track_point_in_time(
            self.hass, self._async_midnight_rollover, fire_at
        )
        _LOGGER.debug(
            "Hoymiles %s: 今日 reset scheduled for %s (region %s)",
            self.dev_id,
            fire_at.isoformat(),
            zone_name or "Home Assistant",
        )

    async def _async_midnight_rollover(self, _now: Any = None) -> None:
        """Run at the device's local midnight: declare the old counters stale.

        Marking rather than clearing is deliberate.  At 00:00 the unit is still
        reporting last night's total, and it is the *sensor* that must read 0
        until a smaller figure proves the firmware noticed.  Clearing here would
        flash yesterday's total for as long as the firmware takes to reset.
        """
        self._day_timer_unsub = None
        self._day_timer_fire_at = None
        today = self._today_date()
        if self._day_timer_day == today:
            # Already stamped for this day - the restart-on-the-same-day case.
            self._async_arm_day_timer()
            return
        self._day_timer_day = today

        if self._inverter_with_today_counters():
            value = _today_counter_of(self._today_counters_payload())
            if value is not None and value > 0:
                # The unit has not reset yet (this is the whole point of the
                # timer), so hold the old figure rather than show it as today's.
                self._today_stale = True
                self._today_returned_value = value
                self._today_stale_day = today
                _LOGGER.info(
                    "Hoymiles %s: local midnight reached (%s), its 今日 counters "
                    "still read %.0f Wh; today's yield reads 0 until the device "
                    "rolls over",
                    self.dev_id,
                    today.isoformat(),
                    value,
                )
            else:
                self._today_stale = False
                self._today_stale_day = None
                self._today_returned_value = None
                _LOGGER.debug(
                    "Hoymiles %s: local midnight reached (%s), counters already "
                    "at zero",
                    self.dev_id,
                    today.isoformat(),
                )
        self._offline_day = None
        self._today_offline_value = None

        if self._available:
            self.async_set_updated_data(dict(self.data))

        self._async_arm_day_timer()

    async def async_apply_region(self) -> None:
        """Re-evaluate the day after the region option changed.

        Called by ``hoymiles.set_region``.  The region itself needs no cache - the
        properties read the config entry live - but two derived things do need a
        nudge: the midnight timer was armed for the *old* zone, and a day that
        has already turned over in the new zone must take effect now rather than
        at the next report.
        """
        self._async_arm_day_timer()
        today = self._today_date()
        stale_day = self._today_stale_day
        if stale_day is not None and today > stale_day:
            # The verdict was made on a day the new zone has already left behind,
            # so its reference value no longer constrains anything.
            self._today_stale = False
            self._today_returned_value = None
            self._today_stale_day = None
            _LOGGER.info(
                "Hoymiles %s: region changed to %s, which already passed %s; "
                "today's yield is live again",
                self.dev_id,
                self.region_name or "Home Assistant",
                stale_day.isoformat(),
            )
        self.async_set_updated_data(dict(self.data))

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

    @property
    def ems_mode(self) -> str | None:
        """Return the EMS mode the device is believed to be running.

        ``_ems_mode_state`` is what the select's state topic carries - the last
        commanded value, refined by whatever the device reports.  It is only
        ``None`` before the first command or report, which the keep-alive treats
        as "unknown, do not second guess" rather than "not mqtt_ctrl".
        """
        if self._ems_mode_state is not None:
            return self._ems_mode_state
        for source in (SRC_SYSTEM, SRC_DEVICE):
            payload = self.data.get(source)
            if not isinstance(payload, dict):
                continue
            mode = payload.get("ems_mode")
            if isinstance(mode, str) and mode:
                return mode
        return None

    @property
    def role(self) -> str | None:
        """Return this unit's role in the installation, or ``None``.

        Protocol §32 「状态事件」 is the only place the firmware says whether the
        unit is standing alone (``single``), heading a master/slave pair
        (``master``) or following one (``slave``), and everything else in that
        payload - ``has_meter``, ``has_plug``, ``has_solar2`` - is derived from
        it.  A slave answers ``false`` to all three by definition.

        ``None`` means the topic has not been heard from yet; callers must treat
        that as "unknown", not as ``single``, or a follower would be drawn with
        the master's meter driven branches the moment HA starts.

        ``servant`` is normalised to ``slave`` here so no consumer has to carry
        the alias.
        """
        payload = self.data.get(SRC_EVENT)
        if not isinstance(payload, dict):
            return None
        value = payload.get("role")
        if not isinstance(value, str):
            return None
        role = value.strip().lower()
        role = ROLE_ALIASES.get(role, role)
        return role if role in ROLES else None

    @property
    def event_flags(self) -> dict[str, bool]:
        """The ``event/state`` capability flags as real booleans.

        Only the three documented tri-state flags are returned, and only when
        the payload actually carries a boolean - a missing field means "this
        build does not say", which is different from ``false`` and must not be
        rendered as "the hardware is not there".
        """
        payload = self.data.get(SRC_EVENT)
        if not isinstance(payload, dict):
            return {}
        flags: dict[str, bool] = {}
        for field in ("has_meter", "has_plug", "has_solar2"):
            value = payload.get(field)
            if isinstance(value, bool):
                flags[field] = value
        return flags

    # ------------------------------------------------------------------
    # capabilities
    # ------------------------------------------------------------------
    @property
    def capabilities(self) -> frozenset[str]:
        """The capabilities this device has proven, by declaring or by sending.

        The union is what makes "show only what was published" hold in both
        directions: a topic in the retained inventory keeps its entities across
        a Home Assistant restart even while the device is offline, and a topic
        that only ever arrives because the device happened to publish it is
        picked up as soon as the first message lands.
        """
        return frozenset(self._inventory | self._declared | self._observed)

    @property
    def capabilities_known(self) -> bool:
        """True once anything about this device's topic set is known.

        Used as the "is absence meaningful?" gate before pruning: with nothing
        known, a missing capability is ignorance, not evidence that the feature
        is absent.
        """
        return bool(self._inventory or self._declared or self._observed)

    @property
    def inventory_known(self) -> bool:
        """True once the firmware's own ``supported_topics`` list has arrived.

        Narrower than :attr:`capabilities_known`, and it is the only gate the
        destructive cleanup may use.  The inventory is the one *complete* list
        the firmware publishes - it is replaced wholesale on every connection -
        so a capability missing from it is a real absence.  A discovery config
        is not comparable in that way (the firmware never withdraws one), which
        is why the two are tracked separately.
        """
        return bool(self._inventory)

    @property
    def live_seen(self) -> bool:
        """True once the device published something live on this connection."""
        return self._live_seen

    @property
    def connection_declared(self) -> bool:
        """True once the CURRENT connection published its own topic list.

        This is the only safe gate for the destructive cleanup: it means the
        device has just told us, on this very connection, what it implements, so
        anything else still sitting on the discovery topic is left over from an
        earlier connection and may be deleted.  Without it, a broker that merely
        replayed old payloads would look like a device that supports them.
        """
        return self._inventory_live

    @callback
    def _begin_connection(self) -> None:
        """Forget everything the previous connection proved, and say so.

        Called the moment the device announces itself on a new connection.  What
        it published live from now on is the whole truth; the retained history
        the broker replayed to us - possibly from a different firmware build, or
        from a unit that linked over MQTTS - must no longer grant any entity.
        The inventory itself is replaced by the caller with the freshly
        announced list, so it is deliberately not cleared here.
        """
        self.session += 1
        self._observed.clear()
        self._declared.clear()
        self._inventory_live = True
        self._attributes_live_at = time.monotonic()
        _LOGGER.warning(
            "Hoymiles %s announced a new connection (session %d); its entities "
            "will follow what this connection publishes",
            self.dev_id,
            self.session,
        )

    # ------------------------------------------------------------------
    # the device's own 「今日」 counters
    # ------------------------------------------------------------------
    @property
    def today_counters_stale(self) -> bool:
        """True while this unit's 「今日」 counters describe a *previous* day.

        A micro inverter has no clock the integration can read - it keeps its own
        date and rolls ``pvs[].ed`` over at *its* midnight - so a device that was
        off the network across midnight comes back still reporting the day it
        went offline.  Nothing in the protocol contradicts that figure: the
        payload has the same shape, the numbers are plausible, and the only
        evidence is that this process watched the unit go silent on one local
        day and reappear on the next.

        So the verdict is made once, at the reconnect (see
        ``_async_publish_availability``), and stands until the device publishes a
        counter that proves it noticed the new day - a figure *lower* than the one
        it came back with, which is exactly what a rollover looks like.  Every
        「今日」 sensor and the plant-wide aggregate consult this, which is what
        makes 今日发电 appear to reset by itself instead of holding yesterday's
        yield until the sun comes up.

        Deliberately process-local: the flag describes one observed outage, and a
        Home Assistant restart is treated as "no evidence" rather than as "assume
        it happened", because a restart says nothing at all about the device.
        """
        return self._today_stale

    @property
    def today_counters_day(self) -> Any:
        """The local day the offline stretch began on, or ``None``."""
        return self._offline_day

    @callback
    def _async_mark_offline_day(self) -> None:
        """Remember which local calendar day the device went silent on.

        Recorded when the availability verdict flips to ``False``, which is the
        only moment the integration can still say *when* the outage started - the
        watchdog proves it after ``SOURCE_STALE_SECONDS``, long before any
        consumer asks.  Comparing this against the day of the reconnect is what
        identifies the one case the device's own 「今日」 counters cannot handle: an
        outage that crossed midnight.

        Kept if one is already recorded: a unit that flaps can flip the verdict
        down more than once, and overwriting the earlier day with today's would
        destroy the evidence that the outage started yesterday.
        """
        if self._offline_day is not None:
            return
        # The day *at the roof*: "crossed midnight while it was away" has to be
        # judged against the device's own calendar, not the server's.  See
        # ``region.py``.
        self._offline_day = self._today_date()
        # The counter as it stands now is the last figure from the day the unit
        # was still reachable; it is what the reading at reconnect is compared
        # against.  Recorded here rather than on every message because the
        # handlers run again during the reconnect burst, which would overwrite
        # the evidence with the very value it is meant to qualify.
        self._today_offline_value = _today_counter_of(self._today_counters_payload())

    @callback
    def _async_note_online_day(self) -> None:
        """Decide whether a returning device's 「今日」 counters are yesterday's.

        A micro inverter has no clock this integration can read - it keeps its own
        date and rolls ``pvs[].ed`` over at *its* midnight - so a unit that was off
        the network across midnight comes back still reporting the day it went
        offline.  Nothing in the payload contradicts that: the shape is identical,
        the numbers are plausible, and the only evidence available is that this
        process watched the unit fall silent on one local day and reappear on
        another.

        Called on every live message because that is when the verdict can be
        *cleared* (the counter falling below the figure it came back with - see
        ``_async_track_today``); setting it happens on the reconnect itself, in
        ``_async_publish_availability``, where the outage is still visible.
        """
        if not self._today_stale:
            return
        self._async_track_today()

    @callback
    def _async_check_rollover(self) -> None:
        """Flag the 「今日」 counters when the device returns after midnight."""
        offline_day = self._offline_day
        offline_value = self._today_offline_value
        self._offline_day = None
        self._today_offline_value = None
        if offline_day is None:
            return

        today = self._today_date()
        if today <= offline_day:
            # Same day, or a clock that went backwards: the counters are still
            # about today, so nothing is stale.
            return
        if not self._inverter_with_today_counters():
            return

        value = _today_counter_of(self._today_counters_payload())
        if value is None or value <= 0:
            # Nothing was produced before the outage, so there is no figure to
            # suppress - and flagging it anyway would be unrecoverable: the only
            # way out is a counter *below* the reference, and nothing is below 0.
            return
        if offline_value is not None and value < offline_value:
            # The unit was reachable up to some figure, went quiet across
            # midnight, and came back reporting *less*: it rolled its own
            # counter over without any help.  Zeroing a correct reading would be
            # exactly the bug this whole mechanism exists to avoid.
            _LOGGER.debug(
                "Hoymiles %s was offline across midnight but rolled its 今日 "
                "counters over by itself (%.0f -> %.0f Wh)",
                self.dev_id,
                offline_value,
                value,
            )
            return

        self._today_stale = True
        self._today_returned_value = value
        self._today_stale_day = today
        _LOGGER.info(
            "Hoymiles %s was offline across midnight (%s -> %s); its 今日 counters "
            "still describe %s (%.0f Wh) and will read 0 until the device rolls "
            "them over",
            self.dev_id,
            offline_day.isoformat(),
            today.isoformat(),
            offline_day.isoformat(),
            value,
        )

    @callback
    def _inverter_with_today_counters(self) -> bool:
        """True when today's yield comes from the per-port ``pvs[].ed`` counters.

        A storage unit answers today's yield from ``system/state`` (``pv_e``),
        which the firmware rolls over itself and which this integration has no
        reason to second-guess.  Gating on the payload - the per-port counter
        present *and* ``pv_e`` absent - rather than on the model mirrors exactly
        the precedence ``s_or_pv`` applies, so the verdict can only ever apply to
        the figure the sensors are actually reading.
        """
        system = self.data.get(SRC_SYSTEM)
        if isinstance(system, dict) and system.get("pv_e") is not None:
            return False
        return _today_counter_of(self._today_counters_payload()) is not None

    def _today_counters_payload(self) -> dict[str, Any]:
        """The ``device/state`` payload the per-port counters live in."""
        payload = self.data.get(SRC_DEVICE)
        return payload if isinstance(payload, dict) else {}

    @callback
    def _async_track_today(self) -> None:
        """Clear the stale verdict once the device proves it noticed the new day.

        The only evidence available is the counter itself: a unit that has just
        rolled over reports a *smaller* 「今日」 figure than the one it came back
        with, because it went from "yesterday, complete" to "today, a few minutes
        in".  Watching for exactly that (and nothing else) means a unit that keeps
        repeating yesterday's number is never silently treated as fresh, while a
        unit that genuinely reset is believed immediately - without waiting for
        the integration to guess a time.
        """
        if not self._today_stale:
            return

        # Safety valve: a unit that stays reachable past the day the verdict was
        # made must have rolled over somewhere in between, whatever its counter
        # says.  Without this, a firmware that never resets ``pvs[].ed`` (or a
        # counter that happens to sit exactly at its old value) would pin 今日发电
        # to 0 for good.
        stale_day = self._today_stale_day
        today = self._today_date()
        if stale_day is not None and today > stale_day:
            self._today_stale = False
            self._today_stale_day = None
            self._today_returned_value = None
            _LOGGER.info(
                "Hoymiles %s stayed online past %s, so its 今日 counters are "
                "assumed rolled over; today's yield is live again",
                self.dev_id,
                stale_day.isoformat(),
            )
            return

        value = _today_counter_of(self._today_counters_payload())
        if value is None:
            return

        returned = self._today_returned_value
        if returned is None or value < returned:
            self._today_stale = False
            self._today_stale_day = None
            self._today_returned_value = None
            _LOGGER.info(
                "Hoymiles %s rolled its 今日 counters over to %s (%.0f Wh); "
                "today's yield is live again",
                self.dev_id,
                today.isoformat(),
                value,
            )

    @property
    def pv_count(self) -> int:
        """How many PV inputs this unit has.

        Three sources, most reliable first:

        1. The firmware's own ``device/state["pv_num"]`` - authoritative once a
           payload has arrived, because it describes the hardware directly.
        2. The SKU at the start of the serial (``RMI-4161`` -> 2 inputs).  Used
           before any payload exists, which is what matters during setup: the
           entities are created then, long before the first 5 minute report.
        3. ``PV_COUNT_MAX`` - the documented maximum, so a device that declares
           nothing still gets every port rather than silently losing readings.
        """
        payload = self.data.get(SRC_DEVICE)
        if isinstance(payload, dict):
            declared = payload.get("pv_num")
            if isinstance(declared, int) and not isinstance(declared, bool):
                if 1 <= declared <= PV_COUNT_MAX:
                    return declared

        known = pv_count_from_dev_id(self.dev_id)
        if known is not None:
            return known

        return PV_COUNT_MAX

    @property
    def device_model(self) -> str | None:
        """Product name for this unit, e.g. ``HiFlow Pro``.

        The firmware publishes its own MQTT discovery under the bare serial and
        that device registry entry carries a precise ``model``; this
        integration's own entry has none.  Reading it here lets every entity
        populate ``DeviceInfo.model`` from one place, which in turn means the
        dashboard title no longer depends on another integration being installed.

        Falls back to the serial prefix (``RMI-`` -> ``HiFlow``), then to
        ``None`` - a missing model only costs a less descriptive title.
        """
        if self._model is not None:
            return self._model or None

        resolved = ""
        try:
            from homeassistant.helpers import device_registry as dr  # noqa: PLC0415

            registry = dr.async_get(self.hass)
        except Exception:  # noqa: BLE001 - a label is never worth breaking setup
            registry = None

        if registry is not None:
            # Every spelling the registry may use for this one serial: this
            # integration's ``(DOMAIN, "RMI-<SN>")`` and the firmware's
            # ``("mqtt", "<SN>")``.
            wanted = {
                self.dev_id.lower(),
                self.dev_id.lower().replace("-", ""),
            }
            if "-" in self.dev_id:
                wanted.add(self.dev_id.rsplit("-", 1)[-1].lower())

            for device in list(registry.devices.values()):
                for pair in device.identifiers:
                    if not pair or pair[1] is None:
                        continue
                    candidate = str(pair[1]).lower()
                    if candidate not in wanted and candidate.replace("-", "") not in wanted:
                        continue
                    for attr in ("model", "model_id"):
                        value = getattr(device, attr, None)
                        if value:
                            resolved = str(value)
                            break
                    if resolved:
                        break
                if resolved:
                    break

        if not resolved:
            resolved = model_from_dev_id(self.dev_id) or ""

        # Cached - including the empty result - because the registry is only read
        # during setup and a per-property lookup on every state write is wasteful.
        self._model = resolved
        return resolved or None

    def has_capability(self, capability: str) -> bool:
        """Return True when this device declared *or* published the topic."""
        return capability in self.capabilities

    @callback
    def set_keepalive_state(self, payload: dict[str, Any]) -> None:
        """Store the power-control keep-alive state for the entity.

        The keep-alive owns this data; pushing it through the coordinator means
        the sensor updates through the normal listener path instead of needing a
        subscription of its own.
        """
        data = dict(self.data)
        data[SRC_KEEPALIVE] = dict(payload)
        self.async_set_updated_data(data)

    @callback
    def add_capability(self, capability: str) -> None:
        """Record a capability discovered outside ``supported_topics``.

        Several features have no ``supported_topics`` entry - the multi phase
        output limit and every ``button`` / ``switch`` object are only visible as
        their own discovery config - so ``discovery_override.py`` reports each
        one here as it arrives.

        The caller is responsible for only reporting a config the firmware
        published **live**.  A config that merely came back as a retained replay
        is not evidence of current support, and treating it as such is what kept
        a storage unit's reboots and factory resets on screen long after the
        firmware stopped offering them.

        A *new* capability means new entities may be justified, so the platforms
        are nudged through the normal listener fan-out.
        """
        if capability in self._declared:
            return

        self._declared.add(capability)
        self._capabilities_ready.set()
        _LOGGER.debug("Hoymiles %s declares capability %s", self.dev_id, capability)
        self.async_set_updated_data(dict(self.data))

    @callback
    def _observe_capability(self, capability: str) -> bool:
        """Record a capability proven by a message that actually arrived.

        Returns True when this is the first time it was seen, which is the
        moment the platforms get a chance to add entities for it.
        """
        if capability in self._observed or capability in self._declared \
                or capability in self._inventory:
            self._observed.add(capability)
            return False

        self._observed.add(capability)
        self._capabilities_ready.set()
        _LOGGER.debug("Hoymiles %s published %s", self.dev_id, capability)
        return True

    async def async_wait_for_capabilities(self) -> None:
        """Wait briefly for the retained payloads that describe this device.

        The platforms need the capability set *before* they decide which
        entities to create, so setup awaits this instead of racing the MQTT
        messages.  A timeout is not an error and no longer means "assume a fully
        featured device": it means the broker has nothing for this device yet, so
        the entities follow its first message instead.
        """
        if self.capabilities_known:
            return
        try:
            await asyncio.wait_for(
                self._capabilities_ready.wait(), CAPABILITIES_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            _LOGGER.debug(
                "Nothing heard from %s within %ss; entities will follow its "
                "first message",
                self.dev_id,
                CAPABILITIES_TIMEOUT_SECONDS,
            )

    @callback
    def _handle_attributes(self, msg: Any) -> None:
        """Record which topics the firmware says it implements.

        The payload is ``{"supported_topics": {"<cap>": "<topic>", ...}}``.  Only
        the keys matter: the values are topics we already know, and trusting
        them would let a firmware change point our subscriptions somewhere else.
        """
        live = getattr(msg, "retain", True) is False
        if live:
            self._live_seen = True
            # ``attributes`` is published exactly once per MQTT connection, so a
            # live copy *is* the device saying "I just connected, this is my topic
            # set".  No debouncing: a power cycle a few seconds after a reconnect
            # is still a new connection, and treating it as the old one would skip
            # the cleanup for the burst it is about to send.  A duplicate would at
            # worst buy one redundant, idempotent pass.
            self._begin_connection()

        try:
            payload = json.loads(msg.payload)
        except (ValueError, TypeError):
            _LOGGER.debug("Invalid JSON on %s: %s", msg.topic, msg.payload)
            return
        if not isinstance(payload, dict):
            return

        supported = payload.get("supported_topics")
        if not isinstance(supported, dict):
            return

        declared = {str(key) for key in supported}
        if not declared:
            return

        previous = self.capabilities
        # Replace, never union: the firmware publishes its COMPLETE topic list on
        # every connection, so a key missing from this payload is a feature this
        # build does not have.  Unioning would make the set grow forever and the
        # page keep advertising options the device already dropped.
        self._inventory = declared
        self._capabilities_ready.set()
        _LOGGER.info(
            "Hoymiles %s declares %d topics: %s",
            self.dev_id,
            len(self._inventory),
            ", ".join(sorted(self._inventory)),
        )
        # Always notify, even when the set happens to match the previous one.
        # ``supported_topics`` is NOT the whole picture - the device also
        # publishes discovery configs and state topics that never appear in it -
        # so the listeners are what schedule the cleanup, and they have to run
        # as soon as the inventory is known rather than only on a visible change.
        del previous
        self.async_set_updated_data(dict(self.data))

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

        # The retained inventory of topics this firmware implements.  Subscribed
        # before anything else reads it, so platforms can gate on it.
        self._unsubscribes.append(
            await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(T_ATTRIBUTES, self.dev_id),
                self._handle_attributes,
                1,
            )
        )

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

        # 「今日发电」 must drop to zero at the *device's* midnight, not whenever
        # the firmware happens to report a reset - see ``_async_arm_day_timer``.
        self._async_arm_day_timer()

    async def async_shutdown(self) -> None:
        """Cancel all subscriptions and leave a usable retained state."""
        for unsub in self._unsubscribes:
            unsub()
        self._unsubscribes.clear()

        # The midnight timer lives outside ``_unsubscribes`` because it is
        # re-armed on every region change; without this it would keep a dead
        # coordinator alive until midnight and then fire into a removed entry.
        if self._day_timer_unsub is not None:
            self._day_timer_unsub()
            self._day_timer_unsub = None
            self._day_timer_fire_at = None

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
        mode = mqtt_util.payload_to_text(msg.payload)
        if mode is None:
            return

        mode = mode.strip('"')
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

        # Never seen anything at all: leave the retained value alone for a while
        # instead of declaring a healthy device offline right after Home
        # Assistant started - the subscriptions are not even live yet.  The
        # grace period is what keeps that from becoming permanent: a device that
        # was already unplugged when Home Assistant started never publishes
        # anything, so without it the stale retained ``online`` would stand.
        if not self._last_seen:
            if (now - self._startup_time) <= AVAILABILITY_STARTUP_GRACE_SECONDS:
                return None
            return False

        return False

    async def _async_publish_availability(self, available: bool) -> None:
        """Publish an availability change and refresh the entities."""
        was_available = self._available
        self._available = available
        payload = PAYLOAD_AVAILABLE if available else PAYLOAD_NOT_AVAILABLE

        # Going silent ends this connection, so everything the device announced
        # during it - the discovery configs it published live included - is
        # history.  Clearing on the way *down* rather than on the way back up
        # keeps this out of the reconnect burst's way: those configs land about
        # a second before the first state message flips the verdict back.
        if not available:
            self._declared.clear()
            self._live_seen = False
            self._inventory_live = False
            # Remember *when* it fell silent: comparing this day against the day
            # it comes back is the only way to know its 「今日」 counters crossed a
            # midnight while it was away.  See ``today_counters_stale``.
            self._async_mark_offline_day()

        # A transition from a PROVEN-offline state back to available is a
        # reconnect: the device is about to re-publish its whole topic set, so
        # what it published during the previous connection is no longer evidence
        # of what it supports now.  Clearing ``_observed`` here (and only here -
        # never on the initial None -> True, which is just this process
        # subscribing to retained topics) is what lets a device that reconnects
        # with fewer topics lose the entities it no longer justifies.
        if available and was_available is False:
            self.session += 1
            self._observed.clear()
            _LOGGER.info(
                "Hoymiles %s reconnected (session %d); its topic set will be "
                "re-read from the new connection",
                self.dev_id,
                self.session,
            )

        # Coming back after the local date rolled over is the one case where the
        # device's own 「今日」 counters are provably wrong: an offline unit keeps
        # the day it went silent in memory and republishes that day's figure on
        # its first message after the reconnect, so 今日发电 would show
        # yesterday's yield all morning.  Flagging it here (and clearing the flag
        # in ``_async_track_today`` the moment a fresh counter arrives) is what
        # lets ``today_counters_stale`` say "this number is yesterday's" to every
        # consumer, including the plant-wide aggregate on the System tab.
        if available and was_available is False:
            self._async_check_rollover()

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
            # ``retain`` is the broker's replay flag: True means the payload was
            # delivered because *we* subscribed, not because the device just
            # said it.  Only the second kind describes the current connection.
            live = getattr(msg, "retain", True) is False
            if live:
                self._live_seen = True

            try:
                payload = json.loads(msg.payload)
            except (ValueError, TypeError):
                _LOGGER.debug("Invalid JSON on %s: %s", msg.topic, msg.payload)
                return
            if not isinstance(payload, dict):
                return

            if key in SOURCE_STALE_SECONDS:
                self._last_seen[key] = time.monotonic()

            # A *live* message is proof that this topic exists for this device,
            # independent of what the retained inventory claims.  This is what
            # keeps the page honest for a unit whose ``attributes`` payload is
            # missing, stale, or simply lists fewer topics than the firmware of
            # a differently connected build actually publishes.  A replayed
            # retained message only proves the topic existed at some point in
            # the past - exactly the claim this integration must not act on.
            capability = SOURCE_CAPABILITY.get(key)
            if capability is not None and live:
                self._observe_capability(capability)

            data = dict(self.data)
            data[key] = payload
            self.async_set_updated_data(data)

            # 「今日」 accounting.  A live message is also the only clock this
            # integration can read on the device's behalf: a counter that drops
            # below the figure the unit came back with proves it rolled over by
            # itself, and that is what clears the stale verdict.
            if live:
                self._async_note_online_day()
            # A fresh message can only ever flip the verdict to available; the
            # watchdog is responsible for the opposite direction.
            if key in SOURCE_STALE_SECONDS and self._available is not True:
                self.hass.async_create_task(self._async_publish_availability(True))

            # Both report carriers can carry the running EMS mode: a storage
            # unit puts it in ``system/state``, a micro inverter (which has no
            # ``system/state`` at all) puts it in ``device/state``.
            if key in (SRC_SYSTEM, SRC_DEVICE):
                mode = payload.get("ems_mode")
                if isinstance(mode, str):
                    self.hass.async_create_task(self._async_sync_ems_mode_state(mode))

        return _handler
