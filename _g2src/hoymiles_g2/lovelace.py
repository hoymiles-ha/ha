"""Best-effort Lovelace dashboard creation for a Hoymiles MS-G2 device.

Home Assistant's ``lovelace`` component does not expose a public API for
creating a storage dashboard, so this module goes through the
``lovelace/dashboards/*`` websocket commands (see :class:`_CommandConnection`
for why only those reach the collection the running instance actually uses)
and keeps its own ``LovelaceStorage`` for the card config.  Those internals are
deprecated in core and slated for removal, so *every* operation here is wrapped
and must never raise - a failed dashboard is logged and skipped, never allowed
to break device setup.

The dashboard mirrors the official integration's G3-prefixed panels: three
views (system / device / control) built from the bundled cards, keyed to the
device's entities.  A micro inverter (``RMI-`` serial) gets the inverter layout;
a storage unit gets the full four-branch schematic plus battery and TOU cards.

The sidebar entry and the dashboard header read the bare serial, e.g.
``RMI-4161A0209FF6``.  Earlier releases prefixed the model (``HiFlow_<serial>``);
those titles are migrated to the bare serial exactly once, and from then on the
title belongs to the user - renaming the dashboard under
*Settings -> Dashboards* is permanent and is never overwritten on restart.

The model string is still resolved (from whichever registry entry carries one -
the firmware publishes its own MQTT discovery under the bare serial, and that
entry is the one with ``model`` filled in) but no longer reaches the dashboard:
revision 11 dropped the heading card that used to print it, because that text was
built in Python and could not follow the language selector.  It now only feeds
``model_from_dev_id`` and the debug log.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN, ROLE_SLAVE, is_inverter_dev_id, model_from_dev_id

_LOGGER = logging.getLogger(__name__)

DASHBOARD_URL_PREFIX = "g2-"
# Same glyph the official integration puts on its generated dashboard, so the
# two entries in the sidebar read as one product.
DASHBOARD_ICON = "mdi:home-battery"
# What earlier releases used; only rewritten by :func:`_async_sync_icon`.
_LEGACY_DASHBOARD_ICON = "mdi:solar-power-variant"

# url_paths whose stored title has already been inspected for a one-time
# migration.  Process-local on purpose: after a restart the check costs one
# storage read per device and is a no-op again once the title is the serial.
_TITLE_CHECKED: set[str] = set()

# url_paths whose view layout has already been inspected.  Same reasoning: one
# read per device per process, and nothing to do once upgraded.
_LAYOUT_CHECKED: set[str] = set()

# url_path -> the role whose view set has already been applied.  Deliberately
# keyed by the role and *not* by the layout revision (see ``_LAYOUT_VERSION``):
# the role arrives in ``event/state``, which the device publishes after Home
# Assistant has already written the dashboard, so a one-shot migration would run
# while the value is still unknown and never run again.  This memo lets the
# check be repeated on every setup and after every late state change, at the
# cost of one storage read each.
_ROLE_APPLIED: dict[str, str] = {}

# Config key holding the System view while a ``slave`` is not allowed to see it.
# It is put back verbatim when the unit reports another role again - a unit that
# is re-paired into a master/slave pair must get its tab back, and restoring the
# stored dict keeps every other view edit intact.
_ROLE_SYSTEM_KEY = "g2_role_system_view"

# Layout revision, stored next to ``views`` in ``.storage/lovelace.<url_path>``.
#
# It exists because the *structural* fingerprint below cannot notice a change
# that only touches card options: once a dashboard has the current view titles
# and view-level keys, ``_is_legacy_layout`` is False forever, so a release that
# only fixes axis scaling (removes the fixed ``span``) would never reach an
# existing install.  The marker lets such a release be applied while still
# leaving every user edit - renames, reordering, added cards - in place: the
# migration in ``_migrate_axis_cards`` rewrites individual card keys instead of
# replacing the whole layout.
#
#   1 (or absent)  charts carried a fixed `span`, so every axis was drawn at
#                  2 000 W / 2 500 W regardless of the measured maximum
#   2              axes scale to the data; `symmetric` / `stack` set per chart
#   3              a micro inverter's Control card no longer offers the TOU plan
#                  row - the firmware has no time-of-use feature at all
#   4              a micro inverter's System view gained the lifetime PV energy
#                  card next to "today"
#   5              a micro inverter's Device view put the power flow beside the
#                  alarm card instead of across the full width
#   6              that pair now share one row as a 3:1 split inside a single
#                  grid section - a nested grid card can only ever divide a row
#                  into equal halves, and two sibling sections are stacked as
#                  soon as the dashboard drops its ``max_columns``
#   7              that split now fills the whole row; revision 6's 9 + 3 was a
#                  correct 3:1 ratio but only a third of the row, so both cards
#                  came out small
#   8              the alarm card now references the entity the *registry* holds
#                  rather than a guessed id - an ``entity_id`` is derived from
#                  the device name at creation time, so a device renamed before
#                  the sensor existed produced ``sensor.wo_shi_..._active_alarms``
#                  and the card sat at "Alarm data unavailable" forever
#   9              a micro inverter's Device view no longer carries the
#                  「功率曲线」 (PV / grid / load) chart: the System view already
#                  draws those three series together, and on one unit the port
#                  chart plus the voltage / yield pair cover the tab
#   10             a micro inverter's Control card no longer pins
#                  ``entities.output_power`` to ``number.<dev>``: the firmware
#                  names both `number` entities after the device, so the base id
#                  is whichever HA created first (`output_power` on a two-input
#                  HiFlow Pro, `power_ctrl` on a single-input HiFlow) and the pin
#                  handed one row the other's range
#   11             every view dropped the ``<model> · <family>`` heading card.
#                  The text was generated in Python, so it could not follow the
#                  dashboard language selector and read 微型逆变器 inside an
#                  English UI; the view's own tab header already says which
#                  device the dashboard belongs to
#   12             the lifetime PV gauge uses the vendor app's "All" ring icon
#                  instead of ♾️, which read as "infinite power" rather than
#                  "everything generated so far"
#   13             the gauge tiles use the vendor app's own named icons
#                  (``panel`` / ``battery`` / ``cycle``) instead of emoji, so the
#                  same four tiles match the official cards glyph for glyph
#   14             the three tabs carry the vendor app's own icons
#                  (``mdi:home-analytics`` / ``mdi:home-battery`` / ``mdi:tune``)
#                  instead of a solar-panel set, and the dashboard's sidebar
#                  entry uses ``mdi:home-battery``
#   15             a micro inverter's Device view keeps the alarm card for the
#                  alarms themselves only: while the device reports none it
#                  hides and the schematic takes the whole row, carrying a small
#                  green-tick / red-lamp badge in its corner instead.  The System
#                  view also gained 「发电量」: one bar per day (or per month),
#                  with this-month / this-year / lifetime tiles above it
#   16             that energy card opens on a month, not on a day - revision 15
#                  wrote the day range the power charts use, which draws a single
#                  curve where the card exists to show one bar per day
#   17             role gating (protocol §32 ``event/state``): a unit whose role
#                  is ``slave`` gets no System view at all - the document limits
#                  ``system/state`` and every aggregate derived from it to
#                  「主机和单机」, so a follower's System tab was four gauges and
#                  two charts of nothing.  Its Control card also loses the rows
#                  whose command topics the same table restricts: EMS mode, the
#                  power-control lease, the output limit, the per-phase limit
#                  and the TOU plan.  A role that has not been heard yet (and
#                  ``single`` / ``master``) keeps the full layout
#   18             a micro inverter's Device row splits 50/50 once the device is
#                  alarming, the way the vendor app lays out that page: the
#                  schematic on one side and the fault list on the other.  It
#                  was 3:1, which gave a two-line alarm list a ninth of the row
#                  and the schematic three quarters it no longer needs while a
#                  fault is on screen.  With no alarm the list still hides and
#                  the schematic is centred across the whole row
#   19             that 50/50 pair really does fill the page.  Revision 18 wrote
#                  18 + 18 columns, but the section owns 48 of them, so both
#                  cards came out at 503 px inside a 1354 px row with a blank
#                  strip down the right; 24 + 24 is the same halves of the row
#                  the page actually has.  The schematic also lost its fixed
#                  640 px drawing cap - it now fills whatever cell it is given,
#                  scaling proportionally, instead of floating centred inside a
#                  cell it can never reach
#   20             the opt-in cards point at the real entity.  Revision 19 built
#                  them from the sensor *description key*, which only matches
#                  the entity id when the display name slugifies to that key
#                  too - so 「有功功率」 referenced
#                  ``sensor.<slug>_grid_on_power_5m``, an entity that has never
#                  existed (the sensor is named "Grid On Power (5 min)" and
#                  therefore lives at ``..._grid_on_power_5_min``).  The card
#                  drew an empty axis forever.  Every opt-in card is now
#                  resolved through the entity registry by ``unique_id``, and
#                  the stored ones are re-pointed here
#   21             the Device view of a micro inverter carries a 「更多曲线」 card
#                  with one switch per opt-in chart, so they can be turned on
#                  and off from the page they appear on instead of from
#                  *Settings -> Devices & Services -> Configure*.  The card
#                  writes the same dashboard document the Options Flow does,
#                  through the integration's own services
#   22             that card is called 「更多数据」, not 「更多曲线」: it switches
#                  readings (grid current, frequency, RSSI, ...), only some of
#                  which are curves the page already draws, and the readings it
#                  adds are chart cards the user picks from data, not from
#                  curves.  The stored title is rewritten for every dashboard
#                  that still carries the old one
#   23             the System view of a micro inverter stops describing *this
#                  unit* and starts describing *the installation*.  Three
#                  changes travel together, because any one of them alone would
#                  leave the tab self-contradictory:
#                    * the schematic is drawn with
#                      ``variant: inverter-system`` - no 光伏2 branch, a negative
#                      负载 folded into 光伏, value labels over the rings instead
#                      of under them
#                    * the 光伏功率 curve reads ``system_plug_power``
#                      (``sys_plug_p``, the AC side, which is what the vendor app
#                      reports) instead of ``system_pv_power`` (``sys_pv_p``, the
#                      DC side).  Measured on the same second: 100.6 W against
#                      133.3 W
#                    * 今日发电 reads ``plant_pv_energy_today``, the aggregated
#                      master + slaves figure, because the firmware only ever
#                      reports each unit's own share (measured 387 / 148 / 613 Wh
#                      on one installation)
#   24             the System power chart of a micro inverter stops pinning
#                  ``symmetric: False``.  电网 输出[+]/输入[-] is a signed series by
#                  definition, and a bottom-up ``0..max`` axis clamped every
#                  negative reading to the baseline: the day the house exported,
#                  the grid curve simply vanished below zero instead of turning
#                  over.  The option is now left out so ``hoymiles-g2-history-
#                  chart`` decides per render (mirrored as soon as any series
#                  dips below zero), which is the rule every other card already
#                  follows - and it keeps the full height on a solar-only day
#   25             the stored dashboard's entity ids are repaired against the
#                  live entity registry.  A HiFlow whose serial collides with an
#                  earlier one ends up with every entity suffixed ``_2`` (and a
#                  single-input body publishes no ``pv2_power`` at all), while
#                  the generator derives the ids from the serial alone - so a
#                  stored dashboard pointed at entities that do not exist and
#                  every card read 「该时间段没有统计数据」.  See
#                  :func:`_migrate_stale_entities`
#   26             the System tab's 总发电量 stops showing this unit's share and
#                  starts showing the installation's.  ``pvs[].et`` is a per-unit
#                  counter and the protocol never adds units up, so the card used
#                  to show 2 944 Wh of a true 6 100 Wh with nothing saying so.
#                  The gauge and the 「发电量」 chart now read
#                  ``plant_pv_energy_total`` (master + ``role: slave`` units); the
#                  Device tab keeps the per-unit counter.  See
#                  :func:`_migrate_plant_energy_total`
#   27             the System tab's two energy tiles stop sitting side by side
#                  and stack, each read as one line (``compact: true``), so the
#                  schematic beside them takes three quarters of the row instead
#                  of half.  Two full tiles arranged horizontally spent a whole
#                  card each on a column that could hold both.  See
#                  :func:`_migrate_system_tile_stack`
#   28             that row's 3:1 split is rewritten from "tracks of a nested
#                  grid" to "columns of the section".  Revision 27 wrote
#                  ``_nested_grid(cards, 4)`` with ``grid_options: {columns: 3}``
#                  / ``{columns: 1}`` on the two children, which HA 2026.5.4
#                  renders as a flat 1:1: ``hui-grid-card`` gives each child one
#                  track and ignores ``grid_options`` on them.  The schematic and
#                  the tile stack are now plain siblings split by
#                  ``grid_options``, the same mechanism the Device view has used
#                  since revision 18.  See
#                  :func:`_migrate_system_tile_stack`
#   29             that split is written as 27 + 9 instead of 36 + 12.  The
#                  numbers are *tracks*, and ``hui-sections-view`` gives a
#                  ``column_span: 4`` section only as many tracks as the view
#                  actually fits - 36 on a 1440 px window, not the configured
#                  48.  A schematic asking for 36 filled the row by itself and
#                  pushed the tiles onto the next line; 27 + 9 sums to exactly
#                  the row and keeps the ratio.  See
#                  :func:`_migrate_system_tile_stack`
#   30             revisions 23 to 29 are re-run over every dashboard, this time
#                  recognising entity ids Home Assistant numbered (``_2``) and
#                  the names revisions 23 / 26 replaced.  A unit whose serial
#                  collided with an earlier registration has
#                  ``sensor.<slug>_system_pv_power_2`` where the generator
#                  wrote ``sensor.<slug>_system_pv_power``, and revisions 23
#                  onwards compared the stored id *exactly*.  The result was a
#                  dashboard that silently kept the pre-revision layout: the
#                  two energy tiles still side by side in a nested grid, the
#                  schematic still without ``variant: inverter-system`` (so 光伏2
#                  was drawn and the AC plug figure was not read), and 今日发电 /
#                  总发电量 still pointing at this unit instead of the
#                  installation.  Every such comparison now goes through
#                  :func:`_strip_suffix`, and the ids written back are the ones
#                  the registry actually holds.  See
#                  :func:`_migrate_plant_view`, :func:`_migrate_plant_energy_total`
#                  and :func:`_migrate_system_tile_stack`
#   31             that 3:1 split is narrowed to two thirds of the row - 18 + 6
#                  instead of 27 + 9 - because the schematic was still too tall.
#                  Its drawing is an SVG at ``width: 100%; height: auto``, so its
#                  height is a pure function of its width; the card therefore
#                  has to become *narrower* to become shorter, and doing it
#                  through the cell rather than through ``max_width`` is what
#                  scales the whole card (header, padding and drawing) instead of
#                  leaving a small picture in a wide one.  See
#                  :func:`_migrate_system_tile_stack`
_LAYOUT_KEY = "g2_layout"
_LAYOUT_VERSION = 31

# The view titles an earlier release wrote.  Used together with the absence of
# ``icon`` / ``max_columns`` as the fingerprint of an untouched old dashboard, so
# a layout upgrade can never overwrite a dashboard the user has edited.
_LEGACY_VIEW_TITLES: tuple[str, ...] = (
    "系统 / System",
    "设备 / Device",
    "控制 / Control",
)

# The history chart card type, referenced by the axis migration below.
HISTORY_CARD = "custom:hoymiles-g2-history-chart"
# The control card type, referenced by the TOU migration below.
CONTROL_CARD = "custom:hoymiles-g2-control"
# The gauge tile type, referenced by the icon migration below.
GAUGE_CARD = "custom:hoymiles-g2-gauge"
# The power flow and alarm card types, referenced by the Device view rebuild.
POWER_FLOW_CARD = "custom:hoymiles-g2-power-flow"
ALARM_CARD = "custom:hoymiles-g2-alarm"
# The opt-in chart switch card, added to the Device view of a micro inverter.
CHART_OPTIONS_CARD = "custom:hoymiles-g2-chart-options"
# The title that switch card was written with before revision 22.  Kept so a
# migration can tell "the title this release wrote" from "a title the user
# typed", and rewrite only the former.
_LEGACY_CHART_OPTIONS_TITLES: tuple[dict[str, str], ...] = (
    {"en": "More Curves", "zh": "更多曲线"},
)

# The two cards a micro inverter's Device view puts in its first row.  They are
# *siblings in one grid section*, sized 24 + 24 columns: a grid section divides
# itself into ``12 * column_span`` columns (``--base-column-count: 12`` in
# ``hui-grid-section``), so a ``column_span: 4`` section owns 48 of them, and
# 24 + 24 is an exact half-and-half split that stays on one row at every width.
# The three shapes that do not work, for the record:
#
#   * a nested ``grid`` card with ``columns: 2`` draws equal halves from the
#     *card* width rather than the section's, so it cannot be combined with
#     anything else and shrinks both children;
#   * two sibling *sections* with ``column_span: 3`` / ``1`` do give a 3:1
#     split, but the dashboard stacks sections once ``max_columns`` drops, so
#     the pair broke onto two rows on a narrower window.
#
# Revision 6 used 9 + 3 and revision 7 used 27 + 9, both of them 3:1: a correct
# ratio for a schematic that only had to share a row with a list which was
# almost always empty.  Now that the list hides itself when the device is quiet
# and the schematic takes the whole row in that case, the split only *exists*
# while there is a fault to show - and then the vendor app's own page is a
# half-and-half pair.
#
# Revision 18 wrote 18 / 18, which was the right *ratio* on the wrong *total*:
# it summed to 36 of the section's 48 columns, so both cards measured 503 px
# inside a 1354 px row and left a 348 px blank strip down the right-hand side.
# 24 / 24 is the same halves of the row the section actually has.
_FLOW_COLUMNS = 24
_ALARM_COLUMNS = 24
_SECTION_COLUMNS = 48

# The schematic's own drawing cap, in pixels.  The Device view's card is half a
# wide row while a fault is listed beside it and the whole row when the list
# hides, so any *fixed* cap is wrong in one of the two states: 640 px left the
# drawing floating in a cell it could never fill (and, once the row was
# measured, in a card that was itself too narrow), and a larger fixed number
# would overflow the half it lives in.  ``0`` means "no cap": the card fills
# whatever cell it is given and the SVG scales proportionally with it, which is
# what makes the pair occupy the full page width in both states.  The System
# view's flows keep their own explicit width - they have no ``variant`` and are
# never touched by the migrations.
_DEVICE_FLOW_MAX_WIDTH = 0

# The System tab's first row, in columns of the section it lives in: three
# quarters for the schematic, one quarter for the two energy tiles stacked in
# it.  The tiles lost their side-by-side arrangement in revision 27 - two
# full-height cards for two numbers, arranged horizontally, spent a whole card
# each on a column that could hold both - and the width they gave up went to the
# drawing, whose cap is raised below to match.
#
# These are the Device view's 24 / 24 mechanism, not tracks of a nested grid.
# Revision 27 wrote the 3:1 ratio as ``_nested_grid(cards, 4)`` with
# ``grid_options: {columns: 3}`` on the schematic and ``{columns: 1}`` on the
# tile stack, which reads correctly and measures as a flat 1:1 on HA 2026.5.4:
# ``hui-grid-card`` lays its children out with ``grid-column: auto`` and never
# reads ``grid_options`` from them, so both cards took exactly one of its four
# tracks.  A *section* does honour ``grid_options`` - ``_FLOW_COLUMNS`` /
# ``_ALARM_COLUMNS`` below have relied on it since revision 18 - so the pair is
# written as two plain siblings of one section instead.
#
# 27 + 9 is 36, the width of the section when ``hui-sections-view`` renders it
# at its *effective* span rather than the configured 4: on a 1440 px window the
# view fits three columns, so the grid section owns ``12 * 3`` tracks and the
# pair fills the row exactly at a 3:1 ratio.  A narrower window clamps the
# schematic to the track count (``grid-column: span min(--column-size,
# --grid-column-count)``) and drops the tiles onto the next row, which is a
# sane degradation to "schematic above, tiles below".
#
# Revision 31 cuts both numbers to two thirds - 18 + 6, still 3:1, still summing
# to the row.  The card was simply too tall, and with the drawing being an SVG
# at ``width: 100%; height: auto`` its height is a pure function of its width
# (700 x 360 in the compact profile), so the *only* way to shorten it without
# distorting the schematic - or leaving a small picture floating in a wide card,
# which a ``max_width`` cap does - is to give the card a narrower cell.  Two
# thirds of the columns is two thirds of the width is two thirds of the height,
# i.e. the whole card scales as one piece, and the tiles that share the row
# shrink with it.
#
# Measured before the change: 830 x 459 px at a 1440 px window and 750 x 418 at
# 824 px.  After it: 551 x 316 and 561 x 320 - two thirds of the width and, as
# predicted, two thirds of the height.  The two windows now agree on the card's
# size, which they did not before: a span of >= the track count clamps to the
# full row, so 27 columns was two thirds of the row on a wide window and all of
# it on a narrow one, and the same dashboard drew the schematic at two sizes.
_SYSTEM_FLOW_COLUMNS = 18
_SYSTEM_TILES_COLUMNS = 6
# The drawing cap for that cell.  It used to be 700 px beside two half-width
# tiles, then 960 px once the tiles dropped to a quarter of the row.  Both were
# chosen to *not* bind, and 960 still does not - it is only the "unset" sentinel
# the migrations write, and the narrower cell is what sizes the drawing now.
_SYSTEM_FLOW_MAX_WIDTH = 960

# Entity ids are ``sensor.<slug(dev_id)>_<key>``.  Only keys whose display name
# slugifies back to the key are safe to reference explicitly below - a few
# (``grid_on_power_5m`` -> "Grid On Power (5 min)", ``ems_mode_running`` ->
# "EMS Mode (Device)") do not round-trip, so they are deliberately absent here
# and are left to the cards' dev_id-based resolution instead.
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(dev_id: str) -> str:
    """Lower-case the serial and turn every non-alphanumeric run into ``_``."""
    return _SLUG_RE.sub("_", dev_id.lower()).strip("_")


def _url_path(dev_id: str) -> str:
    """Return the dashboard url slug, e.g. ``g2-rmi-4161a0209ff6``."""
    return f"{DASHBOARD_URL_PREFIX}{_slug(dev_id)}"


def _is_inverter(dev_id: str) -> bool:
    """True for a grid-tied micro inverter, decided by the serial's PID."""
    return is_inverter_dev_id(dev_id)


