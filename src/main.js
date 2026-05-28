import './style.css'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import SignaturePad from 'signature_pad'
import { APP_CONFIG } from './config.js'

marked.use({ mangle: false, headerIds: false })

const STORAGE_KEYS = {
  personalRecord: 'undefined-app.personal-record.v2',
}

const ACCEPTANCE_PREFIX = 'undefined-accept:v2:'
const PAYLOAD_BUDGET_BYTES = 2400
const PHOTO_CONSENT_LABELS = {
  in: 'Opted in to event photography',
  out: 'Opted out of event photography',
}

const MODES = ['personal', 'kiosk-sign', 'kiosk-checkin']
const MODE_LABELS = {
  personal: 'Personal',
  'kiosk-sign': 'Kiosk sign',
  'kiosk-checkin': 'Kiosk check-in',
}

const kioskScanLog = new Map()

const state = {
  mode: 'personal',
  loadingDocs: true,
  docsError: '',
  docs: null,
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
    pastedPayload: '',
  },
  reads: {
    personal: { terms: false, privacy: false },
    kiosk: { terms: false, privacy: false },
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

        <aside class="secondary-column">
          ${renderRecordCard(activeRecord)}
        </aside>
      </main>
    </div>
  `

  bindUi()
  initializeSignaturePad()
  attachPolicyReadGates()
  attachSignatureCanvases()
  if (state.mode === 'kiosk-checkin') {
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
  if (!state.personalRecord || state.loadingDocs || state.docsError) {
    return ''
  }

  if (isRecordCurrent(state.personalRecord)) {
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

  if (state.mode === 'kiosk-checkin') {
    return renderCheckinPanel()
  }

  return renderSigningPanel(state.mode === 'personal' ? 'personal' : 'kiosk')
}

function renderSigningPanel(kind) {
  const draft = state.drafts[kind]
  const reads = state.reads[kind]
  const record = kind === 'personal' ? state.personalRecord : state.kioskRecord
  const heading =
    kind === 'personal'
      ? 'Read both policies through, then sign and keep the QR on your phone.'
      : 'Hand the device to the next attendee. They must read both policies before they can accept.'
  const actionLabel = kind === 'personal' ? 'Accept & generate my QR' : 'Generate kiosk QR'
  const formId = `${kind}-form`
  const bothRead = reads.terms && reads.privacy
  const disabledAttr = bothRead ? '' : 'disabled'
  const lockedNote = bothRead
    ? ''
    : '<p class="locked-note">Scroll to the end of each policy to unlock the acceptance form.</p>'

  return `
    <div class="stack">
      <div>
        <h2>${kind === 'personal' ? 'Personal acceptance' : 'Kiosk acceptance'}</h2>
        <p>${heading}</p>
      </div>

      ${renderPolicyReader(kind, 'terms', state.docs.terms, reads.terms)}
      ${renderPolicyReader(kind, 'privacy', state.docs.privacy, reads.privacy)}

      <form id="${formId}" data-form-kind="${kind}" class="stack form-grid acceptance-form ${bothRead ? '' : 'is-locked'}">
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
            <button type="button" class="secondary-button" data-action="clear-signature" data-signature-kind="${kind}" ${disabledAttr}>Clear</button>
          </div>
          <canvas id="${kind}-signature" class="signature-canvas" aria-label="Signature pad"></canvas>
        </div>

        <button class="primary-button" type="submit" ${disabledAttr}>${actionLabel}</button>
      </form>

      ${record ? renderSubmissionCard(record, kind) : ''}
    </div>
  `
}

function renderPolicyReader(kind, docKey, doc, hasRead) {
  return `
    <section class="policy-reader ${hasRead ? 'is-read' : ''}">
      <header class="policy-reader__header">
        <div>
          <h3>${escapeHtml(doc.title)}</h3>
          <p class="policy-meta">Updated ${escapeHtml(doc.lastUpdated)} · commit <code>${escapeHtml(shortSha(doc.sha))}</code></p>
        </div>
        <span class="policy-reader__badge">${hasRead ? '✓ Read' : 'Scroll to end to confirm'}</span>
      </header>
      <div class="policy-reader__body" data-policy-body data-policy-kind="${kind}" data-policy-doc="${docKey}" tabindex="0">
        ${doc.html}
      </div>
    </section>
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
      </section>
    `
  }

  return `
    <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
      <div>
        <h3>${kind === 'personal' ? 'Saved acceptance' : 'Latest kiosk acceptance'}</h3>
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
        ${kind === 'personal' && state.shareSupported ? '<button class="secondary-button" type="button" data-action="share-qr">Share QR</button>' : ''}
        ${kind === 'kiosk' ? '<button class="primary-button" type="button" data-action="kiosk-done">Done / reset kiosk</button>' : ''}
      </div>
      <details>
        <summary>Acceptance payload</summary>
        <pre>${escapeHtml(JSON.stringify(record.acceptance, null, 2))}</pre>
      </details>
    </section>
  `
}

function renderCheckinPanel() {
  return `
    <div class="stack">
      <div>
        <h2>Kiosk check-in</h2>
        <p>Scan a QR to confirm whether it still matches the latest terms and privacy policy, then show the attendee's photography preference.</p>
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
    return '<div class="empty-state"><p>No QR scanned yet.</p></div>'
  }

  if (!state.checkinResult.valid) {
    return `<section class="result-card result-card--warning"><h3>Invalid QR</h3><p>${escapeHtml(state.checkinResult.message)}</p></section>`
  }

  const { acceptance, current, issuerOk, expectedIssuer, duplicate, signatureStrokes, endpointResult } = state.checkinResult

  const duplicateBanner = duplicate
    ? `<section class="result-card result-card--warning">
        <h3>⚠ QR already scanned this session</h3>
        <p>First seen ${escapeHtml(formatSignedAt(duplicate.firstScannedAt))} · this is scan #${duplicate.count}. Check the attendee's photo ID before allowing entry.</p>
      </section>`
    : ''

  const issuerBanner = !issuerOk
    ? `<section class="result-card result-card--warning">
        <h3>⚠ Issued by a different host</h3>
        <p>QR claims issuer <code>${escapeHtml(acceptance.issuer ?? 'unknown')}</code>; this kiosk is <code>${escapeHtml(expectedIssuer)}</code>. The QR was generated by a different app deployment — verify the attendee.</p>
      </section>`
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
    ${duplicateBanner}
    ${issuerBanner}
    <section class="result-card ${current ? 'result-card--success' : 'result-card--warning'}">
      <h3>${current ? 'Current acceptance' : 'Re-sign required'}</h3>
      <ul class="result-list">
        <li><strong>Name:</strong> ${escapeHtml(acceptance.name)}</li>
        <li><strong>Email:</strong> ${escapeHtml(acceptance.email)}</li>
        <li><strong>Signed:</strong> ${escapeHtml(formatSignedAt(acceptance.signedAt))}</li>
        <li><strong>Photo consent:</strong> ${escapeHtml(PHOTO_CONSENT_LABELS[acceptance.photoConsent] ?? 'Unknown')}</li>
        <li><strong>Terms version:</strong> ${escapeHtml(acceptance.terms?.lastUpdated ?? 'Unknown')} (<code>${escapeHtml(shortSha(acceptance.terms?.sha))}</code>)</li>
        <li><strong>Privacy version:</strong> ${escapeHtml(acceptance.privacy?.lastUpdated ?? 'Unknown')} (<code>${escapeHtml(shortSha(acceptance.privacy?.sha))}</code>)</li>
        <li><strong>Issuer:</strong> <code>${escapeHtml(acceptance.issuer ?? 'unknown')}</code></li>
        ${endpointLine ? `<li>${escapeHtml(endpointLine)}</li>` : ''}
      </ul>
      ${signatureBlock}
    </section>
  `
}

function renderRecordCard(record) {
  if (!record) {
    return `
      <section class="info-card">
        <h2>Acceptance status</h2>
        <p>No acceptance has been created in this mode yet.</p>
      </section>
    `
  }

  const summary = getRecordSummary(record)
  const current = isRecordCurrent(record)
  return `
    <section class="info-card">
      <h2>Acceptance status</h2>
      <p><strong>${escapeHtml(summary.name)}</strong></p>
      <p>${current ? 'Current' : 'Out of date'} · ${escapeHtml(PHOTO_CONSENT_LABELS[summary.photoConsent])}</p>
      <p>Signed ${escapeHtml(formatSignedAt(summary.signedAt))}</p>
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
      const file = await dataUrlToFile(state.personalRecord.qrDataUrl, 'undefined-acceptance.png')
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Undefined acceptance QR' })
      }
    } catch {
      state.message = 'Unable to share the QR code on this device.'
      render()
    }
  })

  document.querySelector('[data-action="kiosk-done"]')?.addEventListener('click', () => {
    state.kioskRecord = null
    state.drafts.kiosk = defaultFormDraft()
    state.reads.kiosk = { terms: false, privacy: false }
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
}

function attachPolicyReadGates() {
  document.querySelectorAll('[data-policy-body]').forEach((node) => {
    const kind = node.dataset.policyKind
    const docKey = node.dataset.policyDoc
    if (!kind || !docKey) {
      return
    }

    const markRead = () => {
      if (state.reads[kind]?.[docKey]) {
        return
      }
      state.reads[kind][docKey] = true
      render()
    }

    // Auto-mark short docs that fit without scrolling.
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
  const reads = state.reads[kind]
  if (!reads?.terms || !reads?.privacy) {
    state.message = 'Please read both policies through to the end before accepting.'
    render()
    return
  }

  const form = document.querySelector(`#${kind}-form`)
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
    mode: kind,
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
    ? 'Signature is too large to fit in the QR; only the signature hash was embedded. The full image was POSTed to the configured endpoint.'
    : ''
  if (kind === 'personal') {
    state.personalRecord = record
    saveJson(
      STORAGE_KEYS.personalRecord,
      createStoredPersonalRecord({
        name: acceptance.name,
        signedAt,
        photoConsent,
        payloadHash: acceptance.payloadHash,
        termsSha: acceptance.terms.sha,
        privacySha: acceptance.privacy.sha,
      }),
    )
  } else {
    state.kioskRecord = record
  }

  state.drafts[kind] = defaultFormDraft()
  state.reads[kind] = { terms: false, privacy: false }
  render()
}

async function extractSignature() {
  const data = activeSignaturePad.toData()
  const canvas = activeSignaturePad.canvas
  const bounds = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.round(bounds.width))
  const height = Math.max(1, Math.round(bounds.height))
  const strokes = data.map((stroke) =>
    stroke.points.map((p) => [Math.round(p.x), Math.round(p.y)]),
  )
  const signatureDataUrl = activeSignaturePad.toDataURL('image/png')
  const signatureHash = await hashText(signatureDataUrl)
  const encoded = await encodeStrokes(strokes)
  return {
    signatureDataUrl,
    signatureHash,
    qrSignature: encoded ? { ...encoded, width, height, format: 'strokes-v1' } : null,
  }
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
    margin: 1,
    width: 360,
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

function createStoredPersonalRecord({ name, signedAt, photoConsent, termsSha, privacySha, payloadHash }) {
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
