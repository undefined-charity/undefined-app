import './style.css'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import SignaturePad from 'signature_pad'

marked.use({ mangle: false, headerIds: false })

const STORAGE_KEYS = {
  personalRecord: 'undefined-app.personal-record',
  settings: 'undefined-app.settings',
}

const DEFAULT_SETTINGS = {
  organizationName: 'Undefined',
  endpointUrl: '',
  eventLabel: '',
  termsUrl:
    'https://api.github.com/repos/undefined-charity/undefined-site/contents/src/content/terms/-index.md?ref=main',
  privacyUrl:
    'https://api.github.com/repos/undefined-charity/undefined-site/contents/src/content/privacy/-index.md?ref=main',
}

const CERTIFICATE_PREFIX = 'undefined-cert:v1:'
const PHOTO_CONSENT_LABELS = {
  in: 'Opted in to event photography',
  out: 'Opted out of event photography',
}

const state = {
  mode: 'personal',
  loadingDocs: true,
  docsError: '',
  docs: null,
  settings: loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
  personalRecord: loadJson(STORAGE_KEYS.personalRecord, null),
  kioskRecord: null,
  checkinResult: null,
  message: '',
  shareSupported:
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function',
  drafts: {
    personal: defaultFormDraft(),
    kiosk: defaultFormDraft(),
    settings: loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
    pastedPayload: '',
  },
}

const app = document.querySelector('#app')
let activeSignaturePad = null
let activeSignatureKey = null
let qrScanner = null

initialize()

async function initialize() {
  registerServiceWorker()
  render()
  await loadPolicyDocuments()
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

    const parsed = JSON.parse(value)
    if (
      fallback &&
      typeof fallback === 'object' &&
      !Array.isArray(fallback) &&
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return { ...fallback, ...parsed }
    }

    return parsed
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
      fetchPolicyDocument(state.settings.termsUrl, 'Terms & Conditions'),
      fetchPolicyDocument(state.settings.privacyUrl, 'Privacy Policy'),
    ])

    state.docs = { terms, privacy }
  } catch (error) {
    state.docsError = error instanceof Error ? error.message : 'Unable to load policy documents.'
  } finally {
    state.loadingDocs = false
    render()
  }
}