def _entity(dev_id: str, key: str) -> str:
    """Build the conventional entity id ``sensor.<slug>_<key>``.

    This is only a *guess*: it is what Home Assistant would derive for a sensor
    whose name slugifies to exactly ``key``.  It is right for most readings but
    wrong for any whose display name is not the key - ``grid_on_power_5m`` is
    named "Grid On Power (5 min)" and therefore lives at
    ``sensor.<slug>_grid_on_power_5_min``, and a user rename moves it anywhere.
    Anything that must *work* rather than merely look plausible goes through
    :func:`_resolve_entity` instead.
    """
    return f"sensor.{_slug(dev_id)}_{key}"


def _strip_suffix(entity_id: Any) -> str:
    """Drop the ``_2`` / ``_3`` … Home Assistant appended to an ``entity_id``.

    Home Assistant numbers a colliding ``entity_id`` instead of failing, so a
    unit whose serial was registered once before ends up with every entity at
    ``sensor.<slug>_<key>_2`` while the generator - which derives the id from
    the serial alone - writes ``sensor.<slug>_<key>``.  The migrations compare
    stored ids against generated ones, so they have to look past that number:
    ``_strip_suffix("sensor.x_foo_2")`` is ``"sensor.x_foo"``, and an id
    without one is returned unchanged (so anything else, including
    ``..._power_5_min``, is untouched).
    """
    if not isinstance(entity_id, str):
        return entity_id
    base, sep, tail = entity_id.rpartition("_")
    if sep and tail.isdigit() and tail != "0":
        return base
    return entity_id


def _registry_entity(hass: HomeAssistant, dev_id: str, key: str) -> str | None:
    """The ``entity_id`` the registry holds for ``unique_id = <domain>_<dev>_<key>``.

    ``None`` when the entry is not registered (yet), which is different from
    "registered under the conventional name" - the caller has to know whether it
    is looking at a fact or a guess.
    """
    wanted = f"{DOMAIN}_{dev_id}_{key}"

    try:
        from homeassistant.helpers import entity_registry as er  # noqa: PLC0415

        registry = er.async_get(hass)
    except Exception:  # noqa: BLE001 - a card is never worth breaking setup for
        return None

    if registry is None:
        return None

    try:
        entry = registry.async_get_entity_id("sensor", DOMAIN, wanted)
        if entry:
            return entry
    except Exception:  # noqa: BLE001
        pass

    try:
        for candidate in list(registry.entities.values()):
            if candidate.unique_id == wanted and candidate.entity_id:
                return candidate.entity_id
    except Exception:  # noqa: BLE001
        pass

    return None


def _resolve_entity(hass: HomeAssistant, dev_id: str, key: str) -> str:
    """The real ``entity_id`` of this device's ``key`` sensor.

    Resolved through the entity registry by ``unique_id`` - which is built from
    the serial plus the description key and never follows a rename - because the
    conventional id is only a guess (see :func:`_entity`).  The guess is the
    fallback for a device whose platform has not registered the entity yet,
    which is the only case where nothing better exists.
    """
    return _registry_entity(hass, dev_id, key) or _entity(dev_id, key)


def _t(en: str, zh: str) -> dict[str, str]:
    """A language map the cards resolve against the viewing user's UI."""
    return {"en": en, "zh": zh}


def _identity_keys(dev_id: str) -> set[str]:
    """Every spelling a device registry entry may use for this serial.

    This integration registers ``(DOMAIN, "RMI-4161A0209FF6")`` while the
    firmware's own MQTT discovery registers ``4161A0209FF6`` - same hardware,
    two identifiers - so both spellings have to match.
    """
    lowered = dev_id.lower()
    keys = {lowered, _slug(lowered), _slug(lowered).replace("_", "")}
    if "-" in dev_id:
        keys.add(dev_id.rsplit("-", 1)[-1].lower())
    return keys


def _device_model(device: Any) -> str:
    """Model string of a device registry entry, or ``""``."""
    for attr in ("model", "model_id"):
        value = getattr(device, attr, None)
        if value:
            return str(value)
    return ""


def _resolve_model(hass: HomeAssistant, dev_id: str) -> str:
    """Return this device's product name, e.g. ``HiFlow`` or ``HiBattery 4020 X``.

    Read from the device registry because the model is not a config entry value:
    the firmware's own retained discovery carries it.  Falls back to the serial
    prefix so the very first setup already gets a sensible title.
    """
    try:
        from homeassistant.helpers import device_registry as dr  # noqa: PLC0415

        registry = dr.async_get(hass)
    except Exception:  # noqa: BLE001 - a title is never worth breaking setup for
        registry = None

    if registry is not None:
        try:
            own = registry.async_get_device(identifiers={(DOMAIN, dev_id)})
        except Exception:  # noqa: BLE001
            own = None
        if own is not None:
            model = _device_model(own)
            if model:
                return model

        keys = _identity_keys(dev_id)
        for device in list(registry.devices.values()):
            for pair in device.identifiers:
                if not pair or pair[1] is None:
                    continue
                candidate = str(pair[1]).lower()
                if candidate in keys or candidate.replace("-", "") in keys:
                    model = _device_model(device)
                    if model:
                        return model

    return model_from_dev_id(dev_id) or ""


def _dashboard_title(dev_id: str) -> str:
    """The default sidebar / header title: the bare serial.

    Only the serial, never ``<model>_<serial>``: the model string is not stable
    (it arrives later from the firmware's discovery, so the title used to change
    under the user's feet) and the user is free to rename the dashboard anyway -
    see :func:`_is_generated_title`.
    """
    return dev_id


def _is_generated_title(current: str, dev_id: str) -> bool:
    """True when ``current`` is a title a previous version wrote itself.

    Earlier releases titled these dashboards ``HiFlow_RMI-4161A0209FF6`` /
    ``HiFlow Pro_RMI-4161A0209FF6``.  Those are ours, so they may be migrated to
    the bare serial exactly once.  Anything else is a name the user chose and is
    never touched again.
    """
    if not current or current == dev_id:
        return False
    return current.endswith(f"_{dev_id}") or current.endswith(f"-{dev_id}")


def _alarm_entity_id(hass: HomeAssistant, dev_id: str) -> str:
    """The *real* ``entity_id`` of this device's alarm sensor.

    The alarm sensor declares ``_attr_has_entity_name``, so Home Assistant
    derives its ``entity_id`` from the **device name at the moment the entity is
    first created** and never revisits it afterwards.  That sensor is far newer
    than the rest of the platform, so on a device the user had already renamed
    (``卧室 RMI-4161A0209FF6``) it came out as
    ``sensor.wo_shi_rmi_4161a0209ff6_active_alarms`` while every other entity
    kept the serial-based id.  A dashboard that hard-codes
    ``sensor.<slug(dev_id)>_active_alarms`` therefore points at an entity that
    never existed, and the alarm card falls back to "Alarm data unavailable"
    even though the sensor is reporting perfectly well.

    ``unique_id`` is the stable identity here - it is built from the serial and
    never follows a rename - so the registry is searched by that first.  The
    conventional id is only the fallback, for a device whose entity has not been
    registered yet (the very first setup, before the platform is added).
    """
    wanted = f"{DOMAIN}_{dev_id}_active_alarms"

    try:
        from homeassistant.helpers import entity_registry as er  # noqa: PLC0415

        registry = er.async_get(hass)
    except Exception:  # noqa: BLE001 - a card is never worth breaking setup for
        registry = None

    if registry is not None:
        try:
            for entry in list(registry.entities.values()):
                if entry.unique_id == wanted and entry.entity_id:
                    return entry.entity_id
        except Exception:  # noqa: BLE001
            pass

    return _entity(dev_id, "active_alarms")


async def _async_read_storage(hass: HomeAssistant, store: Any) -> Any:
    """Read a ``LovelaceStorage`` config across Home Assistant versions.

    The signature of ``async_load`` changed: some releases declare
    ``async_load(self)``, newer ones ``async_load(self, force: bool)``.  Calling
    it with no argument therefore raises ``TypeError`` on those releases - which
    the caller's broad ``except`` swallowed, silently disabling every layout
    upgrade.  ``force=True`` is passed where accepted so a dashboard written
    earlier in the same process is really re-read from disk instead of served
    from the in-memory cache.
    """
    loader = store.async_load
    try:
        params = inspect.signature(loader).parameters
    except (TypeError, ValueError):
        params = {}

    attempts: list[tuple[Any, ...]] = []
    if "force" in params or len(params) > 1:
        attempts.append((True,))
    attempts.append(())

    for args in attempts:
        try:
            return await loader(*args)
        except TypeError:
            continue
        except Exception:  # noqa: BLE001 - fall through to the file probe
            break

    return await _async_read_storage_file(hass, store)


async def _async_read_storage_file(hass: HomeAssistant, store: Any) -> Any:
    """Last-resort read of the dashboard JSON straight off disk.

    ``LovelaceStorage`` keeps its ``Store`` on a private attribute whose name has
    been stable for years, but the end of the world is not worth risking on it:
    every lookup is guarded and ``None`` simply means "cannot tell", which makes
    the caller leave the dashboard alone.
    """
    inner = getattr(store, "_store", None)
    key = getattr(inner, "key", None)
    if not isinstance(key, str) or not key.startswith("lovelace"):
        return None

    path = hass.config.path(".storage", key)
    try:
        raw = await hass.async_add_executor_job(_read_json_file, path)
    except Exception:  # noqa: BLE001
        return None

    if isinstance(raw, dict):
        return raw.get("data", {}).get("config", raw)
    return None


def _read_json_file(path: str) -> Any:
    """Read one JSON file, raising on any problem."""
    import json  # noqa: PLC0415

    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


_COMMANDS = "websocket_api"
# A dashboard command is a bookkeeping write; if it has not answered by now the
# frontend is gone and waiting longer would hold up device setup for nothing.
_COMMAND_TIMEOUT = 10.0


class _CommandUser:
    """The only attributes the dashboard commands read from a connection."""

    id = "hoymiles-dashboard"
    is_admin = True
    is_owner = True
    is_active = True
    system_generated = False


class _CommandConnection:
    """Just enough of an ``ActiveConnection`` to run one command in-process.

    ``lovelace`` keeps its ``DashboardsCollection`` in a local variable of
    ``async_setup``: it never reaches ``hass.data``.  ``LovelaceData`` holds the
    per-``url_path`` configs, *not* the collection itself, so building a
    ``DashboardsCollection(hass)`` of our own gives a second object with a
    private copy of the data.  Whatever that copy creates is written to disk,
    while the object the delete button talks to never hears about it: the entry
    sits in the sidebar and in *Settings -> Dashboards*, and
    ``lovelace/dashboards/delete`` answers ``not_found``.  Worse, the next time
    Home Assistant saves that file itself it writes its own items and the entry
    is gone from disk.

    The commands registered under ``lovelace/dashboards/*`` are the only
    surviving references to the live collection, so calling one of them is the
    only way to make a dashboard written here an ordinary dashboard: Home
    Assistant persists it, registers its panel, and keeps it in the collection
    that delete, update and rename act on.

    The connection is not a socket.  ``send_result``/``send_error`` resolve the
    future the caller awaits, which turns the command into a plain ``await``.
    """

    subscriptions: dict[int, Any] = {}

    def __init__(self, future: asyncio.Future[Any]) -> None:
        """Wire the replies to ``future``."""
        self._future = future
        self.user = _CommandUser()

    def send_result(self, msg_id: int, data: Any = None) -> None:
        """Deliver the command's answer."""
        if not self._future.done():
            self._future.set_result(data)

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        """Turn the command's error reply into the caller's exception."""
        if not self._future.done():
            self._future.set_exception(HomeAssistantError(f"{code}: {message}"))

    def async_handle_exception(self, msg: dict[str, Any], err: Exception) -> None:
        """Surface an exception raised *inside* the command."""
        if not self._future.done():
            self._future.set_exception(err)

    def send_message(self, msg: Any) -> None:
        """Ignore unsolicited events; nothing here subscribes."""


async def _async_lovelace_command(
    hass: HomeAssistant, command: str, payload: dict[str, Any]
) -> Any:
    """Run one ``lovelace/dashboards/*`` command and return its reply.

    Raises when the command is unknown, answers with an error, or does not
    answer in time - every caller decides for itself whether that is worth a
    log line, because a dashboard must never take down device setup.
    """
    handlers = hass.data.get(_COMMANDS)
    entry = handlers.get(command) if isinstance(handlers, dict) else None
    # ``websocket_api.async_register_command`` stores ``(handler, schema)``.
    handler = entry[0] if isinstance(entry, tuple) else entry
    if handler is None:
        raise HomeAssistantError(f"Home Assistant has no {command} command")

    future: asyncio.Future[Any] = hass.loop.create_future()
    handler(hass, _CommandConnection(future), {"id": 1, "type": command, **payload})
    return await asyncio.wait_for(future, _COMMAND_TIMEOUT)


