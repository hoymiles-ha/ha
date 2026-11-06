"""Auto generated Lovelace dashboard for a Hoymiles micro storage device.

One device publishes roughly 80 entities, which is far too many to lay out by
hand.  This module builds a three view dashboard - System, Device and Control -
out of the cards that ship with the integration, and installs it as a regular
*storage* dashboard so the user can keep editing it afterwards.

The generated layout is a **template**: every device gets the same views and the
same cards, and only the entity ids differ.  A dashboard is a snapshot, though -
Lovelace copies the config into ``.storage/lovelace.<id>`` and the integration is
never asked again - so a template change would silently leave older devices on
the old layout.  ``TEMPLATE_VERSION`` plus the per-device hash recorded in
``.storage/hoymiles.dashboard_meta`` close that gap: a dashboard whose content
still matches what was generated for it is upgraded on setup, and one that has
been edited by hand is left alone.

Nothing here is mandatory: the integration works fine without a dashboard.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import slugify

from .const import (
    DASHBOARD_ICON,
    DASHBOARD_TITLE_PREFIX,
    DASHBOARD_URL_PREFIX,
)

_LOGGER = logging.getLogger(__name__)

VIEW_ICON_SYSTEM = "mdi:home-analytics"
VIEW_ICON_DEVICE = "mdi:home-battery"
VIEW_ICON_CONTROL = "mdi:tune"

# The energy-flow sankey is switched off for now and will come back later.
# Kept as a flag rather than deleted so the card stays supported (and stays in
# ``FRONTEND_ASSETS``) and turning it back on is one word: the config builder
# simply stops emitting the section.
SHOW_SANKEY = False

# Bump this whenever ``build_dashboard_config`` changes shape (a new view, a
# renamed card, different colours).  Dashboards the user has not touched are
# then rebuilt on the next setup; edited ones keep their layout.
TEMPLATE_VERSION = 8

# Return values of ``async_create_device_dashboard``.
RESULT_CREATED = "created"
RESULT_EXISTS = "exists"
RESULT_UPDATED = "updated"
RESULT_UNAVAILABLE = "unavailable"

# Per-device bookkeeping for the template upgrade: ``{"MSA-...": {template_version,
# config_hash, auto_update}}``.  Kept in its own store file so a Lovelace config
# stays a pure Lovelace config.
_META_KEY = "hoymiles.dashboard_meta"


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------
def serial_of(dev_id: str) -> str:
    """Return the SN part of ``client_prefix-SN``."""
    return dev_id.rsplit("-", 1)[-1]


def dashboard_url_path(dev_id: str) -> str:
    """Return the ``url_path`` used for the device's dashboard."""
    return f"{DASHBOARD_URL_PREFIX}{slugify(serial_of(dev_id))}"


def dashboard_title(dev_id: str) -> str:
    """Return the sidebar title of the device's dashboard."""
    return f"{DASHBOARD_TITLE_PREFIX}{serial_of(dev_id)}"


def _entity_id(dev_id: str, suffix: str) -> str:
    """Return the entity id the platform created for ``suffix``.

    ``sensor.py`` builds its entity ids from ``slugify(dev_id)``, so
    ``MSA-280577777777`` becomes ``sensor.msa_280577777777_<suffix>``.
    """
    return f"sensor.{slugify(dev_id)}_{suffix}"


# ---------------------------------------------------------------------------
# Config builder
# ---------------------------------------------------------------------------
def _section(*cards: dict[str, Any]) -> dict[str, Any]:
    return {"type": "grid", "column_span": 4, "cards": list(cards)}


def _label(en: str, zh: str, de: str | None = None) -> dict[str, str]:
    """A three-language label map for a card option.

    The bundled cards resolve these against the reader's choice from the
    language dropdown, so the dashboard follows the person looking at it rather
    than whoever happened to set the interface language.  ``de`` may be omitted,
    in which case the cards fall back to ``en`` - that keeps a partial
    translation readable rather than blank.
    """
    return {"en": en, "zh": zh, "de": de if de is not None else en}


_VIEW_TITLES = {
    "system": {"en": "System", "zh": "系统", "de": "System"},
    "device": {"en": "Device", "zh": "设备", "de": "Ger\u00e4t"},
    "control": {"en": "Control", "zh": "控制", "de": "Steuerung"},
}


def _view_title(key: str, lang: str) -> str:
    return _VIEW_TITLES[key].get(lang) or _VIEW_TITLES[key]["en"]


# Every tab label the template has ever produced.  Used once, to notice a
# dashboard whose only difference is that it was generated while the titles still
# followed the interface language.
_TITLES_EVER = {title for names in _VIEW_TITLES.values() for title in names.values()}


def _titles_of(config: Any) -> tuple[str, ...]:
    """The tab labels of a stored dashboard, in view order."""
    views = config.get("views") if isinstance(config, dict) else None
    if not isinstance(views, list):
        return ()
    return tuple(
        view.get("title") or "" for view in views if isinstance(view, dict)
    )


def _titles_are_template_made(config: Any) -> bool:
    """True when every tab label is one this module could have written.

    A user who renamed a tab to their own words fails this test, which is what
    keeps the one-shot migration below away from hand-edited dashboards.
    """
    titles = _titles_of(config)
    return bool(titles) and all(title in _TITLES_EVER for title in titles)


