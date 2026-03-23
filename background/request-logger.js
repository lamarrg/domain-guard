/**
 * Request logger — observes network requests to identify third-party domains,
 * batches and deduplicates observations, queries their cookies, and persists
 * attribution records for display in the panel.
 *
 * Depends on: DomainUtils, TabTracker (loaded before this script in manifest.json)
 */

const RequestLogger = (() => {
  "use strict";

  const STORAGE_KEY = "thirdPartyRecords";
  const BATCH_INTERVAL_MS = 2000;
  const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const MAX_RECORDS = 5000;

  const ALLOWED_TYPES = new Set([
    "script",
    "xmlhttprequest",
    "beacon",
    "ping",
    "sub_frame",
  ]);

  // Buffer for incoming requests before batch processing
  let requestBuffer = [];

  // Persisted attribution records
  // Key: "thirdPartyDomain|cookieName|cookiePath" -> record object
  let records = new Map();

  // Whether pruning has run this batch cycle
  let prunedThisCycle = false;

  /**
   * webRequest.onCompleted handler — pushes qualifying requests to the buffer.
   */
  function onRequestCompleted(details) {
    if (!ALLOWED_TYPES.has(details.type)) return;
    requestBuffer.push({
      url: details.url,
      tabId: details.tabId,
    });
  }

  /**
   * Process buffered requests: copy-then-clear, deduplicate, look up cookies,
   * and persist attribution records.
   */
  async function processBatch() {
    if (requestBuffer.length === 0) return;

    // Copy-then-clear
    const batch = requestBuffer;
    requestBuffer = [];
    prunedThisCycle = false;

    // Deduplicate: collect unique {thirdPartyDomain, originatingDomain} pairs
    const uniquePairs = new Map(); // "thirdParty|originating" -> {thirdPartyDomain, originatingDomain}

    for (const req of batch) {
      const requestDomain = DomainUtils.getBaseDomain(req.url);
      if (!requestDomain) continue;

      const originatingDomain = TabTracker.getDomainForTab(req.tabId);
      if (!originatingDomain) continue;

      // Same domain = first-party, skip
      if (requestDomain === originatingDomain) continue;

      const key = requestDomain + "|" + originatingDomain;
      if (!uniquePairs.has(key)) {
        uniquePairs.set(key, {
          thirdPartyDomain: requestDomain,
          originatingDomain: originatingDomain,
        });
      }
    }

    if (uniquePairs.size === 0) return;

    // Collect unique third-party domains for cookie lookup
    const thirdPartyDomains = new Set();
    for (const pair of uniquePairs.values()) {
      thirdPartyDomains.add(pair.thirdPartyDomain);
    }

    // Look up cookies for each unique third-party domain
    const cookiesByDomain = new Map();
    for (const domain of thirdPartyDomains) {
      try {
        const cookies = await browser.cookies.getAll({ domain: domain });
        if (cookies.length > 0) {
          cookiesByDomain.set(domain, cookies);
        }
      } catch (e) {
        console.warn("[DomainGuard] Cookie lookup failed for", domain, e);
      }
    }

    // Build attribution records
    const now = Date.now();
    let newRecordCount = 0;

    for (const pair of uniquePairs.values()) {
      const cookies = cookiesByDomain.get(pair.thirdPartyDomain);
      if (!cookies || cookies.length === 0) continue;

      for (const cookie of cookies) {
        const recordKey =
          pair.thirdPartyDomain + "|" + cookie.name + "|" + cookie.path;
        const existing = records.get(recordKey);

        if (existing) {
          // Update timestamp and add originating domain if new
          existing.timestamp = now;
          if (!existing.originatingDomains.includes(pair.originatingDomain)) {
            existing.originatingDomains.push(pair.originatingDomain);
          }
        } else {
          records.set(recordKey, {
            thirdPartyDomain: pair.thirdPartyDomain,
            cookieName: cookie.name,
            cookiePath: cookie.path,
            originatingDomains: [pair.originatingDomain],
            timestamp: now,
          });
          newRecordCount++;
        }
      }
    }

    // Prune if approaching quota
    if (records.size > MAX_RECORDS && !prunedThisCycle) {
      pruneOldRecords();
      prunedThisCycle = true;
    }

    // Persist
    await saveRecords();

    console.log(
      "[DomainGuard] Batch processed:",
      batch.length,
      "requests,",
      uniquePairs.size,
      "unique third-party pairs,",
      newRecordCount,
      "new records"
    );
  }

  /**
   * Remove records older than 30 days.
   */
  function pruneOldRecords() {
    const cutoff = Date.now() - PRUNE_AGE_MS;
    let pruned = 0;
    for (const [key, record] of records) {
      if (record.timestamp < cutoff) {
        records.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log("[DomainGuard] Pruned", pruned, "records older than 30 days");
    }
  }

  /**
   * Save records to browser.storage.local.
   */
  async function saveRecords() {
    const arr = Array.from(records.values());
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: arr });
    } catch (e) {
      console.error("[DomainGuard] Failed to save records:", e);
    }
  }

  /**
   * Load records from browser.storage.local into the in-memory Map.
   */
  async function loadRecords() {
    try {
      const result = await browser.storage.local.get(STORAGE_KEY);
      const arr = result[STORAGE_KEY];
      if (Array.isArray(arr)) {
        for (const record of arr) {
          const key =
            record.thirdPartyDomain +
            "|" +
            record.cookieName +
            "|" +
            record.cookiePath;
          records.set(key, record);
        }
      }
    } catch (e) {
      console.error("[DomainGuard] Failed to load records:", e);
    }
  }

  // --- Public API ---

  /**
   * Returns all third-party attribution records as an array.
   */
  function getThirdPartyRecords() {
    return Array.from(records.values());
  }

  /**
   * Clears all records from memory and storage.
   */
  async function clearAllRecords() {
    records.clear();
    try {
      await browser.storage.local.remove(STORAGE_KEY);
    } catch (e) {
      console.error("[DomainGuard] Failed to clear records:", e);
    }
    console.log("[DomainGuard] All third-party records cleared");
  }

  /**
   * Initialize: load persisted records, register webRequest listener, start batch timer.
   */
  async function init() {
    await loadRecords();

    browser.webRequest.onCompleted.addListener(
      onRequestCompleted,
      { urls: ["<all_urls>"] }
    );

    setInterval(processBatch, BATCH_INTERVAL_MS);

    console.log(
      "[DomainGuard] RequestLogger initialized —",
      records.size,
      "records loaded"
    );
  }

  return { init, getThirdPartyRecords, clearAllRecords };
})();
