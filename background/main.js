/**
 * Background script entry point.
 * Initialization, callback wiring, and message router.
 */

(async () => {
  "use strict";

  console.log("[DomainGuard] Extension loaded.");

  // Sequential init — each module must be ready before the next starts
  await TabTracker.init();
  await RequestLogger.init();
  await Deletion.init();

  // Wire auto-delete trigger after all inits complete
  TabTracker.onDomainClosed(async (baseDomain) => {
    const enabled = await Deletion.getToggleState(baseDomain);
    if (enabled) {
      await Deletion.autoDeleteForDomain(baseDomain);
    }
  });

  // --- Message Router ---
  // Panel scripts cannot directly call background globals.
  // All panel-to-background communication goes through this router.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === "get-cookies") {
      browser.cookies.getAll({ domain: message.domain }).then(sendResponse);
      return true;
    }

    if (message.type === "get-third-party-records") {
      sendResponse(RequestLogger.getThirdPartyRecords());
      return false;
    }

    if (message.type === "get-toggle-state") {
      sendResponse(Deletion.getToggleState(message.domain));
      return false;
    }

    if (message.type === "set-toggle-state") {
      Deletion.setToggleState(message.domain, message.enabled).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.type === "delete-cookie") {
      Deletion.deleteCookie(message.cookie).then((result) => {
        sendResponse(result || { success: true });
      }).catch((e) => {
        console.error("[DomainGuard] delete-cookie handler error:", e);
        sendResponse({ success: false, error: e.message || "Deletion failed" });
      });
      return true;
    }

    if (message.type === "delete-all-cookies") {
      (async () => {
        try {
          const cookies = await browser.cookies.getAll({ domain: message.domain });
          let failCount = 0;
          for (const cookie of cookies) {
            const result = await Deletion.deleteCookie(cookie);
            if (result && !result.success) failCount++;
          }
          sendResponse({ success: failCount === 0, count: cookies.length, failCount: failCount });
        } catch (e) {
          console.error("[DomainGuard] delete-all-cookies handler error:", e);
          sendResponse({ success: false, error: e.message || "Deletion failed" });
        }
      })();
      return true;
    }

    if (message.type === "delete-storage-item") {
      Deletion.deleteStorageItem(message.tabId, message.storageType, message.key).then((result) => {
        sendResponse(result || { success: true });
      }).catch((e) => {
        console.error("[DomainGuard] delete-storage-item handler error:", e);
        sendResponse({ success: false, error: e.message || "Deletion failed" });
      });
      return true;
    }

    if (message.type === "clear-storage") {
      Deletion.clearStorage(message.tabId, message.storageType).then((result) => {
        sendResponse(result || { success: true });
      }).catch((e) => {
        console.error("[DomainGuard] clear-storage handler error:", e);
        sendResponse({ success: false, error: e.message || "Deletion failed" });
      });
      return true;
    }

    if (message.type === "delete-third-party-cookie") {
      (async () => {
        try {
          const cookies = await browser.cookies.getAll({
            domain: message.thirdPartyDomain,
            name: message.cookieName,
          });
          // Find the cookie matching the path
          const match = cookies.find((c) => c.path === message.cookiePath);
          if (match) {
            const result = await Deletion.deleteCookie(match);
            sendResponse(result || { success: true });
          } else {
            // Cookie already gone or not found
            sendResponse({ success: true });
          }
        } catch (e) {
          console.error("[DomainGuard] delete-third-party-cookie handler error:", e);
          sendResponse({ success: false, error: e.message || "Deletion failed" });
        }
      })();
      return true;
    }

    if (message.type === "clear-all-third-party") {
      (async () => {
        const records = RequestLogger.getThirdPartyRecords();
        const domains = new Set(records.map((r) => r.thirdPartyDomain));
        for (const domain of domains) {
          try {
            const cookies = await browser.cookies.getAll({ domain: domain });
            for (const cookie of cookies) {
              const url = (cookie.secure ? "https://" : "http://") +
                DomainUtils.stripLeadingDot(cookie.domain) + cookie.path;
              await browser.cookies.remove({
                url: url,
                name: cookie.name,
                storeId: cookie.storeId,
              });
            }
          } catch (e) {
            console.warn("[DomainGuard] Failed to delete third-party cookies for", domain, e);
          }
        }
        await RequestLogger.clearAllRecords();
        // Broadcast so other panel instances refresh
        try {
          await browser.runtime.sendMessage({
            type: "deletion-complete",
            detail: { action: "clear-all-third-party" },
          });
        } catch (e) {
          // No listeners — expected when no other panels are open
        }
        sendResponse({ success: true });
      })();
      return true;
    }

    return false;
  });

  console.log("[DomainGuard] Message router registered.");
})();
