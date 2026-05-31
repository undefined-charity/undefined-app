import './style.css'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import SignaturePad from 'signature_pad'
import { APP_CONFIG } from './config.js'

marked.use({ mangle: false, headerIds: false })

const STORAGE_KEYS = {
  record: 'undefined-app.record.v3',
  mode: 'undefined-app.mode',
  installDismissed: 'undefined-app.install-dismissed',
}

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

const ACCEPTANCE_PREFIX = 'undefined-accept:v2:'
const ACCEPTANCE_COMPRESSED_PREFIX = 'undefined-accept:v3:'
const PAYLOAD_BUDGET_BYTES = 2400
const PHOTO_CONSENT_LABELS = {
  in: 'Opted in to event photography',
  out: 'Opted out of event photography',
}

const MODES = ['sign', 'checkin']
const MODE_LABELS = {
  sign: 'Sign',
  checkin: 'Check-in',
}

const kioskScanLog = new Map()

const state = {
  mode: loadJson(STORAGE_KEYS.mode, 'sign'),
  showSettings: false,
  loadingDocs: true,
  docsLoadedAt: null,
  docsError: '',
  docs: null,
  record: loadJson(STORAGE_KEYS.record, null),
  checkinResult: null,
  message: '',
  shareSupported:
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function',
  drafts: {
    sign: defaultFormDraft(),
    pastedPayload: '',
  },
  reads: { terms: false, privacy: false },
  installDismissed: loadJson(STORAGE_KEYS.installDismissed, false),
  isStandalone: detectStandaloneDisplay(),
  canInstall: false,
}

const app = document.querySelector('#app')
let activeSignaturePad = null
let activeSignatureKey = null
let qrScanner = null
let deferredInstallPrompt = null

initialize()

async function initialize() {
  registerServiceWorker()
  watchInstallAvailability()
  render()
  await loadPolicyDocuments()
}

function detectStandaloneDisplay() {
  if (typeof window === 'undefined') {
    return false
  }
  const matchesStandalone =
    typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  return matchesStandalone || window.navigator.standalone === true
}

function isIosDevice() {
  if (typeof window === 'undefined') {
    return false
  }
  const ua = window.navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)
}

function watchInstallAvailability() {
  if (typeof window === 'undefined') {
    return
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredInstallPrompt = event
    state.canInstall = true
    render()
  })

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
    state.canInstall = false
    state.isStandalone = true
    render()
  })

  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(display-mode: standalone)').addEventListener?.('change', (event) => {
      state.isStandalone = event.matches
      render()
    })
  }
}

function defaultFormDraft() {
  return {
    name: '',
    email: '',
    photoConsent: 'in',
    acceptTerms: false,
    acceptPrivacy: false,
  }
}

function loadJson(key, fallback) {
  try {
    const value = window.localStorage.getItem(key)
    if (!value) {
      return fallback
    }
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function saveJson(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {})
  })
}

async function loadPolicyDocuments() {
  state.loadingDocs = true
  state.docsError = ''
  render()

  try {
    const [terms, privacy] = await Promise.all([
      fetchPolicyDocument(APP_CONFIG.termsUrl, 'Terms & Conditions'),
      fetchPolicyDocument(APP_CONFIG.privacyUrl, 'Privacy Policy'),
    ])

    state.docs = { terms, privacy }
    state.docsLoadedAt = new Date().toISOString()
  } catch (error) {
    state.docsError = error instanceof Error ? error.message : 'Couldn\u2019t load the latest policies.'
  } finally {
    state.loadingDocs = false
    render()
  }
}

