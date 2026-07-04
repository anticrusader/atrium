// email.js
// The `email` skill: read the Outlook inbox and DRAFT replies via Microsoft
// Graph. By design it is DRAFT-ONLY — it creates drafts in your Drafts folder
// and NEVER calls the Graph /send endpoint. You review and send yourself.
//
// Auth is OAuth2 device-code flow (a public client — no client secret). You run
// `npm run email:login` once, sign in in your browser, and a token is cached to
// server/.msgraph-token.json (gitignored). The step below refreshes that token
// automatically; if there is no token it degrades gracefully with a clear note.
//
// Setup (one time):
//   1. Azure Portal → App registrations → New registration
//        • Supported account types: "Personal Microsoft accounts" (for outlook.com)
//          or "Accounts in any org directory and personal" if unsure.
//        • Authentication → Advanced → "Allow public client flows" = YES.
//        • API permissions → Microsoft Graph → Delegated → Mail.Read, Mail.ReadWrite,
//          offline_access  (Mail.ReadWrite is what lets us create a draft).
//   2. Copy the Application (client) ID into .env as EMAIL_CLIENT_ID.
//      For a personal outlook.com account set EMAIL_TENANT=consumers (default: common).
//   3. Run:  npm run email:login   → follow the device-code prompt.

import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const TOKEN_FILE = fileURLToPath(new URL('./.msgraph-token.json', import.meta.url))
const GRAPH = 'https://graph.microsoft.com/v1.0'
// offline_access → refresh tokens; Mail.ReadWrite → read inbox + create drafts.
export const SCOPES = 'offline_access Mail.Read Mail.ReadWrite'

export function emailConfig() {
  return {
    clientId: process.env.EMAIL_CLIENT_ID || '',
    tenant: process.env.EMAIL_TENANT || 'common', // 'consumers' for personal outlook.com
  }
}

const authBase = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`

// ── Token store ──────────────────────────────────────────────────────────────
function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) } catch { return null }
}
export function saveToken(tok) {
  // Stamp an absolute expiry (caller passes expires_in seconds + a base time).
  writeFileSync(TOKEN_FILE, JSON.stringify(tok, null, 2))
}
export function hasToken() { return !!loadToken()?.refresh_token }

// Exchange a refresh token for a fresh access token. Returns the new token
// record (also persisted), or null on failure.
async function refresh(tok, nowMs) {
  const { clientId, tenant } = emailConfig()
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: tok.refresh_token,
    scope: SCOPES,
  })
  const res = await fetch(`${authBase(tenant)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) return null
  const data = await res.json()
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tok.refresh_token, // may not rotate
    expires_at: nowMs + (data.expires_in ?? 3600) * 1000,
  }
  saveToken(next)
  return next
}

// Get a valid access token, refreshing if it expired. null if not authorized.
export async function getAccessToken(nowMs = 0) {
  const tok = loadToken()
  if (!tok?.refresh_token) return null
  // `nowMs` is passed in (Date.now() is fine here — this is server boot/runtime,
  // not a deterministic workflow). Default 0 forces a refresh when unknown.
  const t = nowMs || _now()
  if (tok.access_token && tok.expires_at && tok.expires_at - t > 60_000) return tok.access_token
  const next = await refresh(tok, t)
  return next?.access_token ?? null
}

const _now = () => Date.now()

// ── Graph helpers ────────────────────────────────────────────────────────────
async function graph(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    signal: AbortSignal.timeout(20_000), // stalled Graph call fails fast, not via watchdog
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 160) || res.statusText
    throw new Error(`Graph ${res.status}: ${msg}`)
  }
  return data
}

// Read the most recent inbox messages (subject/from/preview only).
export async function readInbox(token, n = 5) {
  const q = `/me/mailFolders/inbox/messages?$top=${n}` +
    `&$select=id,subject,from,bodyPreview,receivedDateTime,isRead` +
    `&$orderby=receivedDateTime desc`
  const data = await graph(q, { token })
  return (data?.value || []).map((m) => ({
    id: m.id,
    subject: m.subject || '(no subject)',
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'unknown',
    preview: (m.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 240),
    isRead: m.isRead,
  }))
}

