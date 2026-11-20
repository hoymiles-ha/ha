/**
 * The region (time zone) switch.
 *
 * One `<select>` in the Home Assistant toolbar, sitting immediately to the right
 * of the language switch, that decides which calendar day this integration calls
 * "today".
 *
 * Why it has to live in the toolbar and reach the *backend*:
 *
 * A HiFlow keeps its own date.  It rolls `pvs[].ed` over at its midnight, and the
 * integration has to know whether an outage crossed that midnight before it can
 * decide whether yesterday's total is still being reported.  That is a
 * server-side decision, so the choice cannot live in `localStorage` the way the
 * language does - it is stored once per config entry, in its **options**, and
 * written through the `hoymiles.set_region` service.  Which also means the
 * dropdown has to *read* its current value back from the backend instead of from
 * storage, and that is what `get_region` is for.
 *
 * The switch is deliberately global rather than per device: the panels are
 * dashboards, not device pages, and one roof has one time zone.  Setting it
 * writes every micro-inverter entry at once (a `dev_id` may still be passed to
 * the service to target one device, which is what the options flow does).
 *
 * The toolbar is Home Assistant's own element, several shadow roots away from
 * anything a card may touch, so this file reaches into it by hand:
 *
 *   home-assistant > home-assistant-main > ha-panel-lovelace > hui-root
 *     .header .toolbar .action-items
 *
 * Lit re-renders that row whenever the view changes, so the switch is
 * re-inserted from a `MutationObserver` and from Home Assistant's
 * `location-changed` event rather than being placed once.
 */

