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
}

const ACCEPTANCE_PREFIX = 'undefined-accept:v2:'
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
  mode: 'sign',
  loadingDocs: true,
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
  const shouldRunScanner = state.mode === 'checkin' && !state.checkinResult
  if (!shouldRunScanner) {
    stopScanner()
  }

  const policyStateMarkup = renderPolicyState()
  const bannerMarkup = renderBanner()
  const messageMarkup = state.message
    ? `<section class="banner banner--warning">${escapeHtml(state.message)}</section>`
    : ''

  app.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div class="hero-main">
          <p class="eyebrow">Installable HTML5 acceptance app</p>
          <h1>Undefined acceptance</h1>
          <p class="hero-copy">Read the current policies, sign once, and generate a QR that any kiosk can validate against the latest policy versions — no accounts, no shared secrets.</p>
          ${policyStateMarkup}
        </div>
        <div class="mode-switch" role="tablist" aria-label="Application modes">
          ${MODES.map(renderModeButton).join('')}
        </div>
      </header>

      ${bannerMarkup}
      ${messageMarkup}

      <main class="content-grid">
        <section class="primary-card">
          ${renderModePanel()}
        </section>
      </main>
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

function renderModeButton(mode) {
  const active = state.mode === mode ? 'is-active' : ''
  return `<button class="mode-switch__button ${active}" data-mode="${mode}" type="button" role="tab" aria-selected="${state.mode === mode}">${escapeHtml(MODE_LABELS[mode])}</button>`
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
      <p class="status-pill">Terms ${escapeHtml(state.docs.terms.lastUpdated)} · <code>${escapeHtml(shortSha(state.docs.terms.sha))}</code></p>
      <p class="status-pill">Privacy ${escapeHtml(state.docs.privacy.lastUpdated)} · <code>${escapeHtml(shortSha(state.docs.privacy.sha))}</code></p>
    </div>
  `
}

function renderBanner() {
  if (state.mode !== 'sign' || !state.record || state.loadingDocs || state.docsError) {
    return ''
  }

  if (isRecordCurrent(state.record)) {
    return '<section class="banner banner--success">Your saved acceptance matches the current terms and privacy policy.</section>'
  }

  return '<section class="banner banner--warning">Your saved acceptance is no longer current. Please re-sign before your next event.</section>'
}

function renderModePanel() {
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
    : '<p class="locked-note">Scroll to the end of each policy to unlock the acceptance form.</p>'

  return `
    <div class="stack">
      <div>
        <h2>Sign acceptance</h2>
        <p>Read both policies through, then sign. Personal use? Keep the QR on your phone. Kiosk use? Hit Reset after each attendee.</p>
      </div>

      ${renderPolicyReader('terms', state.docs.terms, reads.terms)}
      ${renderPolicyReader('privacy', state.docs.privacy, reads.privacy)}

      <form id="sign-form" class="stack form-grid acceptance-form ${bothRead ? '' : 'is-locked'}">
        <h3>Your acceptance</h3>
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
          <legend>Photography consent</legend>
          <label><input type="radio" name="photoConsent" value="in" ${draft.photoConsent === 'in' ? 'checked' : ''} ${disabledAttr} /> Opt in</label>
          <label><input type="radio" name="photoConsent" value="out" ${draft.photoConsent === 'out' ? 'checked' : ''} ${disabledAttr} /> Opt out</label>
        </fieldset>

        <label class="checkbox-row">
          <input name="acceptTerms" type="checkbox" ${draft.acceptTerms ? 'checked' : ''} ${disabledAttr} required />
          <span>I have read and accept the Terms &amp; Conditions dated ${escapeHtml(state.docs.terms.lastUpdated)}.</span>
        </label>

        <label class="checkbox-row">
          <input name="acceptPrivacy" type="checkbox" ${draft.acceptPrivacy ? 'checked' : ''} ${disabledAttr} required />
          <span>I have read and accept the Privacy Policy dated ${escapeHtml(state.docs.privacy.lastUpdated)}.</span>
        </label>

        <div class="signature-block">
          <div class="signature-header">
            <span>Signature</span>
            <button type="button" class="secondary-button" data-action="clear-signature" ${disabledAttr}>Clear</button>
          </div>
          <canvas id="sign-signature" class="signature-canvas" aria-label="Signature pad"></canvas>
        </div>

        <button class="primary-button" type="submit" ${disabledAttr}>Accept &amp; generate QR</button>
      </form>

      ${record ? renderSubmissionCard(record) : ''}
    </div>
  `
}

function renderPolicyReader(docKey, doc, hasRead) {
  return `
    <section class="policy-reader ${hasRead ? 'is-read' : ''}">
      <header class="policy-reader__header">
        <div>
          <h3>${escapeHtml(doc.title)}</h3>
          <p class="policy-meta">Updated ${escapeHtml(doc.lastUpdated)} · commit <code>${escapeHtml(shortSha(doc.sha))}</code></p>
        </div>
        <span class="policy-reader__badge">${hasRead ? '✓ Read' : 'Scroll to end to confirm'}</span>
      </header>
      <div class="policy-reader__body" data-policy-body data-policy-doc="${docKey}" tabindex="0">
        ${doc.html}
      </div>
    </section>
  `
}

function renderSubmissionCard(record) {
  const summary = getRecordSummary(record)
  const current = isRecordCurrent(record)
  const endpointStatus = record.endpointResult?.skipped
    ? 'Endpoint not configured.'
    : record.endpointResult?.ok
      ? 'Endpoint delivered successfully.'
      : `Endpoint delivery failed: ${record.endpointResult?.message ?? 'Unknown error.'}`

  if (!record.acceptance || !record.qrDataUrl) {
    return `
      <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
        <div>
          <h3>Saved acceptance summary</h3>
          <p>${escapeHtml(summary.name)} signed on ${escapeHtml(formatSignedAt(summary.signedAt))}.</p>
        </div>
        <ul class="result-list">
          <li>${escapeHtml(PHOTO_CONSENT_LABELS[summary.photoConsent] ?? 'Unknown photo consent')}</li>
          <li>${current ? 'Matches current terms' : 'Needs re-signing before check-in'}</li>
          <li>The app stores only a local status summary after reload. Keep the downloaded QR image on the device for presentation.</li>
        </ul>
        <div class="button-row">
          <button class="secondary-button" type="button" data-action="reset-sign">Reset &amp; sign again</button>
        </div>
      </section>
    `
  }

  return `
    <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
      <div>
        <h3>Acceptance QR</h3>
        <p>${escapeHtml(summary.name)} signed on ${escapeHtml(formatSignedAt(summary.signedAt))}.</p>
      </div>
      <ul class="result-list">
        <li>${escapeHtml(PHOTO_CONSENT_LABELS[summary.photoConsent] ?? 'Unknown photo consent')}</li>
        <li>${current ? 'Matches current terms' : 'Needs re-signing before check-in'}</li>
        <li>${escapeHtml(endpointStatus)}</li>
      </ul>
      <img class="qr-preview" src="${record.qrDataUrl}" alt="QR for ${escapeHtml(summary.name)}" />
      <div class="button-row">
        <a class="secondary-button" href="${record.qrDataUrl}" download="${escapeHtml(buildDownloadFilename(summary))}">Download QR</a>
        ${state.shareSupported ? '<button class="secondary-button" type="button" data-action="share-qr">Share QR</button>' : ''}
        <button class="primary-button" type="button" data-action="reset-sign">Reset &amp; sign again</button>
      </div>
      <details>
        <summary>Acceptance payload</summary>
        <pre>${escapeHtml(JSON.stringify(record.acceptance, null, 2))}</pre>
      </details>
    </section>
  `
}

function renderCheckinPanel() {
  if (state.checkinResult) {
    return `
      <div class="stack">
        ${renderCheckinResult()}
        <div class="button-row button-row--centered">
          <button class="primary-button" type="button" data-action="reset-checkin">Scan another QR</button>
        </div>
      </div>
    `
  }

  return `
    <div class="stack">
      <div>
        <h2>Scan attendee QR</h2>
        <p>Point the camera at the attendee's QR code. Or upload a photo / paste the payload below.</p>
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
        <strong>⚠ Invalid QR</strong>
        <span>${escapeHtml(state.checkinResult.message)}</span>
      </section>
    `
  }

  const { acceptance, current, issuerOk, expectedIssuer, duplicate, signatureStrokes, endpointResult } = state.checkinResult

  const banners = []
  if (duplicate) {
    banners.push(`
      <section class="alert-banner alert-banner--warning">
        <strong>⚠ QR already scanned this session</strong>
        <span>First seen ${escapeHtml(formatSignedAt(duplicate.firstScannedAt))} · this is scan #${duplicate.count}. Verify photo ID before allowing entry.</span>
      </section>
    `)
  }
  if (!issuerOk) {
    banners.push(`
      <section class="alert-banner alert-banner--warning">
        <strong>⚠ Issued by a different host</strong>
        <span>QR claims issuer <code>${escapeHtml(acceptance.issuer ?? 'unknown')}</code>; this kiosk is <code>${escapeHtml(expectedIssuer)}</code>. Verify the attendee.</span>
      </section>
    `)
  }
  if (!current) {
    banners.push(`
      <section class="alert-banner alert-banner--warning">
        <strong>⚠ Re-sign required</strong>
        <span>This QR was signed against older policy versions. Ask the attendee to re-sign before allowing entry.</span>
      </section>
    `)
  }

  const consentCallout =
    acceptance.photoConsent === 'in'
      ? `
        <section class="consent-callout consent-callout--in">
          <span class="consent-callout__heading">📷 Attendee consented to photos</span>
          <span class="consent-callout__subhead">Photography is OK</span>
        </section>
      `
      : acceptance.photoConsent === 'out'
        ? `
          <section class="consent-callout consent-callout--out">
            <span class="consent-callout__heading">🚫 Attendee opted OUT of photos</span>
            <span class="consent-callout__subhead">Do not photograph this attendee</span>
          </section>
        `
        : ''

  let endpointLine = ''
  if (endpointResult) {
    if (endpointResult.skipped) {
      endpointLine = 'Endpoint not configured.'
    } else if (endpointResult.ok) {
      endpointLine = 'Check-in posted to endpoint.'
    } else {
      endpointLine = `Endpoint POST failed: ${endpointResult.message ?? 'Unknown error.'}`
    }
  }

  let signatureBlock = ''
  if (signatureStrokes && acceptance.signature) {
    signatureBlock = `
      <div class="signature-display">
        <span>Signature on file:</span>
        <canvas data-signature-canvas
                data-signature-width="${escapeHtml(acceptance.signature.width)}"
                data-signature-height="${escapeHtml(acceptance.signature.height)}"></canvas>
      </div>
    `
  } else if (acceptance.signatureHash) {
    signatureBlock = `<p class="signature-display-note">Signature image not embedded in QR (only its hash). The full signature was POSTed to the endpoint at signing time.</p>`
  }

  return `
    ${banners.join('')}
    ${consentCallout}
    <section class="result-card">
      <h3>${escapeHtml(acceptance.name)}</h3>
      <ul class="result-list">
        <li><strong>Email:</strong> ${escapeHtml(acceptance.email)}</li>
        <li><strong>Signed:</strong> ${escapeHtml(formatSignedAt(acceptance.signedAt))}</li>
        <li><strong>Terms version:</strong> ${escapeHtml(acceptance.terms?.lastUpdated ?? 'Unknown')} (<code>${escapeHtml(shortSha(acceptance.terms?.sha))}</code>)</li>
        <li><strong>Privacy version:</strong> ${escapeHtml(acceptance.privacy?.lastUpdated ?? 'Unknown')} (<code>${escapeHtml(shortSha(acceptance.privacy?.sha))}</code>)</li>
        <li><strong>Issuer:</strong> <code>${escapeHtml(acceptance.issuer ?? 'unknown')}</code></li>
        ${endpointLine ? `<li>${escapeHtml(endpointLine)}</li>` : ''}
      </ul>
      ${signatureBlock}
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
      state.message = 'Unable to share the QR code on this device.'
      render()
    }
  })

  document.querySelector('[data-action="reset-sign"]')?.addEventListener('click', () => {
    state.record = null
    state.drafts.sign = defaultFormDraft()
    state.reads = { terms: false, privacy: false }
    state.message = ''
    window.localStorage.removeItem(STORAGE_KEYS.record)
    render()
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
      state.checkinResult = { valid: false, message: 'No QR code could be read from that image.' }
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

    const markRead = () => {
      if (state.reads[docKey]) {
        return
      }
      state.reads[docKey] = true
      render()
    }

    requestAnimationFrame(() => {
      if (node.scrollHeight - node.clientHeight <= 4) {
        markRead()
      }
    })

    node.addEventListener('scroll', () => {
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      if (distanceFromBottom <= 12) {
        markRead()
      }
    })
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
    state.message = 'Please read both policies through to the end before accepting.'
    render()
    return
  }

  const form = document.querySelector('#sign-form')
  if (!form?.reportValidity()) {
    return
  }

  if (!activeSignaturePad || activeSignaturePad.isEmpty()) {
    alert('Please provide a signature before continuing.')
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
  let payload = encodeAcceptancePayload(acceptance)
  let omittedSignature = false

  if (payload.length > PAYLOAD_BUDGET_BYTES && acceptance.signature) {
    omittedSignature = true
    const stripped = { ...baseAcceptance }
    acceptance = await finalizeAcceptance(stripped, null)
    payload = encodeAcceptancePayload(acceptance)
  }

  const qrDataUrl = await createQrCodeDataUrl(payload)
  const endpointResult = await submitToEndpoint({
    action: 'agree',
    qrPayload: payload,
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
  state.message = omittedSignature
    ? 'Signature was too large to fit in the QR; only the signature hash was embedded. The full image was POSTed to the configured endpoint.'
    : ''
  state.record = record
  saveJson(
    STORAGE_KEYS.record,
    createStoredRecord({
      name: acceptance.name,
      signedAt,
      photoConsent,
      payloadHash: acceptance.payloadHash,
      termsSha: acceptance.terms.sha,
      privacySha: acceptance.privacy.sha,
    }),
  )

  state.drafts.sign = defaultFormDraft()
  state.reads = { terms: false, privacy: false }
  render()
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

  throw new Error(`Unsupported signature compression: ${signature.compression}`)
}

function encodeAcceptancePayload(acceptance) {
  return `${ACCEPTANCE_PREFIX}${toBase64Url(JSON.stringify(acceptance))}`
}

function decodeAcceptancePayload(payload) {
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

async function decodeAndStoreAcceptance(payload) {
  if (!payload) {
    return
  }

  let acceptance
  try {
    acceptance = decodeAcceptancePayload(payload)
  } catch {
    state.checkinResult = {
      valid: false,
      message: 'That QR payload is not a valid Undefined acceptance.',
    }
    render()
    return
  }

  const claimedHash = acceptance.payloadHash
  if (!claimedHash) {
    state.checkinResult = {
      valid: false,
      message: 'QR is missing its payload hash — likely from an older app version. Ask the attendee to re-sign.',
    }
    render()
    return
  }

  const { payloadHash: _ignored, ...rest } = acceptance
  const expectedHash = await hashText(canonicalJson(rest))
  if (expectedHash !== claimedHash) {
    state.checkinResult = {
      valid: false,
      message: 'Payload hash mismatch — the QR is corrupted or has been tampered with.',
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
  if (acceptance.signature) {
    try {
      signatureStrokes = await decodeStrokes(acceptance.signature)
    } catch {
      signatureStrokes = null
    }
  }

  const endpointResult = await submitToEndpoint({
    action: 'checkin',
    qrPayload: payload,
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
    endpointResult,
  }
  render()
}

function createStoredRecord({ name, signedAt, photoConsent, termsSha, privacySha, payloadHash }) {
  return {
    summary: {
      name,
      signedAt,
      photoConsent,
      termsSha,
      privacySha,
    },
    payloadHash,
  }
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
