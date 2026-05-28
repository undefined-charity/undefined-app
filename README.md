# undefined-app

A small installable HTML5 app for Undefined event terms acceptance, photography consent capture, QR issuance, and kiosk check-in.

## Commands

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Notes

- The app loads the live Terms and Privacy markdown documents from the Undefined site GitHub repository API on every launch.
- Personal and kiosk acceptance flows show both policies in scrollable readers; the acceptance form unlocks only once each policy has been scrolled to the bottom.
- Mode switching uses a small button group at the top-right of the header and defaults to Personal mode.
- App configuration (policy URLs, submission endpoint, organization label, event label) lives in `src/config.js` and is only changeable via a pull request — there is no in-app settings page.

### QR payload (`undefined-accept:v2:` prefix)

Each QR carries a base64url-encoded JSON object with:

- `schema`, `issuer` (the URL the app is hosted at), `organization`, `eventLabel`
- `name`, `email`, `photoConsent`, `signedAt`
- `terms` / `privacy`: `{ sha, lastUpdated }` using the GitHub blob SHA of each policy file
- `signatureHash`: SHA-256 of the PNG data URL of the signature
- `signature` (when it fits): compressed stroke data so kiosks can render the signature for ID comparison without contacting the server
- `payloadHash`: SHA-256 of the canonicalised payload (everything except `payloadHash` itself), recomputed and verified at check-in to detect corruption or tampering

If the signature stroke data won't fit in the QR budget, the QR omits `signature` and keeps only `signatureHash`. The full PNG always goes to the submission endpoint regardless.

### Endpoint POSTs

When `endpointUrl` is set in `src/config.js`, the app POSTs JSON to it with an `action` field:

- `action: 'agree'` — on signing. Body includes `qrPayload`, `acceptance`, `signatureDataUrl` (full PNG), and `issuer`.
- `action: 'checkin'` — on each successful scan. Body includes `qrPayload`, `acceptance`, `scannedAt`, `issuerMatch`, `policyCurrent`, `scanCount`, `firstScannedAt`.

All POSTs include `postedAt` and `scannerIssuer` (the origin the kiosk is served from).

### Kiosk check-in behaviour

On scan, the kiosk:

1. Verifies `payloadHash` against the recomputed canonical hash — rejects corrupted/tampered QRs.
2. Compares `acceptance.issuer` against `window.location.origin` — warns if the QR was issued by a differently-hosted copy of the app.
3. Compares `terms.sha` / `privacy.sha` against the freshly-fetched current SHAs — warns if the attendee needs to re-sign.
4. Looks up `payloadHash` in an in-memory per-session scan log — warns if the same QR was scanned earlier.
5. Renders the embedded signature (when present) for ID comparison.
6. POSTs the result to the configured endpoint with `action: 'checkin'`.