async def _async_dashboard_items(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return every dashboard entry Home Assistant currently holds.

    An empty list is returned on any failure, which makes every caller treat the
    dashboard as absent and rebuild it - the same thing a first install does.
    """
    try:
        items = await _async_lovelace_command(hass, "lovelace/dashboards/list", {})
    except Exception:  # noqa: BLE001 - a dashboard is never worth breaking setup
        _LOGGER.warning("Could not list dashboards", exc_info=True)
        return []
    return [item for item in items or [] if isinstance(item, dict)]


def _dashboard_store(hass: HomeAssistant, item: dict[str, Any]) -> Any:
    """Return the ``LovelaceStorage`` Home Assistant uses for ``item``.

    The live object is preferred: saving through a second ``LovelaceStorage``
    for the same key writes the right file but leaves the copy the frontend
    reads untouched until the next restart.  One is built only when the entry is
    not in the registry yet - a dashboard this process has not registered.
    """
    from homeassistant.components.lovelace.const import CONF_URL_PATH  # noqa: PLC0415
    from homeassistant.components.lovelace.dashboard import (  # noqa: PLC0415
        LovelaceStorage,
    )

    lovelace_data = hass.data.get("lovelace")
    dashboards = getattr(lovelace_data, "dashboards", None)
    if isinstance(dashboards, dict):
        store = dashboards.get(item.get(CONF_URL_PATH))
        if store is not None:
            return store
    return LovelaceStorage(hass, item)


async def async_ensure_dashboard(
    hass: HomeAssistant,
    dev_id: str,
    pv_count: int | None = None,
    role: str | None = None,
) -> None:
    """Create the device's storage dashboard if it does not exist yet.

    Idempotent: a second call for the same device (or after a reload) is a
    no-op.  Every failure path logs a warning and returns, because a dashboard
    must never take down the integration.

    ``pv_count`` and the model name only affect dashboards created from scratch;
    an existing dashboard is left alone so user edits - including a rename -
    survive upgrades.

    ``role`` is the unit's role in its installation (protocol §32), or ``None``
    while ``event/state`` has not been heard from.  It decides whether this unit
    gets a System view at all; see :func:`_build_views`.
    """
    url_path = _url_path(dev_id)
    title = _dashboard_title(dev_id)
    model = _resolve_model(hass, dev_id)

    try:
        from homeassistant.components.lovelace.const import (  # noqa: PLC0415
            CONF_ALLOW_SINGLE_WORD,
            CONF_ICON,
            CONF_TITLE,
            CONF_URL_PATH,
        )
    except ImportError:
        _LOGGER.debug("Lovelace internals unavailable, skipping dashboard for %s", dev_id)
        return

    lovelace_data = hass.data.get("lovelace")
    if lovelace_data is None:
        _LOGGER.debug("Lovelace not loaded, skipping dashboard for %s", dev_id)
        return

    dashboards = getattr(lovelace_data, "dashboards", None)
    if dashboards is None:
        _LOGGER.warning("No dashboards registry, skipping dashboard for %s", dev_id)
        return

    # Fast path: the dashboards dict is already populated and knows this slug.
    # The dashboard - and any name the user gave it - is left untouched; only a
    # title an older release generated is migrated, once.
    if url_path in dashboards:
        _LOGGER.debug("Dashboard %s already exists, leaving it alone", url_path)
        await _async_migrate_title(hass, dev_id, url_path, title)
        await _async_upgrade_layout(
            hass, dashboards[url_path], dev_id, url_path, pv_count, model
        )
        # After the revision work, deliberately: a legacy rebuild replaces the
        # whole ``views`` list, so the role gate has to see the final one.
        await _async_sync_role(
            hass, dashboards[url_path], dev_id, url_path, role
        )
        return

    # Nothing in the live registry under this slug, so ask the collection itself:
    # the dashboard may have been created by an earlier release, before this
    # process registered any panel.
    existing = None
    for candidate in await _async_dashboard_items(hass):
        if candidate.get(CONF_URL_PATH) == url_path:
            existing = candidate
            break

    if existing is not None:
        # Already created by an earlier version.  The views and the name are the
        # user's now: only a title this integration generated itself is migrated
        # to the bare serial, and only once - a rename must never be undone.
        _LOGGER.debug("Dashboard %s already in storage", url_path)
        current = existing.get(CONF_TITLE) or ""
        if _is_generated_title(current, dev_id):
            await _async_rename(hass, existing, url_path, title)
        # An icon an older release generated is migrated the same way, and only
        # while it is still that exact icon: a user who picked their own keeps
        # it, and re-running this is a no-op.
        if (existing.get(CONF_ICON) or "") == _LEGACY_DASHBOARD_ICON:
            await _async_reicon(hass, existing, url_path)
        # The view set is the user's, but the role gate is not a preference: a
        # follower has no System data to draw.  Applied to whatever is stored.
        await _async_sync_role(
            hass, _dashboard_store(hass, existing), dev_id, url_path, role
        )
        return

    # Create the dashboard entry through the live collection, which persists it
    # to ``.storage/lovelace_dashboards``, registers the sidebar panel and keeps
    # it in the object delete/update act on.  See :class:`_CommandConnection`.
    try:
        item = await _async_lovelace_command(
            hass,
            "lovelace/dashboards/create",
            {
                CONF_ALLOW_SINGLE_WORD: True,
                CONF_ICON: DASHBOARD_ICON,
                CONF_TITLE: title,
                CONF_URL_PATH: url_path,
            },
        )
    except Exception:  # noqa: BLE001
        _LOGGER.warning("Could not create dashboard entry for %s", dev_id, exc_info=True)
        return

    if not isinstance(item, dict):
        _LOGGER.warning("Dashboard entry for %s came back empty", dev_id)
        return

    # Persist the views into ``.storage/lovelace.<id>``.  The store comes from
    # the live registry, which the create above just populated, so the frontend
    # sees the cards without waiting for a restart.
    store = _dashboard_store(hass, item)
    try:
        await store.async_save(
            {
                "views": _build_views(
                    dev_id, pv_count, model, _alarm_entity_id(hass, dev_id)
                ),
                _LAYOUT_KEY: _LAYOUT_VERSION,
            }
        )
    except Exception:  # noqa: BLE001
        _LOGGER.warning("Could not save dashboard views for %s", dev_id, exc_info=True)
        try:
            await _async_lovelace_command(
                hass, "lovelace/dashboards/delete", {"dashboard_id": item["id"]}
            )
        except Exception:  # noqa: BLE001
            pass
        return

    # The view set above is always complete; the role decides what of it is
    # visible.  Done here as well as on the existing-dashboard path because a
    # fresh install usually has not seen ``event/state`` yet, and the sync has to
    # be able to run the moment it does (see ``async_sync_role``).
    await _async_sync_role(hass, store, dev_id, url_path, role)

    _LOGGER.info("Created Lovelace dashboard %s (%s)", url_path, title)


async def _async_migrate_title(
    hass: HomeAssistant, dev_id: str, url_path: str, title: str
) -> None:
    """Migrate an older generated title to the bare serial, at most once.

    The live dashboards dict is populated from storage before this integration's
    platforms are set up, so the fast path - not the storage branch - is where an
    existing dashboard is usually seen.  The title therefore has to be checked
    here, which means reading the dashboards collection.  After the first run
    the stored title equals ``dev_id`` and nothing further happens.
    """
    if url_path in _TITLE_CHECKED:
        return
    _TITLE_CHECKED.add(url_path)

    try:
        from homeassistant.components.lovelace.const import (  # noqa: PLC0415
            CONF_ICON,
            CONF_TITLE,
            CONF_URL_PATH,
        )

        for item in await _async_dashboard_items(hass):
            if item.get(CONF_URL_PATH) != url_path:
                continue
            if _is_generated_title(item.get(CONF_TITLE) or "", dev_id):
                await _async_rename(hass, item, url_path, title)
            if (item.get(CONF_ICON) or "") == _LEGACY_DASHBOARD_ICON:
                await _async_reicon(hass, item, url_path)
            return
    except Exception:  # noqa: BLE001 - a title is never worth breaking setup for
        _LOGGER.debug("Could not inspect dashboard title for %s", url_path, exc_info=True)


async def _async_rename(
    hass: HomeAssistant,
    item: dict[str, Any],
    url_path: str,
    title: str,
) -> None:
    """Write ``title`` into the dashboards collection and the sidebar.

    Only ever reached for a title :func:`_is_generated_title` recognises as ours,
    so a user-chosen name is never overwritten.
    """
    try:
        from homeassistant.components.lovelace.const import CONF_TITLE  # noqa: PLC0415

        updated = await _async_lovelace_command(
            hass,
            "lovelace/dashboards/update",
            {"dashboard_id": item["id"], CONF_TITLE: title},
        )
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not retitle dashboard %s", url_path, exc_info=True)
        return

    if isinstance(updated, dict):
        item.update(updated)
    _LOGGER.info("Migrated dashboard %s title to %s", url_path, title)
    _sync_sidebar_title(hass, url_path, title)


async def _async_reicon(
    hass: HomeAssistant,
    item: dict[str, Any],
    url_path: str,
) -> None:
    """Swap the dashboard entry's sidebar icon for ``DASHBOARD_ICON``.

    Only ever reached while the stored icon is exactly the one an earlier
    release generated, so a user-chosen icon is never overwritten, and running
    it again is a no-op.  Home Assistant re-registers the panel from the change
    listener after the update, which is how the icon reaches the sidebar.
    """
    try:
        from homeassistant.components.lovelace.const import CONF_ICON  # noqa: PLC0415

        updated = await _async_lovelace_command(
            hass,
            "lovelace/dashboards/update",
            {"dashboard_id": item["id"], CONF_ICON: DASHBOARD_ICON},
        )
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not re-icon dashboard %s", url_path, exc_info=True)
        return

    if isinstance(updated, dict):
        item.update(updated)
    _LOGGER.info("Migrated dashboard %s icon to %s", url_path, DASHBOARD_ICON)
    _sync_sidebar_title(hass, url_path, item.get("title") or url_path)


async def _async_find_store(hass: HomeAssistant, url_path: str) -> Any:
    """Return the ``LovelaceStorage`` of an existing dashboard, or ``None``.

    The live registry is preferred because it is the object the frontend reads:
    saving through a second ``LovelaceStorage`` for the same key would write the
    right file but leave the loaded copy in memory untouched until a restart.
    The collection is only asked when the registry has no entry for the slug
    (a dashboard created by an earlier release, before the registry was
    populated in this process).
    """
    lovelace_data = hass.data.get("lovelace")
    dashboards = getattr(lovelace_data, "dashboards", None) if lovelace_data else None
    if isinstance(dashboards, dict):
        store = dashboards.get(url_path)
        if store is not None:
            return store

    try:
        from homeassistant.components.lovelace.const import CONF_URL_PATH  # noqa: PLC0415

        for item in await _async_dashboard_items(hass):
            if item.get(CONF_URL_PATH) == url_path:
                return _dashboard_store(hass, item)
    except Exception:  # noqa: BLE001 - a dashboard is never worth breaking setup
        _LOGGER.debug("Could not locate dashboard %s", url_path, exc_info=True)

    return None


async def async_sync_role(hass: HomeAssistant, dev_id: str, role: str | None) -> None:
    """Apply the unit's role to an already-created dashboard.

    Public because the role is not known at setup time: ``event/state`` is
    published by the device whenever it feels like it, and often *after* the
    dashboard was written.  The caller re-invokes this each time the role
    changes (at most a handful of times per install) and it is a no-op when
    nothing has to move.

    Never raises.  ``role is None`` means "not heard yet" and leaves the stored
    layout exactly as it is.
    """
    url_path = _url_path(dev_id)
    try:
        store = await _async_find_store(hass, url_path)
        if store is None:
            return
        await _async_sync_role(hass, store, dev_id, url_path, role)
    except Exception:  # noqa: BLE001 - never break setup for a tab
        _LOGGER.debug("Could not sync the role of %s", dev_id, exc_info=True)


async def _async_sync_role(
    hass: HomeAssistant,
    store: Any,
    dev_id: str,
    url_path: str,
    role: str | None,
) -> None:
    """Hide or restore the System view according to the unit's role.

    Protocol §32 makes the role the key to two different sets of topics, and the
    document puts ``system/state`` - and therefore every system aggregate - under
    「主机和单机」: a ``slave`` never publishes it.  Its System view was six cards
    of ``unknown``, so it is taken out of the stored config and kept aside under
    ``_ROLE_SYSTEM_KEY`` instead of being deleted.  Reporting another role again
    puts the very same dict back at the front, so re-pairing a unit restores its
    tab byte for byte - including anything the user changed inside it.

    Only ``slave`` is acted on.  ``None`` (no ``event/state`` yet, or a spelling
    this release does not know) keeps the full layout: "not heard from" is not
    "follows a master", and a follower's dashboard losing its first tab because
    MQTT was slow would be worse than the empty cards this fixes.

    Every write is a single ``async_save`` and the whole function is optional:
    the Control card gates its own rows from the ``system_role`` sensor, so a
    failure here costs the System tab only.
    """
    if role is None:
        return
    if _ROLE_APPLIED.get(url_path) == role:
        return

    try:
        config = await _async_read_storage(hass, store) or {}
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not read dashboard %s", url_path, exc_info=True)
        return

    if not isinstance(config, dict):
        return
    views = config.get("views")
    if not isinstance(views, list):
        return

    stashed = config.get(_ROLE_SYSTEM_KEY)
    updated: dict[str, Any] | None = None

    if role == ROLE_SLAVE:
        if isinstance(stashed, dict):
            # Hidden by an earlier run; the tab is already gone.
            _ROLE_APPLIED[url_path] = role
            return
        kept: list[Any] = []
        hidden: dict[str, Any] | None = None
        for view in views:
            if hidden is None and isinstance(view, dict) and view.get("path") == "system":
                hidden = view
                continue
            kept.append(view)
        if hidden is None:
            # No System view to hide (a hand-built dashboard): nothing to do,
            # and the role is recorded so this is not re-read on every update.
            _ROLE_APPLIED[url_path] = role
            return
        if not kept:
            # Refuse to leave a dashboard with no tabs at all.
            _LOGGER.debug("Not hiding the only view of %s", url_path)
            return
        updated = {**config, "views": kept, _ROLE_SYSTEM_KEY: hidden}
    else:
        if not isinstance(stashed, dict):
            _ROLE_APPLIED[url_path] = role
            return
        updated = {**config, "views": [stashed, *views]}
        updated.pop(_ROLE_SYSTEM_KEY, None)

    try:
        await store.async_save(updated)
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not save dashboard %s", url_path, exc_info=True)
        return

    _ROLE_APPLIED[url_path] = role
    _LOGGER.info(
        "Dashboard %s: %s as role %s",
        url_path,
        "hid the System view" if role == ROLE_SLAVE else "restored the System view",
        role,
    )


async def _async_upgrade_layout(
    hass: HomeAssistant,
    store: Any,
    dev_id: str,
    url_path: str,
    pv_count: int | None,
    model: str,
) -> None:
    """Bring a dashboard written by an older release up to ``_LAYOUT_VERSION``.

    Two mechanisms, tried in order, because they protect different things:

    1. :func:`_is_legacy_layout` - the dashboard is byte-for-byte what an early
       release produced, so it is safe to rebuild it wholesale.
    2. :func:`_migrate_axis_cards` - the dashboard has been touched by the user
       (renamed views, extra cards), so only the *card options* this release
       changed are rewritten, one key at a time.  Renames, ordering and added
       cards are all preserved.

    Both are gated on the stored ``_LAYOUT_KEY`` marker, so a dashboard is
    migrated at most once and a user who deliberately re-adds a fixed ``span``
    afterwards keeps it.

    Verified once per device per process, because ``LovelaceStorage`` caches its
    config in memory.  The role gate is deliberately *not* applied here: a legacy
    rebuild replaces the whole ``views`` list, so the caller runs
    :func:`_async_sync_role` after this returns, never before.
    """
    if url_path in _LAYOUT_CHECKED:
        return
    _LAYOUT_CHECKED.add(url_path)

    try:
        config = await _async_read_storage(hass, store) or {}
    except Exception:  # noqa: BLE001 - a layout is never worth breaking setup for
        _LOGGER.warning("Could not read dashboard %s", url_path, exc_info=True)
        return

    if not isinstance(config, dict):
        return

    # Already at this revision: nothing to do, now or after a restart.
    if config.get(_LAYOUT_KEY) == _LAYOUT_VERSION:
        return

    if _is_legacy_layout(config):
        try:
            await store.async_save(
                {
                    "views": _build_views(
                        dev_id, pv_count, model, _alarm_entity_id(hass, dev_id)
                    ),
                    _LAYOUT_KEY: _LAYOUT_VERSION,
                }
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Could not upgrade dashboard %s", url_path, exc_info=True)
            return
        _LOGGER.info("Rebuilt dashboard %s at layout revision %s", url_path, _LAYOUT_VERSION)
        return

    # A dashboard the user has touched: patch the chart options in place.
    try:
        alarm_entity = _alarm_entity_id(hass, dev_id) if _is_inverter(dev_id) else None
        changed = _migrate_axis_cards(config)
        changed = _migrate_control_cards(config, dev_id) or changed
        changed = _migrate_energy_total_card(config, dev_id) or changed
        changed = _migrate_device_alarm_card(config, dev_id, alarm_entity) or changed
        changed = (
            _migrate_device_alarm_columns(config, dev_id, alarm_entity) or changed
        )
        changed = _migrate_device_drop_total_power(config, dev_id) or changed
        changed = _migrate_system_energy_chart(config, dev_id) or changed
        changed = _migrate_drop_heading(config) or changed
        changed = _migrate_total_icon(config, dev_id) or changed
        changed = _migrate_gauge_icons(config) or changed
        changed = _migrate_view_icons(config) or changed
        changed = _migrate_optional_entities(config, hass, dev_id) or changed
        changed = _migrate_chart_options_card(config, dev_id) or changed
        changed = _migrate_chart_options_title(config) or changed
        changed = _migrate_plant_view(config, dev_id) or changed
        changed = _migrate_system_power_axis(config, dev_id) or changed
        changed = _migrate_stale_entities(config, hass, dev_id) or changed
        changed = _migrate_plant_energy_total(config, dev_id) or changed
        changed = _migrate_system_tile_stack(config, dev_id) or changed
        if not changed:
            # Nothing matched, so the dashboard is not one of ours at the
            # revision being migrated (a hand-built dashboard, or a layout from
            # a much newer release).  Record the revision so this check does not
            # run again, but leave the content alone.
            await store.async_save({**config, _LAYOUT_KEY: _LAYOUT_VERSION})
            return
        await store.async_save({**config, _LAYOUT_KEY: _LAYOUT_VERSION})
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not patch dashboard %s", url_path, exc_info=True)
        return

    _LOGGER.info("Migrated dashboard %s to layout revision %s", url_path, _LAYOUT_VERSION)


def _migrate_control_cards(config: dict[str, Any], dev_id: str) -> bool:
    """Drop the TOU plan row from a micro inverter's Control card.

    An earlier release created the ``tou_*`` entities on every model, so the
    Control card of a micro inverter grew a "Get TOU plan" row - a button that
    could only ever time out, because the firmware neither declares ``tou_get``
    nor publishes a ``tou_*`` topic.  The generator no longer emits that row, and
    the sensor platform now prunes the entities themselves; this migration exists
    for the dashboards already stored on disk, whose ``_LAYOUT_KEY`` marker keeps
    :func:`_build_views` from regenerating them.

    Only a card that really is the inverter layout is touched: the storage unit
    keeps its TOU editor, and its Control card is left byte-for-byte alone.  A
    dashboard where the row was re-enabled by hand is not overridden either - the
    key is only written where it is still absent.

    The ``entities.output_power`` pin an older release wrote is removed here as
    well, for the same reason it is no longer generated: ``number.<dev>`` is
    whichever of the two ``number`` entities Home Assistant created first, so
    the pin is right on a two-input HiFlow Pro and wrong on a single-input
    HiFlow.  The card now separates the two by their declared floor.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    changed = False
    for card in _walk_cards(views):
        if not isinstance(card, dict):
            continue
        if card.get("type") != CONTROL_CARD:
            continue
        pins = card.get("entities")
        if isinstance(pins, dict) and "output_power" in pins:
            pins = {k: v for k, v in pins.items() if k != "output_power"}
            if pins:
                card["entities"] = pins
            else:
                card.pop("entities", None)
            changed = True
        if "show_tou" in card:
            continue
        card["show_tou"] = False
        changed = True

    return changed


def _migrate_energy_total_card(config: dict[str, Any], dev_id: str) -> bool:
    """Add the lifetime PV energy card next to "today" on an existing dashboard.

    The System view already shows a "PV today" gauge; this release puts the
    lifetime counter beside it so the two can be read together.  A dashboard
    stored by an older release is not regenerated - ``_LAYOUT_KEY`` short-circuits
    :func:`_build_views` - so the card has to be inserted into the live layout.

    Insertion is positional and conservative:

    * the anchor is the card whose ``entity`` is exactly
      ``sensor.<slug>_system_pv_energy_today``, never a title or an index, so a
      user who renamed or reordered things still gets the card in the right
      place;
    * the new card is only added where the layout has neither a
      ``plant_pv_energy_total`` nor a legacy ``pv_energy_total`` gauge yet,
      which makes the migration idempotent and keeps a card the user removed
      from coming back;
    * only micro inverters are touched, because the lifetime counter is created
      with ``requires_absent=CAP_SYSTEM_STATE`` and does not exist on a storage
      unit.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    today_entity = _entity(dev_id, "system_pv_energy_today")
    total_entities = {
        _entity(dev_id, "plant_pv_energy_total"),
        _entity(dev_id, "pv_energy_total"),
    }

    # Never add the card twice: an install that has been through this migration
    # already (or was generated fresh) must be left alone.  Both the current and
    # the pre-rev.26 entity count as "already there", so an upgraded dashboard is
    # not given a second, per-unit card beside the aggregated one.
    for card in _walk_cards(views):
        if isinstance(card, dict) and card.get("entity") in total_entities:
            return False

    added = False

    def walk(node: Any) -> None:
        nonlocal added
        if added:
            return
        if isinstance(node, list):
            for index, item in enumerate(node):
                if added:
                    return
                # The anchor lives in a ``cards`` list; splice right after it, so
                # the new card lands immediately to its right.
                if isinstance(item, dict) and item.get("entity") == today_entity:
                    node.insert(index + 1, _energy_total_gauge(dev_id))
                    added = True
                    return
                walk(item)
            return
        if not isinstance(node, dict):
            return
        for key in ("cards", "sections"):
            if isinstance(node.get(key), list):
                walk(node[key])

    walk(views)
    return added


def _migrate_device_alarm_card(
    config: dict[str, Any], dev_id: str, alarm_entity: str | None = None
) -> bool:
    """Put the alarm card beside a narrower power flow on an existing dashboard.

    The Device view used to draw the power flow across the full width, with the
    alarm list appearing nowhere.  This release gives the flow only one of the
    two columns and puts the alarms in the other, so the two read together: a
    fault and the schematic it affects are on the same screen instead of one tab
    apart.

    The rebuild is narrow on purpose:

    * only the **inverter** layout is touched - a storage unit's Device view has
      a battery card and no ``alarm_state`` capability at all, so an alarm card
      there would sit at "unavailable" forever;
    * only a power-flow card carrying ``variant: inverter`` is an anchor; a
      user-added flow elsewhere on the page is left alone;
    * the card is only added where the layout has no alarm card yet, which makes
      the migration idempotent and keeps a card the user deleted from returning;
    * ``max_width`` is only lowered where it is still the old full-width value,
      so a width the user chose deliberately is preserved.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    # Already there (a fresh layout, or an install that has run this migration):
    # the card must not come back, and the width is left as found.
    if any(
        isinstance(card, dict) and card.get("type") == ALARM_CARD
        for card in _walk_cards(views)
    ):
        return False

    changed = False

    def _is_inverter_flow(item: Any) -> bool:
        return (
            isinstance(item, dict)
            and item.get("type") == POWER_FLOW_CARD
            and item.get("variant") == "inverter"
        )

    def _narrow_flow(flow: dict[str, Any]) -> bool:
        """Give the flow one column and a width that fits it."""
        touched = False
        # ``grid_options: {columns: full}`` is what made the card span the
        # section; dropped so it takes one column of the two-column grid it is
        # about to live in.
        if flow.pop("grid_options", None) is not None:
            touched = True
        if flow.get("max_width") in (640, 700):
            # The same width revision 19 settles on; written here as well so a
            # dashboard coming all the way from revision 5 never flashes the
            # full-width value before ``_migrate_device_alarm_columns`` runs.
            flow["max_width"] = _DEVICE_FLOW_MAX_WIDTH
            touched = True
        return touched

    def _process(container: dict[str, Any], key: str) -> bool:
        """Rewrite the card list ``container[key]``; True if anything changed."""
        nonlocal changed
        cards = container.get(key)
        if not isinstance(cards, list):
            return False

        for index, item in enumerate(cards):
            if not _is_inverter_flow(item):
                continue

            changed = _narrow_flow(item) or changed
            # A two-column grid already places cards side by side: the alarm
            # card only has to be inserted next to the flow.
            if container.get("columns") == 2:
                cards.insert(index + 1, _alarm_card(dev_id, alarm_entity))
            else:
                # A full-width section stacks its cards, so the pair has to be
                # wrapped to end up beside each other.
                cards[index] = _subgrid([item, _alarm_card(dev_id, alarm_entity)])
            changed = True
            return True
        return False

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        for key in ("cards", "sections"):
            if _process(node, key):
                return
        for key in ("cards", "sections"):
            if isinstance(node.get(key), list):
                walk(node[key])

    walk(views)
    return changed


def _migrate_device_alarm_columns(
    config: dict[str, Any], dev_id: str, alarm_entity: str | None = None
) -> bool:
    """Put the schematic and the alarms on one row as a 3:1 pair; revision 6.

    Revision 5 placed the power flow and the alarm list inside a nested ``grid``
    card with ``columns: 2``.  A nested grid only ever divides its row into
    *equal* columns - measured on a live dashboard at 431 px + 431 px inside an
    870 px row - which left the schematic too small to read, and it offers no
    way to ask for anything else.

    Revision 6 therefore makes the two cards *plain siblings of one grid
    section*, sized 9 and 3.  A grid section subdivides itself into
    ``12 * column_span`` columns (``--base-column-count: 12`` in
    ``hui-grid-section``), so 9 + 3 is an exact 3:1 split that stays on a single
    row at every width - unlike two sibling *sections*, which the dashboard
    stacks once it drops its ``max_columns``.

    Revision 7 keeps that shape but scales it up to the section's whole internal
    grid: a section lays out ``12 * column_span`` columns, so on a desktop that
    fits three dashboard columns it owns 36 of them.  9 + 3 was 3:1 but filled
    only a third of the row and left the schematic needlessly small, while
    27 + 9 fills all 36 columns and is still exactly 3:1.

    Revision 18 keeps filling those 36 columns but splits them in half: once the
    alarm list hides itself when the device is quiet, the pair only appears
    while there really is a fault, and the vendor app lays that page out as two
    equal halves.  18 + 18 is that page; the schematic reclaims the whole row on
    its own when the list is gone (see ``_syncRowSpan`` in the card).

    The rewrite is canonical rather than incremental: the flow and the alarm are
    located wherever an earlier revision left them (inside a nested grid, in a
    section of its own, or already side by side) and the section is then
    rewritten to the shape this revision wants.  A second run is therefore a
    no-op.  A flow the user placed among cards of their own keeps its place and
    is left alone.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    changed = False

    def _is_flow(item: Any) -> bool:
        return (
            isinstance(item, dict)
            and item.get("type") == POWER_FLOW_CARD
            and item.get("variant") == "inverter"
        )

    def _is_alarm(item: Any) -> bool:
        return isinstance(item, dict) and item.get("type") == ALARM_CARD

    def _flatten(section: dict[str, Any]) -> None:
        """Lift a nested grid's cards up into the section that held it."""
        nonlocal changed
        cards = section.get("cards")
        if not isinstance(cards, list):
            return
        flat: list[Any] = []
        lifted = False
        for card in cards:
            inner = card.get("cards") if isinstance(card, dict) else None
            if (
                isinstance(card, dict)
                and card.get("type") == "grid"
                and isinstance(inner, list)
                and any(_is_flow(entry) or _is_alarm(entry) for entry in inner)
            ):
                flat.extend(inner)
                lifted = True
            else:
                flat.append(card)
        if lifted:
            section["cards"] = flat
            changed = True

    for view in views:
        if not isinstance(view, dict):
            continue
        sections = view.get("sections")
        if not isinstance(sections, list):
            continue

        for section in sections:
            if isinstance(section, dict):
                _flatten(section)

        flow: Any = None
        flow_section: Any = None
        alarm: Any = None
        alarm_only: list[dict[str, Any]] = []
        for section in sections:
            if not isinstance(section, dict):
                continue
            cards = section.get("cards")
            if not isinstance(cards, list):
                continue
            for card in cards:
                if flow is None and _is_flow(card):
                    flow, flow_section = card, section
                elif alarm is None and _is_alarm(card):
                    alarm = card
            if cards and all(_is_alarm(card) for card in cards):
                alarm_only.append(section)

        if flow is None or not isinstance(flow_section, dict):
            continue

        section_cards = flow_section.get("cards")
        if not isinstance(section_cards, list):
            continue
        # A flow the user placed among cards of their own keeps its position.
        if any(not (_is_flow(card) or _is_alarm(card)) for card in section_cards):
            continue

        if alarm is None:
            alarm = _alarm_card(dev_id, alarm_entity)
            changed = True

        # The sensor derives its ``entity_id`` from the device name at creation
        # time, so a rename can move it away from the serial-based spelling the
        # card was written with.  Only an id this integration would itself have
        # generated is replaced - a card pointing somewhere the user chose is
        # left alone.
        if alarm_entity and alarm.get("entity") != alarm_entity:
            current = alarm.get("entity")
            if current == _entity(dev_id, "active_alarms") or not current:
                alarm["entity"] = alarm_entity
                changed = True

        # ``max_width`` was halved for the half-width column revision 5 drew;
        # revision 6 put it back to 700, revision 7 widened it to 1100 for the
        # three-quarter cell, and revision 19 settles on ``0`` - "fill the
        # cell" - now that the pair really does split the row in half.  Only
        # the values earlier revisions wrote are replaced - a width the user
        # chose is kept.
        if flow.get("max_width") in (380, 640, 700, 1100):
            flow["max_width"] = _DEVICE_FLOW_MAX_WIDTH
            changed = True
        # Both cards are now sized in columns of the shared section.
        if flow.get("grid_options") != {"columns": _FLOW_COLUMNS}:
            flow["grid_options"] = {"columns": _FLOW_COLUMNS}
            changed = True
        if alarm.get("grid_options") != {"columns": _ALARM_COLUMNS}:
            alarm["grid_options"] = {"columns": _ALARM_COLUMNS}
            changed = True

        # Revision 15 stops reserving a quarter of the row for a list that is
        # empty most of the time: the alarm card hides itself and the schematic
        # widens over the freed columns, so it must be able to count what it is
        # hiding.  Both keys are written only when absent or wrong, which keeps
        # a second run a no-op.
        if alarm.get("only_when_alarm") is not True:
            alarm["only_when_alarm"] = True
            changed = True
        if alarm_entity and flow.get("alarm_entity") != alarm_entity:
            flow["alarm_entity"] = alarm_entity
            changed = True
        elif not alarm_entity and "alarm_entity" in flow:
            # A stale id would make the badge show a red lamp for a device the
            # integration no longer tracks; a missing one just drops the badge.
            flow.pop("alarm_entity", None)
            changed = True

        wanted = [flow, alarm]
        if section_cards != wanted:
            flow_section["cards"] = wanted
            changed = True
        # The pair lives in the full-width section the row has always used.
        if flow_section.get("column_span", 4) != 4:
            flow_section["column_span"] = 4
            changed = True

        # Any alarm-only section is a leftover of revision 6's first draft;
        # dropping it keeps the result canonical.
        for section in alarm_only:
            if section is not flow_section:
                sections.remove(section)
                changed = True

    return changed


def _migrate_device_drop_total_power(config: dict[str, Any], dev_id: str) -> bool:
    """Remove the 「功率曲线」 chart from a micro inverter's Device view; rev. 9.

    Revision 9 stops generating that card.  The three series it drew
    (``system_pv_power`` / ``system_grid_power`` / ``system_load_power``) are
    still drawn together on the **System** view, where they belong: that tab is
    the installation as a whole.  On the Device tab they answered a question
    nobody asks of a single unit, duplicated what the per-port chart above
    already says, and meant storing the same three series twice per device.

    The rewrite is deliberately narrow and idempotent:

    * only the **inverter** layout is touched - the storage unit's Device view
      never had this card;
    * a card is recognised by its *series*, not by its title: the user is free
      to rename a card, and a chart that happens to be called 功率曲线 but plots
      something else must survive;
    * the chart has to be alone in its own grid section, which is how every
      generated layout placed it - a chart the user dragged next to cards of
      their own is left in place rather than taking those cards with it;
    * a section that is left empty is dropped, so no blank row remains.

    A second run finds nothing to remove and returns ``False``, which is what
    keeps the ``_LAYOUT_KEY`` marker honest.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    wanted = {
        _entity(dev_id, "system_pv_power"),
        _entity(dev_id, "system_grid_power"),
        _entity(dev_id, "system_load_power"),
    }

    def _is_total_power(card: Any) -> bool:
        if not isinstance(card, dict) or card.get("type") != HISTORY_CARD:
            return False
        return set(_series_entities(card)) == wanted

    changed = False
    for view in views:
        if not isinstance(view, dict) or view.get("path") != "device":
            continue
        sections = view.get("sections")
        if not isinstance(sections, list):
            continue
        for section in list(sections):
            if not isinstance(section, dict):
                continue
            cards = section.get("cards")
            if not isinstance(cards, list):
                continue
            if len(cards) != 1 or not _is_total_power(cards[0]):
                continue
            sections.remove(section)
            changed = True

    return changed


def _migrate_system_energy_chart(config: dict[str, Any], dev_id: str) -> bool:
    """Add 「发电量」 to an existing dashboard's System view; rev. 15.

    Revision 15 generates a bar chart of the lifetime PV counter (one bar per
    day of a month, one per month of a year) with three tiles above it, so the
    tab answers "how much did it make" and not only "how much is it making".
    ``_LAYOUT_KEY`` short-circuits :func:`_build_views`, so an install that
    already has a dashboard never sees the new card without this.

    The rewrite is conservative and idempotent:

    * only the **inverter** layout is touched - ``pv_energy_total`` is created
      with ``requires_absent=CAP_SYSTEM_STATE`` and does not exist on a storage
      unit, so the card there would read "no data" for ever;
    * the anchor is the ``chart`` that plots exactly the three system power
      series - not a title and not an index - so a user who renamed or
      reordered cards still gets the new chart in the right place.  The card is
      inserted as a **sibling section** after the anchor's section, which is how
      :func:`_build_inverter_views` lays the tab out, and reproduced here rather
      than appending to the anchor's ``cards`` because that section is
      ``full``-column and would stack them;
    * the migration returns ``False`` when there is nothing left to change, so a
      second run is a no-op and a chart the user deliberately deleted stays
      deleted.

    Revision 16 only repairs the opening ``range`` of the card this function
    inserts: revision 15 wrote it as a *day*, which is a curve of one day and
    not the row of bars the card exists for.  Only the exact value revision 15
    wrote is replaced, so a user who set another range keeps it.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    energy_entity = _entity(dev_id, "pv_energy_total")
    power_entities = {
        _entity(dev_id, "system_pv_power"),
        _entity(dev_id, "system_grid_power"),
        _entity(dev_id, "system_load_power"),
    }

    # Already present (fresh layout, or an install that ran this before): the
    # card must not come back, but a range revision 15 got wrong is repaired.
    for card in _walk_cards(views):
        if (
            isinstance(card, dict)
            and card.get("type") == HISTORY_CARD
            and energy_entity in _series_entities(card)
        ):
            if card.get("range") == "day":
                card["range"] = "month"
                return True
            return False

    def _is_system_power(card: Any) -> bool:
        return (
            isinstance(card, dict)
            and card.get("type") == HISTORY_CARD
            and power_entities.issubset(set(_series_entities(card)))
        )

    def _energy_chart() -> dict[str, Any]:
        return _grid(
            [
                _history(
                    _t("PV Energy", "发电量"),
                    [
                        {
                            "entity": energy_entity,
                            "name": _t("Generation", "发电量"),
                            "color": "#22c55e",
                        }
                    ],
                    unit="kWh",
                    height=300,
                    range="month",
                    sync_group=f"{_slug(dev_id)}-energy",
                    symmetric=False,
                    stack=False,
                    mode="auto",
                    show_totals=True,
                    scale=0.001,
                )
            ]
        )

    for view in views:
        if not isinstance(view, dict) or view.get("path") != "system":
            continue
        sections = view.get("sections")
        if not isinstance(sections, list):
            continue
        for index, section in enumerate(sections):
            cards = section.get("cards") if isinstance(section, dict) else None
            if not isinstance(cards, list):
                continue
            if not any(_is_system_power(card) for card in cards):
                continue
            sections.insert(index + 1, _energy_chart())
            return True

    return False


def _migrate_plant_view(config: dict[str, Any], dev_id: str) -> bool:
    """Re-point the System tab of a micro inverter at the installation; rev. 23.

    Three things change together on that tab, and doing any one of them alone
    would leave it self-contradictory (a plant-wide 今日发电 beside a per-unit
    curve, or a schematic without 光伏2 beside a curve that still plots it):

    1. the ``hoymiles-g2-power-flow`` card of the **system** view gets
       ``variant: inverter-system``;
    2. the 光伏功率 series of the system power chart moves from
       ``system_pv_power`` to ``system_plug_power``;
    3. the 今日发电 gauge moves from ``system_pv_energy_today`` to
       ``plant_pv_energy_today``.

    Only the ``system`` view is edited.  The Device tab keeps both the plain
    schematic (``variant: inverter``) and the per-unit entities, because that tab
    is about this unit - and a stored dashboard may legitimately have a System
    tab that a slave never got (``_async_sync_role`` removes it), in which case
    there is nothing here to do.

    Each step is independent and idempotent: a card the user removed, re-added or
    re-pointed is left as they left it, and a second run returns ``False``.  The
    stored ids are compared through :func:`_strip_suffix` since revision 30, so a
    unit whose entities Home Assistant numbered (``_2``) is recognised too; the
    ids written back are the plain ones, and :func:`_migrate_stale_entities` -
    which runs after this - maps them onto the numbered ids that really exist.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    old_pv = _entity(dev_id, "system_pv_power")
    new_pv = _entity(dev_id, "system_plug_power")
    old_today = _entity(dev_id, "system_pv_energy_today")
    new_today = _entity(dev_id, "plant_pv_energy_today")

    changed = False

    for view in views:
        if not isinstance(view, dict) or view.get("path") != "system":
            continue

        for card in _walk_cards(view.get("sections") or []):
            if not isinstance(card, dict):
                continue

            # 1. the schematic.
            if (
                card.get("type") == POWER_FLOW_CARD
                and card.get("dev_id") == dev_id
                and card.get("variant") in (None, "")
            ):
                card["variant"] = "inverter-system"
                changed = True

            # 2. the 光伏功率 curve.
            series = card.get("series")
            if isinstance(series, list):
                for item in series:
                    if not isinstance(item, dict):
                        continue
                    if _strip_suffix(item.get("entity")) != old_pv:
                        continue
                    item["entity"] = new_pv
                    changed = True

            # 3. the 今日发电 gauge.
            if _strip_suffix(card.get("entity")) == old_today:
                card["entity"] = new_today
                changed = True

    return changed


def _migrate_plant_energy_total(config: dict[str, Any], dev_id: str) -> bool:
    """Point the System tab's lifetime total at the installation; rev. 26.

    ``pv_energy_total`` is a **per-unit** counter (``pvs[].et`` summed over this
    body's ports) and the firmware never adds units up, so the System tab's
    总发电量 used to show the master's share of the roof: on the test
    installation 2 944 Wh of 6 100 Wh, less than half, and the card gave no hint
    that it was a part.  Revision 26 adds
    ``sensor.<slug>_plant_pv_energy_total`` - master plus every ``role: slave``
    unit - and this migration re-points the two System-tab cards that read the
    old entity:

    * the 总发电量 gauge beside 今日发电;
    * the 「发电量」 chart's single series, whose month / year / lifetime tiles are
      derived from the same statistic.

    Only the ``system`` view is rewritten.  The Device tab correctly keeps the
    per-unit counter, because that tab is about this unit.

    Each rewrite is gated on the exact old entity id, so a card the user
    re-pointed themselves is left alone, and a second run returns ``False``.
    Revision 30 compares through :func:`_strip_suffix`, so a unit whose entities
    Home Assistant numbered (``_2``) is recognised too.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    old_total = _entity(dev_id, "pv_energy_total")
    new_total = _entity(dev_id, "plant_pv_energy_total")
    changed = False

    for view in views:
        if not isinstance(view, dict) or view.get("path") != "system":
            continue

        for card in _walk_cards(view.get("sections") or []):
            if not isinstance(card, dict):
                continue
            # 1. the 总发电量 gauge.
            if _strip_suffix(card.get("entity")) == old_total:
                card["entity"] = new_total
                changed = True
            # 2. the 发电量 chart's series.
            series = card.get("series")
            if isinstance(series, list):
                for item in series:
                    if not isinstance(item, dict):
                        continue
                    if _strip_suffix(item.get("entity")) != old_total:
                        continue
                    item["entity"] = new_total
                    changed = True

    return changed


def _migrate_system_tile_stack(config: dict[str, Any], dev_id: str) -> bool:
    """Restack the System tab's two energy tiles and widen the schematic; rev. 27.

    Before revision 27 the row was ``_subgrid([flow, _subgrid([today, total])])``
    - a two-track grid whose right track held a second two-track grid.  Two full
    tiles placed side by side therefore cost a whole card height each on a
    column that had room for both, and the schematic was left with half the row
    and a 700 px cap.

    Revision 27 tells the same two numbers in one quarter of the row instead:
    the schematic on three quarters, the two tiles stacked on the fourth, each
    read as one line (``compact: true``).  The drawing's cap follows to
    ``_SYSTEM_FLOW_MAX_WIDTH``.

    Revision 27 first wrote that 3:1 ratio as tracks of a *nested* grid, which
    HA 2026.5.4 does not honour - ``hui-grid-card`` gives every child one track
    and ignores ``grid_options`` on them, so the two cards measured a flat 1:1.
    The pair is now two plain siblings of the section, split 36 + 12 of its 48
    columns, which is the mechanism the Device view has used since revision 18.
    Both the rev.26 shape and the rev.27 nested-grid shape are recognised here;
    a dashboard already rewritten to the sibling form is left alone.

    The rewrite is recognised by the *shape* it is replacing - a nested grid
    holding exactly the two energy gauges, either beside the schematic or
    wrapping it too - and not by the card ids alone, so a user who rearranged
    the row keeps their arrangement.  A dashboard that is not shaped that way is
    left untouched and the function returns ``False``.

    Revision 30 makes the pair test tolerant of the two things that kept this
    from ever firing on a real installation: the ``_2`` Home Assistant appends
    to a colliding entity id (:func:`_strip_suffix`) and the entity names that
    revisions 23 and 26 replaced.  Both the current pairs
    (``plant_pv_energy_today`` / ``plant_pv_energy_total``) and the older ones
    (``system_pv_energy_today`` / ``pv_energy_total``) count, so the row is
    restacked whether or not the earlier migrations have already re-pointed it.

    Revision 31 keeps the pair but re-spans it to two thirds of the row.  Note
    that the span is rewritten in the sibling branch as well - the same
    ``_span`` calls run for all three recognised shapes - which is what lets a
    pure width change reach a dashboard that revision 29 had already restacked.
    That is why this function compares nothing about the stored
    ``grid_options``: it always rewrites them from the constants, so bumping
    ``_LAYOUT_VERSION`` is enough to apply a new width.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    today_names = {
        _entity(dev_id, "plant_pv_energy_today"),
        _entity(dev_id, "system_pv_energy_today"),
    }
    total_names = {
        _entity(dev_id, "plant_pv_energy_total"),
        _entity(dev_id, "pv_energy_total"),
    }

    def _is_tile_pair(cards: Any) -> bool:
        """True when this card list is the two energy tiles, 今日 then 总."""
        if not isinstance(cards, list) or len(cards) != 2:
            return False
        entities = [
            _strip_suffix(card.get("entity"))
            for card in cards
            if isinstance(card, dict) and card.get("type") == GAUGE_CARD
        ]
        return (
            len(entities) == 2
            and entities[0] in today_names
            and entities[1] in total_names
        )

    def _is_flow(card: Any) -> bool:
        return isinstance(card, dict) and card.get("type") == POWER_FLOW_CARD

    changed = False

    for view in views:
        if not isinstance(view, dict) or view.get("path") != "system":
            continue

        for section in view.get("sections") or []:
            if not isinstance(section, dict):
                continue
            cards = section.get("cards")
            if not isinstance(cards, list):
                continue

            for index in range(len(cards)):
                flow: dict[str, Any] | None = None
                tiles: list[dict[str, Any]] | None = None
                # ``flatten`` is True for the two older shapes, where the row is
                # wrapped in a nested grid that has to go away.
                flatten = False

                outer = cards[index]
                nxt = cards[index + 1] if index + 1 < len(cards) else None

                if _is_flow(outer) and isinstance(nxt, dict) and nxt.get("type") == "grid":
                    # Already the sibling form (what this function now writes):
                    # the schematic and the tile stack are two cards of the
                    # section.  Only the drawing cap can still need fixing.
                    if _is_tile_pair(nxt.get("cards")):
                        flow, tiles = outer, nxt["cards"]
                elif isinstance(outer, dict) and outer.get("type") == "grid":
                    # Revisions 26 and 27 both wrapped the row in a nested grid:
                    # ``[flow, <grid holding the two tiles>]``.  They differed
                    # only in that grid's ``columns`` and in the ``grid_options``
                    # the children carried - neither of which is read by a
                    # nested ``hui-grid-card`` anyway.
                    inner = outer.get("cards")
                    if isinstance(inner, list) and len(inner) == 2:
                        first, second = inner
                        if (
                            _is_flow(first)
                            and isinstance(second, dict)
                            and second.get("type") == "grid"
                            and _is_tile_pair(second.get("cards"))
                        ):
                            flow, tiles = first, second["cards"]
                            flatten = True

                if flow is None or tiles is None:
                    continue

                flow.pop("grid_options", None)
                flow["max_width"] = _SYSTEM_FLOW_MAX_WIDTH
                for tile in tiles:
                    # ``show_arc`` is left in place: a compact tile never draws
                    # the dial anyway, and keeping it means turning ``compact``
                    # back off restores the tile exactly as it was.
                    tile["compact"] = True

                flow = _span(flow, _SYSTEM_FLOW_COLUMNS)
                stack = _span(_vstack(tiles), _SYSTEM_TILES_COLUMNS)
                if flatten:
                    cards[index : index + 1] = [flow, stack]
                else:
                    cards[index] = flow
                    cards[index + 1] = stack
                changed = True
                break

    return changed


def _migrate_system_power_axis(config: dict[str, Any], dev_id: str) -> bool:
    """Let the System power chart mirror its axis again; rev. 24.

    That card plots 「光伏功率」, 「电网 输出[+]/输入[-]」 and 「负载功率」, and the middle
    one is signed by definition: the day the installation exports more than it
    makes, `system_grid_power` is negative.  The generator used to pin
    ``symmetric: False`` on it, which forces
    :mod:`hoymiles-g2-history-chart` onto a bottom-up ``0..max`` axis, so every
    negative reading was clamped to the baseline - the grid curve did not turn
    over, it just disappeared below zero.

    Revision 24 stops writing the key, so the chart resolves the axis per render
    (mirrored exactly when one of its series dips below zero).  A dashboard that
    already exists keeps the pinned ``False`` - ``_LAYOUT_KEY`` short-circuits
    :func:`_build_views` - so the key has to be removed here as well.

    Revision 30 goes one step further and pins ``symmetric: true``.  Leaving the
    key out means "mirror only on the days the series actually goes negative",
    and 电网 is the one curve on this card that can - so on a day without export
    the axis collapsed back to ``0..max`` and there was no negative half at all
    to read an export against.  Pinning the mirror keeps the zero line in the
    middle where the ownership of the flow is legible: 光伏 above it, 负载 and
    grid import below.

    Recognition is by *content*, never by title or position: the card is the
    history chart whose series are exactly the three system power entities.  The
    old value is only replaced while it is still ``False``, i.e. still what the
    generator wrote, so a user who deliberately pinned the axis keeps their
    choice, and a second run is a no-op.

    Revision 30 also compares the series through :func:`_strip_suffix`.  The
    exact comparison used to find nothing on a unit whose entities Home Assistant
    numbered, so the pinned ``symmetric: False`` stayed on the stored card and
    that dashboard's 功率 curve could never draw an export below the baseline -
    the very defect this migration exists to remove.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    power_entities = {
        _entity(dev_id, "system_plug_power"),
        _entity(dev_id, "system_pv_power"),
        _entity(dev_id, "system_grid_power"),
        _entity(dev_id, "system_load_power"),
    }

    changed = False
    for card in _walk_cards(views):
        if not isinstance(card, dict) or card.get("type") != HISTORY_CARD:
            continue
        if card.get("symmetric") is not False:
            continue
        entities = {_strip_suffix(item) for item in _series_entities(card)}
        # A grid power series is what makes the mirrored axis necessary.  The
        # 光伏功率 entity moved between revisions (rev. 23 re-pointed it from
        # ``system_pv_power`` to ``system_plug_power``), so both are accepted and
        # the grid one is the requirement.
        if _entity(dev_id, "system_grid_power") not in entities:
            continue
        if not entities & power_entities:
            continue
        card["symmetric"] = True
        changed = True

    return changed


def _migrate_stale_entities(
    config: dict[str, Any], hass: HomeAssistant, dev_id: str
) -> bool:
    """Repoint a stored dashboard at the ids the entities actually have; rev. 25.

    Home Assistant appends ``_2`` (``_3`` …) to an ``entity_id`` when the name it
    derives is already taken.  The generated dashboard is written from
    :func:`_entity`, which merely *guesses* the conventional id, so a unit whose
    entity ids were taken - every sensor of ``RMI-1650A02ABA09`` is suffixed
    because an earlier registration of the same serial still held the plain
    names - ends up with a dashboard that references entities which never
    existed.  The symptoms are a 「该时间段没有统计数据。」 curve panel and a port
    list showing one chip where the hardware has two.

    The repair is deliberately timid:

    * only ``sensor.`` ids built from *this* device's own slug are considered,
      so another device's cards inside the same dashboard are untouched;
    * an id is only rewritten when it is neither a live state nor a registered
      entity **and** exactly one registered entity of this device is that id plus
      a numeric suffix.  No fuzzy matching, no 「closest」 guess;
    * everything else - titles, colours, order, hand-added cards - is left as
      found, so a user's own edits are never reverted.
    """
    if not _is_inverter(dev_id):
        return False

    try:
        from homeassistant.helpers import entity_registry as er  # noqa: PLC0415

        registry = er.async_get(hass)
    except Exception:  # noqa: BLE001
        return False
    if registry is None:
        return False

    known: set[str] = set()
    try:
        known.update(str(entry.entity_id) for entry in registry.entities.values())
    except Exception:  # noqa: BLE001
        return False
    known.update(str(state.entity_id) for state in hass.states.async_all())

    prefix = f"sensor.{_slug(dev_id)}_"
    # ``<base>_<n>`` -> candidates.  Only a base with exactly one suffixed id
    # is unambiguous enough to substitute; one that grew ``_2`` *and* ``_3``
    # means a duplicate registration we cannot reason about, so it is skipped.
    candidates: dict[str, list[str]] = {}
    for entity_id in known:
        if not entity_id.startswith(prefix):
            continue
        base, sep, tail = entity_id.rpartition("_")
        if sep and tail.isdigit() and tail != "0":
            candidates.setdefault(base, []).append(entity_id)

    suffixed = {
        base: found[0] for base, found in candidates.items() if len(found) == 1
    }

    if not suffixed:
        return False

    def fix(value: str) -> str:
        if not isinstance(value, str) or not value.startswith(prefix):
            return value
        if value in known:
            return value
        return suffixed.get(value, value)

    changed = False
    for card in _walk_cards(config.get("views") or []):
        if not isinstance(card, dict):
            continue
        for key in ("entity", "entity_id"):
            current = card.get(key)
            fixed = fix(current)
            if fixed != current:
                card[key] = fixed
                changed = True
        series = card.get("series")
        if isinstance(series, list):
            for item in series:
                if not isinstance(item, dict):
                    continue
                current = item.get("entity")
                fixed = fix(current)
                if fixed != current:
                    item["entity"] = fixed
                    changed = True
        entities = card.get("entities")
        if isinstance(entities, list):
            for index, item in enumerate(entities):
                if isinstance(item, str):
                    fixed = fix(item)
                    if fixed != item:
                        entities[index] = fixed
                        changed = True
                elif isinstance(item, dict):
                    current = item.get("entity")
                    fixed = fix(current)
                    if fixed != current:
                        item["entity"] = fixed
                        changed = True

    if _migrate_pv_port_series(config, hass, dev_id):
        changed = True

    return changed


def _migrate_pv_port_series(
    config: dict[str, Any], hass: HomeAssistant, dev_id: str
) -> bool:
    """Collapse 「各光伏端口功率」 to the ports this unit really reports; rev. 25.

    The generator writes one curve per port of the *SKU*, taken from
    ``pv_count_from_dev_id`` rather than from what the firmware publishes.  A
    ``1650`` therefore got ``PV1`` / ``PV2`` curves while the platform prunes the
    phantom ports at setup and only creates ``pv1_power`` - so half of that card
    referenced an entity that never existed and the whole panel fell back to
    「该时间段没有统计数据。」.

    Rewritten only when the card looks like that port chart *and* is broken:
    every series must be one of this device's ``pv<N>_power`` sensors, and at
    least one of them must be unresolvable.  The replacement is the single
    ``pv_total_power`` curve the current generator emits for such a unit, so a
    stored dashboard converges on a freshly generated one instead of drifting.
    A card the user has re-pointed elsewhere is not port-shaped any more and is
    left alone.
    """
    views = config.get("views")
    if not isinstance(views, list):
        return False

    total = _resolve_entity(hass, dev_id, "pv_total_power")
    port_pattern = re.compile(rf"^sensor\.{re.escape(_slug(dev_id))}_pv\d+_power(_\d+)?$")

    changed = False
    for card in _walk_cards(views):
        if not isinstance(card, dict) or card.get("type") != HISTORY_CARD:
            continue
        series = card.get("series")
        if not isinstance(series, list) or len(series) < 2:
            continue
        names = [s.get("entity") for s in series if isinstance(s, dict)]
        if len(names) != len(series):
            continue
        if not all(isinstance(name, str) and port_pattern.match(name) for name in names):
            continue
        if all(_entity_exists(hass, name) for name in names):
            continue

        card["series"] = [
            {
                "entity": total,
                "name": _t("PV1", "PV1"),
                "color": card["series"][0].get("color", "#22c55e"),
            }
        ]
        changed = True

    return changed


def _entity_exists(hass: HomeAssistant, entity_id: str) -> bool:
    """True when Home Assistant knows this ``entity_id`` (state or registry)."""
    if not isinstance(entity_id, str) or not entity_id:
        return False
    if hass.states.get(entity_id) is not None:
        return True
    try:
        from homeassistant.helpers import entity_registry as er  # noqa: PLC0415

        registry = er.async_get(hass)
    except Exception:  # noqa: BLE001
        return True  # cannot tell; assume fine rather than rewrite blindly
    if registry is None:
        return True
    try:
        return registry.async_get(entity_id) is not None
    except Exception:  # noqa: BLE001
        return True


def _migrate_drop_heading(config: dict[str, Any]) -> bool:
    """Remove the ``<model> · <family>`` heading card from every view; rev. 11.

    Revision 11 stops generating that card.  The text was assembled in Python
    (``HiFlow Pro · 微型逆变器``), so it was frozen in whatever language the
    integration happened to hardcode and read 微型逆变器 even in an English or
    German UI - the one string on the dashboard the language selector could not
    reach.  It also said nothing the view's own tab header does not already say,
    and it cost the first row of every tab.

    Recognition is deliberately narrow so a heading the user added themselves
    survives:

    * only ``type: heading`` cards are considered;
    * a heading is removed when its text is one of the two family labels this
      generator wrote, with or without a model prefix - exactly the text the
      generator used to emit.

    Removal is by identity of the dict, so the card disappears from the grid it
    sits in and the section itself stays - the remaining cards keep their
    position.  A second run finds nothing and returns ``False``, which is what
    keeps the ``_LAYOUT_KEY`` marker honest.
    """
    views = config.get("views")
    if not isinstance(views, list):
        return False

    # Every family label the generator used to print, prefixed or bare.
    family: tuple[str, ...] = ("微型逆变器", "储能系统")

    def _is_ours(card: Any) -> bool:
        if not isinstance(card, dict) or card.get("type") != "heading":
            return False
        text = str(card.get("heading") or "").strip()
        # Bare label, or ``<model> · <label>`` - a bare serial, "HiFlow Pro",
        # anything the firmware reports.
        return any(
            text == label or text.endswith(f"· {label}") for label in family
        )

    changed = False
    emptied: list[Any] = []

    def _strip(cards: list[Any]) -> None:
        nonlocal changed
        dropped = False
        for card in list(cards):
            if _is_ours(card):
                cards.remove(card)
                changed = True
                dropped = True
        if dropped and not cards:
            emptied.append(cards)

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        for key in ("cards", "sections"):
            children = node.get(key)
            if isinstance(children, list):
                if key == "cards":
                    _strip(children)
                walk(children)

    walk(views)

    # A section that held nothing but the heading would leave an empty row
    # behind.  Only a section this migration emptied is dropped - a section the
    # user emptied themselves is left exactly as they left it.
    for view in views:
        if not isinstance(view, dict):
            continue
        sections = view.get("sections")
        if not isinstance(sections, list):
            continue
        for section in list(sections):
            if not isinstance(section, dict):
                continue
            cards = section.get("cards")
            if isinstance(cards, list) and any(cards is e for e in emptied):
                sections.remove(section)
                changed = True

    return changed


def _migrate_total_icon(config: dict[str, Any], dev_id: str) -> bool:
    """Swap the lifetime PV gauge's ♾️ for the vendor app's "All" ring; rev. 12.

    Only the one card is touched, and only when it still carries the icon this
    generator used to write.  The anchor is the card's ``entity`` - the
    serial-derived ``sensor.<slug>_pv_energy_total`` - never a title or an index,
    so a dashboard the user reorganised is still patched in the right place.

    An icon the user picked themselves is left alone: the replacement is gated on
    the old value, so ``icon: ❤️`` and a card with no ``icon`` key both survive.
    A second run finds nothing and returns ``False``.
    """
    if not _is_inverter(dev_id):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    total_entity = _entity(dev_id, "pv_energy_total")
    changed = False

    for card in _walk_cards(views):
        if not isinstance(card, dict):
            continue
        if card.get("entity") != total_entity:
            continue
        if card.get("icon") != "♾️":
            continue
        card["icon"] = "all"
        changed = True

    return changed


def _migrate_gauge_icons(config: dict[str, Any]) -> bool:
    """Swap the emoji gauge icons for the vendor app's named ones; rev. 13.

    The four System tiles used to carry an emoji (``☀️`` / ``⚡`` / ``🔋``).  The
    official cards draw their own vector set instead, so the same four tiles on
    the same dashboard looked like two different products.  The card now
    understands those names (see ``ICON_SVG`` in ``hoymiles-g2-gauge.js``), and
    this rewrites the dashboards already on disk.

    Gated on the old value, so an icon the user picked themselves survives, and
    a second run finds nothing and returns ``False``.  Only gauge cards are
    touched: the same emoji appear in titles and on other cards, and those are
    plain text there.
    """
    views = config.get("views")
    if not isinstance(views, list):
        return False

    # Emoji the generator used to write, mapped to the name that replaces it.
    swap = {"☀️": "panel", "⚡": "battery", "🔋": "cycle"}
    changed = False

    for card in _walk_cards(views):
        if not isinstance(card, dict):
            continue
        if card.get("type") != GAUGE_CARD:
            continue
        icon = card.get("icon")
        if icon not in swap:
            continue
        # The SOC tile is a level, not a flow, so it keeps the battery shell
        # rather than the discharge ring the "🔋" would otherwise become.
        entity = str(card.get("entity") or "")
        card["icon"] = "battery" if entity.endswith("_soc") else swap[icon]
        changed = True

    return changed


def _migrate_view_icons(config: dict[str, Any]) -> bool:
    """Give the view tabs the icons the vendor app uses; rev. 14.

    An earlier release drew ``mdi:solar-power-variant`` on System and
    ``mdi:solar-panel-large`` on Device, while the official dashboard uses
    ``mdi:home-analytics`` and ``mdi:home-battery``.  The same three tabs side
    by side therefore carried different glyphs.  Only the exact old values are
    rewritten, so a tab the user re-iconed keeps its icon, and a second run
    finds nothing.
    """
    views = config.get("views")
    if not isinstance(views, list):
        return False

    changed = False
    for view in views:
        if not isinstance(view, dict):
            continue
        # The view's `path` is what `_VIEW_ICONS` is keyed on; a view without one
        # was not generated by us (the first view has an empty path, which is
        # why this looks the icon up rather than defaulting it).
        key = view.get("path")
        wanted = _VIEW_ICONS.get(key) if isinstance(key, str) else None
        if wanted is None:
            continue
        if view.get("icon") != _LEGACY_VIEW_ICONS.get(key):
            continue
        view["icon"] = wanted
        changed = True

    return changed


def _migrate_optional_entities(
    config: dict[str, Any], hass: HomeAssistant, dev_id: str
) -> bool:
    """Re-point stored opt-in cards at the real entity; rev. 20.

    An older release built each of these cards from the sensor *description
    key* - ``sensor.<slug>_<key>`` - which is only the real entity id when the
    sensor's display name slugifies to that key too.  ``grid_on_power_5m`` is
    named "Grid On Power (5 min)" and therefore lives at
    ``..._grid_on_power_5_min``, so 「有功功率」 pointed at an entity that has
    never existed and the card stayed empty.  The user's own rename does the
    same thing.

    Each card is resolved by ``unique_id`` instead, which survives both a
    rename and the display-name mismatch.  Only opted-in cards are touched, and
    only their series entity, so ``since``, titles, colours and axis limits are
    kept.  A card that already names the right entity is left as it is, which is
    what makes a second run a no-op.
    """
    views = config.get("views")
    if not isinstance(views, list):
        return False

    changed = False
    for card in _walk_cards(views):
        if not isinstance(card, dict):
            continue
        key = card.get(_OPTIONAL_KEY)
        if key not in OPTIONAL_CHARTS:
            continue
        entity = _resolve_entity(hass, dev_id, OPTIONAL_CHARTS[key]["entity"])
        changed = _repoint_card(card, entity) or changed

    return changed


def _migrate_axis_cards(config: dict[str, Any]) -> bool:
    """Rewrite the chart config this release changed; return True if any did.

    Only three things are touched, and each only when it still carries the value
    an older release wrote:

    * a fixed ``span`` on a history chart is dropped, so the y axis scales to
      the measured maximum instead of being pinned to 2 000 W / 2 500 W;
    * ``symmetric`` is set to ``False`` on a chart whose series are all
      non-negative levels (voltage, energy, PV power) - a mirrored axis halves
      the usable height for such data;
    * ``stack`` is set to ``False`` where the series are independent
      measurements rather than additive parts of one total.

    Everything else - titles, colours, heights, series order, extra cards, view
    names - is left exactly as found, which is what makes this safe to run on a
    dashboard the user has edited.
    """
    views = config.get("views")
    if not isinstance(views, list):
        return False

    changed = False
    for card in _walk_cards(views):
        if not isinstance(card, dict):
            continue
        if card.get("type") != HISTORY_CARD:
            continue

        # 1. A fixed half-range is what pinned every axis.  Removing it is the
        #    whole point of this migration, so it goes unconditionally.
        if "span" in card:
            card.pop("span", None)
            changed = True

        # 2/3. Both are decisions about *what the numbers mean*, so they are
        #      only applied where the card's own series say so - never by title,
        #      which the user is free to change.
        if _all_non_negative(card) and card.get("symmetric") is None:
            card["symmetric"] = False
            changed = True
        if _is_independent_overlay(card) and card.get("stack") is None:
            card["stack"] = False
            changed = True

    return changed


def _walk_cards(views: list[Any]) -> list[Any]:
    """Every card dict in the view tree, nested grid sections included."""
    out: list[Any] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") and "cards" not in node:
            out.append(node)
        elif node.get("type") and node.get("type") != "grid":
            out.append(node)
        for key in ("cards", "sections"):
            if isinstance(node.get(key), list):
                walk(node[key])

    walk(views)
    return out


def _series_entities(card: dict[str, Any]) -> list[str]:
    """The entity ids a history chart references."""
    series = card.get("series")
    if not isinstance(series, list):
        return []
    return [s["entity"] for s in series if isinstance(s, dict) and s.get("entity")]


def _all_non_negative(card: dict[str, Any]) -> bool:
    """True when no series of this card can go below zero.

    Decided from the entity key, not from the title: a battery or grid power
    entity is signed (charge < 0, export < 0) and keeps its mirrored axis, while
    a PV port's power, a voltage and an ``*_energy*`` counter never are.
    """
    entities = _series_entities(card)
    if not entities:
        return False
    for entity in entities:
        if "battery" in entity or "grid" in entity:
            return False
        if not any(mark in entity for mark in ("pv", "power", "voltage", "energy")):
            return False
    return True


def _is_independent_overlay(card: dict[str, Any]) -> bool:
    """True when this card's series are separate readings, not additive parts.

    Two or more ``*_power`` series that are each a whole measurement (PV, grid,
    load) must be overlaid: stacking them drew the load curve on top of the PV
    curve even when the load was the smaller number.  A single series has
    nothing to stack against, so it is left alone (either setting looks the
    same), and energy series are deliberately excluded because stacking daily
    contributions is exactly right for them.
    """
    entities = _series_entities(card)
    if len(entities) < 2:
        return False
    if any("energy" in entity for entity in entities):
        return False
    return all(entity.endswith("_power") for entity in entities)



def _is_legacy_layout(config: Any) -> bool:
    """True when ``config`` is exactly the layout an earlier release wrote.

    The fingerprint is the combination of the old view titles with the absence of
    the view-level keys this release adds (``icon``, ``max_columns``,
    ``show_icon_and_title``).  A dashboard where the user renamed, reordered,
    removed or added a view - or edited any card - fails one of those checks and
    is left alone.
    """
    if not isinstance(config, dict):
        return False
    views = config.get("views")
    if not isinstance(views, list) or len(views) != len(_LEGACY_VIEW_TITLES):
        return False
    for view, legacy_title in zip(views, _LEGACY_VIEW_TITLES, strict=True):
        if not isinstance(view, dict):
            return False
        if view.get("title") != legacy_title:
            return False
        if "icon" in view or "max_columns" in view or "show_icon_and_title" in view:
            return False
    return True


def _sync_sidebar_title(hass: HomeAssistant, url_path: str, title: str) -> None:
    """Make the generated sidebar entry carry ``title``.

    Re-registering the built-in ``lovelace`` panel is the only supported way to
    change a dashboard's sidebar label - it replaces the entry created when the
    dashboard itself was added, and leaving the old label in place would be worse
    than the extra call.  ``async_register_built_in_panel`` is a @callback, so it
    is called synchronously.
    """
    try:
        from homeassistant.components import frontend  # noqa: PLC0415

        frontend.async_register_built_in_panel(
            hass,
            "lovelace",
            sidebar_title=title,
            sidebar_icon=DASHBOARD_ICON,
            frontend_url_path=url_path,
            config={"mode": "storage"},
            require_admin=False,
            show_in_sidebar=True,
            update=True,
        )
    except TypeError:
        # Older core without the ``update`` keyword: nothing to sync.
        _LOGGER.debug("Sidebar panel for %s left unchanged", url_path)
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not sync sidebar title for %s", url_path, exc_info=True)


def _build_views(
    dev_id: str,
    pv_count: int | None = None,
    model: str = "",
    alarm_entity: str | None = None,
) -> list[dict[str, Any]]:
    """Return the full view set for the device.

    ``pv_count`` is how many PV inputs the unit actually has, so the inverter
    views only reference per-port entities that exist.  ``None`` means "not
    known yet" and is treated as two, the common case for the inverter family
    this layout targets.  ``model`` is accepted for the callers' sake but no
    longer used: revision 11 removed the heading card that printed it.

    The unit's *role* is deliberately not a parameter.  Every dashboard is
    written complete and :func:`_async_sync_role` then hides the parts the role
    denies - a ``slave`` has no System view, because the document limits
    ``system/state`` to 「主机和单机」.  Doing it in two passes is what makes the
    hidden tab restorable: the sync keeps the exact dict it removed, so a unit
    that is later re-paired into a master/slave pair gets its tab back with every
    user edit still inside it.

    ``alarm_entity`` is the registry-resolved ``entity_id`` of the alarm sensor
    (see :func:`_alarm_entity_id`); ``None`` falls back to the conventional
    serial-based spelling, which is all a brand new device can offer.
    """
    if _is_inverter(dev_id):
        return _build_inverter_views(dev_id, pv_count, model, alarm_entity)
    return _build_storage_views(dev_id, model)


# Icon shown on each view's tab.  These are the icons the vendor app's own
# dashboard uses (`VIEW_ICON_*` in the official integration), so a dashboard
# generated here and one generated there look like the same product: a chart
# for the system overview, a battery for the device's own ports, sliders for
# the settings.
_VIEW_ICONS: dict[str, str] = {
    "system": "mdi:home-analytics",
    "device": "mdi:home-battery",
    "control": "mdi:tune",
}

# The view icons an earlier release generated.  Used by
# :func:`_migrate_view_icons` so only a tab the user has not re-iconed is
# rewritten.
_LEGACY_VIEW_ICONS: dict[str, str] = {
    "system": "mdi:solar-power-variant",
    "device": "mdi:solar-panel-large",
}


def _view(
    path: str,
    title: str,
    sections: list[dict[str, Any]],
    *,
    icon: str | None = None,
) -> dict[str, Any]:
    """Assemble a single sections view.

    ``max_columns: 4`` and ``show_icon_and_title`` are emitted for every view so
    a generated dashboard looks the same on a wide screen as a hand-made one:
    the title bar keeps the icon visible instead of collapsing the tab strip.
    """
    return {
        "type": "sections",
        "path": path,
        "title": title,
        "icon": icon or _VIEW_ICONS.get(path, DASHBOARD_ICON),
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": sections,
    }


def _grid(cards: list[dict[str, Any]], column_span: int = 4) -> dict[str, Any]:
    """A grid section holding the given cards."""
    return {"type": "grid", "column_span": column_span, "cards": cards}


def _nested_grid(cards: list[dict[str, Any]], columns: int = 2) -> dict[str, Any]:
    """A nested grid card over ``columns`` tracks, spanning the section.

    ``columns`` is the assumption a card makes about the cell it is placed in,
    and the cards that say nothing take the first free cell in order.

    Note that HA 2026.5.4's ``hui-grid-card`` does **not** read
    ``grid_options: {columns: N}`` on its children: every child takes exactly one
    track, so a nested grid cannot express "this one is 3/4 wide and those are
    1/4".  Use a plain sibling pair of a *section* for that (see
    ``_SYSTEM_FLOW_COLUMNS``); a nested grid is only good for an even split or a
    stack.
    """
    return {
        "type": "grid",
        "columns": columns,
        "square": False,
        "grid_options": {"columns": "full"},
        "cards": cards,
    }


def _subgrid(cards: list[dict[str, Any]]) -> dict[str, Any]:
    """A nested two-column grid card, used to place cards side by side."""
    return _nested_grid(cards, 2)


def _vstack(cards: list[dict[str, Any]]) -> dict[str, Any]:
    """A nested single-column grid card, used to stack cards vertically."""
    return _nested_grid(cards, 1)


def _span(card: dict[str, Any], columns: int) -> dict[str, Any]:
    """Mark a card as spanning ``columns`` columns of its parent.

    Only meaningful for a card that is a direct child of a *section*, whose
    width is ``12 * column_span`` columns (48 for the default ``column_span: 4``).
    A nested ``grid`` card ignores this on its children - see
    :func:`_nested_grid`.
    """
    out = dict(card)
    out["grid_options"] = {"columns": columns}
    return out


def _full_width(card: dict[str, Any]) -> dict[str, Any]:
    """Mark a card as spanning every column of its grid."""
    out = dict(card)
    out["grid_options"] = {"columns": "full"}
    return out


def _history(
    title: dict[str, str],
    series: list[dict[str, Any]],
    *,
    unit: str,
    height: int,
    range: str = "day",
    sync_group: str | None = None,
    symmetric: bool | None = None,
    stack: bool | None = None,
    mode: str | None = None,
    show_totals: bool | None = None,
    scale: float | None = None,
    min_value: float | None = None,
    max_value: float | None = None,
) -> dict[str, Any]:
    """A ``hoymiles-g2-history-chart`` card spanning the full section width.

    The y axis is left to the card: it rounds the *measured* maximum up to the
    next 1/2/5 × 10^n step, so a 490 W peak gets a 0..500 W axis instead of
    floating in the bottom quarter of a fixed one.  A fixed ``span`` is
    therefore wrong here and no longer emitted - it made every generated chart
    draw a 2 000 W / 2 500 W axis regardless of the data, which is what made a
    490 W curve look tiny.

    ``symmetric=False`` switches the axis to a bottom-up ``0..max`` scale.  The
    default (mirrored around zero) is right for a single reading that changes
    sign - battery charge/discharge, grid import/export - but halves the usable
    height for an always-positive one (PV power, voltage, energy), which is the
    other half of why those curves looked flat.  ``stack=False`` overlays the
    curves instead of stacking them; PV power, grid power and load power are
    three independent measurements, not additive parts of one total, so stacking
    them drew the load curve *on top of* the PV curve even while the load was
    the smaller of the two.

    ``range`` is the period the card opens on.  Every power chart wants a day -
    that is the window a curve is read in - while the energy card opens on a
    month, where one bar per day is the question being asked.
    """
    card: dict[str, Any] = {
        "type": "custom:hoymiles-g2-history-chart",
        "title": title,
        "range": range,
        "series": series,
        "unit": unit,
        "height": height,
    }
    if sync_group is not None:
        card["sync_group"] = sync_group
    if symmetric is not None:
        card["symmetric"] = symmetric
    if stack is not None:
        card["stack"] = stack
    # ``mode: auto`` lets the card pick bars for the month / year energy view
    # and a curve for a day; a power card must stay ``line`` because the sum of
    # instantaneous watts has no meaning.
    if mode is not None:
        card["mode"] = mode
    if show_totals is not None:
        card["show_totals"] = show_totals
    # Statistics are read in the sensor's own unit (Wh), but 20 910 Wh on an
    # axis is unreadable.  ``scale`` converts once, up front, so the bars, the
    # axis, the tooltip and the tiles all speak kWh.
    if scale is not None:
        card["scale"] = scale
    # A fixed axis range, for a reading that does not scale with its own data:
    # a dBm level lives between -100 and 0, so an axis derived from the measured
    # maximum would either top out at a round 0 dBm or, mirrored, waste half the
    # height on a positive half that can never be filled.
    if min_value is not None:
        card["min"] = min_value
    if max_value is not None:
        card["max"] = max_value
    return _full_width(card)


# --------------------------------------------------------------------------- #
# Optional device charts
# --------------------------------------------------------------------------- #
# The readings ``device/state`` publishes that the generated Device view does
# not draw.
#
# Deliberately short, and deliberately not everything §25 carries: the ``grid``
# array is a structure rather than a series, the PV string ids and the running
# EMS mode are not measurements, and everything under ``pack*`` belongs to a
# storage unit - which the option does not offer at all.  What is left is the
# per-reading telemetry a HiFlow / HiFlow Pro actually reports.
#
# Grid voltage is *not* in this list even though it is a per-reading
# measurement: the Device view has drawn its own "Grid Voltage" card since the
# first release, and offering it again would put two identical curves on the
# same page the moment it was ticked.
#
#   entity   sensor key (``sensor.<slug>_<entity>``)
#   unit     the axis label
#   color    curve colour
#   en / zh  title, resolved against the viewing user's UI language
#   axis     ``"level"`` for a quantity that is always positive (a bottom-up
#            axis fills the card), ``"signed"`` to let the card decide from the
#            data - which is what a reactive power reading needs, since it
#            changes sign with the power factor - or a ``(min, max)`` pair for
#            a fixed range (a dBm level lives between -100 and 0 and would sit
#            in the wrong half of an axis derived from the data alone).
OPTIONAL_CHARTS: dict[str, dict[str, Any]] = {
    "grid_current": {
        "entity": "grid_on_current",
        "unit": "A",
        "color": "#f59e0b",
        "en": "Grid Current",
        "zh": "电网电流",
        "axis": "level",
    },
    "grid_frequency": {
        "entity": "grid_on_frequency",
        "unit": "Hz",
        "color": "#8b5cf6",
        "en": "Grid Frequency",
        "zh": "电网频率",
        "axis": "level",
    },
    "active_power": {
        "entity": "grid_on_power_5m",
        "unit": "W",
        "color": "#22c55e",
        "en": "Active Power",
        "zh": "有功功率",
        # The AC port exports while the sun is up and draws a little at night,
        # so the sign is a property of the data rather than of the reading.
        "axis": "signed",
    },
    "reactive_power": {
        "entity": "grid_on_reactive_power",
        "unit": "var",
        "color": "#06b6d4",
        "en": "Reactive Power",
        "zh": "无功功率",
        "axis": "signed",
    },
    "rssi": {
        "entity": "rssi",
        "unit": "dBm",
        "color": "#94a3b8",
        "en": "Signal Strength",
        "zh": "信号强度",
        # A dBm reading is negative and bounded, so an axis derived from the
        # data would either mirror it around zero or leave the curve pinned to
        # the top edge. -100..0 puts the zero line at the bottom and every
        # reading on the same scale, which is how a signal strength is read.
        "axis": (-100, 0),
    },
}

# Marker written on every card this section adds, holding its ``OPTIONAL_CHARTS``
# key.  It is the only safe way to find them again: the cards are ordinary
# history charts, indistinguishable from a hand-added one by their ``type``, and
# a title is something the user may edit.  The chart ignores unknown keys.
_OPTIONAL_KEY = "g2_optional"

# Chart cards added at the bottom of the Device view, in this order.
_OPTIONAL_ORDER: tuple[str, ...] = tuple(OPTIONAL_CHARTS)


def _now_iso() -> str:
    """The current instant as an ISO 8601 UTC string (second precision)."""
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def _optional_card(
    key: str, dev_id: str, since: str | None, entity: str | None = None
) -> dict[str, Any]:
    """Build one opt-in history chart of the Device view.

    ``since`` is the instant the card was enabled and goes into the card's own
    config: the statistics from before it are still in the recorder, so the
    curve is clipped there rather than the sensor being recreated.

    ``entity`` is the already-resolved ``entity_id``; it is optional so a caller
    that has no ``hass`` yet (a unit test, a pure layout build) still gets a
    usable card from the conventional id.
    """
    spec = OPTIONAL_CHARTS[key]
    title = _t(spec["en"], spec["zh"])
    series = [
        {
            "entity": entity or _entity(dev_id, spec["entity"]),
            "name": title,
            "color": spec["color"],
        }
    ]
    axis = spec["axis"]
    extra: dict[str, Any] = {}
    if axis == "level":
        extra["symmetric"] = False
    elif isinstance(axis, tuple):
        extra["symmetric"] = False
        extra["min_value"] = axis[0]
        extra["max_value"] = axis[1]
    # ``signed`` is left to the card, which mirrors the axis exactly when the
    # series actually crosses zero.
    card = _history(
        title,
        series,
        unit=spec["unit"],
        height=240,
        sync_group=f"{_slug(dev_id)}-device",
        stack=False,
        **extra,
    )
    card[_OPTIONAL_KEY] = key
    if since:
        card["since"] = since
    return card


def _repoint_card(card: dict[str, Any], entity: str) -> bool:
    """Point a stored opt-in card's single series at ``entity``.

    Returns True when the card actually changed.  Only the series entity is
    rewritten - the title, colour, axis limits and above all ``since`` are the
    user's, and a card that already names the right entity is left untouched so
    re-saving a form is idempotent.
    """
    series = card.get("series")
    if not isinstance(series, list) or len(series) != 1:
        return False
    only = series[0]
    if not isinstance(only, dict):
        return False
    if only.get("entity") == entity:
        return False
    only["entity"] = entity
    return True


async def async_get_optional_charts(hass: HomeAssistant, dev_id: str) -> dict[str, str]:
    """Return ``{key: since}`` for the opt-in cards currently on the dashboard.

    ``since`` is the instant the card was enabled (``""`` when the card carries
    none, e.g. one added by hand).  Used by the options flow to preselect the
    checkboxes, and it is the *stored dashboard* that is the source of truth -
    there is no second copy of this list to fall out of step with what the user
    actually sees.
    """
    try:
        store = await _async_find_store(hass, _url_path(dev_id))
        if store is None:
            return {}
        config = await _async_read_storage(hass, store) or {}
        if not isinstance(config, dict):
            return {}
        found: dict[str, str] = {}
        for card in _walk_cards(config.get("views") or []):
            if not isinstance(card, dict):
                continue
            key = card.get(_OPTIONAL_KEY)
            if key in OPTIONAL_CHARTS:
                found[key] = str(card.get("since") or "")
        return found
    except Exception:  # noqa: BLE001 - a checkbox default is never worth raising
        _LOGGER.debug("Could not read the optional charts of %s", dev_id, exc_info=True)
        return {}


async def async_set_optional_charts(
    hass: HomeAssistant, dev_id: str, wanted: dict[str, bool]
) -> bool:
    """Add / remove the opt-in charts of the Device view; return True if saved.

    Idempotent and non-destructive:

    * every optional card is taken out first, so the wanted set is applied from
      scratch - but a card that stays enabled is re-inserted *its own dict*,
      which is what preserves the instant it was enabled (and anything the user
      changed inside it);
    * a grid section is left in place when the user put cards of their own in
      it, and dropped only once it is empty;
    * nothing else in the dashboard is touched - titles, order, extra views and
      hand-added cards all survive.

    Only a micro inverter is acted on: these are the ``grid_on_*`` readings and
    the Device view of a storage unit is a different layout.
    """
    if not _is_inverter(dev_id):
        return False

    url_path = _url_path(dev_id)
    try:
        store = await _async_find_store(hass, url_path)
        if store is None:
            return False
        config = await _async_read_storage(hass, store) or {}
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not read dashboard %s", url_path, exc_info=True)
        return False

    if not isinstance(config, dict):
        return False
    views = config.get("views")
    if not isinstance(views, list):
        return False

    # 1. Take every optional card out, remembering the ones that stay enabled so
    #    their config - above all their ``since`` - is reused verbatim.
    kept: dict[str, dict[str, Any]] = {}
    touched = False
    for view in views:
        if not isinstance(view, dict) or view.get("path") != "device":
            continue
        sections = view.get("sections")
        if not isinstance(sections, list):
            continue
        for section in list(sections):
            if not isinstance(section, dict):
                continue
            cards = section.get("cards")
            if not isinstance(cards, list):
                continue
            rest: list[Any] = []
            for card in cards:
                if isinstance(card, dict) and card.get(_OPTIONAL_KEY) in OPTIONAL_CHARTS:
                    key = card[_OPTIONAL_KEY]
                    if wanted.get(key):
                        kept.setdefault(key, card)
                    touched = True
                    continue
                rest.append(card)
            if len(rest) == len(cards):
                continue
            if rest:
                section["cards"] = rest
            else:
                sections.remove(section)

    # 2. Put the wanted ones back, at the bottom of the Device view, in the fixed
    #    order of ``OPTIONAL_CHARTS``.
    added: list[dict[str, Any]] = []
    for key in _OPTIONAL_ORDER:
        if not wanted.get(key):
            continue
        entity = _resolve_entity(hass, dev_id, OPTIONAL_CHARTS[key]["entity"])
        card = kept.get(key)
        if card is None:
            card = _optional_card(key, dev_id, _now_iso(), entity)
            touched = True
        else:
            # A kept card is reused as-is so its ``since`` survives, but its
            # series is re-pointed at the real entity: an older release wrote
            # the conventional id, which is wrong for any reading whose display
            # name is not its key (``grid_on_power_5m`` is stored at
            # ``grid_on_power_5_min``), and a card pointing at a non-existent
            # entity draws nothing at all.  Re-saving the same ticks therefore
            # repairs such a card instead of preserving the mistake.
            touched = _repoint_card(card, entity) or touched
        added.append(card)

    if added:
        for view in views:
            if isinstance(view, dict) and view.get("path") == "device":
                sections = view.setdefault("sections", [])
                if isinstance(sections, list):
                    # Directly above the switch card, so the curves read as a
                    # block under the fixed ones and the switch that owns them
                    # stays at the bottom of the page.  A dashboard without that
                    # card (an older layout) simply gets them appended.
                    at = len(sections)
                    for index, section in enumerate(sections):
                        if _is_chart_options_section(section):
                            at = index
                            break
                    sections.insert(at, _grid(added))
                    touched = True
                break

    if not touched:
        # The stored dashboard already matches the wanted set - ticking the
        # same boxes again is a no-op, not a failure, so it must not surface as
        # "could not write the dashboard" to the user.
        return True

    try:
        await store.async_save({**config, "views": views})
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Could not save dashboard %s", url_path, exc_info=True)
        return False

    _LOGGER.info(
        "Dashboard %s: optional charts now %s",
        url_path,
        ", ".join(sorted(k for k in _OPTIONAL_ORDER if wanted.get(k))) or "none",
    )
    return True


# --------------------------------------------------------------------------- #
# Micro inverter (RMI-) views
# --------------------------------------------------------------------------- #
def _build_inverter_views(
    dev_id: str,
    pv_count: int | None = None,
    model: str = "",
    alarm_entity: str | None = None,
) -> list[dict[str, Any]]:
    """System / device / control views for a grid-tied micro inverter.

    Mirrors the hand-built reference dashboard: one full-width power flow and
    history charts that share a ``sync_group`` so every curve on a page moves
    with the same time window.

    Every per-port reference is generated from ``pv_count`` so a single-input
    unit does not get gauges and history series pointing at sensors that this
    integration never created for it.
    """
    ports = pv_count if pv_count and pv_count >= 1 else 2
    slug = _slug(dev_id)
    system_group = f"{slug}-system"
    device_group = f"{slug}-device"
    # The energy bars are a different kind of axis (kWh, one bar per day) from
    # the power curves, so they keep their own window instead of dragging the
    # power chart onto the same statistic grid.
    system_energy_group = f"{slug}-energy"

    # The PV curve reads `system_plug_power` (`sys_plug_p`) rather than
    # `system_pv_power` (`sys_pv_p`).  The two are different measurements and
    # only one of them answers "how much did my roof make": `sys_pv_p` is the
    # DC side, i.e. what the panels delivered *into* the units, while
    # `sys_plug_p` is what the installation delivered at its AC terminals - the
    # number the vendor app puts on the front page and the one the device
    # itself reports back when the power set-point is verified.  The two differ
    # by the units' own conversion and standby losses (measured,
    # `sys_pv_p` 133.3 W against `sys_plug_p` 100.6 W on the same second), and
    # the schematic's PV node is read from the same field so the card and the
    # curve cannot disagree.
    pv_series = {
        "entity": _entity(dev_id, "system_plug_power"),
        "name": _t("PV Power", "光伏功率"),
        "color": "#22c55e",
    }
    grid_series = {
        "entity": _entity(dev_id, "system_grid_power"),
        "name": _t("Grid Output [+]/Input [-]", "电网 输出[+]/输入[-]"),
        "color": "#22d3ee",
    }
    load_series = {
        "entity": _entity(dev_id, "system_load_power"),
        "name": _t("Load", "负载"),
        "color": "#f5a623",
    }

    # One curve per port that exists; the colours match the port gauges.  A
    # single-input body gets one curve reading `pv_total_power` instead of
    # `pv1_power`, because that body reports more than one DC string even
    # though it exposes one connector (`1650`: `pv1_p` / `pv2_p` carry the same
    # mirrored reading) and the schematic beside this chart prints the sum.  Two
    # cards on the same tab disagreeing about the roof by a factor of two is the
    # one outcome worth avoiding, so the curve follows the node.
    _PORT_COLORS = ("#22c55e", "#4a90d9", "#8b5cf6", "#06b6d4")
    port_series = [
        {
            "entity": _entity(
                dev_id,
                "pv_total_power" if ports == 1 else f"pv{port}_power",
            ),
            "name": _t(f"PV{port}", f"PV{port}"),
            "color": _PORT_COLORS[(port - 1) % len(_PORT_COLORS)],
        }
        for port in range(1, ports + 1)
    ]

    power_flow = {
        "type": "custom:hoymiles-g2-power-flow",
        "dev_id": dev_id,
        "title": _t("My Home", "我的家"),
        "max_width": _SYSTEM_FLOW_MAX_WIDTH,
        "show_title": False,
        # The System tab draws *the installation*, not this unit, and a grid-tied
        # HiFlow installation differs from the storage schematic in three ways:
        # there is no second PV branch (光伏2 is a storage input), a negative
        # 负载 is generation and belongs on 光伏, and the value labels sit over
        # the rings because the HiFlow connectors leave the ring downwards.  The
        # card knows all three under this one name; the storage dashboard never
        # sets it, so its schematic is untouched.  The Device tab below overrides
        # it with `"variant": "inverter"` (the per-unit layout) through the
        # `{**power_flow, ...}` spread.
        "variant": "inverter-system",
    }

    system = _view(
        "system",
        "System",
        [
            # One row of the section's columns: the schematic takes three
            # quarters of it, the two energy tiles the remaining quarter,
            # stacked one above the other.  They used to sit side by side beside
            # the drawing, which made each of them a full-height card for one
            # number and left the schematic no wider than 700 px.  Restacked
            # and half as tall, the two tiles are read top to bottom - today
            # first, lifetime under it - and the space they gave up went to the
            # drawing.
            #
            # Both cards are plain siblings of one grid section, not children of
            # a nested ``grid`` card: a ``hui-grid-card`` ignores ``grid_options``
            # on its children (they all take one track, hence a flat 1:1 split
            # when revision 27 wrote four), while a *section* honours it exactly.
            # See ``_SYSTEM_FLOW_COLUMNS``.
            _grid(
                [
                    _span(power_flow, _SYSTEM_FLOW_COLUMNS),
                    _span(
                        _vstack(
                            [
                                # The installation's yield, not this unit's.
                                # Every HiFlow reports ``pvs[].ed`` for
                                # itself and the protocol never adds them up
                                # (measured 387 / 148 / 613 Wh on three units
                                # of one installation), so the System tab -
                                # which describes the installation - reads the
                                # aggregated entity instead of the per-unit
                                # one.  The Device tab keeps
                                # ``system_pv_energy_today``, because that tab
                                # is about this unit.
                                _gauge(
                                    dev_id,
                                    "plant_pv_energy_today",
                                    _t("PV Today", "今日发电"),
                                    "Wh",
                                    max=2000,
                                    decimals=0,
                                    icon="panel",
                                    show_arc=False,
                                    compact=True,
                                ),
                                _energy_total_gauge(dev_id, compact=True),
                            ]
                        ),
                        _SYSTEM_TILES_COLUMNS,
                    ),
                ]
            ),
            _grid(
                [
                    _history(
                        _t("Power", "功率"),
                        [pv_series, grid_series, load_series],
                        unit="W",
                        height=330,
                        sync_group=system_group,
                        # Mirrored **always**, not decided per render from the
                        # data.  ``symmetric=False`` pinned a bottom-up
                        # ``0..max`` axis, and 电网 is a signed series: the day
                        # the house exports, every negative grid reading was
                        # clamped to the baseline and the curve visibly went
                        # missing below zero.  Leaving the key out (revision 24)
                        # only mirrored on the days the data actually dipped,
                        # which made the axis jump between layouts and left no
                        # negative half to read an export against on a
                        # consumption-only day.  Pinning ``True`` keeps the zero
                        # line across the middle where the direction of the flow
                        # is legible: 光伏 above it, 负载 and grid import below.
                        symmetric=True,
                        stack=False,
                    )
                ]
            ),
            _grid(
                [
                    # Energy, not power: one bar per day of a month and one per
                    # month of a year, a smooth curve for a single day.  The
                    # three tiles above it (month / year / lifetime) are derived
                    # from the same lifetime statistic, so no extra sensor is
                    # needed for "this month" and "this year" - and that is why
                    # this curve reads the *plant* total: three tiles summed
                    # from one unit's counter while the fourth card of the same
                    # row shows the installation's would be two answers to one
                    # question.  The Device tab keeps the per-unit curve.
                    _history(
                        _t("PV Energy", "发电量"),
                        [
                            {
                                "entity": _entity(dev_id, "plant_pv_energy_total"),
                                "name": _t("Generation", "发电量"),
                                "color": "#22c55e",
                            }
                        ],
                        unit="kWh",
                        height=300,
                        # Opens on a month: one bar per day of it, which is the
                        # window the vendor app shows and the only one where
                        # "how much did it make" is a single row of bars.
                        range="month",
                        sync_group=system_energy_group,
                        symmetric=False,
                        stack=False,
                        mode="auto",
                        show_totals=True,
                        scale=0.001,
                    )
                ]
            ),
        ],
    )

    device = _view(
        "device",
        "Device",
        [
            # One row, filled edge to edge: half the section's 48 columns of
            # schematic and half of faults.  Both cards are siblings in a single
            # grid section - a nested ``grid`` card would also give equal halves
            # but cannot be collapsed later, and two sibling sections would
            # stack once the dashboard drops ``max_columns``.  The alarm card
            # hides itself while the device is quiet, and the schematic then
            # widens over the freed columns by itself (``_syncRowSpan``).
            _grid(
                [
                    {
                        **power_flow,
                        "variant": "inverter",
                        "pv_count": ports,
                        "max_width": _DEVICE_FLOW_MAX_WIDTH,
                        "grid_options": {"columns": _FLOW_COLUMNS},
                        # The alarm list beside this card hides itself when the
                        # device is quiet, so the badge in the schematic corner
                        # is the only remaining indication of health.  It needs
                        # the sensor to count with; without it the badge is
                        # simply omitted.
                        **({"alarm_entity": alarm_entity} if alarm_entity else {}),
                    },
                    {**_alarm_card(dev_id, alarm_entity), "grid_options": {"columns": _ALARM_COLUMNS}},
                ]
            ),
            _grid(
                [
                    _history(
                        _t("PV Power by Port", "各光伏端口功率"),
                        port_series,
                        unit="W",
                        height=280,
                        sync_group=device_group,
                        symmetric=False,
                        stack=False,
                    )
                ]
            ),
            # The 功率曲线 card that used to sit here is gone.  The System view
            # already draws PV / grid / load together, and on this tab the three
            # curves answered a question nobody asks of *one* unit: the port
            # chart above already says which input is producing, and the two
            # cards below cover voltage and yield.  Keeping it also meant the
            # same three series were stored twice per device.
            _grid(
                [
                    _history(
                        _t("Grid Voltage", "电网电压"),
                        [
                            {
                                "entity": _entity(dev_id, "grid_on_voltage"),
                                "name": _t("Grid Voltage", "电网电压"),
                                "color": "#60a5fa",
                            }
                        ],
                        unit="V",
                        height=240,
                        sync_group=device_group,
                        symmetric=False,
                    ),
                    _history(
                        _t("Energy Today", "今日发电量"),
                        [
                            {
                                "entity": _entity(dev_id, "system_pv_energy_today"),
                                "name": _t("PV Today", "今日发电"),
                                "color": "#fbbf24",
                            }
                        ],
                        unit="Wh",
                        height=240,
                        sync_group=device_group,
                        symmetric=False,
                    ),
                ]
            ),
            # The switch for the opt-in curves.  Last, so the curves it adds read
            # as a block right above it (``async_set_optional_charts`` appends
            # them, i.e. just before this section).
            _grid([_chart_options_card(dev_id)]),
        ],
    )

    control = _view(
        "control",
        "Control",
        [
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-control",
                            "dev_id": dev_id,
                            "subtitle": False,
                            # A micro inverter has no time-of-use feature: its
                            # retained `attributes` inventory carries no
                            # `tou_get` (verified live - alarm_state,
                            # device_state, ems_mode, factory_reset,
                            # output_power, power_ctrl, quick_state, reboot,
                            # reset_ble_pin_code, switch_ctrl), and the firmware
                            # never publishes a `tou_*` topic. The row is
                            # switched off explicitly instead of relying on the
                            # entity being absent, so a registry row left over
                            # from an older build cannot bring the button back.
                            "show_tou": False,
                            # No ``entities`` pin here, deliberately. Both
                            # `power_ctrl` and `output_power` are plain `number`
                            # entities and the firmware names them all after the
                            # device, so `number.<dev>` is whichever one HA
                            # created first - measured, `output_power` on the
                            # two-input HiFlow Pro but `power_ctrl` on the
                            # single-input HiFlow. Pinning the base id therefore
                            # only moved the bug between models: the Control
                            # card of a HiFlow offered `100 ~ 800` on its
                            # power-control row and `0 ~ 132` on its output row,
                            # i.e. each row showed the other's range. The card
                            # tells the two apart from the declared floor
                            # (`power_ctrl` can reach 0 or below, `output_power`
                            # starts at 100 W), which holds on every model.
                        }
                    ),
                ]
            )
        ],
    )

    return [system, device, control]


