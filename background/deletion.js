/**
 * Deletion engine — handles manual deletion (user clicks) and automatic
 * delete-on-leave cleanup. Broadcasts deletion events to all panel instances.
 *
 * Depends on: DomainUtils (for stripLeadingDot), TabTracker (for onDomainClosed)
 * Both are loaded before this script in manifest.json.
 */

const Deletion = (() => {
  "use strict";

  const TOGGLE_STORAGE_KEY = "domainToggles";

  // baseDomain -> boolean (true = auto-delete ON)
  let toggleState = new Map();

  /**
   * Build the URL needed for browser.cookies.remove().
   * Uses the cookie's secure flag to determine protocol,
   * and strips leading dot from domain.
   */
  function buildCookieUrl(cookie) {
    const protocol = cookie.secure ? "https://" : "http://";
    return protocol + DomainUtils.stripLeadingDot(cookie.domain) + cookie.path;
  }

  /**
   * Broadcast a deletion event to all listeners (panel instances).
   * Wrapped in try/catch — broadcast may fail if no listeners are active.
   */
  async function broadcastDeletion(detail) {
    try {
      await browser.runtime.sendMessage({
        type: "deletion-complete",
        detail: detail,
      });
    } catch (e) {
      // No listeners — this is expected when no panels are open
    }
  }

  // --- Manual Deletion (user clicks while tab is open) ---

  /**
   * Delete a single cookie by its properties.
   * @param {object} cookie - Cookie object with domain, name, path, secure, storeId
   */
  async function deleteCookie(cookie) {
    const url = buildCookieUrl(cookie);
    try {
      await browser.cookies.remove({
        url: url,
        name: cookie.name,
        storeId: cookie.storeId,
      });
    } catch (e) {
      console.error("[DomainGuard] Failed to delete cookie:", cookie.name, "from", cookie.domain, e);
      return { success: false, error: e.message || "Cookie deletion failed" };
    }
    await broadcastDeletion({
      action: "delete-cookie",
      domain: DomainUtils.stripLeadingDot(cookie.domain),
      cookieName: cookie.name,
    });
    console.log("[DomainGuard] Deleted cookie:", cookie.name, "from", cookie.domain);
    return { success: true };
  }

  /**
   * Delete a single localStorage or sessionStorage item via content script.
   * @param {number} tabId - Tab to send message to
   * @param {string} storageType - "local" or "session"
   * @param {string} key - Storage key to delete
   */
  async function deleteStorageItem(tabId, storageType, key) {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "delete-storage-item",
        storageType: storageType,
        key: key,
      });
    } catch (e) {
      console.error("[DomainGuard] Failed to delete storage item:", key, e);
      return { success: false, error: e.message || "Storage item deletion failed" };
    }
    await broadcastDeletion({
      action: "delete-storage-item",
      storageType: storageType,
      key: key,
    });
    console.log("[DomainGuard] Deleted", storageType, "storage item:", key);
    return { success: true };
  }

  /**
   * Clear all items from a storage type via content script.
   * @param {number} tabId - Tab to send message to
   * @param {string} storageType - "local", "session", or "all"
   */
  async function clearStorage(tabId, storageType) {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "clear-storage",
        storageType: storageType,
      });
    } catch (e) {
      console.error("[DomainGuard] Failed to clear", storageType, "storage:", e);
      return { success: false, error: e.message || "Storage clear failed" };
    }
    await broadcastDeletion({
      action: "clear-storage",
      storageType: storageType,
    });
    console.log("[DomainGuard] Cleared", storageType, "storage");
    return { success: true };
  }

  // --- Auto Delete-on-Leave (last tab for domain closed) ---

  /**
   * Automatically delete all first-party data for a domain.
   * Called when the last tab for a domain closes and the toggle is ON.
   *
   * Uses browser.cookies.remove for cookies (one by one) and
   * browser.browsingData.remove for localStorage/sessionStorage.
   * Does NOT attempt content script messaging (tab is already closed).
   * Does NOT touch third-party data (bottom section).
   */
  async function autoDeleteForDomain(baseDomain) {
    console.log("[DomainGuard] Auto-deleting data for", baseDomain);

    // Delete cookies
    try {
      const cookies = await browser.cookies.getAll({ domain: baseDomain });
      for (const cookie of cookies) {
        const url = buildCookieUrl(cookie);
        await browser.cookies.remove({
          url: url,
          name: cookie.name,
          storeId: cookie.storeId,
        });
      }
      console.log("[DomainGuard] Auto-deleted", cookies.length, "cookies for", baseDomain);
    } catch (e) {
      console.error("[DomainGuard] Failed to auto-delete cookies for", baseDomain, e);
    }

    // Delete localStorage and sessionStorage via browsingData API
    try {
      await browser.browsingData.remove(
        {
          hostnames: [baseDomain],
        },
        {
          localStorage: true,
          sessionStorage: true,
        }
      );
      console.log("[DomainGuard] Auto-deleted storage for", baseDomain);
    } catch (e) {
      console.error("[DomainGuard] Failed to auto-delete storage for", baseDomain, e);
    }

    await broadcastDeletion({
      action: "auto-delete",
      domain: baseDomain,
    });
  }

  // --- Toggle State ---

  /**
   * Get the delete-on-leave toggle state for a domain.
   * Defaults to true (ON) for domains not explicitly set.
   * @param {string} baseDomain
   * @returns {boolean}
   */
  function getToggleState(baseDomain) {
    if (toggleState.has(baseDomain)) {
      return toggleState.get(baseDomain);
    }
    return true; // Default ON
  }

  /**
   * Set the delete-on-leave toggle state for a domain.
   * Persists to browser.storage.local.
   * @param {string} baseDomain
   * @param {boolean} enabled
   */
  async function setToggleState(baseDomain, enabled) {
    toggleState.set(baseDomain, enabled);
    await saveToggles();
    await broadcastToggleChange(baseDomain, enabled);
    console.log("[DomainGuard] Toggle for", baseDomain, "set to", enabled);
  }

  /**
   * Broadcast a toggle state change to all listeners (panel instances).
   * Wrapped in try/catch — broadcast may fail if no listeners are active.
   */
  async function broadcastToggleChange(domain, enabled) {
    try {
      await browser.runtime.sendMessage({
        type: "toggle-changed",
        domain: domain,
        enabled: enabled,
      });
    } catch (e) {
      // No listeners — this is expected when no panels are open
    }
  }

  // --- Persistence ---

  async function saveToggles() {
    const obj = Object.fromEntries(toggleState);
    try {
      await browser.storage.local.set({ [TOGGLE_STORAGE_KEY]: obj });
    } catch (e) {
      console.error("[DomainGuard] Failed to save toggle state:", e);
    }
  }

  async function loadToggles() {
    try {
      const result = await browser.storage.local.get(TOGGLE_STORAGE_KEY);
      const obj = result[TOGGLE_STORAGE_KEY];
      if (obj && typeof obj === "object") {
        for (const [domain, enabled] of Object.entries(obj)) {
          toggleState.set(domain, enabled);
        }
      }
    } catch (e) {
      console.error("[DomainGuard] Failed to load toggle state:", e);
    }
  }

  // --- Init ---

  /**
   * Initialize the deletion module.
   * Loads persisted toggle state. Does NOT register onDomainClosed —
   * that is wired by main.js after all inits complete.
   */
  async function init() {
    await loadToggles();
    console.log("[DomainGuard] Deletion initialized —", toggleState.size, "domain toggles loaded");
  }

  return {
    init,
    deleteCookie,
    deleteStorageItem,
    clearStorage,
    autoDeleteForDomain,
    getToggleState,
    setToggleState,
  };
})();
