# Undefined event consent

A small, installable web app that lets attendees of Undefined charity events review the current **Terms & Conditions** and **Privacy Policy**, capture their consent and photography preference with a signature, and receive a check-in pass that any Undefined device can validate at the door.

Live at **https://tos.undefined.charity**.

## How it works

### For attendees

1. Open the app on your phone (or use the kiosk provided at the event).
2. Read the Terms & Conditions and Privacy Policy in full.
3. Enter your name, email, photography preference, and signature.
4. You receive a check-in pass — keep the image on your phone, save it, or share it.

### For event staff

1. Switch the app to **Check-in** (top-right of the page).
2. Hold the attendee's pass up to the camera, or upload a photo of it.
3. The screen shows a large **Photos OK** or **No photos** banner and the attendee's details.
4. Warnings appear at the top if the pass has already been scanned, was issued by a different version of the app, or was signed against older policy versions.

## Configuration

Everything site-wide lives in [`src/config.js`](src/config.js) and is intentionally **not** editable from inside the app — it can only be changed by opening a pull request. The values are:

- `timeZone` — used when rendering signed timestamps in the app (defaults to Seattle time).
- `endpointUrl` — n8n webhook that receives every signing (`action: "agree"`) and every successful check-in (`action: "checkin"`).
- `termsUrl` and `privacyUrl` — GitHub Contents API URLs for the canonical Terms and Privacy markdown documents. The app fetches these live on every launch.

## QR pass contents and verification

There are no signing keys, certificates, or shared secrets. The QR text encodes an acceptance JSON payload.

### What is inside the QR payload

Passes currently include:

- `issuer` — the origin that issued the pass (for example `https://tos.undefined.charity`).
- `name`, `email`, `photoConsent`, `signedAt` — attendee details and signing timestamp.
- `policyVersion` — a single value in the form `${termsSha}:${privacySha}` used for policy freshness checks.
- `terms` and `privacy` — policy snapshot display text (`lastUpdated`).
- `signature` — optional compressed stroke data (`format: strokes-v1`) plus width/height. This is omitted when needed to stay within QR size budget.
- `payloadHash` — SHA-256 hash of the canonicalised payload (excluding `payloadHash` itself) used as the tamper-evident integrity check.

### How the QR payload is generated

1. The app captures form data, current policy snapshots, and the drawn signature.
2. It computes `policyVersion` from the current Terms and Privacy commit SHAs (`termsSha:privacySha`).
3. It attempts to encode signature strokes for kiosk display.
4. It computes `payloadHash` from canonical JSON (sorted keys, stable encoding).
5. It encodes the final acceptance object into QR text:
   - Preferred: `undefined-accept:v3:` + deflate-raw-compressed base64url JSON.
   - Fallback: `undefined-accept:v2:` + plain base64url JSON.
6. If the payload is too large, it regenerates the pass without the `signature` object, then re-hashes and re-encodes.

### What check-in actively uses today

At scan time the kiosk decodes the payload and directly uses:

1. Recomputes the payload hash and rejects the pass if it doesn't match (catches corruption or hand-edits).
2. Compares the embedded `issuer` URL against its own origin and warns on mismatch (catches passes from a different deployment).
3. Compares the embedded `policyVersion` against the live policy version and warns if the attendee should sign again.
4. Looks the pass up in a per-session scan log and warns on a repeat scan.

It also displays attendee details (`name`, `email`, `signedAt`, `photoConsent`) and renders the signature if a `signature` object is present and decodable.

The pass is tamper-evident, not authenticated — staff are expected to verify ID at the door for anything significant.

## Local development

```sh
npm install
npm run dev      # local server on http://localhost:5173
npm run build    # production bundle in dist/
npm run preview  # serve the production bundle
```

## Deployment

This repository auto-deploys to GitHub Pages from `main` via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). On every push to `main`:

1. `npm ci && npm run build` runs on a fresh runner.
2. The contents of `dist/` (including `public/CNAME` so the custom domain persists) are uploaded as a Pages artifact.
3. `actions/deploy-pages@v4` publishes the artifact.

Pull requests run the build only.

### One-time setup

- **GitHub Pages:** Repo Settings → Pages → Source = `GitHub Actions`. The workflow uses `actions/configure-pages@v5` with `enablement: true`, so this should self-configure the first time it runs — but you may need to flip it manually if your org disallows that.
- **DNS for `tos.undefined.charity`:** at the registrar, add either a `CNAME` pointing to `undefined-charity.github.io`, or A records pointing to GitHub Pages' apex IPs (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`).
- **HTTPS:** once DNS resolves, tick **Enforce HTTPS** in repo Settings → Pages. Let's Encrypt provisions a certificate automatically.

### n8n webhook (CORS)

The browser POSTs to the n8n webhook from `tos.undefined.charity`, which is cross-origin. The webhook must respond to preflight `OPTIONS` requests and include `Access-Control-Allow-Origin: https://tos.undefined.charity` (or `*`) on its responses. In n8n, the simplest path is to open the Webhook node, add the **Allowed Origins (CORS)** option, and set it to the production URL.

## Privacy

- Each device stores a tiny, non-identifying summary of the last issued pass in `localStorage` (under the key `undefined-app.record.v3`) so it can warn the holder when policies change. A couple of other non-identifying preferences are also kept in `localStorage` — the selected mode (`undefined-app.mode`) and whether the "install this app" banner has been dismissed (`undefined-app.install-dismissed`). There is no other client-side persistence.
- The full signature image is sent to the configured n8n webhook at signing time and is **not** retained on the device.
- There is no analytics, no third-party tracking, no central database of attendees on Undefined's side — only whatever the n8n workflow chooses to record.

## Project structure

```
src/
  main.js       single-page render-on-state-change UI
  style.css     all styles
  config.js     site-wide configuration (PR-only)
public/
  CNAME         custom domain for GitHub Pages
  manifest.webmanifest
  service-worker.js
  icon.svg
.github/
  workflows/
    deploy.yml  build on PR, build + deploy on push to main
  copilot-instructions.md
```
