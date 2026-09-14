"""The Hoymiles Micro Storage integration."""

from __future__ import annotations

import logging
from pathlib import Path

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
from .services import async_setup_services

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Hoymiles Micro Storage from a config entry."""
    dev_id: str = entry.data[CONF_DEV_ID]

    coordinator = HoymilesCoordinator(hass, dev_id)
    await coordinator.async_setup()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "coordinator": coordinator,
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
            await entry_data["coordinator"].async_shutdown()
    return unloaded


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the bundled Lovelace cards and inject them as frontend modules.

    Every asset listed in ``const.FRONTEND_ASSETS`` is published under
    ``FRONTEND_URL`` and appended with ``add_extra_js_url``, so users never
    have to register the cards manually as Lovelace resources.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_frontend_registered"):
        return

    www_dir = Path(__file__).parent / "www"
    assets: list[tuple[str, str]] = []
    for filename in FRONTEND_ASSETS:
        asset_path = www_dir / filename
        if not asset_path.is_file():
            _LOGGER.warning("Bundled frontend asset %s is missing, skipping", asset_path)
            continue
        assets.append((f"{FRONTEND_URL}/{filename}", str(asset_path)))

    if not assets:
        _LOGGER.warning("No frontend assets found in %s, skipping frontend setup", www_dir)
        return

    http = getattr(hass, "http", None)
    if http is None:
        _LOGGER.debug("No HTTP component available, skipping static path registration")
        return

    try:
        from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

        await http.async_register_static_paths(
            [StaticPathConfig(url, path, cache_headers=False) for url, path in assets]
        )
    except ImportError:
        # Home Assistant < 2024.7
        for url, path in assets:
            http.register_static_path(url, path, False)

    try:
        from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415

        for url, _path in assets:
            add_extra_js_url(hass, url)
    except Exception:  # noqa: BLE001 - never break setup because of the card
        _LOGGER.warning("Unable to register the Hoymiles frontend cards", exc_info=True)
        return

    domain_data["_frontend_registered"] = True
    _LOGGER.debug("Registered frontend assets: %s", [url for url, _ in assets])
