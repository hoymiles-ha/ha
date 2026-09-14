"""Options flow: a native TOU (time-of-use) configuration wizard.

The bundled Lovelace card is the recommended UI, but this wizard lets users
configure the plan from *Settings → Devices & Services → Configure* without any
custom frontend resource.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from . import mqtt_util
from .const import (
    CONF_DEV_ID,
    EMS_MODES,
    T_EMS_MODE_CMD,
    T_REBOOT,
    T_TOU_DAY_SET,
    T_TOU_GET,
    T_TOU_STATUS,
    T_TOU_WEEK_SET,
    TOU_DAY_IDX_MAX,
    TOU_PLAN_MAX,
    TOU_SOC_MAX,
    TOU_SOC_MIN,
    TOU_TS_MAX,
    TOU_WEEKDAYS,
)

_LOGGER = logging.getLogger(__name__)

MODE_OPTIONS = [
    {"value": "1", "label": "1 - Force charge (强制充电)"},
    {"value": "2", "label": "2 - PV charge (光伏充电)"},
    {"value": "4", "label": "4 - Discharge (放电)"},
]

WEEK_OPTIONS = [
    {"value": "none", "label": "— none (不安排)"},
    *[
        {"value": f"day{idx}", "label": f"day{idx}"}
        for idx in range(1, TOU_DAY_IDX_MAX + 1)
    ],
]


def _num(min_v: float, max_v: float) -> NumberSelector:
    return NumberSelector(
        NumberSelectorConfig(
            min=min_v, max=max_v, step=1, mode=NumberSelectorMode.BOX
        )
    )


class HoymilesOptionsFlow(OptionsFlow):
    """TOU configuration wizard."""

    def __init__(self) -> None:
        self._day_idx: int = 1
        self._seg_count: int = 0
        self._segments: list[dict[str, int]] = []
        self._cursor: int = 0

    @property
    def _dev_id(self) -> str:
        return str(self.config_entry.data[CONF_DEV_ID])

    # ------------------------------------------------------------------
    # menu
    # ------------------------------------------------------------------
    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        return self.async_show_menu(
            step_id="init",
            menu_options=["day_plan", "week_plan", "get_plan", "set_mode", "reboot"],
        )

    # ------------------------------------------------------------------
    # day plan
    # ------------------------------------------------------------------
    async def async_step_day_plan(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            self._day_idx = int(user_input["day_idx"])
            self._seg_count = int(user_input["segments"])
            self._segments = []
            self._cursor = 0
            return await self.async_step_day_segment()

        return self.async_show_form(
            step_id="day_plan",
            data_schema=vol.Schema(
                {
                    vol.Required("day_idx", default=1): _num(1, TOU_DAY_IDX_MAX),
                    vol.Required("segments", default=2): _num(1, TOU_PLAN_MAX),
                }
            ),
        )

    async def async_step_day_segment(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            self._segments.append(
                {
                    "mode": int(user_input["mode"]),
                    "ts": int(user_input["ts"]),
                    "te": int(user_input["te"]),
                    "sh": int(user_input["sh"]),
                    "sl": int(user_input["sl"]),
                    "pc": int(user_input["pc"]),
                    "pd": int(user_input["pd"]),
                }
            )
            self._cursor += 1
            if self._cursor >= self._seg_count:
                payload = {
                    "day_idx": self._day_idx,
                    "day_plan": self._segments,
                }
                await mqtt_util.async_publish(
                    self.hass, mqtt_util.topic(T_TOU_DAY_SET, self._dev_id), payload
                )
                _LOGGER.debug("Published day plan for day_idx=%s", self._day_idx)
                return self.async_create_entry(title="", data={})
            return await self.async_step_day_segment()

        return self.async_show_form(
            step_id="day_segment",
            data_schema=vol.Schema(
                {
                    vol.Required("mode", default="1"): SelectSelector(
                        SelectSelectorConfig(
                            options=MODE_OPTIONS, mode=SelectSelectorMode.DROPDOWN
                        )
                    ),
                    vol.Required("ts", default=0): _num(0, TOU_TS_MAX),
                    vol.Required("te", default=96): _num(0, TOU_TS_MAX),
                    vol.Required("sh", default=55): _num(TOU_SOC_MIN, TOU_SOC_MAX),
                    vol.Required("sl", default=10): _num(TOU_SOC_MIN, TOU_SOC_MAX),
                    vol.Required("pc", default=1000): _num(100, 100000),
                    vol.Required("pd", default=1000): _num(100, 100000),
                }
            ),
            description_placeholders={
                "index": str(self._cursor + 1),
                "total": str(self._seg_count),
                "day": f"day{self._day_idx}",
            },
        )

    # ------------------------------------------------------------------
    # week plan
    # ------------------------------------------------------------------
    async def async_step_week_plan(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            groups: dict[str, list[str]] = {}
            for day in TOU_WEEKDAYS:
                value = str(user_input.get(day.lower(), "none"))
                if value == "none":
                    continue
                day_idx = int(value.replace("day", ""))
                groups.setdefault(str(day_idx), []).append(day)

            week_plan = [
                {"week": days, "day_idx": int(idx)}
                for idx, days in groups.items()
            ]
            if not week_plan:
                return self.async_abort(reason="empty_week_plan")

            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_TOU_WEEK_SET, self._dev_id),
                {"week_plan": week_plan},
            )
            _LOGGER.debug("Published week plan: %s", week_plan)
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="week_plan",
            data_schema=vol.Schema(
                {
                    vol.Required(day.lower(), default="none"): SelectSelector(
                        SelectSelectorConfig(
                            options=WEEK_OPTIONS, mode=SelectSelectorMode.DROPDOWN
                        )
                    )
                    for day in TOU_WEEKDAYS
                }
            ),
        )

    # ------------------------------------------------------------------
    # get plan
    # ------------------------------------------------------------------
    async def async_step_get_plan(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            week = str(user_input["week"])
            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_TOU_GET, self._dev_id),
                {"week": week},
            )
            status = await mqtt_util.async_wait_for_message(
                self.hass, mqtt_util.topic(T_TOU_STATUS, self._dev_id), timeout=5.0
            )
            message = "timeout"
            if status is not None:
                code = status.get("status")
                message = status.get("err_msg", "unknown")
                if code == 0:
                    self.hass.async_create_task(
                        self.hass.services.async_call(
                            "persistent_notification",
                            "create",
                            {
                                "title": f"TOU plan · {week}",
                                "message": (
                                    f"day_idx={status.get('day_idx')}\n"
                                    f"```json\n{status.get('day_plan')}\n```"
                                ),
                            },
                        )
                    )
                    return self.async_create_entry(title="", data={})

            return self.async_abort(reason="get_plan_failed")

        return self.async_show_form(
            step_id="get_plan",
            data_schema=vol.Schema(
                {
                    vol.Required("week", default="Mon"): SelectSelector(
                        SelectSelectorConfig(
                            options=TOU_WEEKDAYS, mode=SelectSelectorMode.DROPDOWN
                        )
                    )
                }
            ),
        )

    # ------------------------------------------------------------------
    # ems mode
    # ------------------------------------------------------------------
    async def async_step_set_mode(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_EMS_MODE_CMD, self._dev_id),
                str(user_input["mode"]),
            )
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="set_mode",
            data_schema=vol.Schema(
                {
                    vol.Required("mode", default=EMS_MODES[2]): SelectSelector(
                        SelectSelectorConfig(
                            options=EMS_MODES, mode=SelectSelectorMode.DROPDOWN
                        )
                    )
                }
            ),
        )

    # ------------------------------------------------------------------
    # reboot
    # ------------------------------------------------------------------
    async def async_step_reboot(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            await mqtt_util.async_publish(
                self.hass, mqtt_util.topic(T_REBOOT, self._dev_id), "RESTART"
            )
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="reboot",
            data_schema=vol.Schema(
                {vol.Required("confirm", default=False): cv.boolean}
            ),
        )