(() => {
  const SELECT_CLASS = "hm-region-switch";
  const STYLE_ID = "hm-region-switch-style";
  /* Either language switch: the storage package's own (``hm-lang-switch``) or the
     one this subpackage ships when only micro inverters are configured
     (``hm-g2-lang-switch``).  The region control belongs on their right, and the
     two settings are separate controls - language is a per-browser reading
     preference, the region is a per-device fact. */
  const LANG_SELECT_CLASSES = ["hm-lang-switch", "hm-g2-lang-switch"];
  /* The language switch fires this; the two belong side by side, so a newly
     placed language select means the region one may have been wiped too. */
  const LANG_EVENT = "hoymiles-language";

  /** The value used for "follow Home Assistant" - `""` in the entry options. */
  const FOLLOW = "";

  /* ------------------------------------------------------------------ *
   * Talking to the backend
   * ------------------------------------------------------------------ */

  /**
   * Ask the integration for the current region, the shortlist and HA's own zone.
   *
   * A raw websocket `call_service` rather than `hass.callService`: the response
   * form of that helper has changed signature several times, while the
   * `return_response` flag on the websocket command has been stable, and this
   * file has to keep working across the range of versions the integration
   * supports.
   */
  async function fetchRegion(hass) {
    if (!hass || typeof hass.callWS !== "function") return null;
    try {
      const reply = await hass.callWS({
        type: "call_service",
        domain: "hoymiles",
        service: "get_region",
        service_data: {},
        return_response: true,
      });
      const data = reply && reply.response;
      return data && typeof data === "object" ? data : null;
    } catch (err) {
      /* No inverter configured, integration not loaded yet, or a version without
         the service: the switch simply does not appear. */
      return null;
    }
  }

  /** Write the choice. An empty value means "follow Home Assistant". */
  async function pushRegion(hass, value) {
    try {
      await hass.callService("hoymiles", "set_region", { region: value || FOLLOW });
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * The shared region protocol, for the cards
   * ------------------------------------------------------------------ */

  /**
   * The zone every card should format times in, cached process-wide.
   *
   * A card cannot reasonably call `get_region` itself: the history chart formats
   * a few hundred labels per redraw, and an await per label is not an option.
   * So this module publishes the answer into one variable and every card reads
   * it synchronously through `window.HoymilesG2Region`.
   *
   * It holds the **effective** zone, not the raw selection.  "Follow Home
   * Assistant" means the *server* uses HA's `time_zone`, and the cards have to
   * agree with it - otherwise a card on a laptop whose browser is set to another
   * zone would draw its day boundaries against a different midnight than the
   * one the coordinator used to decide 今日发电 was stale.  So an empty selection
   * is resolved to HA's own zone here.
   *
   * `""` is only left in place when nothing has answered yet (or the names are
   * unusable), and then `partsIn` falls back to the browser, like HA's own cards.
   */
  let regionZone = "";

  /**
   * Format one instant in the chosen region.
   *
   * `Intl` rather than manual offset arithmetic: a region is a rule (daylight
   * saving, historical changes), and the browser already knows the rule.  The
   * cost is that only the named fields can be read back out, which is why this
   * returns a plain object of numbers.
   */
  function partsIn(date, zone) {
    const when = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(when.getTime())) return null;
    if (!zone) {
      return {
        year: when.getFullYear(),
        month: when.getMonth() + 1,
        day: when.getDate(),
        hour: when.getHours(),
        minute: when.getMinutes(),
        second: when.getSeconds(),
        weekday: when.getDay(),
      };
    }
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      });
    } catch (err) {
      /* An unknown zone name must not blank the chart; fall back to local. */
      return partsIn(when, "");
    }
    const out = {};
    for (const part of fmt.formatToParts(when)) {
      out[part.type] = part.value;
    }
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(out.weekday);
    return {
      year: Number(out.year),
      month: Number(out.month),
      day: Number(out.day),
      /* `hour12: false` renders midnight as 24 in some engines. */
      hour: Number(out.hour) % 24,
      minute: Number(out.minute),
      second: Number(out.second),
      weekday: weekday < 0 ? 0 : weekday,
    };
  }

  /**
   * How far the region is from UTC at one instant, in milliseconds.
   *
   * Derived by formatting *the same instant* twice and reading the wall clock the
   * region shows: the difference between that wall clock (pretended to be UTC)
   * and the instant itself is exactly the offset, daylight saving included.
   */
  function offsetIn(date, zone) {
    const when = date instanceof Date ? date : new Date(date);
    const parts = partsIn(when, zone);
    if (!parts) return 0;
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    /* Milliseconds are dropped by the formatter; add them back so the offset is
       a whole number of seconds. */
    return asUtc - (when.getTime() - when.getMilliseconds());
  }

  /** The instant the chosen region's day containing `date` starts. */
  function startOfDayIn(date, zone) {
    const when = date instanceof Date ? date : new Date(date);
    const parts = partsIn(when, zone);
    if (!parts) return startOfDayIn(when, "");
    const midnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    /* Two passes: the offset at midnight can differ from the offset now (a
       daylight-saving night), so re-evaluate it at the answer. */
    let offset = offsetIn(when, zone);
    let guess = midnightAsUtc - offset;
    offset = offsetIn(new Date(guess), zone);
    guess = midnightAsUtc - offset;
    return new Date(guess);
  }

  /** The instant the chosen region's day containing `date` ends (last ms). */
  function endOfDayIn(date, zone) {
    const start = startOfDayIn(date, zone);
    /* Not `start + 24h`: a daylight-saving day is 23 or 25 hours long. */
    const nextNoon = new Date(start.getTime() + 36 * 3600 * 1000);
    const nextStart = startOfDayIn(nextNoon, zone);
    return new Date(nextStart.getTime() - 1);
  }

  /** `HH:MM` in the region, for axis labels. */
  function timeLabel(date, zone) {
    const parts = partsIn(date, zone);
    if (!parts) return "";
    return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  }

  /**
   * Publish the shared API.
   *
   * Loaded from `const.FRONTEND_ASSETS` immediately after the i18n module, so the
   * cards can rely on it being defined by the time they evaluate.
   */
  const listeners = new Set();

  window.HoymilesG2Region = {
    /**
     * The effective zone the cards should format in - HA's own zone when the
     * device is set to follow it - or `""` while nothing has answered yet.
     */
    zone() {
      return regionZone;
    },
    /** Adopt a zone (the switch calls this before announcing it). */
    set(zone) {
      const next = typeof zone === "string" ? zone : "";
      if (next === regionZone) return;
      regionZone = next;
      for (const fn of listeners) {
        try {
          fn(regionZone);
        } catch (err) {
          /* one bad listener must not stop the others */
        }
      }
    },
    /** Be told when the zone changes. Returns an unsubscribe function. */
    watch(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    partsIn,
    offsetIn,
    startOfDayIn,
    endOfDayIn,
    timeLabel,
  };

  /* ------------------------------------------------------------------ *
   * The switch itself
   * ------------------------------------------------------------------ *
   */
  /** The label for one choice, in the current card language. */
  function labelOf(choice, lang, haZone) {
    if (!choice.value) {
      const suffix = haZone ? ` (${haZone})` : "";
      return lang === "zh" ? `跟随 Home Assistant${suffix}` : `Follow Home Assistant${suffix}`;
    }
    return lang === "zh" ? choice.label_zh || choice.value : choice.label_en || choice.value;
  }

  /** Current card language, resolved the same way the cards resolve it. */
  function currentLang(hass) {
    const api = window.HoymilesG2I18n;
    if (api && typeof api.lang === "function") {
      try {
        return api.lang(hass, null) || "en";
      } catch (err) {
        /* fall through to the storage default */
      }
    }
    return "en";
  }

  /**
   * Build the `<select>`.
   *
   * The options are re-read from the backend whenever it opens or the region
   * changes elsewhere, because the list is owned by `const.REGION_CHOICES` on
   * the server - hard-coding it here would mean two copies drifting apart.
   */
  function buildSelect(hass, info) {
    const lang = () => currentLang(hass);
    const select = document.createElement("select");
    select.className = SELECT_CLASS;
    select.setAttribute("aria-label", "Region");
    /* Not "language / time zone": the two are separate controls now, and a
       tooltip that names both would suggest this dropdown changes labels. */
    select.title = lang() === "zh" ? "地区（时区）" : "Region (time zone)";

    const rebuild = (data) => {
      const choices = (data && data.choices) || [];
      const haZone = (data && data.ha_zone) || (hass.config ? hass.config.time_zone : "");
      const chosen = data ? data.region || FOLLOW : FOLLOW;
      const language = lang();

      select.replaceChildren();
      const follow = document.createElement("option");
      follow.value = FOLLOW;
      follow.textContent = labelOf({ value: FOLLOW }, language, haZone);
      select.append(follow);

      let known = false;
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = labelOf(choice, language, haZone);
        if (choice.value === chosen) known = true;
        select.append(option);
      }
      /* A stored zone outside the shortlist - typed in the options flow, say -
         must still be selectable, or opening this page would silently drop it. */
      if (chosen && !known) {
        const option = document.createElement("option");
        option.value = chosen;
        option.textContent = chosen;
        select.append(option);
      }
      select.value = chosen;
      /* Every card formats its times through this, so it has to track whatever
         the server just told us - including on the very first render, which is
         what makes a reload already show the right zone.  An empty choice means
         "follow Home Assistant", which for the cards is HA's own zone. */
      window.HoymilesG2Region.set(chosen || haZone || "");
    };

    /* Keep the raw reply so the options can be re-rendered in a new language
       without asking the server again. */
    select.__hmRebuild = (data) => {
      select.__hmChoices = (data && data.choices) || [];
      select.__hmZone = (data && data.ha_zone) || "";
      rebuild(data);
    };

    select.__hmRebuild(info);

    select.addEventListener("change", async () => {
      select.disabled = true;
      const ok = await pushRegion(hass, select.value);
      select.disabled = false;
      if (!ok) {
        /* Put the switch back where the server still thinks it is, so a rejected
           value does not look applied. */
        const fresh = await fetchRegion(hass);
        if (fresh) select.__hmRebuild(fresh);
        return;
      }
      /* The region now decides where "today" starts, and the pending midnight
         timer was armed for the old zone - the backend re-arms it, but every card
         showing a time needs to redraw as well.  The cards listen for this. */
      window.HoymilesG2Region.set(select.value || select.__hmZone || "");
      window.dispatchEvent(
        new CustomEvent("hoymiles-region", { detail: select.value || FOLLOW }),
      );
    });

    /* The language switch changes labels without touching the region, so the
       options have to be re-rendered in the new language. */
    const onLang = () => {
      if (!select.isConnected) {
        window.removeEventListener(LANG_EVENT, onLang);
        return;
      }
      select.__hmRebuild({
        choices: select.__hmChoices || [],
        ha_zone: select.__hmZone || "",
        region: select.value,
      });
    };
    window.addEventListener(LANG_EVENT, onLang);

    /* Refresh once the element is in the document: the dashboard may have
       rendered before the integration answered. */
    fetchRegion(hass).then((data) => {
      if (data && select.isConnected) select.__hmRebuild(data);
    });

    return select;
  }

  /** The styles live in the toolbar's shadow root, scoped to our class. */
  function ensureStyle(shadow) {
    if (shadow.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${SELECT_CLASS} {
        font: inherit;
        font-size: 13px;
        line-height: 1.2;
        margin-inline-end: 2px;
        padding: 3px 2px;
        max-width: 132px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--app-header-text-color, var(--primary-text-color));
        cursor: pointer;
      }
      .${SELECT_CLASS}:hover {
        background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
      }
      .${SELECT_CLASS}:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 1px;
      }
    `;
    shadow.append(style);
  }

  /** The row of toolbar buttons, or `null` while no Lovelace view is showing. */
  function findActionItems() {
    const app = document.querySelector("home-assistant");
    const main = app && app.shadowRoot && app.shadowRoot.querySelector("home-assistant-main");
    const panel = main && main.shadowRoot
      && main.shadowRoot.querySelector("ha-panel-lovelace");
    const hui = panel && panel.shadowRoot && panel.shadowRoot.querySelector("hui-root");
    const shadow = hui && hui.shadowRoot;
    if (!shadow) return null;
    const items = shadow.querySelector(".header .toolbar .action-items");
    return items ? { shadow, items, hass: app.hass } : null;
  }

  /** The language control currently in the toolbar, if any. */
  function findLangSelect(items) {
    for (const cls of LANG_SELECT_CLASSES) {
      const found = items.querySelector(`.${cls}`);
      if (found) return found;
    }
    return null;
  }

  /** Put the switch in the toolbar. Idempotent: safe to call as often as we like. */
  function place() {
    const found = findActionItems();
    if (!found || !found.hass) return false;
    ensureStyle(found.shadow);
    if (found.items.querySelector(`.${SELECT_CLASS}`)) return true;

    const select = buildSelect(found.hass, null);

    /* Immediately right of the language switch when that is present; otherwise
       at the left edge, which is where the language switch would have gone. */
    const langSelect = findLangSelect(found.items);
    if (langSelect && langSelect.nextSibling) {
      found.items.insertBefore(select, langSelect.nextSibling);
    } else if (langSelect) {
      found.items.append(select);
    } else {
      found.items.prepend(select);
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Keeping it there
   * ------------------------------------------------------------------ */

  const hooked = new WeakSet();
  let queued = false;
  let retryTimer = 0;

  /** Coalesce a burst of mutations into one placement per frame. */
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place();
    });
  }

  /** Watch one shadow root. Re-observing the same root is a no-op. */
  function hook(root) {
    if (!root || hooked.has(root)) return;
    hooked.add(root);
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  }

  function hookKnownRoots() {
    const app = document.querySelector("home-assistant");
    hook(app && app.shadowRoot);
    const main = app && app.shadowRoot && app.shadowRoot.querySelector("home-assistant-main");
    hook(main && main.shadowRoot);
    const panel = main && main.shadowRoot
      && main.shadowRoot.querySelector("ha-panel-lovelace");
    hook(panel && panel.shadowRoot);
    const hui = panel && panel.shadowRoot && panel.shadowRoot.querySelector("hui-root");
    hook(hui && hui.shadowRoot);
  }

  /**
   * Place the switch, and keep trying for a while if the frontend is not ready.
   *
   * This module is loaded from `index.html` and runs before Home Assistant has
   * built its interface - the element chain simply is not there yet on a cold
   * load, and the delay is not fixed (a slow start on a Raspberry Pi takes
   * seconds).  Retrying beats a fixed `setTimeout`: it also covers the moment a
   * panel is swapped while the tab was in the background.
   */
  function retry() {
    if (retryTimer) return; // a run is already in flight
    let tries = 0;
    const step = () => {
      retryTimer = 0;
      /* Both jobs, on the same schedule: the card may render before `hui-root`
         exists, and it needs the zone either way. */
      if (place() && bootZone()) return;
      tries += 1;
      if (tries >= 240) return; // give up after a minute; navigations re-arm
      retryTimer = setTimeout(step, 250);
    };
    step();
  }

  /**
   * Read the region once, independently of the switch.
   *
   * The cards format times through `window.HoymilesG2Region`, and they must be
   * right even on a page where the toolbar switch could not be placed - a
   * sub-view, another panel, or a moment during start-up when `hui-root` does
   * not exist yet.  So this asks the backend directly and publishes the answer,
   * rather than waiting for the dropdown to do it.
   */
  function bootZone() {
    const app = document.querySelector("home-assistant");
    const hass = app && app.hass;
    if (!hass) return false;
    if (regionZone) return true;
    fetchRegion(hass).then((data) => {
      if (data) window.HoymilesG2Region.set(data.region || data.ha_zone || "");
    });
    return true;
  }

  function boot() {
    hookKnownRoots();
    retry();
    bootZone();

    /* Navigating between dashboards (or into another panel and back) rebuilds
       hui-root; the observers catch most of it, this catches the rest. */
    window.addEventListener("location-changed", () => {
      hookKnownRoots();
      retry();
    });
    window.addEventListener("popstate", () => {
      hookKnownRoots();
      retry();
    });

    /* The language switch places itself on its own schedule; whenever it
       (re)appears, make sure the region switch is on its right. */
    window.addEventListener(LANG_EVENT, () => {
      hookKnownRoots();
      retry();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
