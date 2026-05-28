# undefined-app

A small installable HTML5 app for Undefined event terms acceptance, photography consent capture, QR certificate issuance, and kiosk check-in.

## Commands

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Notes

- The app loads the public Terms and Privacy markdown documents from the Undefined site GitHub repository API by default.
- Personal mode stores the latest generated certificate in local storage and warns when the policy timestamps change.
- Kiosk sign mode generates a QR for attendees to photograph, while kiosk check-in mode validates scanned QR payloads against the current policy timestamps.
- Set a submission endpoint in Settings to POST `{ qrPayload, certificate }` for each signature.
