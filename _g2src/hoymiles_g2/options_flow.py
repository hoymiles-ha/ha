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
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from . import mqtt_util, region
from .const import (
    CONF_DEV_ID,
    CONF_REGION,
    DOMAIN,
    EMS_MODES,
    is_inverter_dev_id,
    REGION_CHOICES,
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
            menu_options=[
                "region",
                "charts",
                "day_plan",
                "week_plan",
                "get_plan",
                "set_mode",
                "reboot",
            ],
        )

    # ------------------------------------------------------------------
    # optional device charts
    # ------------------------------------------------------------------
    async def async_step_region(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Choose the time zone this device's day is measured in.

        Same option the toolbar switch writes, offered here as well because a
        wizard is the discoverable place for it and because the toolbar is not
        present on every dashboard.  ``custom_value`` is deliberate: the list is
        a shortlist of common markets, not an enumeration of the tz database, and
        a unit installed somewhere else must still be settable.
        """
        if user_input is not None:
            raw = user_input.get(CONF_REGION)
            wanted = raw.strip() if isinstance(raw, str) else ""
            if wanted and region.resolve(wanted) is None:
                return self.async_show_form(
                    step_id="region",
                    data_schema=self._region_schema(wanted),
                    errors={CONF_REGION: "invalid_region"},
                )

            entry = self.config_entry
            if region.zone_name(entry) != wanted:
                self.hass.config_entries.async_update_entry(
                    entry, options={**entry.options, CONF_REGION: wanted}
                )
                _LOGGER.info(
                    "Hoymiles %s: region changed to %s (options flow)",
                    self._dev_id,
                    wanted or "Home Assistant",
                )

            # The day may already have turned over in the new zone and the
            # midnight timer was armed for the old one.
            coordinator = self.hass.data.get(DOMAIN, {}).get(entry.entry_id, {})
            if isinstance(coordinator, dict):
                coord = coordinator.get("coordinator")
                if coord is not None and hasattr(coord, "async_apply_region"):
                    await coord.async_apply_region()
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="region",
            data_schema=self._region_schema(region.zone_name(self.config_entry)),
        )
    def _region_schema(self, current: str) -> vol.Schema:
        """The dropdown, with "follow Home Assistant" as the first choice."""
        options = [SelectOptionDict(value="", label="* 跟随 Home Assistant")]
        options.extend(
            SelectOptionDict(value=value, label=f"{label_en} / {label_zh}")
            for value, label_en, label_zh in REGION_CHOICES
        )
        # A stored zone outside the shortlist must still show up as the selected
        # value, otherwise opening the wizard would silently rewrite it to "".
        if current and all(opt["value"] != current for opt in options):
            options.append(SelectOptionDict(value=current, label=current))
        return vol.Schema(
            {
                vol.Optional(CONF_REGION, default=current): SelectSelector(
                    SelectSelectorConfig(
                        options=options,
                        mode=SelectSelectorMode.DROPDOWN,
                        custom_value=True,
                    )
                )
            }
        )

    async def async_step_charts(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Tick the extra Device-view curves the user wants to keep.

        The device page has drawn a fixed set of curves since the first release;
        ``device/state`` carries more readings than that, so each of the
        remaining ones can be added as a card of its own.  The dashboard is the
        source of truth - the checkboxes are preselected from the cards already
        stored, and a card that stays enabled keeps the instant it was enabled
        (see ``lovelace.OPTIONAL_CHARTS``), which is what makes its curve start
        at that moment instead of at the device's whole recorded history.
        """
        from . import lovelace  # noqa: PLC0415

        dev_id = self._dev_id
        if not is_inverter_dev_id(dev_id):
            # These are the ``grid_on_*`` readings of a micro inverter, and the
            # only layout they belong on is its Device view.
            return self.async_abort(reason="charts_unsupported")

        if user_input is not None:
            wanted = {
                key: bool(user_input.get(key)) for key in lovelace.OPTIONAL_CHARTS
            }
            if not await lovelace.async_set_optional_charts(self.hass, dev_id, wanted):
                return self.async_abort(reason="charts_not_saved")
            return self.async_create_entry(title="", data={})

        current = await lovelace.async_get_optional_charts(self.hass, dev_id)
        schema: dict[Any, Any] = {}
        for key in lovelace.OPTIONAL_CHARTS:
            schema[
                vol.Optional(key, default=key in current)
            ] = BooleanSelector()
        return self.async_show_form(step_id="charts", data_schema=vol.Schema(schema))

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
