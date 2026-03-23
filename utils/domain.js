/**
 * Domain normalization utility.
 * Extracts base domain (eTLD+1) from URLs and identifies restricted URLs.
 *
 * Used by all modules — loaded as a background script so its functions
 * are available in the background context. Content scripts and panel
 * scripts that need domain logic will message the background.
 */

const DomainUtils = (() => {
  "use strict";

  // Two-part TLDs where the base domain is eTLD+2 (e.g., example.co.uk).
  // This covers the most common multi-part public suffixes.
  // A full public suffix list would be thousands of entries; this pragmatic
  // subset handles the vast majority of real-world browsing.
  const MULTI_PART_TLDS = new Set([
    // Generic country second-level domains
    "ac.uk", "co.uk", "gov.uk", "org.uk", "net.uk", "me.uk", "ltd.uk", "plc.uk",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
    "co.kr", "or.kr", "ne.kr", "go.kr",
    "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
    "co.za", "org.za", "net.za", "gov.za", "ac.za",
    "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "ac.in", "gov.in",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
    "com.br", "net.br", "org.br", "gov.br", "edu.br",
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
    "com.mx", "net.mx", "org.mx", "gob.mx", "edu.mx",
    "com.ar", "net.ar", "org.ar", "gov.ar", "edu.ar",
    "com.tw", "net.tw", "org.tw", "gov.tw", "edu.tw",
    "com.hk", "net.hk", "org.hk", "gov.hk", "edu.hk",
    "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
    "com.my", "net.my", "org.my", "gov.my", "edu.my",
    "com.ph", "net.ph", "org.ph", "gov.ph", "edu.ph",
    "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
    "com.ua", "net.ua", "org.ua", "gov.ua", "edu.ua",
    "com.ng", "net.ng", "org.ng", "gov.ng", "edu.ng",
    "com.eg", "net.eg", "org.eg", "gov.eg", "edu.eg",
    "co.il", "org.il", "net.il", "ac.il", "gov.il",
    "co.th", "or.th", "net.th", "ac.th", "go.th",
    "co.id", "or.id", "net.id", "ac.id", "go.id", "web.id",
    "com.vn", "net.vn", "org.vn", "gov.vn", "edu.vn",
    "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk",
    "com.bd", "net.bd", "org.bd", "gov.bd", "edu.bd",
    "com.pe", "net.pe", "org.pe", "gob.pe", "edu.pe",
    "com.co", "net.co", "org.co", "gov.co", "edu.co",
    "com.ve", "net.ve", "org.ve", "gov.ve", "edu.ve",
    "com.ec", "net.ec", "org.ec", "gob.ec", "edu.ec",
    "co.ke", "or.ke", "ne.ke", "ac.ke", "go.ke",
    // European
    "co.at", "or.at", "ac.at",
    "co.hu", "org.hu", "gov.hu",
    "com.pl", "net.pl", "org.pl", "gov.pl", "edu.pl",
    "com.pt", "net.pt", "org.pt", "gov.pt", "edu.pt",
    "com.ro", "net.ro", "org.ro", "gov.ro", "edu.ro",
    "com.gr", "net.gr", "org.gr", "gov.gr", "edu.gr",
    // Others
    "com.sa", "net.sa", "org.sa", "gov.sa", "edu.sa",
    "com.qa", "net.qa", "org.qa", "gov.qa", "edu.qa",
    "com.kw", "net.kw", "org.kw", "gov.kw", "edu.kw",
    "com.bh", "net.bh", "org.bh", "gov.bh", "edu.bh",
    "com.lb", "net.lb", "org.lb", "gov.lb", "edu.lb",
  ]);

  const RESTRICTED_SCHEMES = ["about:", "moz-extension:", "file:", "chrome:"];

  /**
   * Check if a URL is restricted (not a real web page).
   * @param {string} url
   * @returns {boolean}
   */
  function isRestrictedUrl(url) {
    if (!url || typeof url !== "string") return true;
    for (const scheme of RESTRICTED_SCHEMES) {
      if (url.startsWith(scheme)) return true;
    }
    return false;
  }

  /**
   * Strip a leading dot from a cookie domain.
   * e.g., ".walmart.com" -> "walmart.com"
   * @param {string} domain
   * @returns {string}
   */
  function stripLeadingDot(domain) {
    if (!domain || typeof domain !== "string") return domain;
    return domain.startsWith(".") ? domain.slice(1) : domain;
  }

  /**
   * Extract the base domain (eTLD+1) from a URL string.
   * e.g., "https://shop.walmart.com/cart" -> "walmart.com"
   *        "https://example.co.uk/page"   -> "example.co.uk"
   *
   * Returns null for restricted URLs or unparseable input.
   * @param {string} url
   * @returns {string|null}
   */
  function getBaseDomain(url) {
    if (!url || typeof url !== "string") return null;
    if (isRestrictedUrl(url)) return null;

    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (e) {
      return null;
    }

    if (!hostname) return null;

    // Strip leading dot (shouldn't happen from URL parsing, but be safe)
    hostname = stripLeadingDot(hostname);

    // IP addresses — return as-is
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) {
      return hostname;
    }

    const parts = hostname.split(".");

    // Single-label hostname (e.g., "localhost")
    if (parts.length <= 1) return hostname;

    // Check if the last two parts form a known multi-part TLD
    if (parts.length >= 3) {
      const lastTwo = parts.slice(-2).join(".");
      if (MULTI_PART_TLDS.has(lastTwo)) {
        // eTLD is two parts, so base domain is eTLD+1 = last 3 parts
        return parts.slice(-3).join(".");
      }
    }

    // Default: eTLD is 1 part, base domain is last 2 parts
    return parts.slice(-2).join(".");
  }

  return { getBaseDomain, isRestrictedUrl, stripLeadingDot };
})();