# --------------------------------------------------------------------------- #
# Storage (MSA-) views
# --------------------------------------------------------------------------- #
def _build_storage_views(dev_id: str, model: str = "") -> list[dict[str, Any]]:
    """System / device / control views for a micro storage unit.

    Same frame as the inverter layout - full-width power flow, icon and title on
    every view, shared ``sync_group`` on the history charts.
    """
    slug = _slug(dev_id)
    group = f"{slug}-system"
    system = _view(
        "system",
        "System",
        [
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-power-flow",
                            "dev_id": dev_id,
                            "title": _t("My Home", "我的家"),
                            "max_width": 700,
                            "show_title": False,
                        }
                    ),
                ]
            ),
            _grid(
                [
                    _gauge(
                        dev_id,
                        "system_pv_energy_today",
                        _t("PV Today", "今日发电"),
                        "kWh",
                        scale=0.001,
                        icon="panel",
                    ),
                    _gauge(
                        dev_id,
                        "battery_charge_energy_today",
                        _t("Charge Today", "今日充电"),
                        "kWh",
                        scale=0.001,
                        icon="battery",
                    ),
                    _gauge(
                        dev_id,
                        "battery_discharge_energy_today",
                        _t("Discharge Today", "今日放电"),
                        "kWh",
                        scale=0.001,
                        icon="cycle",
                    ),
                    _gauge(
                        dev_id,
                        "system_soc",
                        _t("Battery SOC", "电池电量"),
                        "%",
                        max=100,
                        min=0,
                        icon="battery",
                    ),
                ]
            ),
            _grid(
                [
                    _history(
                        _t("Power", "功率"),
                        [
                            {
                                "entity": _entity(dev_id, "system_pv_power"),
                                "name": _t("PV Power", "光伏功率"),
                                "color": "#22c55e",
                            },
                            {
                                "entity": _entity(dev_id, "system_battery_power"),
                                "name": _t("Battery", "电池"),
                                "color": "#4a90d9",
                            },
                            {
                                "entity": _entity(dev_id, "system_grid_power"),
                                "name": _t("Grid Output [+]/Input [-]", "电网 输出[+]/输入[-]"),
                                "color": "#22d3ee",
                            },
                        ],
                        unit="W",
                        height=330,
                        sync_group=group,
                        stack=False,
                    )
                ]
            ),
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-energy-sankey",
                            "dev_id": dev_id,
                            "title": _t("Energy Flow", "能量流"),
                            "range": "today",
                        }
                    )
                ]
            ),
        ],
    )

    device = _view(
        "device",
        "Device",
        [
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-battery",
                            "dev_id": dev_id,
                            "title": _t("Battery", "电池"),
                        }
                    ),
                ]
            ),
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-pack-list",
                            "dev_id": dev_id,
                            "title": _t("Battery Packs", "电池组"),
                            "columns": 2,
                        }
                    )
                ]
            ),
            _grid([_diagnostics(dev_id, inverter=False)]),
        ],
    )

    control = _view(
        "control",
        "Control",
        [
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-control",
                            "dev_id": dev_id,
                            "subtitle": False,
                            # Protocol §29 declares the factory-reset command for
                            # HiFlow / HiFlow Pro only, and a storage unit's
                            # retained `attributes` inventory carries no
                            # `factory_reset` entry. The card reaches the same
                            # conclusion from the product id on its own; this is
                            # written out so the intent survives a look at the
                            # generated dashboard.
                            "show_factory_reset": False,
                            # Same reasoning for protocol §31 (BLE PIN reset) -
                            # a storage unit declares `reset_ble_pin_code` neither.
                            "show_ble_pin_reset": False,
                        }
                    ),
                ]
            ),
            _grid(
                [
                    _full_width(
                        {
                            "type": "custom:hoymiles-g2-tou-editor",
                            "dev_id": dev_id,
                            "title": _t("TOU Plan", "峰谷计划"),
                        }
                    )
                ]
            ),
        ],
    )

    return [system, device, control]


