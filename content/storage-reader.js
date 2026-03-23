/**
 * Content script — reads and deletes localStorage/sessionStorage on demand.
 * Injected at document_idle on all URLs.
 * Does nothing until messaged by the background script.
 *
 * NOT a background script — does NOT share the global scope with
 * DomainUtils, TabTracker, etc. Communicates exclusively via messages.
 * Does NOT use the IIFE namespace pattern (isolated per page, no globals to expose).
 */

"use strict";

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "read-storage") {
    const localItems = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      localItems.push({ key, value: localStorage.getItem(key) });
    }

    const sessionItems = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      sessionItems.push({ key, value: sessionStorage.getItem(key) });
    }

    sendResponse({ localStorage: localItems, sessionStorage: sessionItems });
    return true;
  }

  if (message.type === "delete-storage-item") {
    if (message.storageType === "local") {
      localStorage.removeItem(message.key);
    } else if (message.storageType === "session") {
      sessionStorage.removeItem(message.key);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "clear-storage") {
    if (message.storageType === "local") {
      localStorage.clear();
    } else if (message.storageType === "session") {
      sessionStorage.clear();
    } else if (message.storageType === "all") {
      localStorage.clear();
      sessionStorage.clear();
    }
    sendResponse({ success: true });
    return true;
  }

  return false;
});
