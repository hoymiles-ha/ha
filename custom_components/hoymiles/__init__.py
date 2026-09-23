"""The Hoymiles Micro Storage integration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    CONF_DEV_ID,
    DOMAIN,
    FRONTEND_ASSETS,
    FRONTEND_URL,
    PLATFORMS,
)
from .coordinator import HoymilesCoordinator
from .discovery_override import FirmwareDiscoveryPatcher
from .services import async_setup_services

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Hoymiles Micro Storage from a config entry."""
    dev_id: str = entry.data[CONF_DEV_ID]

    coordinator = HoymilesCoordinator(hass, dev_id)
    await coordinator.async_setup()

    # Patch the firmware's retained discovery payloads so the entities it
    # registers itself comply with Home Assistant's per-domain schemas.  See
    # discovery_override.py for the list of patches; it is a no-op once the
    # firmware ships compliant payloads.
    patcher = FirmwareDiscoveryPatcher(hass, dev_id)
    await patcher.async_setup()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "coordinator": coordinator,
        "patcher": patcher,
        "dev_id": dev_id,
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    await _async_register_frontend(hass)
    await async_setup_services(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        entry_data = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if entry_data:
            entry_data["patcher"].async_shutdown()
            await entry_data["coordinator"].async_shutdown()
    return unloaded


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the bundled Lovelace cards and inject them as frontend modules.

    Every asset listed in ``const.FRONTEND_ASSETS`` is published under
    ``FRONTEND_URL`` and appended with ``add_extra_js_url``, so users never
    have to register the cards manually as Lovelace resources.

    The assets are served with ``Cache-Control: no-cache``: the browser may keep
    them, but it has to revalidate before every use.  Home Assistant's own static
    path helper is not usable here - it either promises a one month cache or
    sends no cache directive at all (``web.FileResponse`` only carries
    ``ETag``/``Last-Modified``), and with no directive a browser is free to reuse
    its copy without asking.  That is what made an updated card keep running the
    old code until the user cleared the cache by hand or restarted Home
    Assistant.  Revalidating costs a 304 when the file is unchanged, and the new
    body as soon as it is.  The ``?v=`` query string is kept as well: it is a
    second line of defence and makes the URL self-documenting.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_frontend_registered"):
        return

    www_dir = Path(__file__).parent / "www"
    assets: list[tuple[str, str, int]] = []
    for filename in FRONTEND_ASSETS:
        asset_path = www_dir / filename
        if not asset_path.is_file():
            _LOGGER.warning("Bundled frontend asset %s is missing, skipping", asset_path)
            continue
        assets.append((f"{FRONTEND_URL}/{filename}", str(asset_path), _asset_version(asset_path)))

    if not assets:
        _LOGGER.warning("No frontend assets found in %s, skipping frontend setup", www_dir)
        return

    http = getattr(hass, "http", None)
    if http is None:
        _LOGGER.debug("No HTTP component available, skipping static path registration")
        return

    if not _register_asset_routes(http, assets):
        # No aiohttp application to attach to (very old or unusual setup); fall
        # back to the helper, which at least serves the files.
        try:
            from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

            await http.async_register_static_paths(
                [StaticPathConfig(url, path, cache_headers=False) for url, path, _v in assets]
            )
        except ImportError:
            # Home Assistant < 2024.7
            for url, path, _v in assets:
                http.register_static_path(url, path, False)
        except Exception:  # noqa: BLE001 - never break setup because of the cards
            _LOGGER.warning("Unable to serve the Hoymiles frontend cards", exc_info=True)
            return

    try:
        from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415

        # The version is only used to bust the browser cache: the route matches
        # on the path and ignores the query string.
        for url, _path, version in assets:
            add_extra_js_url(hass, f"{url}?v={version}")
    except Exception:  # noqa: BLE001 - never break setup because of the card
        _LOGGER.warning("Unable to register the Hoymiles frontend cards", exc_info=True)
        return

    domain_data["_frontend_registered"] = True
    _LOGGER.debug("Registered frontend assets: %s", [url for url, _p, _v in assets])


def _register_asset_routes(http: Any, assets: list[tuple[str, str, int]]) -> bool:
    """Serve each asset with a revalidating cache directive.

    Returns False when there is no aiohttp router to register on, so the caller
    can fall back to Home Assistant's static path helper.
    """
    app = getattr(http, "app", None)
    router = getattr(app, "router", None)
    if router is None:
        return False

    try:
        from aiohttp import web  # noqa: PLC0415
        from aiohttp.hdrs import CACHE_CONTROL  # noqa: PLC0415
    except ImportError:  # pragma: no cover - aiohttp is always there in practice
        return False

    for url, path, _version in assets:

        async def _serve(_request, _path=path):
            return web.FileResponse(_path, headers={CACHE_CONTROL: "no-cache"})

        router.add_get(url, _serve)
    return True


def _asset_version(path: Path) -> int:
    """Return a cache-busting token for one bundled asset."""
    try:
        return int(path.stat().st_mtime)
    except OSError:  # pragma: no cover - unreadable file, not worth failing over
        return 0