def _series(
    entity: str,
    name_en: str,
    name_zh: str,
    color: str,
    name_de: str | None = None,
) -> dict[str, Any]:
    """One curve of a history chart."""
    return {
        "entity": entity,
        "name": _label(name_en, name_zh, name_de),
        "color": color,
    }


def _history(
    title_en: str,
    title_zh: str,
    series: list[dict[str, Any]],
    title_de: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """A history chart; ``series`` is mandatory, the card rejects a config without it."""
    return {
        "type": "custom:hoymiles-history-chart",
        "title": _label(title_en, title_zh, title_de),
        "range": "day",
        "series": series,
        "grid_options": {"columns": "full"},
        **extra,
    }


def _gauge(
    entity: str,
    name_en: str,
    name_zh: str,
    icon: str,
    name_de: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "type": "custom:hoymiles-gauge",
        "entity": entity,
        "name": _label(name_en, name_zh, name_de),
        "unit": "kWh",
        "scale": 0.001,
        "max": 10,
        "decimals": 2,
        "icon": icon,
        **extra,
    }


# ---------------------------------------------------------------------------
# Chart palette
# ---------------------------------------------------------------------------
# The colours follow the vendor app so a screenshot from one is readable in the
# other: yellow production, green battery, blue grid & load.
#
# The three power curves are stacked and overlap for most of the day, so the
# hues still have to be far apart - yellow / green / blue sit roughly 120
# degrees from each other, and each also differs in lightness, which keeps them
# separable for the common forms of colour blindness. (An earlier trio of
# #22c55e / #4a90d9 / #22d3ee collapsed into one ribbon: the last two are 40
# degrees apart and the lighter one vanished under the darker one at 32 % fill.)
COLOR_PV = "#f59e0b"        # amber/yellow - production
COLOR_BATTERY = "#22c55e"   # green        - charge / discharge, and SOC
COLOR_GRID = "#3b82f6"      # blue         - grid & load (system view)
COLOR_SOC = COLOR_BATTERY   # battery SOC uses the battery colour

# The device view splits what the system view folds together, so it needs two
# more slots: the on-grid port in slate grey, the off-grid (EPS) port in the same
# blue the system view uses for the combined reading.
COLOR_GRID_PORT = "#64748b"
COLOR_OFFGRID = COLOR_GRID

# Four-slot palette for the per-PV-port chart (yellow / green / grey / blue).
COLOR_SERIES_4 = (COLOR_PV, COLOR_BATTERY, "#64748b", COLOR_GRID)

# Per-pack palette. With the usual single pack only the first slot is ever
# drawn; the rest only matter on multi-pack units, where the extra hues have to
# stay distinguishable from each other on the same 0..100 % axis.
COLOR_PACKS = (COLOR_BATTERY, "#0ea5e9", COLOR_PV, "#a855f7")


def _power_series(
    dev_id: str,
    grid_name_en: str,
    grid_name_zh: str,
    grid_name_de: str | None = None,
) -> list[dict[str, Any]]:
    """PV / battery / grid curves shared by both power charts.

    The names carry no ``[+]/[-]`` suffix on purpose: the sign already says
    which way the power flows, and the value is the magnitude of it. Spelling
    that out made the legend wider than the chart and pushed the tooltip into
    truncation ("To grid & load [+]/F").

    When a grid meter is fitted the grid and the load stop being one number and
    this list has to become four curves. That is a data change, not a card
    change: give ``_power_series`` the two extra entities (see the recipe in
    ``docs/CARDS.md``) instead of ``grid_on_power``.
    """
    return [
        _series(
            _entity_id(dev_id, "pv_power"), "PV power", "光伏功率", COLOR_PV, "PV-Leistung"
        ),
        _series(
            _entity_id(dev_id, "bat_power"), "Battery", "电池", COLOR_BATTERY, "Batterie"
        ),
        _series(
            _entity_id(dev_id, "grid_on_power"),
            grid_name_en,
            grid_name_zh,
            COLOR_GRID,
            grid_name_de,
        ),
    ]


def _sankey_section(dev_id: str) -> list[dict[str, Any]]:
    """The energy-flow section, or nothing while ``SHOW_SANKEY`` is off.

    Returned as a list so the caller can spread it into its ``sections`` and
    the layout stays identical whether or not the card is emitted.
    """
    if not SHOW_SANKEY:
        return []
    return [
        _section(
            {
                "type": "custom:hoymiles-energy-sankey",
                "dev_id": dev_id,
                "title": _label("Energy flow", "能量流", "Energiefluss"),
                # No icon: the card draws a full sankey diagram right below the
                # title, so a glyph there was one symbol too many - it repeated
                # "this is a flow" next to the flow itself.
                "grid_options": {"columns": "full"},
            }
        )
    ]


def build_dashboard_config(dev_id: str, lang: str = "en") -> dict[str, Any]:
    """Return the Lovelace config for one device.

    A plain ``dict`` rather than YAML: the Lovelace storage format is JSON and
    going through YAML would only add a round trip.  All user visible strings
    are ``{en, zh, de}`` maps - the bundled cards pick the one matching the
    reader's choice from the language dropdown (English unless they picked
    something else), so the dashboard follows the person looking at it instead
    of being frozen in one language.

    ``lang`` only affects the **view titles**: a Lovelace view title is a plain
    string rather than a language map, and nothing on the client can rewrite it
    when the dropdown changes, so the titles stay English.
    """
    pv_today = _entity_id(dev_id, "system_pv_energy_today")
    slug = slugify(dev_id)
    sync_system = f"{slug}-system"
    sync_device = f"{slug}-device"

    system_view = {
        "title": _view_title("system", lang),
        "path": "system",
        "icon": VIEW_ICON_SYSTEM,
        "type": "sections",
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": [
            _section(
                {
                    "type": "grid",
                    "columns": 2,
                    "square": False,
                    # A grid card that sits directly in a section only takes two
                    # of the section's columns unless it asks for all of them.
                    # Without this the power flow and the gauges end up squeezed
                    # into the left half of the page.
                    "grid_options": {"columns": "full"},
                    "cards": [
                        {
                            "type": "custom:hoymiles-power-flow",
                            "dev_id": dev_id,
                            "title": _label("My home", "我的家", "Mein Zuhause"),
                            "max_width": 700,
                            "show_title": False,
                            "grid_options": {"columns": "full"},
                        },
                        {
                            "type": "grid",
                            "columns": 2,
                            "square": False,
                            "cards": [
                                _gauge(
                                    pv_today,
                                    "PV today",
                                    "今日发电",
                                    "panel",
                                    "PV heute",
                                    label=_label("Self-consumption", "自用率", "Eigenverbrauch"),
                                    percent_numerator=pv_today,
                                    percent_subtract=_entity_id(
                                        dev_id, "grid_on_energy_out_today"
                                    ),
                                ),
                                {
                                    "type": "grid",
                                    "columns": 1,
                                    "square": False,
                                    "cards": [
                                        _gauge(
                                            _entity_id(
                                                dev_id,
                                                "battery_discharge_energy_today",
                                            ),
                                            "Discharged today",
                                            "今日放电",
                                            "cycle",
                                            "Entladen heute",
                                            show_arc=False,
                                        ),
                                        _gauge(
                                            _entity_id(
                                                dev_id,
                                                "battery_charge_energy_today",
                                            ),
                                            "Charged today",
                                            "今日充电",
                                            "battery",
                                            "Geladen heute",
                                            show_arc=False,
                                        ),
                                    ],
                                },
                            ],
                        },
                    ],
                }
            ),
            _section(
                {
                    "type": "custom:hoymiles-history-chart",
                    "title": _label("History Data", "历史数据", "Verlauf"),
                    "range": "day",
                    "sync_group": sync_system,
                    # Two charts, one time window.  Drawn as separate cards they
                    # each carried their own date picker, which made the second
                    # one look like it kept a period of its own.
                    "panes": [
                        {
                            "title": _label("Power", "功率", "Leistung"),
                            "series": _power_series(
                                dev_id,
                                "Grid & load",
                                "电网与负载",
                                "Netz & Last",
                            ),
                            "unit": "W",
                            "height": 330,
                            # Overlay, do not stack.  PV, battery and grid are
                            # three *independent* measurements of the same flow,
                            # not parts of a sum: stacking them drew the battery
                            # at 0..88 W and the grid at 88..176 W even when the
                            # two readings were identical, so the curves sat one
                            # above the other instead of on top of each other.
                            "stack": False,
                            # No `span`: the y axis fits whatever the day
                            # actually contains.  A fixed +-2500 W range
                            # flattened a 90 W idle evening into a hairline.
                        },
                        {
                            "title": _label("Battery SOC", "电池电量", "Batteriestand"),
                            "series": [
                                _series(
                                    _entity_id(dev_id, "soc"),
                                    "Battery SOC",
                                    "电池电量",
                                    COLOR_SOC,
                                    "Batteriestand",
                                )
                            ],
                            "unit": "%",
                            "height": 250,
                            "symmetric": False,
                            "min": 0,
                            "max": 100,
                        },
                    ],
                    "grid_options": {"columns": "full"},
                }
            ),
            *_sankey_section(dev_id),
        ],
    }
    device_view = {
        "title": _view_title("device", lang),
        "path": "device",
        "icon": VIEW_ICON_DEVICE,
        "type": "sections",
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": [
            _section(
                {
                    "type": "custom:hoymiles-battery",
                    "dev_id": dev_id,
                    "max_width": 620,
                    "show_history": False,
                    "grid_options": {"columns": "full"},
                }
            ),
            _section(
                _history(
                    "Battery level",
                    "各电池包电量",
                    [
                        _series(
                            _entity_id(dev_id, f"pack_{idx}_soc"),
                            f"Battery {idx}",
                            f"电池 {idx}",
                            color,
                            f"Batterie {idx}",
                        )
                        for idx, color in enumerate(COLOR_PACKS, start=1)
                    ],
                    "Ladezustand der Pakete",
                    unit="%",
                    height=300,
                    symmetric=False,
                    min=0,
                    max=100,
                    sync_group=sync_device,
                    # The list is written for the largest unit (four packs), but
                    # a pack that does not exist reports nothing, and the card
                    # drops such a series instead of drawing it as a flat 0 %
                    # line.  One pack in, one green curve out.
                    skip_empty=True,
                    # ...and the *number* of packs comes from the device itself,
                    # not from this template. `skip_empty` alone was not enough:
                    # the recorder keeps values for packs a unit had before it was
                    # re-configured, so a one-pack device kept drawing four stale
                    # curves next to a power-flow card that drew one module.
                    count_entity=_entity_id(dev_id, "pack_count"),
                ),
                _history(
                    "PV power by port",
                    "各光伏端口功率",
                    [
                        _series(
                            _entity_id(dev_id, f"pv{idx}_power"),
                            f"PV{idx}",
                            f"光伏{idx}",
                            color,
                            f"PV{idx}",
                        )
                        for idx, color in enumerate(COLOR_SERIES_4, start=1)
                    ],
                    "PV-Leistung je Anschluss",
                    unit="W",
                    height=240,
                    sync_group=sync_device,
                    # Here stacking *is* meaningful: the ports are parts of one
                    # total, so the top of the stack reads as the whole array.
                    stack=True,
                    # Only the ports that exist report; unused ones are dropped
                    # by the card rather than drawn as a 0 W line.
                    skip_empty=True,
                ),
            ),
            _section(
                _history(
                    "Power curve",
                    "功率曲线",
                    # The device view is per *port*, not per meter: a unit without
                    # a grid meter still reports its on-grid and off-grid ports
                    # separately, so these four curves are four independent
                    # measurements. The system view instead folds the ports into
                    # one "Grid & load" reading.
                    [
                        _series(
                            _entity_id(dev_id, "pv_power"),
                            "PV power",
                            "光伏功率",
                            COLOR_PV,
                            "PV-Leistung",
                        ),
                        _series(
                            _entity_id(dev_id, "bat_power"),
                            "Battery",
                            "电池",
                            COLOR_BATTERY,
                            "Batterie",
                        ),
                        _series(
                            _entity_id(dev_id, "grid_on_power"),
                            "Grid port",
                            "并网端口",
                            COLOR_GRID_PORT,
                            "Netzanschluss",
                        ),
                        _series(
                            _entity_id(dev_id, "grid_off_power"),
                            "Off-grid port",
                            "离网端口",
                            COLOR_OFFGRID,
                            "Inselanschluss",
                        ),
                    ],
                    "Leistungsverlauf",
                    unit="W",
                    height=300,
                    sync_group=sync_device,
                    # Independent readings: overlay, never stack.
                    stack=False,
                ),
            ),
        ],
    }

    control_view = {
        "title": _view_title("control", lang),
        "path": "control",
        "icon": VIEW_ICON_CONTROL,
        "type": "sections",
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": [
            # One card only: `<hoymiles-control>` hosts the TOU editor inside
            # its EMS card when the device is in tou_plan, so the plan is never
            # a separate block further down the page.
            _section(
                {
                    "type": "custom:hoymiles-control",
                    "dev_id": dev_id,
                    "subtitle": False,
                    "grid_options": {"columns": "full"},
                }
            ),
        ],
    }

    # Two pages only. The diagnostics page used to hold the MQTT log, but that
    # is a switch on the control page now, and a whole page whose single card was
    # usually off read as an empty tab in the sidebar.
    return {"views": [system_view, device_view, control_view]}