def _gauge(
    dev_id: str,
    key: str,
    name: dict[str, str],
    unit: str,
    *,
    scale: float = 1,
    max: float | None = None,
    min: float = 0,
    decimals: int | None = None,
    icon: str | None = None,
    show_arc: bool | None = None,
    compact: bool = False,
) -> dict[str, Any]:
    """Build a ``hoymiles-g2-gauge`` card for one energy/power/SOC entity.

    ``compact`` asks the card for its one-line reading - name on the left, value
    on the right - which is roughly half the height of a full tile.  It exists
    for the System tab, where 「今日发电」 and 「总发电量」 are stacked in a narrow
    column beside the schematic: two full tiles there would be taller than the
    drawing next to them and leave a gap under it.
    """
    card: dict[str, Any] = {
        "type": "custom:hoymiles-g2-gauge",
        "entity": _entity(dev_id, key),
        "name": name,
        "unit": unit,
    }
    # Only non-default options are emitted: the card already defaults to
    # ``scale: 1`` / ``min: 0``, and carrying them in every card made the
    # generated YAML noisier than the hand-written dashboard it mirrors.
    if scale != 1:
        card["scale"] = scale
    if max is not None:
        card["max"] = max
    if min:
        card["min"] = min
    if decimals is not None:
        card["decimals"] = decimals
    if icon is not None:
        card["icon"] = icon
    if show_arc is not None:
        card["show_arc"] = show_arc
    if compact:
        card["compact"] = True
    return card