async function fetchPolicyDocument(url, fallbackTitle) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Unable to load ${fallbackTitle} from ${url}.`)
  }

  const contentType = response.headers.get('content-type') || ''
  let markdown
  if (contentType.includes('application/json')) {
    const payload = await response.json()
    markdown =
      typeof payload.content === 'string'
        ? fromBase64ToUtf8(payload.content.replace(/\n/g, ''))
        : JSON.stringify(payload)
  } else {
    markdown = await response.text()
  }

  return parsePolicyDocument(markdown, fallbackTitle, url)
}

function parsePolicyDocument(markdown, fallbackTitle, url) {
  const titleMatch = markdown.match(/title:\s*(.+)/i)
  const lastUpdatedMatch = markdown.match(/_Last updated:\s*(.+?)_/i)
  const body = markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/\]\((\/(?!\/)[^)]+)\)/g, '](https://undefined.charity$1)')

  return {
    title: titleMatch ? titleMatch[1].trim() : fallbackTitle,
    lastUpdated: lastUpdatedMatch ? lastUpdatedMatch[1].trim() : 'Unknown',
    sourceUrl: url,
    html: DOMPurify.sanitize(marked.parse(body)),
  }
}

function currentPolicyVersion() {
  if (!state.docs) {
    return null
  }

  return {
    digest: `${state.docs.terms.lastUpdated}::${state.docs.privacy.lastUpdated}`,
    termsUpdated: state.docs.terms.lastUpdated,
    privacyUpdated: state.docs.privacy.lastUpdated,
    termsSource: state.settings.termsUrl,
    privacySource: state.settings.privacyUrl,
  }
}

function getRecordCertificate(record) {
  return record?.certificate ?? null
}

function getRecordSummary(record) {
  const certificate = getRecordCertificate(record)
  return {
    name: certificate?.attendee?.name ?? record?.summary?.name ?? 'Saved attendee',
    email: certificate?.attendee?.email ?? '',
    signedAt: certificate?.signedAt ?? record?.summary?.signedAt ?? '',
    photoConsent: certificate?.photoConsent ?? record?.summary?.photoConsent ?? 'in',
    policyVersion: certificate?.policyVersion ?? record?.policyVersion ?? null,
  }
}

function isPolicyVersionCurrent(policyVersion) {
  if (!policyVersion || !state.docs) {
    return false
  }

  return policyVersion.digest === currentPolicyVersion()?.digest
}

function isCertificateCurrent(certificate) {
  return isPolicyVersionCurrent(certificate?.policyVersion)
}

function isRecordCurrent(record) {
  return isPolicyVersionCurrent(getRecordSummary(record).policyVersion)
}

function formatSignedAt(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function render() {
  if (state.mode !== 'kiosk-checkin') {
    stopScanner()
  }

  const activeRecord = state.mode === 'personal' ? state.personalRecord : state.kioskRecord
  const policyStateMarkup = renderPolicyState()
  const bannerMarkup = renderBanner()
  const messageMarkup = state.message
    ? `<section class="banner banner--warning">${escapeHtml(state.message)}</section>`
    : ''

  app.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Installable HTML5 acceptance app</p>
          <h1>Undefined acceptance certificates</h1>
          <p class="hero-copy">Collect signatures, capture photo consent, generate a QR certificate, and validate it at check-in without a central database.</p>
        </div>
        <div class="hero-status">
          ${policyStateMarkup}
        </div>
      </header>

      <nav class="mode-tabs" aria-label="Application modes">
        ${renderModeButton('personal', 'Personal mode')}
        ${renderModeButton('kiosk-sign', 'Kiosk sign mode')}
        ${renderModeButton('kiosk-checkin', 'Kiosk check-in mode')}
        ${renderModeButton('settings', 'Settings')}
      </nav>

      ${bannerMarkup}
      ${messageMarkup}

      <main class="content-grid">
        <section class="primary-card">
          ${renderModePanel()}
        </section>

        <aside class="secondary-column">
          ${renderRecordCard(activeRecord)}
          ${renderPolicyPanel()}
        </aside>
      </main>
    </div>
  `

  bindUi()
  initializeSignaturePad()
  if (state.mode === 'kiosk-checkin') {
    startScanner()
  }
}

function renderModeButton(mode, label) {
  const active = state.mode === mode ? 'is-active' : ''
  return `<button class="mode-tab ${active}" data-mode="${mode}" type="button">${label}</button>`
}

function renderPolicyState() {
  if (state.loadingDocs) {
    return '<p class="status-pill">Loading current terms…</p>'
  }

  if (state.docsError) {
    return `<p class="status-pill status-pill--warning">${escapeHtml(state.docsError)}</p>`
  }

  return `
    <div class="status-stack">
      <p class="status-pill">Terms updated ${escapeHtml(state.docs.terms.lastUpdated)}</p>
      <p class="status-pill">Privacy updated ${escapeHtml(state.docs.privacy.lastUpdated)}</p>
    </div>
  `
}

function renderBanner() {
  if (!state.personalRecord || state.loadingDocs || state.docsError) {
    return ''
  }

  if (isRecordCurrent(state.personalRecord)) {
    return '<section class="banner banner--success">Your saved certificate matches the current terms and privacy policy.</section>'
  }

  return '<section class="banner banner--warning">Your saved certificate is no longer current. Please re-sign before your next event.</section>'
}

function renderModePanel() {
  if (state.mode === 'settings') {
    return renderSettingsPanel()
  }

  if (state.loadingDocs) {
    return '<div class="empty-state"><p>Loading policy content…</p></div>'
  }

  if (state.docsError) {
    return `
      <div class="empty-state">
        <p>${escapeHtml(state.docsError)}</p>
        <button class="primary-button" type="button" data-action="reload-docs">Retry loading policies</button>
      </div>
    `
  }

  if (state.mode === 'kiosk-checkin') {
    return renderCheckinPanel()
  }

  return renderSigningPanel(state.mode === 'personal' ? 'personal' : 'kiosk')
}