async function fetchPolicyDocument(url, fallbackTitle) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Couldn\u2019t load the latest ${fallbackTitle}. Please try again.`)
  }

  const contentType = response.headers.get('content-type') || ''
  let markdown
  let sha = ''
  if (contentType.includes('application/json')) {
    const payload = await response.json()
    sha = typeof payload.sha === 'string' ? payload.sha : ''
    markdown =
      typeof payload.content === 'string'
        ? fromBase64ToUtf8(payload.content.replace(/\n/g, ''))
        : JSON.stringify(payload)
  } else {
    markdown = await response.text()
  }

  return parsePolicyDocument(markdown, fallbackTitle, url, sha)
}

function parsePolicyDocument(markdown, fallbackTitle, url, sha) {
  const titleMatch = markdown.match(/title:\s*(.+)/i)
  const lastUpdatedMatch = markdown.match(/_Last updated:\s*(.+?)_/i)
  const body = markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/\]\((\/(?!\/)[^)]+)\)/g, '](https://undefined.charity$1)')

  return {
    title: titleMatch ? titleMatch[1].trim() : fallbackTitle,
    lastUpdated: lastUpdatedMatch ? lastUpdatedMatch[1].trim() : 'Unknown',
    sourceUrl: url,
    sha,
    html: DOMPurify.sanitize(marked.parse(body)),
  }
}

function currentPolicySnapshot() {
  if (!state.docs) {
    return null
  }
  return {
    terms: { sha: state.docs.terms.sha, lastUpdated: state.docs.terms.lastUpdated },
    privacy: { sha: state.docs.privacy.sha, lastUpdated: state.docs.privacy.lastUpdated },
  }
}

function getRecordAcceptance(record) {
  return record?.acceptance ?? null
}

function getRecordSummary(record) {
  const acceptance = getRecordAcceptance(record)
  return {
    name: acceptance?.name ?? record?.summary?.name ?? 'Saved attendee',
    email: acceptance?.email ?? '',
    signedAt: acceptance?.signedAt ?? record?.summary?.signedAt ?? '',
    photoConsent: acceptance?.photoConsent ?? record?.summary?.photoConsent ?? 'in',
  }
}

function isPolicyCurrent(termsSha, privacySha) {
  if (!state.docs || !termsSha || !privacySha) {
    return false
  }
  return termsSha === state.docs.terms.sha && privacySha === state.docs.privacy.sha
}

function isAcceptanceCurrent(acceptance) {
  return isPolicyCurrent(acceptance?.terms?.sha, acceptance?.privacy?.sha)
}

function isRecordCurrent(record) {
  const acceptance = getRecordAcceptance(record)
  if (acceptance) {
    return isAcceptanceCurrent(acceptance)
  }
  return isPolicyCurrent(record?.summary?.termsSha, record?.summary?.privacySha)
}

function canonicalJson(value) {
  if (value === undefined) {
    return undefined
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item) ?? 'null').join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  const parts = []
  for (const key of keys) {
    const encoded = canonicalJson(value[key])
    if (encoded !== undefined) {
      parts.push(JSON.stringify(key) + ':' + encoded)
    }
  }
  return '{' + parts.join(',') + '}'
}

function formatSignedAt(value) {
  if (!value) {
    return 'Unknown'
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : 'unknown'
}

function buildDownloadFilename(summary) {
  const slug = (summary.name || '').toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'acceptance'
  const date = summary.signedAt ? summary.signedAt.slice(0, 10) : 'undated'
  return `undefined-acceptance-${slug}-${date}.png`
}

function render() {
  const shouldRunScanner = state.mode === 'checkin' && !state.checkinResult && !state.showSettings
  if (!shouldRunScanner) {
    stopScanner()
  }

  const policyStateMarkup = renderPolicyState()
  const bannerMarkup = renderBanner()
  const installBannerMarkup = renderInstallBanner()
  const messageMarkup = state.message
    ? `<section class="banner banner--warning">${escapeHtml(state.message)}</section>`
    : ''

  app.innerHTML = `
    <div class="shell">
      ${installBannerMarkup}
      <header class="hero">
        <div class="hero-main">
          <h1>Welcome to Undefined</h1>
          <p class="hero-copy">Please take a moment to review our Terms &amp; Conditions and Privacy Policy, then sign to receive your event check-in pass.</p>
          ${policyStateMarkup}
        </div>
      </header>

      ${bannerMarkup}
      ${messageMarkup}

      <main class="content-grid">
        <section class="primary-card">
          ${state.showSettings ? renderSettingsPanel() : renderModePanel()}
        </section>
      </main>

      ${renderFooter()}
    </div>
  `

  bindUi()
  initializeSignaturePad()
  attachPolicyReadGates()
  attachSignatureCanvases()
  if (shouldRunScanner) {
    startScanner()
  }
}

function renderFooter() {
  return `
    <footer class="footer">
      <span class="footer__brand">Undefined Charity</span>
      <span class="footer__sep">·</span>
      <span class="footer__version">v${escapeHtml(APP_VERSION)}</span>
      <span class="footer__sep">·</span>
      <button type="button" class="footer__link" data-action="${state.showSettings ? 'close-settings' : 'open-settings'}">
        ${state.showSettings ? '← Back' : 'Settings ⚙'}
      </button>
    </footer>
  `
}

function renderPolicyState() {
  if (state.loadingDocs) {
    return '<p class="status-pill">Loading the latest policies…</p>'
  }

  if (state.docsError) {
    return `<p class="status-pill status-pill--warning">${escapeHtml(state.docsError)}</p>`
  }

  return `
    <div class="status-stack">
      <p class="status-pill">Terms · updated ${escapeHtml(state.docs.terms.lastUpdated)}</p>
      <p class="status-pill">Privacy · updated ${escapeHtml(state.docs.privacy.lastUpdated)}</p>
    </div>
  `
}

function renderInstallBanner() {
  if (state.isStandalone || state.installDismissed) {
    return ''
  }

  if (state.canInstall && deferredInstallPrompt) {
    return `
      <section class="banner banner--install">
        <div class="banner-install__text">
          <strong>Install this app</strong>
          <span>Add Undefined to your device for quick, offline access to your check-in pass.</span>
        </div>
        <div class="banner-install__actions">
          <button class="primary-button" type="button" data-action="install-app">Install</button>
          <button class="banner-dismiss" type="button" data-action="dismiss-install" aria-label="Dismiss install prompt">&times;</button>
        </div>
      </section>
    `
  }

  if (isIosDevice()) {
    return `
      <section class="banner banner--install">
        <div class="banner-install__text">
          <strong>Install this app</strong>
          <span>Tap the Share button, then choose &ldquo;Add to Home Screen&rdquo; to keep your check-in pass handy.</span>
        </div>
        <div class="banner-install__actions">
          <button class="banner-dismiss" type="button" data-action="dismiss-install" aria-label="Dismiss install prompt">&times;</button>
        </div>
      </section>
    `
  }

  return ''
}

function renderBanner() {
  if (state.mode !== 'sign' || !state.record || state.loadingDocs || state.docsError) {
    return ''
  }

  if (isRecordCurrent(state.record)) {
    return '<section class="banner banner--success">You\u2019re all set. Your pass matches the latest Terms and Privacy Policy.</section>'
  }

  return '<section class="banner banner--warning">Our policies have been updated since you last signed. Please review and sign again before your next event.</section>'
}

function renderModePanel() {
  if (state.loadingDocs) {
    return '<div class="empty-state"><p>Loading the latest policies…</p></div>'
  }

  if (state.docsError) {
    return `
      <div class="empty-state">
        <p>${escapeHtml(state.docsError)}</p>
        <button class="primary-button" type="button" data-action="reload-docs">Try again</button>
      </div>
    `
  }

  if (state.mode === 'checkin') {
    return renderCheckinPanel()
  }

  return renderSigningPanel()
}

function renderSigningPanel() {
  const draft = state.drafts.sign
  const reads = state.reads
  const record = state.record
  const bothRead = reads.terms && reads.privacy
  const disabledAttr = bothRead ? '' : 'disabled'
  const lockedNote = bothRead
    ? ''
    : '<p class="locked-note">Please read both policies (scroll to the end of each one) to enable the form.</p>'

  const intro = record
    ? `
      <div>
        <h2>Your pass</h2>
        <p>This is the pass you signed earlier. Show it to a member of staff at the door. If anything has changed, scroll down to re-sign.</p>
      </div>
    `
    : `
      <div>
        <h2>Sign in</h2>
        <p>Please read both policies below, then enter your details and sign to receive your check-in pass.</p>
      </div>
    `

  const reSignHeading = record
    ? `<div><h3>Re-sign</h3><p>Your details and signature will replace the saved pass above.</p></div>`
    : ''

  return `
    <div class="stack">
      ${intro}

      ${record ? renderSubmissionCard(record) : ''}

      ${reSignHeading}

      ${renderPolicyReader('terms', state.docs.terms, reads.terms)}
      ${renderPolicyReader('privacy', state.docs.privacy, reads.privacy)}

      <form id="sign-form" class="stack form-grid acceptance-form ${bothRead ? '' : 'is-locked'}">
        <h3>Your details</h3>
        ${lockedNote}

        <label>
          <span>Full name</span>
          <input name="name" type="text" autocomplete="name" value="${escapeHtml(draft.name)}" ${disabledAttr} required />
        </label>

        <label>
          <span>Email</span>
          <input name="email" type="email" autocomplete="email" value="${escapeHtml(draft.email)}" ${disabledAttr} required />
        </label>

        <fieldset class="inline-fieldset" ${disabledAttr}>
          <legend>Event photography</legend>
          <label><input type="radio" name="photoConsent" value="in" ${draft.photoConsent === 'in' ? 'checked' : ''} ${disabledAttr} /> I\u2019m happy to be photographed</label>
          <label><input type="radio" name="photoConsent" value="out" ${draft.photoConsent === 'out' ? 'checked' : ''} ${disabledAttr} /> Please don\u2019t photograph me</label>
        </fieldset>

        <label class="checkbox-row">
          <input name="acceptTerms" type="checkbox" ${draft.acceptTerms ? 'checked' : ''} ${disabledAttr} required />
          <span>I have read and accept the Terms &amp; Conditions (updated ${escapeHtml(state.docs.terms.lastUpdated)}).</span>
        </label>

        <label class="checkbox-row">
          <input name="acceptPrivacy" type="checkbox" ${draft.acceptPrivacy ? 'checked' : ''} ${disabledAttr} required />
          <span>I have read and accept the Privacy Policy (updated ${escapeHtml(state.docs.privacy.lastUpdated)}).</span>
        </label>

        <div class="signature-block">
          <div class="signature-header">
            <span>Signature</span>
            <button type="button" class="secondary-button" data-action="clear-signature" ${disabledAttr}>Clear</button>
          </div>
          <canvas id="sign-signature" class="signature-canvas" aria-label="Signature pad"></canvas>
        </div>

        <button class="primary-button" type="submit" ${disabledAttr}>Accept &amp; continue</button>
      </form>
    </div>
  `
}

function renderPolicyReader(docKey, doc, hasRead) {
  return `
    <section class="policy-reader ${hasRead ? 'is-read' : ''}">
      <header class="policy-reader__header">
        <div>
          <h3>${escapeHtml(doc.title)}</h3>
          <p class="policy-meta">Updated ${escapeHtml(doc.lastUpdated)}</p>
        </div>
        <span class="policy-reader__badge">${hasRead ? '✓ Read' : 'Please read'}</span>
      </header>
      <div class="policy-reader__body" data-policy-body data-policy-doc="${docKey}" tabindex="0">
        ${doc.html}
      </div>
    </section>
  `
}

function renderConsentCallout(photoConsent) {
  if (photoConsent === 'in') {
    return `
      <section class="consent-callout consent-callout--in">
        <span class="consent-callout__heading">📷 Photos OK</span>
        <span class="consent-callout__subhead">Agreed to event photography</span>
      </section>
    `
  }
  if (photoConsent === 'out') {
    return `
      <section class="consent-callout consent-callout--out">
        <span class="consent-callout__heading">🚫 No photos</span>
        <span class="consent-callout__subhead">Please respect their preference</span>
      </section>
    `
  }
  return ''
}

function renderSubmissionCard(record) {
  const summary = getRecordSummary(record)
  const current = isRecordCurrent(record)
  const consentCallout = renderConsentCallout(summary.photoConsent)

  if (!record.acceptance || !record.qrDataUrl) {
    return `
      ${consentCallout}
      <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
        <div>
          <h3>Your pass</h3>
          <p>Signed by ${escapeHtml(summary.name)} on ${escapeHtml(formatSignedAt(summary.signedAt))}.</p>
        </div>
        <ul class="result-list">
          <li>${current ? 'Up to date with the latest Terms and Privacy Policy.' : 'Out of date — please sign again before your next event.'}</li>
          <li>Keep your downloaded pass image on this device to show at check-in.</li>
        </ul>
        <div class="button-row">
          <button class="secondary-button" type="button" data-action="reset-sign">Reset</button>
        </div>
      </section>
    `
  }

  return `
    ${consentCallout}
    <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
      <div>
        <h3>Your check-in pass</h3>
        <p>Signed by ${escapeHtml(summary.name)} on ${escapeHtml(formatSignedAt(summary.signedAt))}.</p>
      </div>
      <ul class="result-list">
        <li>${current ? 'Up to date with the latest Terms and Privacy Policy.' : 'Out of date — please sign again before your next event.'}</li>
        <li>Show this pass at check-in. You can also save the image or share it to keep a copy.</li>
      </ul>
      <img class="qr-preview" src="${record.qrDataUrl}" alt="Check-in pass for ${escapeHtml(summary.name)}" />
      <div class="button-row">
        <a class="secondary-button" href="${record.qrDataUrl}" download="${escapeHtml(buildDownloadFilename(summary))}">Save image</a>
        ${state.shareSupported ? '<button class="secondary-button" type="button" data-action="share-qr">Share</button>' : ''}
        <button class="primary-button" type="button" data-action="reset-sign">Reset</button>
      </div>
    </section>
  `
}

function renderCheckinPanel() {
  if (state.checkinResult) {
    return `
      <div class="stack">
        ${renderCheckinResult()}
        <div class="button-row button-row--centered">
          <button class="primary-button" type="button" data-action="reset-checkin">Scan another</button>
        </div>
      </div>
    `
  }

  return `
    <div class="stack">
      <div>
        <h2>Scan a check-in pass</h2>
        <p>Hold the attendee\u2019s pass up to the camera. You can also upload a photo or paste the code text.</p>
      </div>

      <div class="scanner-card">
        <video id="scanner-video" class="scanner-video" playsinline muted></video>
        <div class="button-row">
          <button class="primary-button" type="button" data-action="restart-scanner">Restart camera</button>
          <label class="secondary-button file-button">
            <input id="scan-upload" type="file" accept="image/*" capture="environment" />
            Scan from photo
          </label>
        </div>
        <label>
          <span>Paste pass code</span>
          <textarea id="pasted-payload" rows="4" placeholder="Paste the text of the pass if scanning isn\u2019t available.">${escapeHtml(state.drafts.pastedPayload)}</textarea>
        </label>
        <button class="secondary-button" type="button" data-action="decode-pasted">Check this code</button>
      </div>
    </div>
  `
}

function renderCheckinResult() {
  if (!state.checkinResult) {
    return ''
  }

  if (!state.checkinResult.valid) {
    return `
      <section class="alert-banner alert-banner--danger">
        <strong>⚠ Pass not recognised</strong>
        <span>${escapeHtml(state.checkinResult.message)}</span>
      </section>
    `
  }

  const { acceptance, current, issuerOk, duplicate, signatureStrokes, signatureMessage } = state.checkinResult

  const banners = []
  if (duplicate) {
    banners.push(`
      <section class="alert-banner alert-banner--warning">
        <strong>⚠ Already scanned today</strong>
        <span>First scanned at ${escapeHtml(formatSignedAt(duplicate.firstScannedAt))} \u2014 this is scan #${duplicate.count}. Please check the attendee\u2019s ID before allowing entry.</span>
      </section>
    `)
  }
  if (!issuerOk) {
    banners.push(`
      <section class="alert-banner alert-banner--warning">
        <strong>⚠ Pass from another version of the app</strong>
        <span>This pass wasn\u2019t issued by this kiosk. Please verify the attendee.</span>
      </section>
    `)
  }
  if (!current) {
    banners.push(`
      <section class="alert-banner alert-banner--warning">
        <strong>⚠ Pass is out of date</strong>
        <span>Our policies have been updated since this pass was issued. Please ask the attendee to sign again.</span>
      </section>
    `)
  }

  const consentCallout = renderConsentCallout(acceptance.photoConsent)

  const signatureBlock = signatureStrokes && acceptance.signature
    ? `
      <div class="signature-display">
        <span>Signature</span>
        <canvas data-signature-canvas
                data-signature-width="${escapeHtml(acceptance.signature.width)}"
                data-signature-height="${escapeHtml(acceptance.signature.height)}"></canvas>
      </div>
    `
    : `
      <div class="signature-display">
        <span>Signature</span>
        <p class="signature-display-note">${escapeHtml(signatureMessage || 'This pass does not include a signature to display.')}</p>
      </div>
    `

  return `
    ${banners.join('')}
    ${consentCallout}
    <section class="result-card">
      <h3>${escapeHtml(acceptance.name)}</h3>
      <ul class="result-list">
        <li><strong>Email:</strong> ${escapeHtml(acceptance.email)}</li>
        <li><strong>Signed:</strong> ${escapeHtml(formatSignedAt(acceptance.signedAt))}</li>
        <li><strong>Terms version:</strong> updated ${escapeHtml(acceptance.terms?.lastUpdated ?? 'Unknown')}</li>
        <li><strong>Privacy version:</strong> updated ${escapeHtml(acceptance.privacy?.lastUpdated ?? 'Unknown')}</li>
      </ul>
      ${signatureBlock}
    </section>
  `
}

function getStorageStats() {
  let totalBytes = 0
  const items = []
  for (const [name, key] of Object.entries(STORAGE_KEYS)) {
    const value = window.localStorage.getItem(key)
    if (value !== null) {
      const bytes = new Blob([key + value]).size
      totalBytes += bytes
      items.push({ name, key, bytes })
    }
  }
  return { totalBytes, items }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatRelative(isoString) {
  if (!isoString) return 'never'
  const then = new Date(isoString)
  const diffMs = Date.now() - then.getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)} hr ago`
  return `${Math.round(diffMs / 86_400_000)} days ago`
}