# ---------------------------------------------------------------------------
# Lovelace plumbing
# ---------------------------------------------------------------------------
def _lovelace_data(hass: HomeAssistant) -> Any:
    """Return ``hass.data[LOVELACE_DATA]`` or None when Lovelace is missing."""
    try:
        from homeassistant.components.lovelace.const import (  # noqa: PLC0415
            LOVELACE_DATA,
        )
    except ImportError:  # pragma: no cover - Lovelace ships with Home Assistant
        return None
    return hass.data.get(LOVELACE_DATA)


def _dashboards(hass: HomeAssistant) -> dict[str, Any] | None:
    """Return the ``url_path -> LovelaceConfig`` mapping.

    Home Assistant has exposed this container as a mapping and, in newer
    releases, as an attribute of a dataclass.  Both shapes are supported.
    """
    data = _lovelace_data(hass)
    if data is None:
        return None
    if isinstance(data, dict):
        return data.get("dashboards")
    return getattr(data, "dashboards", None)


def _dashboards_collection(hass: HomeAssistant) -> Any:
    """Return the dashboards storage collection when the release exposes it."""
    data = _lovelace_data(hass)
    if data is None:
        return None
    if isinstance(data, dict):
        return data.get("dashboards_collection")
    return getattr(data, "dashboards_collection", None)


