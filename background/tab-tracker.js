/**
 * Tab tracker — maps tabs to base domains, tracks open count per domain,
 * and fires a delayed callback when the last tab for a domain closes.
 *
 * Depends on: DomainUtils (loaded before this script in manifest.json)
 */

const TabTracker = (() => {
  "use strict";

  // tabId -> baseDomain
  const tabToDomain = new Map();

  // baseDomain -> number of open tabs
  const domainTabCount = new Map();

  // baseDomain -> setTimeout ID (500ms close delay)
  const closeTimers = new Map();

  // Registered callback for when a domain fully closes
  let domainClosedCallback = null;

  /**
   * Increment the tab count for a domain.
   * Cancels any pending close timer for that domain.
   */
  function incrementDomain(domain) {
    const count = domainTabCount.get(domain) || 0;
    domainTabCount.set(domain, count + 1);

    // Cancel pending close timer — a tab is back
    if (closeTimers.has(domain)) {
      clearTimeout(closeTimers.get(domain));
      closeTimers.delete(domain);
      console.log("[DomainGuard] Close timer cancelled for", domain);
    }
  }

  /**
   * Decrement the tab count for a domain.
   * If count reaches 0, start a 500ms close timer.
   */
  function decrementDomain(domain) {
    const count = domainTabCount.get(domain) || 0;
    if (count <= 1) {
      domainTabCount.delete(domain);
      startCloseTimer(domain);
    } else {
      domainTabCount.set(domain, count - 1);
    }
  }

  /**
   * Start a 500ms timer for a domain that has reached 0 tabs.
   * If a timer already exists for this domain, do not restart it.
   */
  function startCloseTimer(domain) {
    if (closeTimers.has(domain)) return;

    const timerId = setTimeout(() => {
      closeTimers.delete(domain);
      console.log("[DomainGuard] Domain closed:", domain);
      if (domainClosedCallback) {
        domainClosedCallback(domain);
      }
    }, 500);

    closeTimers.set(domain, timerId);
    console.log("[DomainGuard] Close timer started for", domain);
  }

  /**
   * Handle a tab's URL changing (new tab, navigation, etc.).
   * Updates maps and counts accordingly.
   */
  function updateTab(tabId, url) {
    const newDomain = DomainUtils.getBaseDomain(url);
    const oldDomain = tabToDomain.get(tabId) || null;

    // No change
    if (newDomain === oldDomain) return;

    // Remove old domain association
    if (oldDomain) {
      decrementDomain(oldDomain);
    }

    // Set new domain association (or remove if restricted)
    if (newDomain) {
      tabToDomain.set(tabId, newDomain);
      incrementDomain(newDomain);
    } else {
      tabToDomain.delete(tabId);
    }
  }

  // --- Listeners ---

  function onTabCreated(tab) {
    // URL may not be available yet on creation
    if (tab.url) {
      updateTab(tab.id, tab.url);
    }
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    // Only act when the URL actually changes
    if (changeInfo.url) {
      updateTab(tabId, changeInfo.url);
    }
  }

  function onTabRemoved(tabId) {
    const domain = tabToDomain.get(tabId);
    tabToDomain.delete(tabId);

    if (domain) {
      decrementDomain(domain);
    }
  }

  // --- Public API ---

  /**
   * Returns the base domain for a given tab ID, or null if not tracked.
   */
  function getDomainForTab(tabId) {
    return tabToDomain.get(tabId) || null;
  }

  /**
   * Returns the current open tab count for a base domain.
   */
  function getTabCount(baseDomain) {
    return domainTabCount.get(baseDomain) || 0;
  }

  /**
   * Register a callback that fires when the last tab for a domain closes
   * (after a 500ms delay). The callback receives the base domain string.
   */
  function onDomainClosed(callback) {
    domainClosedCallback = callback;
  }

  /**
   * Initialize the tracker by rebuilding state from currently open tabs.
   * Called by main.js on extension startup.
   */
  async function init() {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.url) {
        const domain = DomainUtils.getBaseDomain(tab.url);
        if (domain) {
          tabToDomain.set(tab.id, domain);
          const count = domainTabCount.get(domain) || 0;
          domainTabCount.set(domain, count + 1);
        }
      }
    }

    // Register listeners
    browser.tabs.onCreated.addListener(onTabCreated);
    browser.tabs.onUpdated.addListener(onTabUpdated);
    browser.tabs.onRemoved.addListener(onTabRemoved);

    console.log("[DomainGuard] TabTracker initialized —", tabToDomain.size, "tabs tracked across", domainTabCount.size, "domains");
  }

  return { getDomainForTab, getTabCount, onDomainClosed, init };
})();