def _energy_total_gauge(dev_id: str, *, compact: bool = False) -> dict[str, Any]:
    """The lifetime PV energy card that sits to the right of "today".

    Same card and the same visual format as the "today" gauge next to it - a
    number with a unit and no arc - because the two are read together.  Three
    things do differ, all deliberately:

    * **kWh, not Wh.**  A lifetime counter is seven digits on the test
      installation's largest unit alone, which overflows a half-width card on a
      phone.  Scaled to kWh it reads ``6.1`` for the three units together.
    * **A different icon.**  "Today" uses ☀️; repeating the sun on the adjacent
      card makes the two indistinguishable at a glance.  This one uses the
      vendor app's "All" ring - a broken circle with the word inside - which
      says "everything generated so far" without inventing a second sun.  The
      glyph is drawn by the card itself (``ICON_SVG.all``); set the option to
      ``all`` and it lands in the head at the same size as any emoji.
    * **One decimal.**  A tenth of a kWh is the smallest step that ever matters
      on a lifetime total, and it keeps the width stable as the number grows.

    ``show_arc`` stays off for the same reason as its sibling: a lifetime total
    has no meaningful ceiling, so a percentage of ``max`` would be invented.

    The entity is ``plant_pv_energy_total``, **not** ``pv_energy_total``.
    ``et`` is a per-unit counter and the protocol never adds units up, so the
    per-unit figure showed the master's share of the roof - on the test
    installation 2.9 of 6.1 kWh, less than half, with nothing on the card saying
    so.  This card sits on the System tab, which describes the installation, so
    it reads the aggregated entity; the Device tab keeps the per-unit
    ``pv_energy_total`` beside the per-unit 今日发电.
    """
    return _gauge(
        dev_id,
        "plant_pv_energy_total",
        _t("PV Total", "总发电量"),
        "kWh",
        scale=0.001,
        decimals=1,
        icon="all",
        show_arc=False,
        compact=compact,
    )


