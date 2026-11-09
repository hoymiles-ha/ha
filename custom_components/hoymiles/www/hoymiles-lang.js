/**
 * The language switch.
 *
 * One `<select>` in the Home Assistant toolbar, shared by every card, instead of
 * one per card header.
 *
 * The choice belongs to the reader, not to a card: it lives in a single
 * `localStorage` key and is announced with a single `window` event, so picking a
 * language anywhere switches every card of this integration at once and survives
 * a reload.  English is the default - a dashboard is often shared, hung on a
 * wall or screenshotted for someone else, so it deliberately does not follow the
 * Home Assistant UI language any more.
 *
 * The toolbar is Home Assistant's own element, several shadow roots away from
 * anything a card may touch, so this file reaches into it by hand:
 *
 *   home-assistant > home-assistant-main > ha-panel-lovelace > hui-root
 *     .header .toolbar .action-items
 *
 * That is the row holding the tabs on the left and the add / search / assist /
 * edit buttons on the right; the switch sits at its left edge, i.e. immediately
 * before the add button.  Lit re-renders that row whenever the view changes, so
 * the switch is re-inserted from a `MutationObserver` and from Home Assistant's
 * `location-changed` event rather than being placed once.
 */

(() => {
  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";
  const LANG_CHOICES = [["en", "English"], ["zh", "\u4e2d\u6587"], ["de", "Deutsch"]];
  const SELECT_CLASS = "hm-lang-switch";
  const STYLE_ID = "hm-lang-switch-style";

  /* ------------------------------------------------------------------ *
   * The shared language protocol
   * ------------------------------------------------------------------ */

  /** Map any Home Assistant language tag to one of the three card languages. */
  function hmNormalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  /** The stored choice, or "" when nothing has been picked (or no storage). */
  function hmStored() {
    try {
      return hmNormalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return ""; // private mode / storage disabled: fall back to the default
    }
  }

  /** Remember a choice and tell every card about it. */
  function hmSetLang(value) {
    const lang = hmNormalise(value) || "en";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      /* nothing to remember it with; the event still switches this page */
    }
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
  }

  /* ------------------------------------------------------------------ *
   * The switch itself
   * ------------------------------------------------------------------ */

  /**
   * A plain `<select>`: one control with three fixed options. The native one
   * keeps the keyboard, the screen reader and the mobile picker working without
   * any code, and it inherits the toolbar's colours from the header variables.
   */
  function buildSelect() {
    const select = document.createElement("select");
    select.className = SELECT_CLASS;
    select.setAttribute("aria-label", "Language");
    select.title = "Language / \u8bed\u8a00 / Sprache";
    for (const [code, label] of LANG_CHOICES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      select.append(option);
    }
    select.value = hmStored() || "en";
    select.addEventListener("change", () => hmSetLang(select.value));

    /* A change made somewhere else - another tab, the console, a future card
       control - has to move this switch too.  The listener detaches itself once
       the element is gone, so a re-render cannot leak one listener per view. */
    const onLangChange = (event) => {
      if (!select.isConnected) {
        window.removeEventListener(LANG_EVENT, onLangChange);
        return;
      }
      if (event.detail && select.value !== event.detail) select.value = event.detail;
    };
    window.addEventListener(LANG_EVENT, onLangChange);

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
    return items ? { shadow, items } : null;
  }

  /** Put the switch in the toolbar. Idempotent: safe to call as often as we like. */
  function place() {
    const found = findActionItems();
    if (!found) return false;
    ensureStyle(found.shadow);
    if (found.items.querySelector(`.${SELECT_CLASS}`)) return true;
    found.items.prepend(buildSelect());
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
      if (place()) return;
      tries += 1;
      if (tries >= 240) return; // give up after a minute; navigations re-arm
      retryTimer = setTimeout(step, 250);
    };
    step();
  }

  function boot() {
    hookKnownRoots();
    retry();

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

    /* Another tab of this browser picked a language: follow it here too. */
    window.addEventListener("storage", (event) => {
      if (event.key !== LANG_KEY) return;
      window.dispatchEvent(
        new CustomEvent(LANG_EVENT, { detail: hmNormalise(event.newValue) || "en" }),
      );
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