def _entry_spec(url_path: str, title: str) -> dict[str, Any]:
    return {
        "url_path": url_path,
        "title": title,
        "icon": DASHBOARD_ICON,
        "show_in_sidebar": True,
        "require_admin": False,
        "mode": "storage",
    }


async def _async_register_fallback(hass: HomeAssistant, item: dict[str, Any]) -> None:
    """Publish a dashboard the running instance does not know about yet.

    Only used when neither the collection nor the WebSocket command could be
    reached.  The entry is already persisted by then; this adds the in-memory
    object and the sidebar panel so the dashboard is usable without a restart.
    """
    try:
        from homeassistant.components.lovelace.const import (  # noqa: PLC0415
            MODE_STORAGE,
        )
        from homeassistant.components.lovelace.dashboard import (  # noqa: PLC0415
            LovelaceStorage,
        )
    except ImportError:  # pragma: no cover
        return

    url_path = item["url_path"]
    dashboards = _dashboards(hass)
    if dashboards is not None and url_path not in dashboards:
        dashboards[url_path] = LovelaceStorage(hass, item)

    try:
        from homeassistant.components import frontend  # noqa: PLC0415

        frontend.async_register_built_in_panel(
            hass,
            "lovelace",
            frontend_url_path=url_path,
            config={"mode": MODE_STORAGE},
            require_admin=bool(item.get("require_admin", False)),
            sidebar_title=item.get("title"),
            sidebar_icon=item.get("icon"),
            update=False,
        )
    except Exception:  # noqa: BLE001 - the entry is saved, the panel is a bonus
        _LOGGER.debug("Unable to register the dashboard panel %s", url_path, exc_info=True)


