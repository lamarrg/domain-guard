"use strict";

(() => {
  const DEBUG = false;

  // --- State ---
  let currentTabId = null;
  let currentWindowId = null;
  let currentDomain = null;
  let requestCounter = 0;
  let storageAvailable = false;

  // Lazy rendering state for third-party list
  let thirdPartyRecords = [];
  let thirdPartyRenderedCount = 0;
  const THIRD_PARTY_BATCH_SIZE = 50;

  // Debounce timer for refreshData — coalesces rapid deletions
  let refreshDebounceTimer = null;
  const REFRESH_DEBOUNCE_MS = 200;

  // --- DOM refs ---
  const restrictedMessage = document.getElementById("restricted-message");
  const content = document.getElementById("content");
  const domainName = document.getElementById("domain-name");
  const toggleCheckbox = document.getElementById("toggle-delete-on-leave");

  const badgeCookies = document.getElementById("badge-cookies");
  const badgeLocalStorage = document.getElementById("badge-local-storage");
  const badgeSessionStorage = document.getElementById("badge-session-storage");
  const badgeThirdParty = document.getElementById("badge-third-party");

  const listCookies = document.getElementById("list-cookies");
  const listLocalStorage = document.getElementById("list-local-storage");
  const listSessionStorage = document.getElementById("list-session-storage");
  const listThirdParty = document.getElementById("list-third-party");

  const thirdPartyContainer = document.getElementById("third-party-container");

  // --- Init ---
  async function init() {
    const win = await browser.windows.getCurrent();
    currentWindowId = win.id;

    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return;

    const tab = tabs[0];
    currentTabId = tab.id;

    setupEventListeners();
    await loadTab(tab);

    if (DEBUG) console.log("[DomainGuard] Panel loaded for domain:", currentDomain);
  }

  function setupEventListeners() {
    // Tab switch
    browser.tabs.onActivated.addListener(async (activeInfo) => {
      if (activeInfo.windowId !== currentWindowId) return;
      const tab = await browser.tabs.get(activeInfo.tabId);
      currentTabId = tab.id;
      await loadTab(tab);
    });

    // Tab URL change (navigation)
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (tabId === currentTabId && changeInfo.url) {
        await loadTab(tab);
      }
    });

    // Deletion broadcasts — debounced re-fetch to coalesce rapid deletions
    browser.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return false;

      if (message.type === "deletion-complete") {
        debouncedRefresh();
      }

      if (message.type === "toggle-changed") {
        // Sync toggle UI if the change is for the current domain
        if (message.domain === currentDomain) {
          toggleCheckbox.checked = message.enabled;
        }
      }

      return false;
    });

    // Toggle handler
    toggleCheckbox.addEventListener("change", async () => {
      if (!currentDomain) return;
      await browser.runtime.sendMessage({
        type: "set-toggle-state",
        domain: currentDomain,
        enabled: toggleCheckbox.checked,
      });
    });

    // Collapse/expand segment headers
    document.querySelectorAll(".segment-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        // Don't toggle if clicking the Delete All button
        if (e.target.classList.contains("btn-delete-all")) return;
        const segment = header.closest(".segment");
        if (segment.classList.contains("disabled")) return;
        segment.classList.toggle("expanded");
      });
    });

    // Delete All buttons (top section)
    document.querySelectorAll(".btn-delete-all[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        const action = btn.dataset.action;
        let response;
        if (action === "delete-all-cookies") {
          response = await browser.runtime.sendMessage({ type: "delete-all-cookies", domain: currentDomain });
        } else if (action === "clear-local-storage") {
          response = await browser.runtime.sendMessage({ type: "clear-storage", tabId: currentTabId, storageType: "local" });
        } else if (action === "clear-session-storage") {
          response = await browser.runtime.sendMessage({ type: "clear-storage", tabId: currentTabId, storageType: "session" });
        }
        if (response && !response.success) {
          showErrorFlash(btn.closest(".segment"));
        }
        debouncedRefresh();
      });
    });

    // Delete All third-party
    document.getElementById("btn-delete-all-third-party").addEventListener("click", async () => {
      const response = await browser.runtime.sendMessage({ type: "clear-all-third-party" });
      if (response && !response.success) {
        showErrorFlash(document.getElementById("third-party-container"));
      }
      debouncedRefresh();
    });

    // Lazy rendering scroll listener
    thirdPartyContainer.addEventListener("scroll", () => {
      const list = thirdPartyContainer.querySelector(".item-list");
      if (!list) return;
      const scrollBottom = thirdPartyContainer.scrollTop + thirdPartyContainer.clientHeight;
      if (scrollBottom >= list.scrollHeight - 50) {
        renderMoreThirdParty();
      }
    });
  }

  // --- Load tab data ---
  async function loadTab(tab) {
    const url = tab.url;

    // Restricted URL pre-check — instant, no async round-trip
    if (DomainUtils.isRestrictedUrl(url)) {
      currentDomain = null;
      showRestricted();
      return;
    }

    const baseDomain = DomainUtils.getBaseDomain(url);
    if (!baseDomain) {
      currentDomain = null;
      showRestricted();
      return;
    }

    currentDomain = baseDomain;
    showContent();
    domainName.textContent = baseDomain;

    await refreshData();
  }

  async function refreshData() {
    if (!currentDomain) return;
    await Promise.all([
      fetchCookies(),
      fetchStorage(),
      fetchToggle(),
      fetchThirdParty(),
    ]);
  }

  /**
   * Debounced refresh — coalesces rapid deletion broadcasts into one re-render.
   * Resets the timer on each call so only the last one fires.
   */
  function debouncedRefresh() {
    if (refreshDebounceTimer) {
      clearTimeout(refreshDebounceTimer);
    }
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      refreshData();
    }, REFRESH_DEBOUNCE_MS);
  }

  // --- Fetch cookies ---
  async function fetchCookies() {
    try {
      const cookies = await browser.runtime.sendMessage({
        type: "get-cookies",
        domain: currentDomain,
      });
      renderCookies(cookies || []);
    } catch (e) {
      if (DEBUG) console.warn("[DomainGuard] Failed to fetch cookies:", e);
      renderCookies([]);
    }
  }

  // --- Fetch storage with timeout and stale response handling ---
  async function fetchStorage() {
    const myRequestId = ++requestCounter;
    const myTabId = currentTabId;

    storageAvailable = false;

    try {
      const response = await Promise.race([
        browser.tabs.sendMessage(myTabId, { type: "read-storage" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);

      // Stale response check
      if (currentTabId !== myTabId) return;

      storageAvailable = true;
      renderLocalStorage(response.localStorage || []);
      renderSessionStorage(response.sessionStorage || []);
    } catch (e) {
      // Stale check — don't update UI if tab changed
      if (currentTabId !== myTabId) return;

      if (DEBUG) console.warn("[DomainGuard] Storage data unavailable — timeout or error");
      showStorageUnavailable();
    }
  }

  // --- Fetch toggle state ---
  async function fetchToggle() {
    try {
      const enabled = await browser.runtime.sendMessage({
        type: "get-toggle-state",
        domain: currentDomain,
      });
      toggleCheckbox.checked = enabled;
    } catch (e) {
      if (DEBUG) console.warn("[DomainGuard] Failed to fetch toggle state:", e);
      toggleCheckbox.checked = true; // Default ON
    }
  }

  // --- Fetch third-party records ---
  async function fetchThirdParty() {
    try {
      const records = await browser.runtime.sendMessage({ type: "get-third-party-records" });
      thirdPartyRecords = records || [];
      thirdPartyRenderedCount = 0;
      listThirdParty.innerHTML = "";
      badgeThirdParty.textContent = thirdPartyRecords.length;

      if (thirdPartyRecords.length === 0) {
        listThirdParty.innerHTML = '<li class="empty-message">No third-party data recorded</li>';
      } else {
        renderMoreThirdParty();
      }
    } catch (e) {
      if (DEBUG) console.warn("[DomainGuard] Failed to fetch third-party records:", e);
      thirdPartyRecords = [];
      badgeThirdParty.textContent = "0";
      listThirdParty.innerHTML = '<li class="empty-message">No third-party data recorded</li>';
    }
  }

  // --- Render cookies ---
  function renderCookies(cookies) {
    badgeCookies.textContent = cookies.length;
    listCookies.innerHTML = "";

    if (cookies.length === 0) {
      listCookies.innerHTML = '<li class="empty-message">No cookies</li>';
      return;
    }

    for (const cookie of cookies) {
      const li = document.createElement("li");

      const info = document.createElement("div");
      info.className = "item-info";

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = cookie.name;
      info.appendChild(name);

      const value = document.createElement("span");
      value.className = "item-value";
      value.textContent = cookie.value;
      value.title = cookie.value;
      info.appendChild(value);

      li.appendChild(info);

      const btn = document.createElement("button");
      btn.className = "btn-delete-item";
      btn.textContent = "Delete";
      btn.addEventListener("click", async () => {
        const response = await browser.runtime.sendMessage({ type: "delete-cookie", cookie: cookie });
        if (response && !response.success) {
          showErrorFlash(li);
        }
        debouncedRefresh();
      });
      li.appendChild(btn);

      listCookies.appendChild(li);
    }
  }

  // --- Render storage items ---
  function renderStorageItems(items, listEl, badgeEl, storageType) {
    badgeEl.textContent = items.length;
    listEl.innerHTML = "";

    // Show unavailable message if hidden
    const segment = listEl.closest(".segment");
    const unavailMsg = segment.querySelector(".unavailable-message");
    if (unavailMsg) unavailMsg.classList.add("hidden");
    segment.classList.remove("disabled");

    // Enable delete all button
    const deleteAllBtn = segment.querySelector(".btn-delete-all");
    if (deleteAllBtn) deleteAllBtn.disabled = false;

    if (items.length === 0) {
      listEl.innerHTML = '<li class="empty-message">No items</li>';
      return;
    }

    for (const item of items) {
      const li = document.createElement("li");

      const info = document.createElement("div");
      info.className = "item-info";

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = item.key;
      info.appendChild(name);

      const value = document.createElement("span");
      value.className = "item-value";
      value.textContent = item.value;
      value.title = item.value;
      info.appendChild(value);

      li.appendChild(info);

      const btn = document.createElement("button");
      btn.className = "btn-delete-item";
      btn.textContent = "Delete";
      btn.addEventListener("click", async () => {
        const response = await browser.runtime.sendMessage({
          type: "delete-storage-item",
          tabId: currentTabId,
          storageType: storageType,
          key: item.key,
        });
        if (response && !response.success) {
          showErrorFlash(li);
        }
        debouncedRefresh();
      });
      li.appendChild(btn);

      listEl.appendChild(li);
    }
  }

  function renderLocalStorage(items) {
    renderStorageItems(items, listLocalStorage, badgeLocalStorage, "local");
  }

  function renderSessionStorage(items) {
    renderStorageItems(items, listSessionStorage, badgeSessionStorage, "session");
  }

  // --- Show storage unavailable ---
  function showStorageUnavailable() {
    for (const segmentId of ["segment-local-storage", "segment-session-storage"]) {
      const segment = document.getElementById(segmentId);
      segment.classList.add("disabled");
      segment.classList.remove("expanded");

      const list = segment.querySelector(".item-list");
      list.innerHTML = "";

      const badge = segment.querySelector(".badge");
      badge.textContent = "-";

      const unavailMsg = segment.querySelector(".unavailable-message");
      if (unavailMsg) unavailMsg.classList.remove("hidden");

      const deleteAllBtn = segment.querySelector(".btn-delete-all");
      if (deleteAllBtn) deleteAllBtn.disabled = true;
    }
  }

  // --- Lazy render third-party items ---
  function renderMoreThirdParty() {
    const end = Math.min(thirdPartyRenderedCount + THIRD_PARTY_BATCH_SIZE, thirdPartyRecords.length);
    for (let i = thirdPartyRenderedCount; i < end; i++) {
      const record = thirdPartyRecords[i];
      const li = document.createElement("li");

      const info = document.createElement("div");
      info.className = "item-info";

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = record.thirdPartyDomain;
      info.appendChild(name);

      const cookieLabel = document.createElement("span");
      cookieLabel.className = "item-value";
      cookieLabel.textContent = record.cookieName;
      info.appendChild(cookieLabel);

      if (record.originatingDomains && record.originatingDomains.length > 0) {
        const meta = document.createElement("span");
        meta.className = "item-meta";
        meta.textContent = "seen on: " + record.originatingDomains.join(", ");
        info.appendChild(meta);
      }

      li.appendChild(info);

      const btn = document.createElement("button");
      btn.className = "btn-delete-item";
      btn.textContent = "Delete";
      btn.addEventListener("click", async () => {
        // Look up the actual cookie to get correct secure/storeId values
        const response = await browser.runtime.sendMessage({
          type: "delete-third-party-cookie",
          thirdPartyDomain: record.thirdPartyDomain,
          cookieName: record.cookieName,
          cookiePath: record.cookiePath,
        });
        if (response && !response.success) {
          showErrorFlash(btn.closest("li"));
        }
        debouncedRefresh();
      });
      li.appendChild(btn);

      listThirdParty.appendChild(li);
    }
    thirdPartyRenderedCount = end;
  }

  // --- Error flash indicator ---

  /**
   * Show a brief red error flash on an element that auto-dismisses after 3 seconds.
   * No retry — just visual feedback that something failed.
   */
  function showErrorFlash(element) {
    if (!element) return;
    element.classList.add("error-flash");
    setTimeout(() => {
      element.classList.remove("error-flash");
    }, 3000);
  }

  // --- View state management ---
  function showRestricted() {
    restrictedMessage.classList.remove("hidden");
    content.classList.add("hidden");
  }

  function showContent() {
    restrictedMessage.classList.add("hidden");
    content.classList.remove("hidden");

    // Expand cookies segment by default
    document.getElementById("segment-cookies").classList.add("expanded");
    document.getElementById("segment-local-storage").classList.add("expanded");
    document.getElementById("segment-session-storage").classList.add("expanded");
  }

  // --- Start ---
  init();
})();