function renderSigningPanel(kind) {
  const draft = state.drafts[kind]
  const record = kind === 'personal' ? state.personalRecord : state.kioskRecord
  const heading =
    kind === 'personal'
      ? 'Review the current policies, sign once, and keep your QR certificate on your phone.'
      : 'Run this on a kiosk so each attendee can sign, receive a QR certificate, and reset for the next person.'
  const actionLabel = kind === 'personal' ? 'Accept & generate my QR certificate' : 'Generate kiosk QR certificate'
  const formId = `${kind}-form`

  return `
    <div class="stack">
      <div>
        <h2>${kind === 'personal' ? 'Personal signing' : 'Kiosk signing'}</h2>
        <p>${heading}</p>
      </div>

      <form id="${formId}" data-form-kind="${kind}" class="stack form-grid">
        <label>
          <span>Full name</span>
          <input name="name" type="text" autocomplete="name" value="${escapeHtml(draft.name)}" required />
        </label>

        <label>
          <span>Email</span>
          <input name="email" type="email" autocomplete="email" value="${escapeHtml(draft.email)}" required />
        </label>

        <fieldset class="inline-fieldset">
          <legend>Photography consent</legend>
          <label><input type="radio" name="photoConsent" value="in" ${draft.photoConsent === 'in' ? 'checked' : ''} /> Opt in</label>
          <label><input type="radio" name="photoConsent" value="out" ${draft.photoConsent === 'out' ? 'checked' : ''} /> Opt out</label>
        </fieldset>

        <label class="checkbox-row">
          <input name="acceptTerms" type="checkbox" ${draft.acceptTerms ? 'checked' : ''} required />
          <span>I accept the Terms &amp; Conditions dated ${escapeHtml(state.docs.terms.lastUpdated)}.</span>
        </label>

        <label class="checkbox-row">
          <input name="acceptPrivacy" type="checkbox" ${draft.acceptPrivacy ? 'checked' : ''} required />
          <span>I accept the Privacy Policy dated ${escapeHtml(state.docs.privacy.lastUpdated)}.</span>
        </label>

        <div class="signature-block">
          <div class="signature-header">
            <span>Signature</span>
            <button type="button" class="secondary-button" data-action="clear-signature" data-signature-kind="${kind}">Clear</button>
          </div>
          <canvas id="${kind}-signature" class="signature-canvas" aria-label="Signature pad"></canvas>
        </div>

        <button class="primary-button" type="submit">${actionLabel}</button>
      </form>

      ${record ? renderSubmissionCard(record, kind) : ''}
    </div>
  `
}

function renderSubmissionCard(record, kind) {
  const summary = getRecordSummary(record)
  const current = isRecordCurrent(record)
  const endpointStatus = record.endpointResult?.skipped
    ? 'Endpoint not configured.'
    : record.endpointResult?.ok
      ? 'Endpoint delivered successfully.'
      : `Endpoint delivery failed: ${record.endpointResult?.message ?? 'Unknown error.'}`

  if (!record.certificate || !record.qrDataUrl) {
    return `
      <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
        <div>
          <h3>Saved certificate summary</h3>
          <p>${escapeHtml(summary.name)} signed on ${escapeHtml(formatSignedAt(summary.signedAt))}.</p>
        </div>
        <ul class="result-list">
          <li>${escapeHtml(PHOTO_CONSENT_LABELS[summary.photoConsent] ?? 'Unknown photo consent')}</li>
          <li>${current ? 'Matches current terms' : 'Needs re-signing before check-in'}</li>
          <li>The app stores only a local status summary after reload. Keep the downloaded QR image on the device for presentation.</li>
        </ul>
      </section>
    `
  }

  return `
    <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
      <div>
        <h3>${kind === 'personal' ? 'Saved certificate' : 'Latest kiosk certificate'}</h3>
        <p>${escapeHtml(summary.name)} signed on ${escapeHtml(formatSignedAt(summary.signedAt))}.</p>
      </div>
      <ul class="result-list">
        <li>${escapeHtml(PHOTO_CONSENT_LABELS[summary.photoConsent] ?? 'Unknown photo consent')}</li>
        <li>${current ? 'Matches current terms' : 'Needs re-signing before check-in'}</li>
        <li>${escapeHtml(endpointStatus)}</li>
      </ul>
      <img class="qr-preview" src="${record.qrDataUrl}" alt="QR certificate for ${escapeHtml(summary.name)}" />
      <div class="button-row">
        <a class="secondary-button" href="${record.qrDataUrl}" download="undefined-certificate-${escapeHtml(summary.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'))}.png">Download QR</a>
        ${kind === 'personal' && state.shareSupported ? '<button class="secondary-button" type="button" data-action="share-qr">Share QR</button>' : ''}
        ${kind === 'kiosk' ? '<button class="primary-button" type="button" data-action="kiosk-done">Done / reset kiosk</button>' : ''}
      </div>
      <details>
        <summary>Certificate payload</summary>
        <pre>${escapeHtml(JSON.stringify(record.certificate, null, 2))}</pre>
      </details>
    </section>
  `
}

