# undefined-app

A small installable HTML5 app for Undefined event terms acceptance, photography consent capture, QR issuance, and check-in.

## Commands

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Modes

Two modes, switched via the small button group at the top-right of the header:

- **Sign** (default) — read the live Terms and Privacy markdown documents, sign once, generate a QR, and either keep it personally or hit **Reset & sign again** for the next attendee on the same device.
- **Check-in** — scan a QR, validate it against the current policy versions, warn on duplicate scans and on QRs issued by a different host.

Configuration (policy URLs, submission endpoint, organization label, event label) lives in `src/config.js` and is intentionally git-only — there is no in-app settings page.

## QR payload (`undefined-accept:v2:` prefix)

Each QR carries a base64url-encoded JSON object with:

- `schema`, `issuer` (the URL the app is hosted at), `organization`, `eventLabel`
- `name`, `email`, `photoConsent`, `signedAt`
- `terms` / `privacy`: `{ sha, lastUpdated }` using the GitHub blob SHA of each policy file
- `signatureHash`: SHA-256 of the PNG data URL of the signature
- `signature` (when it fits): compressed stroke data (Ramer-Douglas-Peucker-style distance simplification + deflate-raw + base64url) so kiosks can render the signature for ID comparison without contacting the server
- `payloadHash`: SHA-256 of the canonicalised payload (everything except `payloadHash` itself), recomputed and verified at check-in to detect corruption or tampering

If the signature stroke data won't fit in the QR budget (~2400 bytes), the QR omits `signature` and keeps only `signatureHash`. The full PNG always goes to the submission endpoint regardless.

The QR is rendered at 720×720 (with a 2-module quiet zone) so a phone camera can capture it cleanly from a screen.

## Endpoint POSTs

When `endpointUrl` is set in `src/config.js`, the app POSTs JSON to it with an `action` field:

- `action: 'agree'` — on signing. Body includes `qrPayload`, `acceptance`, `signatureDataUrl` (full PNG), and `issuer`.
- `action: 'checkin'` — on each successful scan. Body includes `qrPayload`, `acceptance`, `scannedAt`, `issuerMatch`, `policyCurrent`, `scanCount`, `firstScannedAt`.

All POSTs include `postedAt` and `scannerIssuer` (the origin the device is served from).

## Kiosk check-in behaviour

On scan, the kiosk:

1. Verifies `payloadHash` against the recomputed canonical hash — rejects corrupted/tampered QRs.
2. Compares `acceptance.issuer` against `window.location.origin` — warns if the QR was issued by a differently-hosted copy of the app.
3. Compares `terms.sha` / `privacy.sha` against the freshly-fetched current SHAs — warns if the attendee needs to re-sign.
4. Looks up `payloadHash` in an in-memory per-session scan log — warns if the same QR was scanned earlier.
5. Renders the embedded signature (when present) for ID comparison.
6. POSTs the result to the configured endpoint with `action: 'checkin'`.