function renderSettingsPanel() {
  const isKiosk = state.mode === 'checkin'
  const storage = getStorageStats()
  const record = state.record
  const recordSummary = record ? getRecordSummary(record) : null
  const recordCurrent = record ? isRecordCurrent(record) : false

  const kioskStats = isKiosk
    ? `
      <section class="settings-block">
        <h3>Kiosk session</h3>
        <ul class="settings-list">
          <li><span>Unique passes scanned</span><strong>${kioskScanLog.size}</strong></li>
          <li><span>Total scans</span><strong>${[...kioskScanLog.values()].reduce((sum, entry) => sum + entry.count, 0)}</strong></li>
        </ul>
        ${kioskScanLog.size > 0 ? '<button class="secondary-button" type="button" data-action="clear-scan-history">Clear scan history</button>' : ''}
      </section>
    `
    : ''

  return `
    <div class="stack settings-panel">
      <div>
        <h2>Settings</h2>
        <p>Behind-the-scenes details and controls for this device.</p>
      </div>

      <section class="settings-block">
        <h3>Kiosk check-in mode</h3>
        <p>Use this device to scan attendees\u2019 passes at the door instead of for signing.</p>
        <label class="toggle">
          <input type="checkbox" data-action="toggle-kiosk-mode" ${isKiosk ? 'checked' : ''} />
          <span class="toggle__track"><span class="toggle__thumb"></span></span>
          <span class="toggle__label">${isKiosk ? 'On — this device is in kiosk check-in mode' : 'Off — this device is for signing'}</span>
        </label>
      </section>

      <section class="settings-block">
        <h3>Saved pass</h3>
        ${
          record
            ? `
              <ul class="settings-list">
                <li><span>Name</span><strong>${escapeHtml(recordSummary.name)}</strong></li>
                <li><span>Signed</span><strong>${escapeHtml(formatSignedAt(recordSummary.signedAt))}</strong></li>
                <li><span>Photo consent</span><strong>${escapeHtml(PHOTO_CONSENT_LABELS[recordSummary.photoConsent] ?? 'Unknown')}</strong></li>
                <li><span>Status</span><strong style="color: ${recordCurrent ? '#047857' : '#b45309'};">${recordCurrent ? 'Up to date' : 'Out of date — please re-sign'}</strong></li>
              </ul>
              <button class="secondary-button" type="button" data-action="clear-saved-pass">Clear saved pass</button>
            `
            : '<p class="settings-empty">No pass saved on this device.</p>'
        }
      </section>

      <section class="settings-block">
        <h3>Current policies</h3>
        ${
          state.docs
            ? `
              <ul class="settings-list">
                <li><span>Terms</span><strong>updated ${escapeHtml(state.docs.terms.lastUpdated)} <code>${escapeHtml(shortSha(state.docs.terms.sha))}</code></strong></li>
                <li><span>Privacy</span><strong>updated ${escapeHtml(state.docs.privacy.lastUpdated)} <code>${escapeHtml(shortSha(state.docs.privacy.sha))}</code></strong></li>
                <li><span>Last loaded</span><strong>${escapeHtml(formatRelative(state.docsLoadedAt))}</strong></li>
              </ul>
            `
            : '<p class="settings-empty">Policies haven\u2019t loaded yet.</p>'
        }
        <button class="secondary-button" type="button" data-action="refresh-policies">Refresh policies</button>
      </section>

      ${kioskStats}

      <section class="settings-block">
        <h3>This device</h3>
        <ul class="settings-list">
          <li><span>App version</span><strong>v${escapeHtml(APP_VERSION)}</strong></li>
          <li><span>Origin</span><strong><code>${escapeHtml(window.location.origin)}</code></strong></li>
          <li><span>Local storage used</span><strong>${formatBytes(storage.totalBytes)}</strong></li>
          ${storage.items.map((item) => `<li><span>&nbsp;\u00b7 <code>${escapeHtml(item.key)}</code></span><strong>${formatBytes(item.bytes)}</strong></li>`).join('')}
        </ul>
      </section>

      <section class="settings-block">
        <h3>Danger zone</h3>
        <p>Clear all local data on this device. Won\u2019t affect anything on Undefined\u2019s servers.</p>
        <button class="danger-button" type="button" data-action="reset-everything">Reset everything</button>
      </section>
    </div>
  `
}

