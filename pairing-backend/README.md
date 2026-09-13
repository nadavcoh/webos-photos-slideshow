# Pairing backend

A tiny bridge between a standard Google OAuth Authorization Code flow
(required for the Photos Picker API scope, which Google doesn't allow
over the Device Authorization Grant) and the TV app, using short-lived
pairing codes. Four serverless functions, no framework, no build step.

## Endpoints

- `GET /api/start?state=<code>` — redirects the phone to Google's
  consent screen.
- `GET /api/callback` — Google redirects here after consent; exchanges
  the code for tokens, creates a Picker session, stashes both in KV
  keyed by `state`, then redirects the phone straight into the picker.
- `GET /api/poll?state=<code>` — the TV polls this until pairing
  completes (202 while waiting, 200 with tokens once ready, single-use).
- `POST /api/refresh` — the TV calls this to refresh its access token
  without ever holding the client secret itself.

## Deploy

1. **Google Cloud Console → Credentials → Create Credentials → OAuth
   client ID** → Application type: **Web application** (not "TVs and
   Limited Input devices" — that type doesn't support this flow).
   Leave it open for now; the redirect URI goes in after step 3.
2. **APIs & Services → Library** → enable **Google Photos Picker API**,
   if you haven't already for this project.
3. Deploy this directory as its own Vercel project:
   ```bash
   cd pairing-backend
   vercel deploy --prod
   ```
   Or connect the repo in the Vercel dashboard and set this directory
   (`pairing-backend/`) as the project's root directory.
4. Note the resulting domain (e.g. `your-project.vercel.app`), go back
   to the OAuth client from step 1, and add this as an **Authorized
   redirect URI**:
   ```
   https://your-project.vercel.app/api/callback
   ```
5. **Vercel project → Storage → Create Database → KV** (this is Vercel
   KV / Upstash Redis under the hood) and connect it to this project —
   it auto-injects the `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars
   that `@vercel/kv` needs.
6. **Vercel project → Settings → Environment Variables**, add:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` = `https://your-project.vercel.app/api/callback`
     (must match step 4 exactly, including scheme and no trailing slash)
7. Redeploy after adding the env vars so the functions pick them up.
8. Put the resulting base URL (`https://your-project.vercel.app`, no
   trailing slash) into the TV app's `CONFIG.PAIRING_BACKEND_URL` in
   `app.js` (or inject it via the GitHub Action — see the main README).

## Security notes

- The `state` pairing code is the only thing standing between "the TV
  that generated it" and "whoever calls /api/poll with it" — treat it
  like a short-lived bearer credential. It's random (via the TV's
  `uuidv4()`), single-use (deleted on first successful poll), and
  expires after 10 minutes in KV even if never collected.
- The client secret only ever exists in this backend's environment
  variables — it's never sent to, or stored by, the TV app.
- `prompt=consent` on every `/api/start` redirect means re-pairing
  always issues a fresh refresh token; Google would otherwise omit it
  on repeat consents for the same account.
