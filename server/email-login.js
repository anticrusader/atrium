// email-login.js
// One-time interactive sign-in for the `email` skill (Microsoft Graph).
// Run:  npm run email:login
//
// Uses the OAuth2 DEVICE CODE flow (no client secret needed). It prints a URL
// and a short code; you open the URL, enter the code, and sign in. On success it
// caches a refresh token to server/.msgraph-token.json so the orchestrator can
// read your inbox and create drafts (never send) without prompting again.

import { emailConfig, saveToken, SCOPES } from './email.js'

try { process.loadEnvFile() } catch { /* no .env — fine */ }

const { clientId, tenant } = emailConfig()
const authBase = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`

if (!clientId) {
  console.error('\n  ✗ EMAIL_CLIENT_ID is not set in .env')
  console.error('    Register an app in Azure (see server/email.js header) and set EMAIL_CLIENT_ID.\n')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1) Request a device code.
  const dcRes = await fetch(`${authBase}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
  })
  const dc = await dcRes.json()
  if (!dcRes.ok) {
    console.error(`\n  ✗ device code request failed: ${dc.error_description || dc.error || dcRes.status}\n`)
    process.exit(1)
  }

  console.log(`\n  ┌─ Sign in to authorize the email skill ─────────────────────`)
  console.log(`  │  1. Open:  ${dc.verification_uri}`)
  console.log(`  │  2. Enter code:  ${dc.user_code}`)
  console.log(`  │  3. Sign in with the Outlook account you want the agent to use.`)
  console.log(`  └──────────────────────────────────────────────────────────────\n`)
  console.log('  waiting for you to complete sign-in…')

  // 2) Poll the token endpoint until the user finishes (or it expires).
  const interval = (dc.interval ?? 5) * 1000
  const deadline = Date.now() + (dc.expires_in ?? 900) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const tRes = await fetch(`${authBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: dc.device_code,
      }),
    })
    const data = await tRes.json()
    if (tRes.ok) {
      saveToken({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      })
      console.log('\n  ✓ authorized — token cached to server/.msgraph-token.json')
      console.log('    The email-skilled agent can now read your inbox and draft replies (never send).\n')
      return
    }
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') { await sleep(interval); continue }
    console.error(`\n  ✗ sign-in failed: ${data.error_description || data.error}\n`)
    process.exit(1)
  }
  console.error('\n  ✗ timed out waiting for sign-in. Run `npm run email:login` again.\n')
  process.exit(1)
}

main().catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exit(1) })
