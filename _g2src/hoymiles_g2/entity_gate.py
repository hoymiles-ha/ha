"""Create entities that only a later MQTT message justifies.

Every platform decides which entities to create during ``async_setup_entry``,
which on this integration happens before the device has necessarily said
anything: the capability set is built from retained MQTT payloads, and a device
that was offline (or connected over MQTTS, which publishes a strictly smaller
topic set) may have only part of them.

Refusing to create anything at that moment would leave a real device without
entities until the next restart, so the platforms hand the "what is justified
*now*" question to :func:`async_add_gated_entities` once and it is asked again
whenever the capability set grows.

The other half is removal.  A device publishes **all** of its topics in one
burst when it connects, so the set it announced *is* the feature set it has.
Right after that burst has settled, the entities the device never justified are
dropped.  This happens once per connection - not on a repeating timer, and not
only once per Home Assistant process.  A device that reconnects with fewer
topics (which is exactly what a unit linking over MQTTS does) loses the entities
those topics used to justify.

Anything that arrives during a connection is purely additive, which is what
"show whatever the device publishes" means in practice.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Iterable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import HoymilesCoordinator

_LOGGER = logging.getLogger(__name__)

# How long to let the device finish announcing its topic set before entries are
# reconciled, and how long to let the entity registry settle before anything is
# removed: ``async_add_entities`` returns before the entities are registered, so
# a removal issued in the same tick races the add that is still in flight and
# loses.  A device publishes everything within a second or two of connecting,
# but some topics (``system/state``, the TOU acks) are periodic rather than
# immediate, so the window is deliberately generous - removing an entity because
# its topic was merely slow would also destroy its long-term statistics, while
# keeping a wrong one for another minute costs nothing.
SETTLE_SECONDS: float = 60.0

# Returns every entity the *current* capability set justifies.  Called again on
# each capability change, so it must be free of side effects.
EntityFactory = Callable[[], Iterable[Entity]]

# Returns the entity key suffixes (``{DOMAIN}_{dev_id}_{key}``) this device does
# *not* justify any more.  Only consulted once the device has announced itself.
StaleKeys = Callable[[], set[str]]


@callback
def async_add_gated_entities(
    coordinator: HoymilesCoordinator,
    async_add_entities: AddEntitiesCallback,
    build: EntityFactory,
    entry: ConfigEntry,
    *,
    hass: HomeAssistant | None = None,
    domain: str | None = None,
    stale: StaleKeys | None = None,
) -> None:
    """Add the entities the current capabilities justify, then keep watching.

    ``build`` takes no arguments and reads the coordinator itself.  An entity
    whose ``unique_id`` has already been handed over is skipped, which is what
    lets ``build`` stay a plain comprehension over the description table - the
    ones that are still unjustified simply are not returned.

    Nothing is recomputed while the capability set is unchanged: this
    integration's coordinator fires on every 1 s ``quick/state``, and building
    (then discarding) a few dozen entity objects once a second is not free.

    Pass ``hass``, ``domain`` and ``stale`` to also remove registry entries the
    device never announced.  That reconciliation runs **once per connection**:
    the device re-publishes its whole topic set every time it links up, so each
    reconnect is a fresh statement of what it supports and deserves exactly one
    check.  ``coordinator.session`` increments on a proven offline -> online
    transition, which is what "a new connection" means here.

    There is deliberately no repeating timer: capabilities only ever change on a
    connection boundary, and rescanning the registry every few seconds would cost
    CPU forever to find nothing.
    """
    # unique_id -> the live entity, so a stale one can be taken out of the state
    # machine properly (deleting the registry entry alone would leave an orphan)
    # and re-added later if the device publishes its topic again.
    live: dict[str, Entity] = {}
    last: list[frozenset[str] | None] = [None]
    # The connection whose registry state has already been reconciled.  0 means
    # "never", which is impossible for a real session (it starts at 1) and so
    # guarantees the first pass runs.
    reconciled: list[int] = [0]

    @callback
    def _flush() -> None:
        capabilities = coordinator.capabilities
        changed = capabilities != last[0]
        last[0] = capabilities

        if changed:
            fresh: list[Entity] = []
            for entity in build():
                try:
                    unique_id = entity.unique_id
                except Exception:  # noqa: BLE001 - an unnamed entity is a bug, not a crash
                    unique_id = None
                if not unique_id or unique_id in live:
                    continue
                live[unique_id] = entity
                fresh.append(entity)

            if fresh:
                _LOGGER.debug(
                    "Hoymiles %s: adding %d entities after its capabilities changed",
                    coordinator.dev_id,
                    len(fresh),
                )
                async_add_entities(fresh)

        # Reconciliation is destructive, so it waits until the device has
        # actually announced something, and runs at most once per connection.
        if (
            hass is None
            or domain is None
            or stale is None
            or reconciled[0] == coordinator.session
            or not coordinator.capabilities_known
        ):
            return
        reconciled[0] = coordinator.session
        hass.async_create_task(
            _async_reconcile(
                hass, coordinator, domain, stale, live, coordinator.session
            ),
            f"{DOMAIN} reconcile {domain} entities for {coordinator.dev_id}",
        )

    _flush()
    entry.async_on_unload(coordinator.async_add_listener(_flush))


async def _async_reconcile(
    hass: HomeAssistant,
    coordinator: HoymilesCoordinator,
    domain: str,
    stale: StaleKeys,
    live: dict[str, Entity],
    session: int,
) -> None:
    """Remove the entities this device no longer justifies, once per connection."""
    try:
        await asyncio.sleep(SETTLE_SECONDS)

        if coordinator.session != session:
            # The device reconnected while we waited.  That connection armed its
            # own pass with a newer topic set, so this one is working from stale
            # evidence and must not delete anything.
            _LOGGER.debug(
                "%s: skipping reconciliation, a newer connection took over", domain
            )
            return

        registry = er.async_get(hass)
        capabilities = coordinator.capabilities
        candidates = sorted(stale())
        removed = 0
        for key in candidates:
            unique_id = f"{DOMAIN}_{coordinator.dev_id}_{key}"
            if unique_id in live:
                # Justified after all - the capability arrived while we waited,
                # and ``build()`` already handed the entity over.
                continue
            entity_id = registry.async_get_entity_id(domain, DOMAIN, unique_id)
            if entity_id is None:
                continue
            _LOGGER.info(
                "Removing %s: this device does not publish the topic it needs",
                entity_id,
            )
            registry.async_remove(entity_id)
            live.pop(unique_id, None)
            removed += 1
        _LOGGER.info(
            "Reconciled %s %s (connection %d) against %d announced topics "
            "(%s): %d candidates, %d removed",
            domain,
            coordinator.dev_id,
            session,
            len(capabilities),
            ", ".join(sorted(capabilities)) or "none",
            len(candidates),
            removed,
        )
    except Exception:  # noqa: BLE001 - never break setup because of a registry
        _LOGGER.debug("Reconciling %s entities failed", domain, exc_info=True)