def _chart_options_card(dev_id: str) -> dict[str, Any]:
    """The 「更多数据」 switch card of the Device view.

    It is the on-page counterpart of the Options Flow's data-card step: five
    switches, one per :data:`OPTIONAL_CHARTS` entry, writing the same dashboard
    document through the integration's ``set_optional_charts`` service.  The
    card carries ``dev_id`` because it has no entity to infer the device from -
    it acts on the dashboard the reader is already looking at.

    The title is 「更多数据」 and not 「更多曲线」: it switches *readings*, and the
    cards it adds are charts the user chose from the data the device reports.

    It is deliberately *not* marked with :data:`_OPTIONAL_KEY`: that marker means
    "this card is one of the opt-in charts" and
    :func:`async_set_optional_charts` removes every card carrying it.  Marking
    this one would make it delete itself the first time a switch was used.
    """
    return {
        "type": CHART_OPTIONS_CARD,
        "dev_id": dev_id,
        "title": _t("More Data", "更多数据"),
    }


def _is_chart_options_section(section: Any) -> bool:
    """True when this grid section holds the opt-in switch card."""
    if not isinstance(section, dict):
        return False
    cards = section.get("cards")
    if not isinstance(cards, list):
        return False
    return any(
        isinstance(card, dict) and card.get("type") == CHART_OPTIONS_CARD
        for card in cards
    )


