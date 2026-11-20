"""The region (time zone) a micro inverter's day is measured in.

A HiFlow has no clock this integration can read: it keeps its own date, rolls
``pvs[].ed`` over at *its* midnight and stamps its alarms in its own local time.
Home Assistant's ``time_zone`` describes where the *server* runs, which is the
right answer only while the unit sits on the same premises.  Install the roof one
time zone away from the box and three things go wrong at once:

* 「今日发电」 is reported against a midnight nobody can see, so the figure the
  dashboard calls "today" is the device's day, not the reader's;
* an outage that crossed *the device's* midnight is not recognised as crossing
  one, so yesterday's total is shown all morning (see
  ``coordinator.today_counters_stale``);
* every alarm timestamp is off by the offset.

This module is the single place that resolves "which day is it at the roof",
so the coordinator and the cards cannot disagree about it.

The choice is stored in the config entry's **options**, one per device, because
the coordinator needs it on the event loop - a per-browser ``localStorage`` value
cannot make a server-side decision.  The toolbar switch writes it through the
``hoymiles.set_region`` service; the options flow writes it directly.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, tzinfo
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import CONF_REGION, DEFAULT_REGION

_LOGGER = logging.getLogger(__name__)


def resolve(zone: str | None) -> tzinfo | None:
    """Return the ``tzinfo`` for a zone name, or ``None`` when unusable.

    ``zoneinfo`` rather than a table of offsets: a region is a *rule*, not a fixed
    offset, and every country that observes daylight saving changes offset twice a
    year.  An unknown name is logged and ignored instead of raising - a stored
    region that this Python build cannot resolve (a bare container without the
    tz database) must degrade to "follow Home Assistant", never break a device.
    """
    name = (zone or "").strip()
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo  # noqa: PLC0415

        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - KeyError, ValueError, missing tzdata
        _LOGGER.warning(
            "Unknown region %r; falling back to the Home Assistant time zone", name
        )
        return None


def zone_name(entry_or_options: Any) -> str:
    """The region stored on a config entry / options mapping, or ``""``.

    ``""`` means "follow Home Assistant", which is what every entry that predates
    the option gets.
    """
    if entry_or_options is None:
        return DEFAULT_REGION
    options = getattr(entry_or_options, "options", None)
    if isinstance(entry_or_options, dict):
        options = entry_or_options
    if not isinstance(options, dict):
        return DEFAULT_REGION
    value = options.get(CONF_REGION)
    return value.strip() if isinstance(value, str) else DEFAULT_REGION


def tz_of(entry_or_options: Any) -> tzinfo | None:
    """The region as a ``tzinfo``, or ``None`` to mean "Home Assistant's"."""
    return resolve(zone_name(entry_or_options))


def now(zone: tzinfo | None) -> datetime:
    """The current instant in ``zone``, or in Home Assistant's zone when ``None``."""
    return dt_util.now(zone) if zone is not None else dt_util.now()


def today(zone: tzinfo | None) -> date:
    """Which calendar day it is *at the roof*.

    Every "did the day change" decision goes through here.  ``dt_util.now()``
    would answer for the server, which is the bug this module exists to prevent.
    """
    return now(zone).date()


def next_midnight(zone: tzinfo | None) -> datetime:
    """The next local midnight in ``zone``, as an aware ``datetime``.

    The coordinator schedules a timer on exactly this instant so 「今日发电」 drops
    to zero the moment the device's own day starts, instead of waiting for the
    next 5 minute report - or, worse, for a reconnect that may not happen until
    mid-morning.  Computed from the *date* rather than by adding 24 hours so a
    daylight-saving night (23 or 25 hours long) still lands on 00:00.
    """
    current = now(zone)
    tomorrow = current.date() + timedelta(days=1)
    midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day)
    if zone is not None:
        midnight = midnight.replace(tzinfo=zone)
    else:
        midnight = midnight.replace(tzinfo=current.tzinfo)
    # ``fold=0`` picks the first of two 00:00 readings on a clock-back night,
    # which is the earlier instant and therefore the start of the day.
    return midnight


def entry_of(hass: HomeAssistant, dev_id: str) -> ConfigEntry | None:
    """The config entry of a device id, or ``None`` when it is not set up."""
    from .const import CONF_DEV_ID, DOMAIN  # noqa: PLC0415

    for entry in hass.config_entries.async_entries(DOMAIN):
        if str(entry.data.get(CONF_DEV_ID, "")) == dev_id:
            return entry
    return None


def zone_for_dev_id(hass: HomeAssistant, dev_id: str) -> str:
    """The region chosen for one device, or ``""`` for "follow Home Assistant"."""
    return zone_name(entry_of(hass, dev_id))
