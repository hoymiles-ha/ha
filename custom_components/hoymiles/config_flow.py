"""Config flow for the Hoymiles Micro Storage integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from . import mqtt_util
from .const import CONF_DEV_ID, DOMAIN, NAME

_LOGGER = logging.getLogger(__name__)


class HoymilesConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for a Hoymiles micro storage device."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered: list[str] = []

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> Any:
        """Return the TOU configuration wizard."""
        from .options_flow import HoymilesOptionsFlow  # noqa: PLC0415

        return HoymilesOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> Any:
        """Ask for the device id (discovered values are offered as options)."""
        errors: dict[str, str] = {}

        if user_input is not None:
            dev_id = str(user_input[CONF_DEV_ID]).strip()
            if not dev_id:
                errors["base"] = "dev_id_required"
            else:
                await self.async_set_unique_id(dev_id)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=dev_id, data={CONF_DEV_ID: dev_id}
                )

        if not self._discovered:
            self._discovered = await mqtt_util.async_discover_dev_ids(self.hass)
            _LOGGER.debug("Discovered Hoymiles devices: %s", self._discovered)

        configured = {
            entry.data.get(CONF_DEV_ID)
            for entry in self._async_current_entries()
        }
        options = [dev for dev in self._discovered if dev not in configured]

        schema = vol.Schema(
            {
                vol.Required(CONF_DEV_ID): SelectSelector(
                    SelectSelectorConfig(
                        options=options,
                        custom_value=True,
                        mode=SelectSelectorMode.DROPDOWN,
                    )
                )
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
            description_placeholders={
                "name": NAME,
                "count": str(len(options)),
            },
        )