function renderCheckinPanel() {
  return `
    <div class="stack">
      <div>
        <h2>Kiosk check-in</h2>
        <p>Scan a QR certificate to confirm whether it still matches the latest terms and privacy policy, then show the attendee's photography preference.</p>
      </div>

      <div class="scanner-card">
        <video id="scanner-video" class="scanner-video" playsinline muted></video>
        <div class="button-row">
          <button class="primary-button" type="button" data-action="restart-scanner">Restart camera</button>
          <label class="secondary-button file-button">
            <input id="scan-upload" type="file" accept="image/*" capture="environment" />
            Scan from image
          </label>
        </div>
        <label>
          <span>Paste QR payload</span>
          <textarea id="pasted-payload" rows="4" placeholder="Paste the text stored in a QR code if scanning is unavailable.">${escapeHtml(state.drafts.pastedPayload)}</textarea>
        </label>
        <button class="secondary-button" type="button" data-action="decode-pasted">Validate pasted payload</button>
      </div>

      ${renderCheckinResult()}
    </div>
  `
}

function renderCheckinResult() {
  if (!state.checkinResult) {
    return '<div class="empty-state"><p>No certificate scanned yet.</p></div>'
  }

  if (!state.checkinResult.valid) {
    return `<section class="result-card result-card--warning"><h3>Invalid certificate</h3><p>${escapeHtml(state.checkinResult.message)}</p></section>`
  }

  const { certificate, current } = state.checkinResult
  return `
    <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
      <h3>${current ? 'Current certificate' : 'Re-sign required'}</h3>
      <ul class="result-list">
        <li><strong>Name:</strong> ${escapeHtml(certificate.attendee.name)}</li>
        <li><strong>Email:</strong> ${escapeHtml(certificate.attendee.email)}</li>
        <li><strong>Signed:</strong> ${escapeHtml(formatSignedAt(certificate.signedAt))}</li>
        <li><strong>Photo consent:</strong> ${escapeHtml(PHOTO_CONSENT_LABELS[certificate.photoConsent] ?? 'Unknown')}</li>
        <li><strong>Terms version:</strong> ${escapeHtml(certificate.policyVersion?.termsUpdated ?? 'Unknown')}</li>
        <li><strong>Privacy version:</strong> ${escapeHtml(certificate.policyVersion?.privacyUpdated ?? 'Unknown')}</li>
      </ul>
    </section>
  `
}

function renderSettingsPanel() {
  const draft = state.drafts.settings
  return `
    <div class="stack">
      <div>
        <h2>Configuration</h2>
        <p>Set the endpoint that receives every QR payload and, if needed, override the public policy document URLs.</p>
      </div>

      <form id="settings-form" class="stack form-grid">
        <label>
          <span>Organization label</span>
          <input name="organizationName" type="text" value="${escapeHtml(draft.organizationName)}" required />
        </label>

        <label>
          <span>Event label (optional)</span>
          <input name="eventLabel" type="text" value="${escapeHtml(draft.eventLabel)}" />
        </label>

        <label>
          <span>Submission endpoint URL</span>
          <input name="endpointUrl" type="url" value="${escapeHtml(draft.endpointUrl)}" placeholder="https://example.com/qr-certificates" />
        </label>

        <label>
          <span>Terms markdown URL</span>
          <input name="termsUrl" type="url" value="${escapeHtml(draft.termsUrl)}" required />
        </label>

        <label>
          <span>Privacy markdown URL</span>
          <input name="privacyUrl" type="url" value="${escapeHtml(draft.privacyUrl)}" required />
        </label>

        <button class="primary-button" type="submit">Save settings &amp; reload policies</button>
      </form>
    </div>
  `
}