class _StubUser:
    """Minimal user object; the create command is admin only."""

    is_admin = True


class _StubConnection:
    """Collect the result of a WebSocket command run in-process."""

    user = _StubUser()

    def __init__(self) -> None:
        self.result: Any = None
        self.error: tuple[str, str] | None = None

    def send_result(self, msg_id: int, result: Any = None) -> None:
        self.result = result

    def send_error(self, msg_id: int, code: str, message: str, **_: Any) -> None:
        self.error = (code, message)

    def send_message(self, msg: dict[str, Any]) -> None:  # pragma: no cover
        pass


async def _async_create_via_command(
    hass: HomeAssistant, spec: dict[str, Any]
) -> dict[str, Any] | None:
    """Run Home Assistant's own ``lovelace/dashboards/create`` command.

    Recent releases keep the dashboards collection private, so this is the only
    way to create an entry that the running instance fully knows about: it goes
    through the same validation, persists the item and fires the listener that
    registers the sidebar panel.  Returns the created item, or None.
    """
    try:
        from homeassistant.components import websocket_api  # noqa: PLC0415

        handlers = hass.data.get(websocket_api.DOMAIN)
        entry = handlers.get("lovelace/dashboards/create") if handlers else None
    except ImportError:  # pragma: no cover
        return None

    # The registry holds either the bare handler or a (handler, schema) tuple,
    # depending on the release.
    handler = None
    if callable(entry):
        handler = entry
    elif isinstance(entry, tuple):
        handler = next((part for part in entry if callable(part)), None)
    if handler is None:
        return None

    connection = _StubConnection()
    try:
        await handler(hass, connection, {"id": 1, "type": "lovelace/dashboards/create", **spec})
    except Exception:  # noqa: BLE001 - fall through to the next strategy
        _LOGGER.debug("lovelace/dashboards/create failed", exc_info=True)
        return None

    if connection.error is not None:
        _LOGGER.debug("lovelace/dashboards/create: %s", connection.error)
        return None
    return connection.result if isinstance(connection.result, dict) else {}