function bindUi() {
  document.querySelector('[data-action="dismiss-install"]')?.addEventListener('click', () => {
    state.installDismissed = true
    saveJson(STORAGE_KEYS.installDismissed, true)
    render()
  })

  document.querySelector('[data-action="install-app"]')?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      return
    }
    deferredInstallPrompt.prompt()
    let outcome = 'dismissed'
    try {
      ({ outcome } = await deferredInstallPrompt.userChoice)
    } catch {
      // Keep the default 'dismissed' outcome if the choice can't be read.
    }
    deferredInstallPrompt = null
    state.canInstall = false
    if (outcome === 'accepted') {
      state.installDismissed = true
      saveJson(STORAGE_KEYS.installDismissed, true)
    }
    render()
  })

  document.querySelector('[data-action="open-settings"]')?.addEventListener('click', () => {
    state.showSettings = true
    render()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  document.querySelector('[data-action="close-settings"]')?.addEventListener('click', () => {
    state.showSettings = false
    render()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  document.querySelector('[data-action="toggle-kiosk-mode"]')?.addEventListener('change', (event) => {
    const enabled = event.target.checked
    state.mode = enabled ? 'checkin' : 'sign'
    state.checkinResult = null
    if (enabled) {
      saveJson(STORAGE_KEYS.mode, 'checkin')
    } else {
      window.localStorage.removeItem(STORAGE_KEYS.mode)
    }
    render()
  })

  document.querySelector('[data-action="clear-saved-pass"]')?.addEventListener('click', () => {
    if (!confirm('Clear your saved pass from this device? You\u2019ll need to sign again before your next event.')) {
      return
    }
    state.record = null
    window.localStorage.removeItem(STORAGE_KEYS.record)
    render()
  })

  document.querySelector('[data-action="clear-scan-history"]')?.addEventListener('click', () => {
    if (!confirm('Clear the kiosk scan history for this session?')) {
      return
    }
    kioskScanLog.clear()
    state.checkinResult = null
    render()
  })

  document.querySelector('[data-action="reset-everything"]')?.addEventListener('click', () => {
    if (!confirm('Reset everything on this device? This clears your saved pass, kiosk mode, scan history, and all local data.')) {
      return
    }
    Object.values(STORAGE_KEYS).forEach((key) => window.localStorage.removeItem(key))
    kioskScanLog.clear()
    state.record = null
    state.mode = 'sign'
    state.showSettings = false
    state.checkinResult = null
    state.drafts.sign = defaultFormDraft()
    state.reads = { terms: false, privacy: false }
    render()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  document.querySelector('[data-action="refresh-policies"]')?.addEventListener('click', () => {
    void loadPolicyDocuments()
  })

  document.querySelector('[data-action="reload-docs"]')?.addEventListener('click', () => {
    void loadPolicyDocuments()
  })

  document.querySelectorAll('[data-action="clear-signature"]').forEach((button) => {
    button.addEventListener('click', () => {
      activeSignaturePad?.clear()
    })
  })

  document.querySelector('[data-action="share-qr"]')?.addEventListener('click', async () => {
    if (!state.record?.qrDataUrl) {
      return
    }

    try {
      const file = await dataUrlToFile(state.record.qrDataUrl, 'undefined-acceptance.png')
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Undefined acceptance QR' })
      }
    } catch {
      state.message = 'Couldn\u2019t share the pass on this device.'
      render()
    }
  })

  document.querySelector('[data-action="reset-sign"]')?.addEventListener('click', () => {
    if (!confirm('Reset and clear your saved pass from this device? You\u2019ll need to sign again before your next event.')) {
      return
    }
    state.record = null
    state.drafts.sign = defaultFormDraft()
    state.reads = { terms: false, privacy: false }
    state.message = ''
    window.localStorage.removeItem(STORAGE_KEYS.record)
    render()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  document.querySelector('[data-action="restart-scanner"]')?.addEventListener('click', () => {
    void startScanner(true)
  })

  document.querySelector('[data-action="reset-checkin"]')?.addEventListener('click', () => {
    state.checkinResult = null
    state.drafts.pastedPayload = ''
    state.message = ''
    render()
  })

  document.querySelector('[data-action="decode-pasted"]')?.addEventListener('click', () => {
    const textarea = document.querySelector('#pasted-payload')
    if (!textarea) {
      return
    }
    state.drafts.pastedPayload = textarea.value.trim()
    void decodeAndStoreAcceptance(textarea.value.trim())
  })

  document.querySelector('#scan-upload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const result = await QrScanner.scanImage(file)
      await decodeAndStoreAcceptance(result)
    } catch {
      state.checkinResult = { valid: false, message: 'Couldn\u2019t find a code in that photo. Please try another.' }
      render()
    }
  })

  const signForm = document.querySelector('#sign-form')
  if (signForm) {
    signForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      await submitSigningForm()
    })
    signForm.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => syncFormDraft(input))
      input.addEventListener('change', () => syncFormDraft(input))
    })
  }
}