function renderRecordCard(record) {
  if (!record) {
    return `
      <section class="info-card">
        <h2>Certificate status</h2>
        <p>No certificate has been created in this mode yet.</p>
      </section>
    `
  }

  const summary = getRecordSummary(record)
  const current = isRecordCurrent(record)
  return `
    <section class="info-card">
      <h2>Certificate status</h2>
      <p><strong>${escapeHtml(summary.name)}</strong></p>
      <p>${current ? 'Current' : 'Out of date'} · ${escapeHtml(PHOTO_CONSENT_LABELS[summary.photoConsent])}</p>
      <p>Signed ${escapeHtml(formatSignedAt(summary.signedAt))}</p>
    </section>
  `
}

function renderPolicyPanel() {
  if (!state.docs) {
    return ''
  }

  return `
    <section class="info-card info-card--scroll">
      <h2>Current policies</h2>
      <details open>
        <summary>${escapeHtml(state.docs.terms.title)} · ${escapeHtml(state.docs.terms.lastUpdated)}</summary>
        <div class="policy-body">${state.docs.terms.html}</div>
      </details>
      <details>
        <summary>${escapeHtml(state.docs.privacy.title)} · ${escapeHtml(state.docs.privacy.lastUpdated)}</summary>
        <div class="policy-body">${state.docs.privacy.html}</div>
      </details>
    </section>
  `
}

function bindUi() {
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode
      state.message = ''
      render()
    })
  })

  document.querySelector('[data-action="reload-docs"]')?.addEventListener('click', () => {
    void loadPolicyDocuments()
  })

  document.querySelectorAll('[data-action="clear-signature"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (activeSignatureKey === button.dataset.signatureKind && activeSignaturePad) {
        activeSignaturePad.clear()
      }
    })
  })

  document.querySelector('[data-action="share-qr"]')?.addEventListener('click', async () => {
    if (!state.personalRecord?.qrDataUrl) {
      return
    }

    try {
      const file = await dataUrlToFile(state.personalRecord.qrDataUrl, 'undefined-certificate.png')
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Undefined QR certificate' })
      }
    } catch {
      state.message = 'Unable to share the QR code on this device.'
      render()
    }
  })

  document.querySelector('[data-action="kiosk-done"]')?.addEventListener('click', () => {
    state.kioskRecord = null
    state.drafts.kiosk = defaultFormDraft()
    render()
  })

  document.querySelector('[data-action="restart-scanner"]')?.addEventListener('click', () => {
    void startScanner(true)
  })

  document.querySelector('[data-action="decode-pasted"]')?.addEventListener('click', () => {
    const textarea = document.querySelector('#pasted-payload')
    if (!textarea) {
      return
    }
    state.drafts.pastedPayload = textarea.value.trim()
    decodeAndStoreCertificate(textarea.value.trim())
  })

  document.querySelector('#scan-upload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const result = await QrScanner.scanImage(file)
      decodeAndStoreCertificate(result)
    } catch {
      state.checkinResult = { valid: false, message: 'No QR code could be read from that image.' }
      render()
    }
  })

  document.querySelectorAll('form[data-form-kind]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      await submitSigningForm(form.dataset.formKind)
    })

    form.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => syncFormDraft(form.dataset.formKind, input))
      input.addEventListener('change', () => syncFormDraft(form.dataset.formKind, input))
    })
  })

  document.querySelector('#settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    state.settings = {
      organizationName: formData.get('organizationName').toString().trim(),
      eventLabel: formData.get('eventLabel').toString().trim(),
      endpointUrl: formData.get('endpointUrl').toString().trim(),
      termsUrl: formData.get('termsUrl').toString().trim(),
      privacyUrl: formData.get('privacyUrl').toString().trim(),
    }
    state.drafts.settings = { ...state.settings }
    saveJson(STORAGE_KEYS.settings, state.settings)
    await loadPolicyDocuments()
  })
}