def _has_chart_options(config: dict[str, Any]) -> bool:
    """True when the dashboard already carries the switch card somewhere."""
    views = config.get("views")
    if not isinstance(views, list):
        return False
    for card in _walk_cards(views):
        if isinstance(card, dict) and card.get("type") == CHART_OPTIONS_CARD:
            return True
    return False


def _migrate_chart_options_card(config: dict[str, Any], dev_id: str) -> bool:
    """Add the 「更多曲线」 switch card to an inverter's Device view; rev. 21.

    ``_LAYOUT_KEY`` short-circuits :func:`_build_views`, so an install that
    already has a dashboard never sees a newly generated card without this.

    It only ever *adds*, and only to the Device view of a micro inverter - the
    storage unit's layout has no opt-in charts, and its Device view is left
    byte-for-byte alone.  The card goes last, after the fixed curves, so the
    opt-in ones (which :func:`async_set_optional_charts` inserts just above it)
    read as a block under the readings they extend.
    """
    if not _is_inverter(dev_id):
        return False

    if _has_chart_options(config):
        return False

    views = config.get("views")
    if not isinstance(views, list):
        return False

    for view in views:
        if not isinstance(view, dict) or view.get("path") != "device":
            continue
        sections = view.setdefault("sections", [])
        if not isinstance(sections, list):
            return False
        sections.append(_grid([_chart_options_card(dev_id)]))
        return True

    return False


def _migrate_chart_options_title(config: dict[str, Any]) -> bool:
    """Rename the switch card's stored title to 「更多数据」; rev. 22.

    The title lives in the dashboard document, so a new default in
    :func:`_chart_options_card` only reaches *new* dashboards - every install
    that already has the card would keep reading 「更多曲线」 forever.

    Only the title an earlier release wrote is rewritten.  A title the user typed
    (anything else) is theirs and is left alone, because the card renders
    ``config.title`` and a user-chosen label must not be overwritten by a rename
    of ours.
    """
    changed = False
    for card in _walk_cards(config.get("views") or []):
        if not isinstance(card, dict) or card.get("type") != CHART_OPTIONS_CARD:
            continue
        if card.get("title") not in _LEGACY_CHART_OPTIONS_TITLES:
            continue
        card["title"] = _t("More Data", "更多数据")
        changed = True
    return changed


def _alarm_card(dev_id: str, entity: str | None = None) -> dict[str, Any]:
    """The device-alarm card that sits to the right of the power flow.

    It reads the ``Active Alarms`` sensor, whose state is the count and whose
    ``alarms`` attribute is the decoded list (protocol §27).  The card itself
    decides between "no data", "no alarms" and the list - it has to, because
    ``alarm/state`` is not retained and a silent device must not be shown as a
    healthy one.

    ``entity`` is the id resolved from the registry by
    :func:`_alarm_entity_id`.  It is passed in rather than recomputed so the
    generated card and the migration agree, and so a rename that moved the
    ``entity_id`` away from the serial-based spelling still resolves.
    ``max`` is capped at six rows: the card shares a row with the power flow, so
    a long list scrolls inside it instead of stretching the row.
    """
    return {
        "type": ALARM_CARD,
        "entity": entity or _entity(dev_id, "active_alarms"),
        "title": _t("Alarms", "设备告警"),
        "max": 6,
        # The card hides itself while the device reports nothing, which lets the
        # schematic beside it take the whole row.  The schematic carries a small
        # badge instead (green tick / red lamp), so the state is never lost - and
        # a device that has *never* reported is shown as unknown on the badge
        # rather than as healthy.
        "only_when_alarm": True,
    }


def _diagnostics(dev_id: str, *, inverter: bool) -> dict[str, Any]:
    """A markdown card showing device identity and a few live readings."""
    slug = _slug(dev_id)
    rows = [
        f"## {dev_id}",
        "",
        "| 项目 | 值 |",
        "| --- | --- |",
        f"| RSSI | {{{{ states('sensor.{slug}_rssi') }}}} dBm |",
    ]
    if inverter:
        rows += [
            f"| 电网电压 | {{{{ states('sensor.{slug}_grid_on_voltage') }}}} V |",
            f"| 电网频率 | {{{{ states('sensor.{slug}_grid_on_frequency') }}}} Hz |",
        ]
    else:
        rows += [
            f"| 电池电压 | {{{{ states('sensor.{slug}_battery_voltage') }}}} V |",
            f"| 电池温度 | {{{{ states('sensor.{slug}_battery_temperature') }}}} ℃ |",
        ]
    return {"type": "markdown", "content": "\n".join(rows)}