async def _async_registry_items(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return the dashboard items Lovelace has persisted.

    The registry file - not the in-memory container - is the source of truth for
    a dashboard's ``id``.  The object handed back right after creation still
    carries its pre-create state, which is how a config once ended up under
    ``lovelace.g3-...`` while Lovelace read ``lovelace.g3_...`` and showed an
    empty page.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return []
    try:
        data = await Store(hass, 1, "lovelace_dashboards").async_load()
    except Exception:  # noqa: BLE001 - an unreadable registry is an empty one
        return []
    if not isinstance(data, dict):
        return []
    payload = data.get("data")
    if not isinstance(payload, dict):
        return []
    items = payload.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


async def _async_ensure_registry_entry(
    hass: HomeAssistant, spec: dict[str, Any]
) -> bool:
    """Add the item to the persisted registry when nothing else could.

    ``lovelace/dashboards/create`` is a WebSocket command and recent releases
    keep the collection private, so an integration has no supported way to add
    an entry.  Writing the same store file Home Assistant writes is the last
    resort: it is exactly what the next restart would produce anyway, and the
    sidebar panel is registered in memory so the dashboard is usable at once.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return False

    url_path = str(spec["url_path"])
    store = Store(hass, 1, "lovelace_dashboards")
    try:
        data = await store.async_load()
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        data = {"version": 1, "minor_version": 1, "key": "lovelace_dashboards"}

    payload = data.get("data")
    if not isinstance(payload, dict):
        payload = {}
        data["data"] = payload
    items = payload.get("items")
    if not isinstance(items, list):
        items = []
    if any(isinstance(i, dict) and i.get("url_path") == url_path for i in items):
        return True

    payload["items"] = [*items, dict(spec)]
    payload.setdefault("deleted_items", [])
    try:
        await store.async_save(data)
    except Exception:  # noqa: BLE001
        _LOGGER.warning(
            "Unable to add %s to the dashboards registry", url_path, exc_info=True
        )
        return False

    await _async_register_fallback(hass, dict(spec))
    _LOGGER.info("Added the dashboard entry %s to the registry", url_path)
    return True


async def _async_ensure_entry(hass: HomeAssistant, url_path: str, title: str) -> bool:
    """Create the dashboard entry unless it is already there.

    Tried in order of preference: the storage collection, Home Assistant's own
    ``lovelace/dashboards/create`` command, and finally the registry file.  Each
    step re-checks the registry instead of trusting the return value - the
    in-process connection used for the command can add the item and still report
    a failure while replying to a stub that is not a real client.
    """
    dashboards = _dashboards(hass)
    if dashboards is None:
        return False
    if url_path in dashboards:
        return True

    spec = _entry_spec(url_path, title)

    collection = _dashboards_collection(hass)
    if collection is not None:
        try:
            await collection.async_create_item(dict(spec))
        except Exception:  # noqa: BLE001 - never break the caller over a panel
            _LOGGER.debug(
                "dashboards collection rejected %s", url_path, exc_info=True
            )
        if url_path in (_dashboards(hass) or {}):
            return True

    item = await _async_create_via_command(hass, spec)
    persisted = any(
        entry.get("url_path") == url_path
        for entry in await _async_registry_items(hass)
    )

    if persisted or item is not None:
        # Either the command replied normally or it added the item first and
        # then failed to talk to our stub connection.  The registry decides.
        if url_path not in (_dashboards(hass) or {}):
            await _async_register_fallback(hass, {**spec, **dict(item or {})})
        return True

    return await _async_ensure_registry_entry(hass, spec)




async def _async_item_id(hass: HomeAssistant, dashboard: Any, url_path: str) -> str:
    """Return the ``id`` Lovelace stores this dashboard's config under.

    Resolved in this order, because only the first one is authoritative:

    1. the persisted registry item whose ``url_path`` matches,
    2. the ``id`` carried by the in-memory dashboard object,
    3. Home Assistant's own rule, ``slugify(url_path)``.

    Step 3 is what ``lovelace/dashboards/create`` would have produced, so it is
    the right answer for a dashboard that was created but never loaded.  Step 1
    matters for older dashboards whose id kept the dash (``g3-280577777777``):
    guessing would write a second file that the real one then shadows.
    """
    for entry in await _async_registry_items(hass):
        if entry.get("url_path") != url_path:
            continue
        item_id = entry.get("id")
        if isinstance(item_id, str) and item_id:
            return item_id

    current = getattr(dashboard, "config", None)
    if isinstance(current, dict):
        item_id = current.get("id")
        if isinstance(item_id, str) and item_id:
            return item_id

    return slugify(url_path)


async def _async_has_config(hass: HomeAssistant, dashboard: Any, url_path: str) -> bool:
    """Return whether the dashboard already has a usable config on disk."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return False

    key = await _async_item_id(hass, dashboard, url_path)
    try:
        data = await Store(hass, 1, f"lovelace.{key}").async_load()
    except Exception:  # noqa: BLE001 - a missing or corrupt file is "empty"
        return False
    if not isinstance(data, dict):
        return False
    config = data.get("config")
    return isinstance(config, dict) and bool(config.get("views"))


async def _async_write_config(
    hass: HomeAssistant,
    dashboard: Any,
    url_path: str,
    config: dict[str, Any],
) -> bool:
    """Write the config straight into its own ``lovelace.<id>`` store file.

    ``LovelaceConfig.async_save`` is the documented path, but on some releases
    the write never reaches the disk: the storage key is derived from the item
    id, which differs from the url path, and the object handed out right after
    the entry was created still carries the pre-create state.  The dashboard
    then looks fine until the next restart and is empty afterwards.  Writing
    the file Lovelace loads at startup closes that gap.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return False

    key = await _async_item_id(hass, dashboard, url_path)
    store = Store(hass, 1, f"lovelace.{key}")
    try:
        existing = await store.async_load()
        if isinstance(existing, dict) and existing.get("config") == config:
            return True
        await store.async_save({"config": config})
    except Exception:  # noqa: BLE001
        _LOGGER.warning("Unable to write lovelace.%s", key, exc_info=True)
        return False
    _LOGGER.debug("Wrote lovelace.%s", key)
    return True


async def _async_read_config(
    hass: HomeAssistant, dashboard: Any, url_path: str
) -> dict[str, Any] | None:
    """Return the config Lovelace will load for this dashboard, or None."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return None

    key = await _async_item_id(hass, dashboard, url_path)
    try:
        data = await Store(hass, 1, f"lovelace.{key}").async_load()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    config = data.get("config")
    return config if isinstance(config, dict) else None


def _config_hash(config: dict[str, Any] | None) -> str:
    """Fingerprint a dashboard config, independent of key order.

    Used to tell "the user has not touched this" from "the user made it their
    own": the moment anything in the layout changes by hand the hash stops
    matching what was generated, and the template upgrade backs off.
    """
    blob = json.dumps(config if isinstance(config, dict) else {}, sort_keys=True,
                      separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _known_hashes(record: dict[str, Any]) -> list[str]:
    """Every hash this integration is known to have written for a device.

    One hash is not enough: a dashboard can legitimately differ from the latest
    generated config without anyone having edited it - an interrupted write, a
    rebuild by an older version of this module, or a Lovelace round-trip that
    reordered nothing but rewrote the file.  Each of those used to look exactly
    like a hand edit and permanently opted the dashboard out of upgrades, which
    is how one device kept the old emoji icons while its neighbours moved on.
    """
    hashes: list[str] = []
    listed = record.get("config_hashes")
    if isinstance(listed, list):
        hashes = [h for h in listed if isinstance(h, str) and h]
    latest = record.get("config_hash")
    if isinstance(latest, str) and latest and latest not in hashes:
        hashes.append(latest)
    return hashes


async def _async_meta(hass: HomeAssistant) -> dict[str, Any]:
    """Load the per-device template bookkeeping."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return {}
    try:
        data = await Store(hass, 1, _META_KEY).async_load()
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(data, dict):
        return {}
    entries = data.get("entries")
    return entries if isinstance(entries, dict) else {}


async def _async_record_template(
    hass: HomeAssistant,
    dev_id: str,
    config: dict[str, Any],
    *,
    auto_update: bool = True,
) -> None:
    """Remember which template produced this dashboard."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return

    entries = await _async_meta(hass)
    new_hash = _config_hash(config)
    previous = entries.get(dev_id) if isinstance(entries.get(dev_id), dict) else {}
    history = _known_hashes(previous)
    if new_hash in history:
        history.remove(new_hash)
    history.append(new_hash)
    entries[dev_id] = {
        "template_version": TEMPLATE_VERSION,
        "config_hash": new_hash,
        # Bounded: a keep-forever list would grow on every template bump and
        # nothing needs more than the last handful of generations.
        "config_hashes": history[-8:],
        "auto_update": auto_update,
    }
    try:
        await Store(hass, 1, _META_KEY).async_save({"entries": entries})
    except Exception:  # noqa: BLE001 - bookkeeping must never break setup
        _LOGGER.debug("Unable to save the dashboard template meta", exc_info=True)


def _card_signature(card: Any) -> str:
    """Shape of one card: its type, plus the shape of the cards inside it."""
    if not isinstance(card, dict):
        return "?"
    kind = str(card.get("type") or "")
    nested = card.get("cards")
    if isinstance(nested, list) and nested:
        return kind + "(" + ",".join(_card_signature(c) for c in nested) + ")"
    return kind


def _structure_signature(config: dict[str, Any] | None) -> str:
    """Shape of a whole dashboard, ignoring every value.

    This is what separates a *template* change from a *cosmetic* edit: a new or
    removed view, or a card added inside a section, changes the signature, while
    recolouring a curve, renaming it, or switching a boolean does not.  It is
    only used to adopt dashboards that predate ``TEMPLATE_VERSION`` - once a
    dashboard has been recorded, the exact content hash decides.
    """
    if not isinstance(config, dict):
        return ""
    parts: list[str] = []
    for view in config.get("views") or []:
        if not isinstance(view, dict):
            continue
        body = view.get("cards")
        if not isinstance(body, list):
            body = view.get("sections")
        cards = body if isinstance(body, list) else []
        parts.append(
            str(view.get("path") or "") + "[" + ",".join(_card_signature(c) for c in cards) + "]"
        )
    return "|".join(parts)


async def async_upgrade_dashboard_template(
    hass: HomeAssistant, dev_id: str
) -> str | None:
    """Rebuild an untouched dashboard that was generated by an older template.

    Returns the result of the rebuild, or None when nothing was done.  Four
    outcomes:

    * the stored config matches a config this integration wrote for the device
      (any recorded generation, not just the newest) and the template has moved
      on -> rebuild it,
    * the stored config matches nothing we ever wrote -> it was edited by hand,
      so remember that and never check again,
    * it was flagged as hand-edited before this module kept a hash history, but
      its shape still matches the template -> the flag predates the check, so it
      is rebuilt once and recorded properly,
    * no record at all but the shape still matches the current template -> the
      dashboard is simply up to date, record it and stop,
    * no record and a different shape -> it was generated by an older template,
      rebuild it.  Shape, not content, because a dashboard from before the
      versioning had no way of recording "I was generated": recolouring a curve
      must not count as a hand edit, while a missing view is a template change.
    """
    url_path = dashboard_url_path(dev_id)
    dashboards = _dashboards(hass) or {}
    dashboard = dashboards.get(url_path)
    if dashboard is None:
        return None

    stored = await _async_read_config(hass, dashboard, url_path)
    if not isinstance(stored, dict) or not stored.get("views"):
        return None  # the empty case is handled by the create path

    meta = await _async_meta(hass)
    record = meta.get(dev_id) if isinstance(meta.get(dev_id), dict) else None

    if record is None:
        expected = build_dashboard_config(dev_id)
        if _structure_signature(stored) == _structure_signature(expected):
            # Same layout as the bundled template - nothing to bring forward.
            if stored == expected:
                await _async_record_template(hass, dev_id, stored)
                return None
            # Structurally identical but values differ: the user has customised
            # it, so adopt it as-is and treat it as opted out of upgrades.
            await _async_record_template(hass, dev_id, stored, auto_update=False)
            _LOGGER.info(
                "Dashboard %s keeps its customised layout (template v%s)",
                url_path,
                TEMPLATE_VERSION,
            )
            return None

        _LOGGER.info(
            "Dashboard %s was built by an older template, rebuilding it with v%s",
            url_path,
            TEMPLATE_VERSION,
        )
        return await async_create_device_dashboard(hass, dev_id, overwrite=True)

    if record.get("auto_update") is False:
        # Records written before ``config_hashes`` existed carried a single hash,
        # so a legitimate write by an older build of this module (or a
        # round-trip through Lovelace that re-serialised the file) looked
        # exactly like a hand edit and opted the dashboard out for good.  One
        # device still had the old emoji icons because of that.
        #
        # Those records cannot be re-evaluated against the history they never
        # kept, but they can be re-evaluated against the shape: a dashboard the
        # user really did customise gets its record rewritten with history by
        # the branch below (or by the adopt path), so this can only ever fire
        # once per device and never on a dashboard that has a history.
        if "config_hashes" in record:
            # One migration still has to reach these records: the tab labels
            # used to follow the Home Assistant interface language and are now
            # English, because nothing on the client can rewrite a view title
            # when the reader changes the language in a card.  A dashboard whose
            # only difference is the wording of its tabs is not a customised
            # dashboard, and leaving it alone would show Chinese tabs next to
            # English cards.
            version = record.get("template_version")
            expected = build_dashboard_config(dev_id)
            if (
                isinstance(version, int)
                and version < TEMPLATE_VERSION
                and _titles_of(stored) != _titles_of(expected)
                and _titles_are_template_made(stored)
                and _structure_signature(stored) == _structure_signature(expected)
            ):
                _LOGGER.info(
                    "Dashboard %s kept the old view titles; rebuilding with v%s",
                    url_path,
                    TEMPLATE_VERSION,
                )
                return await async_create_device_dashboard(hass, dev_id, overwrite=True)
            return None
        version = record.get("template_version")
        if not isinstance(version, int) or version >= TEMPLATE_VERSION:
            return None
        expected = build_dashboard_config(dev_id)
        if _structure_signature(stored) != _structure_signature(expected):
            return None
        _LOGGER.info(
            "Dashboard %s was flagged before hash history existed; rebuilding with v%s",
            url_path,
            TEMPLATE_VERSION,
        )
        return await async_create_device_dashboard(hass, dev_id, overwrite=True)

    stored_hash = _config_hash(stored)
    if stored_hash not in _known_hashes(record):
        # Something changed the layout outside this module.  Respect it.
        _LOGGER.info(
            "Dashboard %s was edited by hand, leaving its layout alone", url_path
        )
        meta[dev_id] = {**record, "auto_update": False}
        try:
            from homeassistant.helpers.storage import Store  # noqa: PLC0415

            await Store(hass, 1, _META_KEY).async_save({"entries": meta})
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to record the edit for %s", url_path, exc_info=True)
        return None

    version = record.get("template_version")
    if isinstance(version, int) and version >= TEMPLATE_VERSION:
        return None

    _LOGGER.info(
        "Dashboard %s still uses template v%s, rebuilding it with v%s",
        url_path,
        version,
        TEMPLATE_VERSION,
    )
    return await async_create_device_dashboard(hass, dev_id, overwrite=True)


async def async_create_device_dashboard(
    hass: HomeAssistant,
    dev_id: str,
    *,
    overwrite: bool = False,
) -> str:
    """Create the dashboard for ``dev_id`` and return what was done.

    ``overwrite=False`` leaves an existing dashboard untouched, so a user's own
    edits survive every restart.  Passing ``overwrite=True`` (the service, the
    options flow) rebuilds the bundled layout from scratch.
    """
    url_path = dashboard_url_path(dev_id)
    title = dashboard_title(dev_id)

    dashboards = _dashboards(hass)
    if dashboards is None:
        _LOGGER.warning(
            "Lovelace is not set up, skipping the dashboard for %s", dev_id
        )
        return RESULT_UNAVAILABLE

    existed = url_path in dashboards
    current = dashboards.get(url_path) if existed else None

    # A dashboard entry can exist and still be empty: the sidebar item is
    # created first, and the config write is a separate step that may not have
    # happened (an interrupted setup, or an entry made before this integration
    # wrote a dashboard at all).  Treating that as "exists" left the user with a
    # blank page and no way to tell why, so an empty config is filled in.
    if existed and not overwrite:
        if await _async_has_config(hass, current, url_path):
            return RESULT_EXISTS
        _LOGGER.info(
            "Dashboard %s exists but has no config, writing the bundled layout",
            url_path,
        )

    if not await _async_ensure_entry(hass, url_path, title):
        return RESULT_UNAVAILABLE

    dashboard = (_dashboards(hass) or {}).get(url_path)
    if dashboard is None:
        # The registry has the item but this release did not hand out a config
        # object for it.  The file below is what Lovelace reads at startup, so
        # writing it still leaves a working dashboard instead of a blank page.
        _LOGGER.debug(
            "Dashboard %s has no config object, writing the file directly", url_path
        )

    config = build_dashboard_config(dev_id)
    if dashboard is not None:
        try:
            await dashboard.async_save(config)
        except Exception:  # noqa: BLE001 - e.g. a YAML mode dashboard
            _LOGGER.warning(
                "Lovelace rejected the dashboard %s", url_path, exc_info=True
            )

    if not await _async_write_config(hass, dashboard, url_path, config):
        return RESULT_UNAVAILABLE

    # ``async_save`` updates the in-memory copy only when it got that far, and a
    # freshly created storage dashboard starts out with nothing loaded.  A
    # ``force=True`` load re-reads the file written above, so the copy the
    # frontend is served matches the disk from the very first request.  Without
    # this, a dashboard created while Home Assistant is running could show the
    # \"add card\" placeholder until the next restart, even though the config was
    # already on disk.
    if dashboard is not None:
        try:
            await dashboard.async_load(force=True)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - the file is the source of truth
            _LOGGER.debug("Unable to reload %s after writing", url_path, exc_info=True)

    # Record what was generated, so a later template change can tell an untouched
    # dashboard from one the user has made their own.
    await _async_record_template(hass, dev_id, config, auto_update=True)

    _LOGGER.info(
        "%s dashboard %s for %s",
        "Updated" if existed else "Created",
        url_path,
        dev_id,
    )
    return RESULT_UPDATED if existed else RESULT_CREATED


def device_dashboard_exists(hass: HomeAssistant, dev_id: str) -> bool:
    """Return whether the device already has a dashboard."""
    dashboards = _dashboards(hass) or {}
    return dashboard_url_path(dev_id) in dashboards


__all__ = [
    "RESULT_CREATED",
    "RESULT_EXISTS",
    "RESULT_UNAVAILABLE",
    "RESULT_UPDATED",
    "TEMPLATE_VERSION",
    "async_create_device_dashboard",
    "async_upgrade_dashboard_template",
    "build_dashboard_config",
    "dashboard_title",
    "dashboard_url_path",
    "device_dashboard_exists",
    "serial_of",
]