function syncFormDraft(kind, input) {
  if (input.type === 'checkbox') {
    state.drafts[kind][input.name] = input.checked
    return
  }

  if (input.type === 'radio') {
    if (input.checked) {
      state.drafts[kind][input.name] = input.value
    }
    return
  }

  state.drafts[kind][input.name] = input.value
}

function initializeSignaturePad() {
  const canvas = document.querySelector(`#${state.mode === 'personal' ? 'personal' : state.mode === 'kiosk-sign' ? 'kiosk' : 'none'}-signature`)
  if (!canvas) {
    activeSignaturePad = null
    activeSignatureKey = null
    return
  }

  activeSignatureKey = state.mode === 'personal' ? 'personal' : 'kiosk'
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

async function submitSigningForm(kind) {
  const form = document.querySelector(`#${kind}-form`)
  if (!form?.reportValidity()) {
    return
  }

  if (!activeSignaturePad || activeSignaturePad.isEmpty()) {
    alert('Please provide a signature before continuing.')
    return
  }

  const formData = new FormData(form)
  const signatureDataUrl = activeSignaturePad.toDataURL('image/png')
  const certificate = await buildCertificate({
    name: formData.get('name').toString().trim(),
    email: formData.get('email').toString().trim(),
    photoConsent: formData.get('photoConsent').toString(),
    signatureDataUrl,
  })
  const payload = encodeCertificatePayload(certificate)
  const qrDataUrl = await createQrCodeDataUrl(payload)
  const endpointResult = await submitToEndpoint(payload, certificate)

  const record = { certificate, payload, qrDataUrl, endpointResult }
  state.message = ''
  if (kind === 'personal') {
    state.personalRecord = record
    saveJson(STORAGE_KEYS.personalRecord, createStoredPersonalRecord(record))
  } else {
    state.kioskRecord = record
  }

  state.drafts[kind] = defaultFormDraft()
  render()
}

async function buildCertificate({ name, email, photoConsent, signatureDataUrl }) {
  const signatureHash = await hashText(signatureDataUrl)
  return {
    schema: 'undefined-charity/acceptance-certificate@1',
    organization: state.settings.organizationName || DEFAULT_SETTINGS.organizationName,
    eventLabel: state.settings.eventLabel || undefined,
    acceptance: 'accepted',
    signedAt: new Date().toISOString(),
    attendee: { name, email },
    photoConsent,
    signatureHash,
    policyVersion: currentPolicyVersion(),
  }
}

function encodeCertificatePayload(certificate) {
  return `${CERTIFICATE_PREFIX}${toBase64Url(JSON.stringify(certificate))}`
}

function decodeCertificatePayload(payload) {
  if (payload.startsWith(CERTIFICATE_PREFIX)) {
    return JSON.parse(fromBase64Url(payload.slice(CERTIFICATE_PREFIX.length)))
  }

  return JSON.parse(payload)
}

async function createQrCodeDataUrl(payload) {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  })
}

async function submitToEndpoint(payload, certificate) {
  if (!state.settings.endpointUrl) {
    return { ok: true, skipped: true }
  }

  let endpoint
  try {
    endpoint = new URL(state.settings.endpointUrl)
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
      body: JSON.stringify({ qrPayload: payload, certificate }),
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
      decodeAndStoreCertificate(payload)
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
      message: 'Camera access is unavailable. Use image upload or paste the QR payload instead.',
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

function decodeAndStoreCertificate(payload) {
  if (!payload) {
    return
  }

  try {
    const certificate = decodeCertificatePayload(payload)
    state.checkinResult = {
      valid: true,
      certificate,
      current: isCertificateCurrent(certificate),
    }
  } catch {
    state.checkinResult = { valid: false, message: 'That QR payload is not a valid Undefined certificate.' }
  }

  render()
}

function createStoredPersonalRecord(record) {
  return {
    summary: {
      name: record.certificate.attendee.name,
      signedAt: record.certificate.signedAt,
      photoConsent: record.certificate.photoConsent,
    },
    policyVersion: record.certificate.policyVersion,
  }
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