function attachPolicyReadGates() {
  document.querySelectorAll('[data-policy-body]').forEach((node) => {
    const docKey = node.dataset.policyDoc
    if (!docKey) {
      return
    }

    const markRead = (advance = false) => {
      if (state.reads[docKey]) {
        return
      }
      state.reads[docKey] = true
      render()
      if (advance) {
        scrollToNextSigningStep(docKey)
      }
    }

    requestAnimationFrame(() => {
      if (node.scrollHeight - node.clientHeight <= 4) {
        markRead(false)
      }
    })

    node.addEventListener('scroll', () => {
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      if (distanceFromBottom <= 12) {
        markRead(true)
      }
    })
  })
}

function scrollToNextSigningStep(justReadDocKey) {
  requestAnimationFrame(() => {
    const otherDoc = justReadDocKey === 'terms' ? 'privacy' : 'terms'
    const target = state.reads[otherDoc]
      ? document.querySelector('#sign-form')
      : document.querySelector(`[data-policy-doc="${otherDoc}"]`)?.closest('.policy-reader')
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function syncFormDraft(input) {
  const draft = state.drafts.sign
  if (input.type === 'checkbox') {
    draft[input.name] = input.checked
    return
  }

  if (input.type === 'radio') {
    if (input.checked) {
      draft[input.name] = input.value
    }
    return
  }

  draft[input.name] = input.value
}

function initializeSignaturePad() {
  const canvas = document.querySelector('#sign-signature')
  if (!canvas) {
    activeSignaturePad = null
    activeSignatureKey = null
    return
  }

  activeSignatureKey = 'sign'
  resizeSignatureCanvas(canvas)
  activeSignaturePad = new SignaturePad(canvas, {
    penColor: '#111827',
    minWidth: 1,
    maxWidth: 2.5,
  })

  window.addEventListener('resize', () => resizeSignatureCanvas(canvas), { once: true })
}

function resizeSignatureCanvas(canvas) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1)
  const bounds = canvas.getBoundingClientRect()
  canvas.width = bounds.width * ratio
  canvas.height = bounds.height * ratio
  canvas.getContext('2d').scale(ratio, ratio)
}

async function submitSigningForm() {
  if (!state.reads.terms || !state.reads.privacy) {
    state.message = 'Please read both policies to the end before continuing.'
    render()
    return
  }

  const form = document.querySelector('#sign-form')
  if (!form?.reportValidity()) {
    return
  }

  if (!activeSignaturePad || activeSignaturePad.isEmpty()) {
    alert('Please sign before continuing.')
    return
  }

  const formData = new FormData(form)
  const signedAt = new Date().toISOString()
  const photoConsent = formData.get('photoConsent').toString()
  const snapshot = currentPolicySnapshot()
  const signature = await extractSignature()

  const baseAcceptance = {
    schema: 'undefined-charity/acceptance@2',
    issuer: window.location.origin,
    organization: APP_CONFIG.organizationName,
    eventLabel: APP_CONFIG.eventLabel || undefined,
    name: formData.get('name').toString().trim(),
    email: formData.get('email').toString().trim(),
    photoConsent,
    signedAt,
    terms: snapshot.terms,
    privacy: snapshot.privacy,
    signatureHash: signature.signatureHash,
  }

  let acceptance = await finalizeAcceptance(baseAcceptance, signature.qrSignature)
  let payload = await encodeAcceptancePayload(acceptance)
  let omittedSignature = false

  if (payload.length > PAYLOAD_BUDGET_BYTES && acceptance.signature) {
    omittedSignature = true
    const stripped = { ...baseAcceptance }
    acceptance = await finalizeAcceptance(stripped, null)
    payload = await encodeAcceptancePayload(acceptance)
  }

  const qrDataUrl = await createQrCodeDataUrl(payload)
  const endpointResult = await submitToEndpoint({
    action: 'agree',
    qrPayload: payload,
    qrDataUrl,
    acceptance,
    signatureDataUrl: signature.signatureDataUrl,
    issuer: acceptance.issuer,
  })

  const record = {
    acceptance,
    payload,
    qrDataUrl,
    endpointResult,
    omittedSignature,
    signatureDataUrl: signature.signatureDataUrl,
  }
  state.message = ''
  state.record = record
  persistRecord(record)

  state.drafts.sign = defaultFormDraft()
  state.reads = { terms: false, privacy: false }
  render()
  scrollToQrResult()
}

function persistRecord(record) {
  saveJson(STORAGE_KEYS.record, {
    acceptance: record.acceptance,
    payload: record.payload,
    qrDataUrl: record.qrDataUrl,
    signatureDataUrl: record.signatureDataUrl,
    omittedSignature: record.omittedSignature,
    savedAt: new Date().toISOString(),
  })
}

function scrollToQrResult() {
  requestAnimationFrame(() => {
    const target = document.querySelector('.qr-preview')?.closest('.result-card') ?? document.querySelector('.qr-preview')
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

async function extractSignature() {
  const data = activeSignaturePad.toData()
  const canvas = activeSignaturePad.canvas
  const bounds = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.round(bounds.width))
  const height = Math.max(1, Math.round(bounds.height))
  const strokes = data.map((stroke) => simplifyStroke(
    stroke.points.map((p) => [Math.round(p.x), Math.round(p.y)]),
  ))
  const signatureDataUrl = activeSignaturePad.toDataURL('image/png')
  const signatureHash = await hashText(signatureDataUrl)
  const encoded = await encodeStrokes(strokes)
  return {
    signatureDataUrl,
    signatureHash,
    qrSignature: encoded ? { ...encoded, width, height, format: 'strokes-v1' } : null,
  }
}

function simplifyStroke(points, minDistance = 1.5) {
  if (points.length <= 2) {
    return points
  }
  const minDistSq = minDistance * minDistance
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]
    const dx = points[i][0] - last[0]
    const dy = points[i][1] - last[1]
    if (dx * dx + dy * dy >= minDistSq) {
      out.push(points[i])
    }
  }
  out.push(points[points.length - 1])
  return out
}

async function finalizeAcceptance(base, qrSignature) {
  const candidate = { ...base }
  if (qrSignature) {
    candidate.signature = qrSignature
  }
  const payloadHash = await hashText(canonicalJson(candidate))
  return { ...candidate, payloadHash }
}

async function encodeStrokes(strokes) {
  const json = JSON.stringify(strokes)
  if (typeof CompressionStream === 'undefined') {
    return { compression: 'none', encoded: toBase64Url(json) }
  }

  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const buffer = await new Response(stream).arrayBuffer()
    return {
      compression: 'deflate-raw',
      encoded: bytesToBase64Url(new Uint8Array(buffer)),
    }
  } catch {
    return { compression: 'none', encoded: toBase64Url(json) }
  }
}

