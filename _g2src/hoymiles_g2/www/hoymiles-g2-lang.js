/**
 * The language switch of the micro-inverter dashboards.
 *
 * A second `<select>` in the Home Assistant toolbar, next to - and deliberately
 * *separate from* - the region switch in `hoymiles-g2-region.js`.
 *
 * Why a duplicate of the storage package's `hoymiles-lang.js`: that file is only
 * injected when a *storage* entry is set up, so on an installation that runs
 * micro inverters alone the toolbar got the region dropdown and nothing else,
 * which reads as one combined "language & time zone" control.  The two settings
 * also mean genuinely different things - the language is a per-browser reading
 * preference, the region is a per-device fact stored in the config entry - so
 * they should never share a widget.
 *
 * When the storage package *is* present its switch is reused instead of adding a
 * second identical control, and this module simply steps aside.
 *
 * The choice is not stored here: `window.HoymilesG2I18n` owns the
 * `localStorage` key and the `hoymiles-language` event, so this file only builds
 * the control and calls into that module.  See `hoymiles-g2-i18n.js`.
 */

(() => {
  const SELECT_CLASS = "hm-g2-lang-switch";
  /* The storage package's switch.  Present means the reader already has a
     language control, and two of them would just be confusing. */
  const FOREIGN_SELECT_CLASS = "hm-lang-switch";
  const STYLE_ID = "hm-g2-lang-switch-style";
  const LANG_EVENT = "hoymiles-language";

  /** The i18n module, or `null` while it has not been evaluated yet. */
  function i18n() {
    const api = window.HoymilesG2I18n;
    return api && typeof api.setLang === "function" ? api : null;
  }

  /** Current language, resolved exactly the way the cards resolve it. */
  function currentLang(hass) {
    const api = i18n();
    if (api && typeof api.lang === "function") {
      try {
        return api.lang(hass, null) || "en";
      } catch (err) {
        /* fall through to the storage default */
      }
    }
    return "en";
  }

  /** The `<select>`. Labels are the language's own name, so they never translate. */
  function buildSelect(hass) {
    const select = document.createElement("select");
    select.className = SELECT_CLASS;
    select.setAttribute("aria-label", "Language");
    select.title = "Language / 语言 / Sprache";

    const api = i18n();
    const choices = (api && api.LANG_CHOICES) || [["en", "English"]];
    for (const [code, label] of choices) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      select.append(option);
    }
    select.value = currentLang(hass);

    select.addEventListener("change", () => {
      const module = i18n();
      if (module) module.setLang(select.value);
    });

    /* A change made elsewhere - the storage switch, another tab, the console -
       has to move this control too.  The listener detaches itself once the
       element is gone, so re-renders cannot leak one per view. */
    const onLang = (event) => {
      if (!select.isConnected) {
        window.removeEventListener(LANG_EVENT, onLang);
        return;
      }
      const next = (event && event.detail) || currentLang(hass);
      if (next && select.value !== next) select.value = next;
    };
    window.addEventListener(LANG_EVENT, onLang);

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
        margin-inline: 2px;
        padding: 3px 2px;
        max-width: 104px;
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

  /** Put the switch in the toolbar. Idempotent: safe to call as often as we like. */
  function place() {
    const found = findActionItems();
    if (!found || !found.hass) return false;
    ensureStyle(found.shadow);

    const own = found.items.querySelector(`.${SELECT_CLASS}`);
    const foreign = found.items.querySelector(`.${FOREIGN_SELECT_CLASS}`);

    /* The storage package's own language control takes precedence, because it
       is the one the user's other dashboards already show.  Two switches appear
       when both scripts are loaded and ours won the race: on a cold load this
       one can run before the other has inserted its <select>, so the guard
       below sees nothing and prepends; afterwards `own` is truthy and used to
       return early, leaving the duplicate in place for ever.  So when both are
       present ours steps aside.  Nothing is lost: both controls read and write
       the same `localStorage["hoymiles.language"]` and announce on the same
       `hoymiles-language` event, so the surviving one is the same setting. */
    if (own) {
      if (foreign) own.remove();
      return true;
    }
    if (foreign) return true;

    /* Left edge, which is where the language switch belongs: the region switch
       inserts itself to the right of whichever language control it finds. */
    found.items.prepend(buildSelect(found.hass));
    return true;
  }

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
   * Place the switch, retrying while the frontend is still starting up.
   *
   * Loaded from `index.html`, before Home Assistant has built its interface: the
   * element chain does not exist yet on a cold load, and the delay is not fixed.
   */
  function retry() {
    if (retryTimer) return; // a run is already in flight
    let tries = 0;
    const step = () => {
      retryTimer = 0;
      if (place()) return;
      tries += 1;
      if (tries >= 240) return; // give up after a minute; navigations re-arm
      retryTimer = setTimeout(step, 250);
    };
    step();
  }

  function boot() {
    /* The i18n module defines the choice list; if it has not been evaluated
       yet, wait for it rather than defaulting to English only. */
    hookKnownRoots();
    retry();

    window.addEventListener("location-changed", () => {
      hookKnownRoots();
      retry();
    });
    window.addEventListener("popstate", () => {
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