// Create a DRAFT reply (saved to Drafts, NOT sent). createReply makes the draft;
// we then set its body. Returns the draft message id.
export async function draftReply(token, messageId, bodyText) {
  const draft = await graph(`/me/messages/${messageId}/createReply`, { method: 'POST', token })
  await graph(`/me/messages/${draft.id}`, {
    method: 'PATCH',
    token,
    body: { body: { contentType: 'Text', content: bodyText } },
  })
  return draft.id
}

/**
 * One step of the email skill. Reads the inbox, triages it with the model, and
 * drafts a reply to the top message that warrants one — all DRAFT-ONLY.
 * Same async contract as researchStep.
 */
export async function emailStep({ task, chat, limiter }) {
  const { clientId } = emailConfig()
  try {
    if (!clientId) { task.phase = 'done'; return { delta: 1, note: '📧 email not configured — set EMAIL_CLIENT_ID in .env (see server/email.js)' } }
    const token = await getAccessToken(_now())
    if (!token) { task.phase = 'done'; return { delta: 1, note: '📧 not authorized — run: npm run email:login' } }

    // Phase 1: FETCH the inbox.
    if (!task.phase) {
      const msgs = await readInbox(token, 5)
      task._messages = msgs
      task.phase = msgs.length ? 'triage' : 'done'
      if (!msgs.length) return { delta: 1, note: '📭 inbox empty — nothing to draft' }
      return { delta: 0.35, note: `📥 read ${msgs.length} inbox messages` }
    }

    // Phase 2: TRIAGE — let the model pick which message most needs a reply.
    if (task.phase === 'triage') {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const list = (task._messages || [])
        .map((m, i) => `${i + 1}. from ${m.from} — "${m.subject}": ${m.preview}`)
        .join('\n')
      const r = await chat([
        { role: 'system', content: 'You triage an inbox. Reply with ONLY the number of the single message that most needs a personal reply, then a dash and a 6-word reason. If none need a reply, answer "0 - none".' },
        { role: 'user', content: `Messages:\n${list}\n\nWhich one to reply to?` },
      ], 60)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'})` }
      const num = parseInt((r.text.match(/\d+/) || ['0'])[0], 10)
      task._pickIdx = num >= 1 && num <= (task._messages?.length || 0) ? num - 1 : -1
      task.phase = task._pickIdx >= 0 ? 'draft' : 'done'
      if (task._pickIdx < 0) return { delta: 1, note: '✅ triaged inbox — nothing needs a reply right now' }
      const m = task._messages[task._pickIdx]
      return { delta: 0.3, note: `🔎 picked "${m.subject}" from ${m.from} to reply to` }
    }

    // Phase 3: DRAFT a reply and save it to Drafts (never sent).
    if (task.phase === 'draft') {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const m = task._messages[task._pickIdx]
      const r = await chat([
        { role: 'system', content: 'You draft a professional, concise email reply on the user\'s behalf. Write ONLY the reply body (no subject line, no placeholders like [Name] unless necessary). Keep it polite and to the point.' },
        { role: 'user', content: `Reply to this email.\nFrom: ${m.from}\nSubject: ${m.subject}\nMessage: ${m.preview}\n\nDraft reply:` },
      ], 320)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'})` }
      const bodyText = (r.text || '').trim()
      await draftReply(token, m.id, bodyText)
      task.result = `Draft reply to "${m.subject}" (${m.from}) saved to Drafts:\n\n${bodyText}`
      task.phase = 'done'
      return { delta: 1, note: `📝 drafted reply to "${m.subject}" → saved to Drafts (NOT sent)` }
    }

    return { delta: 1, note: 'done' }
  } catch (err) {
    // Hard failure (Graph error, network) → retry once, then FAILED. The
    // unconfigured/unauthorized cases above stay graceful completions — they
    // are expected states, not failures worth retrying.
    return { failed: true, note: `email failed: ${err.message}` }
  }
}