async function decodeStrokes(signature) {
  if (!signature?.encoded) {
    return []
  }

  if (signature.compression === 'none') {
    return JSON.parse(fromBase64Url(signature.encoded))
  }

  if (signature.compression === 'deflate-raw' && typeof DecompressionStream !== 'undefined') {
    const bytes = base64UrlToBytes(signature.encoded)
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    const buffer = await new Response(stream).arrayBuffer()
    return JSON.parse(new TextDecoder().decode(buffer))
  }

  if (signature.compression === 'deflate-raw') {
    throw new Error('This signature requires browser features that are not available on this device.')
  }

  throw new Error(`Unsupported signature compression: ${signature.compression}`)
}

async function encodeAcceptancePayload(acceptance) {
  const json = JSON.stringify(acceptance)
  const compressed = await compressPayload(json)
  if (compressed) {
    return `${ACCEPTANCE_COMPRESSED_PREFIX}${bytesToBase64Url(compressed)}`
  }
  return `${ACCEPTANCE_PREFIX}${toBase64Url(json)}`
}

async function decodeAcceptancePayload(payload) {
  if (payload.startsWith(ACCEPTANCE_COMPRESSED_PREFIX)) {
    const bytes = base64UrlToBytes(payload.slice(ACCEPTANCE_COMPRESSED_PREFIX.length))
    return JSON.parse(await decompressPayload(bytes))
  }
  if (payload.startsWith(ACCEPTANCE_PREFIX)) {
    return JSON.parse(fromBase64Url(payload.slice(ACCEPTANCE_PREFIX.length)))
  }

  return JSON.parse(payload)
}

