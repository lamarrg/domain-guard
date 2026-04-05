# DomainGuard Privacy Policy

**Last updated:** April 2026

## Summary

DomainGuard operates entirely within your browser. It does not collect, transmit, or share any data with external servers. All data stays on your device.

## What Data DomainGuard Accesses

DomainGuard accesses the following browser data to provide its functionality:

- **Cookies:** Reads cookie names, values, and metadata (domain, path, expiration) for the sites you visit, so you can view and delete them.
- **localStorage and sessionStorage:** Reads storage keys and values for the active tab's site via a content script, so you can view and delete them.
- **Network requests:** Observes request URLs (not content or headers) to identify third-party domains that set cookies while you browse.
- **Tab information:** Tracks which domains are open in your tabs to enable the auto-delete-on-leave feature.

## What Data DomainGuard Stores

- **Third-party attribution records:** Domain name, cookie name, cookie path, and which first-party sites the third-party was observed on. Stored in `browser.storage.local`. Records older than 30 days are automatically pruned. Maximum 5,000 records retained.
- **Per-domain toggle settings:** Whether auto-delete-on-leave is enabled or disabled for each domain. Stored in `browser.storage.local`.

## What DomainGuard Does NOT Do

- Does not send any data to external servers, APIs, or third parties.
- Does not include analytics, telemetry, or crash reporting.
- Does not track your browsing history beyond what is needed for the current session's tab-to-domain mapping (held in memory only, not persisted).
- Does not read the content of web pages or network request/response bodies.
- Does not modify web pages.

## Permissions Explained

| Permission | Why it is needed |
|---|---|
| `cookies` | Read and delete cookies per domain |
| `tabs` | Track active tab domain for the panel display and auto-delete-on-leave |
| `storage` | Persist third-party records and per-domain toggle settings |
| `webRequest` | Observe request URLs to identify third-party cookie-setting domains |
| `browsingData` | Clear localStorage/sessionStorage when auto-deleting on domain leave |
| `<all_urls>` | Required for the content script and webRequest listener to work on all sites |

## User Controls

- **Manual deletion:** Delete individual cookies, storage items, or third-party records at any time via the panel.
- **Bulk deletion:** "Delete All" buttons for each data category.
- **Auto-delete-on-leave:** Per-domain toggle that automatically clears first-party data when you close all tabs for a site.

## Contact

If you have questions about this privacy policy, please open an issue on the project's GitHub repository.
