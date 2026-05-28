# Copilot instructions — undefined-app

## What this is

A small static single-page web app for **Undefined** charity events. Three jobs:

1. Show attendees the current Terms & Conditions and Privacy Policy.
2. Capture their acceptance, photography preference, and signature.
3. Issue a scannable check-in pass that any other Undefined device can validate against the live policy versions.

Deployed at https://tos.undefined.charity via GitHub Pages (workflow at `.github/workflows/deploy.yml`).

## Stack

- Vanilla JS, ES modules, no UI framework.
- Build: Vite.
- Runtime dependencies: `dompurify` (sanitise policy HTML), `marked` (markdown → HTML), `qrcode` (generate), `qr-scanner` (camera + image decode), `signature_pad` (canvas signature capture).
- Everything ships statically from `dist/`; the only runtime network calls are to GitHub's Contents API (live policy fetch) and the n8n webhook (acceptance + check-in events).

## Render model

There is one `render()` function in `src/main.js` that wipes and rebuilds `#app.innerHTML` from `state` on every change. After each render, `bindUi()` reattaches event listeners, `initializeSignaturePad()` mounts the canvas, `attachPolicyReadGates()` wires the scroll-to-read tracking, and `attachSignatureCanvases()` redraws any embedded signature on the check-in result. The scanner has its own start/stop lifecycle controlled by the `shouldRunScanner` flag in `render()`.

When adding UI:

- Mutate `state` and call `render()` rather than patching the DOM directly.
- Use template strings inside `render*()` helpers; never inject untrusted strings without `escapeHtml`.
- Any HTML from external sources (the policy markdown) must be sanitised with `DOMPurify.sanitize(marked.parse(...))` — see `parsePolicyDocument`.

## Configuration

All site-wide configuration lives in `src/config.js` and is intentionally **git-only** — there is no settings page and no localStorage override. Values:

- `organizationName`, `eventLabel`
- `endpointUrl` — n8n webhook receiving acceptance + check-in events
- `termsUrl`, `privacyUrl` — GitHub Contents API URLs for the canonical policy markdown

Never reintroduce in-app editing of these. If new site-wide settings are needed, add them to `APP_CONFIG` and document them.

## Modes

Two modes, rendered from the same SPA, switched via the pill group in the hero:

- `sign` (default) — attendee reads both policies (form is locked until each `.policy-reader__body` has been scrolled to the bottom), fills name/email/photo consent, signs, gets a pass.
- `checkin` — staff scans a pass via camera, photo upload, or pasted code; banner-style warnings show at the top of the result for duplicate scans, mismatched issuer, or out-of-date policies; a large green/red callout shows the attendee's photography preference.

The mode list lives in the `MODES` constant. The check-in scan log lives in the module-level `kioskScanLog` Map (cleared on full reload; intentional — "scan #N this session" is a kiosk-runtime concept).

## Check-in pass format (`undefined-accept:v2:` prefix)

base64url-encoded JSON. Fields:

- `schema`, `issuer` (`window.location.origin`), `organization`, `eventLabel`
- `name`, `email`, `photoConsent` (`"in"` | `"out"`), `signedAt`
- `terms`, `privacy`: `{ sha, lastUpdated }` from the GitHub Contents API
- `signatureHash`: SHA-256 of the signature PNG data URL
- `signature` *(optional)*: compressed stroke data (`format: "strokes-v1"`, `compression: "deflate-raw" | "none"`, `width`, `height`, `encoded`). Only included when the encoded payload fits inside the `PAYLOAD_BUDGET_BYTES` (2400) limit.
- `payloadHash`: SHA-256 of the canonicalised (key-sorted) JSON of the payload **with `payloadHash` removed**. See `canonicalJson` for the exact serialisation contract.

Integrity checks at scan time (in `decodeAndStoreAcceptance`):

1. Recompute `payloadHash` from the canonical form; reject on mismatch.
2. Compare `acceptance.issuer` to `window.location.origin`; warn on mismatch.
3. Compare `acceptance.terms.sha` and `acceptance.privacy.sha` to the freshly-fetched current SHAs; warn if out of date.
4. Dedupe by `payloadHash` in `kioskScanLog`; warn on repeat scans.

**There is no signing key.** The pass is tamper-evident (payloadHash + GitHub-pinned policy SHAs), not authenticated. Anyone with this repo can construct a valid pass. That's intentional — the security model is "verify ID at the door for anything significant". Don't add HMAC/PKI without an explicit product decision.

If you change the pass format, bump the prefix (`undefined-accept:v2:` → `undefined-accept:v3:`) and the storage key version (`STORAGE_KEYS.record`). Older passes will then read as "issued by an older version".

## n8n webhook

POSTed at signing (`action: "agree"`) and on every successful check-in scan (`action: "checkin"`). Both include `qrPayload`, `acceptance`, `postedAt`, `scannerIssuer`. `agree` additionally includes `signatureDataUrl` (the full PNG, never persisted locally). `checkin` additionally includes `scannedAt`, `issuerMatch`, `policyCurrent`, `scanCount`, `firstScannedAt`.

The endpoint must send `Access-Control-Allow-Origin` headers for cross-origin POSTs from `https://tos.undefined.charity` to succeed. n8n's Webhook node has an "Allowed Origins (CORS)" option for this.

## Persistence

- `localStorage` key `undefined-app.record.v3` holds a tiny per-device summary of the last signed pass (name, signedAt, photoConsent, termsSha, privacySha, payloadHash). Nothing else is persisted client-side.
- No cookies, no IndexedDB, no analytics.

## User-facing copy

Keep all visible text **friendly and non-technical**. Don't expose commit SHAs, payload hashes, "endpoint", "issuer", "POST", or other implementation jargon in the default UI. If support detail is needed, hide it in a collapsed `<details>` block. The app is used by event attendees and volunteer staff, not engineers.

Refer to the artifact as "the pass" or "check-in pass" in user copy, even though it's a QR code under the hood.

## Build, verify, deploy

- `npm install` — first time
- `npm run dev` — local server on `http://localhost:5173`
- `npm run build` — emits static site to `dist/`
- `npm run preview` — serves the built site

Don't add lint/test commands without also wiring them into `.github/workflows/deploy.yml`. The workflow runs `npm ci && npm run build` on every PR (build check only) and additionally deploys to Pages on every push to `main`. The CNAME for the custom domain lives at `public/CNAME` so Vite copies it into `dist/` and `actions/deploy-pages` preserves it across deploys.

## Common pitfalls

- **Scroll position resets on render.** Because each `render()` wipes `#app.innerHTML`, inner scroll positions of `.policy-reader__body` are lost. The read-gate handlers tolerate this; auto-scroll-to-next-step handles the page-level UX. Don't try to preserve `scrollTop` across renders unless you also change the render model.
- **Vite copies `public/` into `dist/` verbatim.** Anything that needs to be at the site root (CNAME, manifest, service worker, favicon) goes in `public/`, not `src/`.
- **GitHub Pages CORS for `api.github.com`.** The browser fetches policy markdown from the GitHub Contents API directly — this works without auth because the source repo is public. If `undefined-charity/undefined-site` becomes private, the live policy load will fail; pre-bake the policies into the build instead.
- **`crypto.subtle` requires HTTPS.** The payload hash and signature hash use `crypto.subtle.digest`. On `localhost` and `https://` this works; on plain `http://` (other than localhost) it doesn't. Always test on the deployed HTTPS URL before assuming.
- **Camera permission per origin.** `qr-scanner` triggers a camera permission prompt scoped to the origin. The user has to accept it on the production domain, not just on `localhost`.