async function createQrCodeDataUrl(payload) {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 720,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  })
}

async function submitToEndpoint(body) {
  if (!APP_CONFIG.endpointUrl) {
    return { ok: true, skipped: true }
  }

  let endpoint
  try {
    endpoint = new URL(APP_CONFIG.endpointUrl)
  } catch {
    return { ok: false, message: 'Endpoint URL is not valid.' }
  }

  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    return { ok: false, message: 'Endpoint URL must use http or https.' }
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        postedAt: new Date().toISOString(),
        scannerIssuer: window.location.origin,
      }),
    })

    if (!response.ok) {
      return { ok: false, message: `Endpoint returned ${response.status}.` }
    }

    return { ok: true, skipped: false }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Submission failed.',
    }
  }
}

async function startScanner(forceRestart = false) {
  const video = document.querySelector('#scanner-video')
  if (!video) {
    return
  }

  if (forceRestart) {
    stopScanner()
  }

  if (qrScanner) {
    return
  }

  qrScanner = new QrScanner(
    video,
    (result) => {
      const payload = typeof result === 'string' ? result : result?.data
      void decodeAndStoreAcceptance(payload)
    },
    {
      returnDetailedScanResult: true,
      highlightScanRegion: true,
      highlightCodeOutline: true,
    },
  )

  try {
    await qrScanner.start()
  } catch {
    state.checkinResult = {
      valid: false,
      message: 'Camera isn\u2019t available. Try uploading a photo or pasting the code.',
    }
    render()
  }
}

function stopScanner() {
  if (!qrScanner) {
    return
  }

  qrScanner.stop()
  qrScanner.destroy()
  qrScanner = null
}

async function decodeAndStoreAcceptance(payload) {
  if (!payload) {
    return
  }

  let acceptance
  try {
    acceptance = await decodeAcceptancePayload(payload)
  } catch (error) {
    state.checkinResult = {
      valid: false,
      message: error instanceof Error && error.message
        ? error.message
        : 'That doesn\u2019t look like an Undefined event pass.',
    }
    render()
    return
  }

  const claimedHash = acceptance.payloadHash
  if (!claimedHash) {
    state.checkinResult = {
      valid: false,
      message: 'This pass was issued by an older version of the app. Please ask the attendee to sign again.',
    }
    render()
    return
  }

  const { payloadHash: _ignored, ...rest } = acceptance
  const expectedHash = await hashText(canonicalJson(rest))
  if (expectedHash !== claimedHash) {
    state.checkinResult = {
      valid: false,
      message: 'This pass appears damaged or invalid. Please ask the attendee to sign again.',
    }
    render()
    return
  }

  const expectedIssuer = window.location.origin
  const issuerOk = acceptance.issuer === expectedIssuer
  const current = isAcceptanceCurrent(acceptance)

  const scannedAt = new Date()
  const previous = kioskScanLog.get(claimedHash)
  const duplicate = previous
    ? { firstScannedAt: previous.firstScannedAt, count: previous.count + 1 }
    : null
  kioskScanLog.set(claimedHash, {
    firstScannedAt: previous?.firstScannedAt ?? scannedAt.toISOString(),
    count: (previous?.count ?? 0) + 1,
  })

  let signatureStrokes = null
  let signatureMessage = ''
  if (acceptance.signature) {
    try {
      signatureStrokes = await decodeStrokes(acceptance.signature)
    } catch (error) {
      signatureStrokes = null
      signatureMessage = error instanceof Error && error.message
        ? error.message
        : 'The signature data could not be read.'
    }
  } else {
    signatureMessage = 'This pass does not include a signature to display.'
  }

  let regeneratedQrDataUrl = ''
  try {
    regeneratedQrDataUrl = await createQrCodeDataUrl(payload)
  } catch {
    regeneratedQrDataUrl = ''
  }

  let regeneratedSignatureDataUrl = ''
  if (signatureStrokes && acceptance.signature) {
    try {
      const offscreen = document.createElement('canvas')
      renderSignatureToCanvas(
        offscreen,
        signatureStrokes,
        acceptance.signature.width,
        acceptance.signature.height,
      )
      regeneratedSignatureDataUrl = offscreen.toDataURL('image/png')
    } catch {
      regeneratedSignatureDataUrl = ''
    }
  }

  const endpointResult = await submitToEndpoint({
    action: 'checkin',
    qrPayload: payload,
    qrDataUrl: regeneratedQrDataUrl,
    signatureDataUrl: regeneratedSignatureDataUrl,
    acceptance,
    scannedAt: scannedAt.toISOString(),
    issuerMatch: issuerOk,
    policyCurrent: current,
    scanCount: (previous?.count ?? 0) + 1,
    firstScannedAt: previous?.firstScannedAt ?? scannedAt.toISOString(),
  })

  state.checkinResult = {
    valid: true,
    acceptance,
    current,
    issuerOk,
    expectedIssuer,
    duplicate,
    signatureStrokes,
    signatureMessage,
    endpointResult,
  }
  render()
}

function attachSignatureCanvases() {
  if (!state.checkinResult?.signatureStrokes) {
    return
  }

  document.querySelectorAll('[data-signature-canvas]').forEach((canvas) => {
    const width = Number.parseInt(canvas.dataset.signatureWidth, 10) || 600
    const height = Number.parseInt(canvas.dataset.signatureHeight, 10) || 240
    renderSignatureToCanvas(canvas, state.checkinResult.signatureStrokes, width, height)
  })
}

function renderSignatureToCanvas(canvas, strokes, width, height) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1)
  canvas.width = width * ratio
  canvas.height = height * ratio
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  ctx.scale(ratio, ratio)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#111827'
  ctx.fillStyle = '#111827'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  strokes.forEach((stroke) => {
    if (!stroke?.length) {
      return
    }
    if (stroke.length === 1) {
      ctx.beginPath()
      ctx.arc(stroke[0][0], stroke[0][1], 1.5, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.beginPath()
    ctx.moveTo(stroke[0][0], stroke[0][1])
    for (let i = 1; i < stroke.length; i++) {
      ctx.lineTo(stroke[i][0], stroke[i][1])
    }
    ctx.stroke()
  })
}

function bytesToBase64Url(bytes) {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  const binary = atob(`${normalized}${padding}`)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function toBase64Url(value) {
  return encodeUtf8ToBase64(value)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return decodeBase64ToUtf8(`${normalized}${padding}`)
}

function fromBase64ToUtf8(value) {
  return decodeBase64ToUtf8(value)
}

function encodeUtf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

function decodeBase64ToUtf8(value) {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function hashText(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('')
}

async function dataUrlToFile(dataUrl, filename) {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], filename, { type: blob.type })
}

async function compressPayload(value) {
  if (typeof CompressionStream === 'undefined') {
    return null
  }
  try {
    const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const buffer = await new Response(stream).arrayBuffer()
    return new Uint8Array(buffer)
  } catch {
    return null
  }
}

async function decompressPayload(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This pass requires compression support that is not available in this browser. Please try a different device or update your browser.')
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new TextDecoder().decode(buffer)
}
