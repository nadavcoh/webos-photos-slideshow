# Ambient Photos — webOS TV slideshow

## ⚠️ Read this first: two other approaches were tried and rejected

Your original spec called for `mediaItems:search` filtered by album or
favorite status. As of **April 1, 2025**, Google removed that capability
for the `photoslibrary.readonly` scope — the Library API now only returns
items an app *itself* uploaded.

The next candidate, the **Photos Ambient API**, is purpose-built for
exactly this use case (a persistent "device" with an ongoing curated
feed, no re-picking) — but it requires acceptance into Google's **Photos
Partner Program** first. That's a formal application aimed at device
manufacturers, not a self-serve API, so it's a dead end for a personal
project unless you want to go apply for it separately.

What this app actually uses is the **Photos Picker API**, which needs no
partner approval. Its catch: the scope
(`photospicker.mediaitems.readonly`) isn't on Google's allow-list for the
OAuth **Device Authorization Grant** (the TV-shows-a-code flow) —
requesting it there returns `invalid_scope`. Getting that scope requires
a standard **Authorization Code** flow with a real HTTPS redirect URI,
which a TV app alone can't provide. So this app talks to a small
**pairing backend** (in `pairing-backend/`) instead of Google directly
for anything auth-related — see that folder's own README for what it
does and how to deploy it. The end-user experience is unchanged: one QR
code on the TV, sign in and pick photos on your phone.

## Directory layout

```
webos-photos-slideshow/
├── appinfo.json          ← webOS app manifest
├── icon.png               ← 80x80 app icon (placeholder — swap for your own)
├── index.html             ← markup for pairing screen + slideshow
├── style.css               ← dark-mode lean-back styling, crossfade CSS
├── app.js                  ← pairing-backend client, Picker API flow, slideshow engine
├── .github/workflows/      ← GitHub Action: package + deploy to the TV over Tailscale
└── pairing-backend/        ← small Vercel service — NOT packaged into the TV app
```

Everything under the top level (outside `pairing-backend/`) is plain
HTML/CSS/JS — no build step, no bundler. That's what gets handed to
`ares-package` (the GitHub Action excludes `pairing-backend/`, `.github/`,
and `README.md` from the `.ipk` automatically).

## 0. Deploy the pairing backend

Do this first — the TV app needs its URL. Full instructions are in
[`pairing-backend/README.md`](pairing-backend/README.md): create a
**Web application** OAuth client (not "TVs and Limited Input devices"),
enable the Photos Picker API, deploy the four functions to Vercel with a
KV database attached, and note the resulting `https://....vercel.app`
URL.

## 1. Configure the app

**If you're deploying via the GitHub Action (section 4 below), skip
this** — leave the placeholder in `app.js` as-is; the workflow
substitutes it from a repo secret at build time.

For manual/local packaging instead, open `app.js` and fill in:

```js
PAIRING_BACKEND_URL: "https://your-pairing-backend.vercel.app",
```

Also update `appinfo.json` → `"id"` to your own reverse-domain app ID
(e.g. `com.yourname.ambientphotos`) and `"vendor"` to your name.

There is no Google client ID/secret anywhere in this app — those live
only in the pairing backend's own environment variables.

## 2. Install the webOS CLI (on your dev machine, not the TV)

```bash
npm install -g @webosose/ares-cli
```

Put your TV into Developer Mode (install the **Developer Mode** app from
the LG Content Store, enable it, note the IP address it shows), then
register the TV as a deploy target:

```bash
ares-setup-device
# follow the prompts: name it e.g. "livingroom-tv", enter its IP,
# port 9922, and the passphrase shown in the Developer Mode app
```

## 3. Package and install

From the parent directory of `webos-photos-slideshow/`:

```bash
ares-package webos-photos-slideshow/ --app-exclude pairing-backend --app-exclude .github --app-exclude .git --app-exclude README.md
# produces com.yourdomain.ambientphotos_1.0.0_all.ipk

ares-install -d livingroom-tv com.yourdomain.ambientphotos_1.0.0_all.ipk

ares-launch -d livingroom-tv com.yourdomain.ambientphotos
```

To iterate quickly during development, `ares-install` again after each
`ares-package` — no need to relaunch Developer Mode each time.

### First run on the TV

1. The app shows one QR code / link. Scan it (or open the link) on your
   phone — it takes you through Google sign-in and then straight into
   the Photos Picker to choose albums/photos, back to back.
2. The slideshow starts automatically once you finish picking, and keeps
   running; the picked-item list is silently refreshed every 50 minutes
   to keep image URLs (which expire hourly) valid. The refresh token and
   Picker session id are stored in `localStorage`, so a reboot skips
   pairing entirely — until that session eventually needs re-picking
   (Picker sessions aren't indefinite), at which point the same QR flow
   reappears automatically.

## 4. Automatic deploys via GitHub Actions (`.github/workflows/deploy-webos.yml`)

The workflow packages the app, joins your tailnet, and pushes the result
straight to the TV on every push to `main`. Three things to set up first:

### a) Tailscale reachability

webOS has no Tailscale client, so the TV itself is never a tailnet node.
The GitHub-hosted runner only reaches it if **one** of these is true:

- A device already on your home LAN (a Pi, NAS, or router) is running
  Tailscale as a **subnet router**:
  ```bash
  sudo tailscale up --advertise-routes=192.168.1.0/24   # use your TV's actual subnet
  ```
  then approve that route in the [Tailscale admin console](https://login.tailscale.com/admin/machines).
- Or you self-host the Actions runner on a machine already on that LAN
  (swap `runs-on: ubuntu-latest` for `runs-on: self-hosted` in the
  workflow) — in that case the Tailscale step is optional.

Create a Tailscale OAuth client (Admin console → Settings → OAuth clients)
scoped to write devices with `tag:ci`, and add these repo secrets:
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_SECRET`

> **Troubleshooting `403: calling actor does not have enough permissions`**
> This means the OAuth client has the wrong scope. It needs **Auth Keys:
> Write** specifically (a distinct entry from "Devices" or "OAuth
> clients" in the scope picker — easy to pick the wrong one). Also make
> sure `tag:ci` exists in your ACL policy's `tagOwners` block before you
> try to scope the client to it:
> ```json
> "tagOwners": {
>   "tag:ci": ["autogroup:admin"]
> }
> ```
> and that the tag selected on the OAuth client matches the `tags:`
> value in the workflow exactly.

### b) TV pairing key

Generate this once, locally, from a machine already on the same LAN as
the TV (with Developer Mode open and its passphrase visible on-screen):

```bash
ares-setup-device --add livingroom-tv --info \
  '{"host":"<TV LAN IP>","port":"9922","username":"prisoner"}'
ares-novacom --device livingroom-tv --getkey --passphrase <passphrase-shown-on-TV>
base64 -i ~/.novacom-cert/livingroom-tv/webos_rsa | pbcopy   # macOS; use base64 -w0 on Linux
```

Add these repo secrets:
- `WEBOS_TV_SSH_KEY_B64` — the base64 output from above
- `WEBOS_TV_HOST` — the TV's LAN IP (reachable via the subnet route)
- `WEBOS_APP_ID` — your reverse-domain app ID (e.g.
  `com.yourname.ambientphotos`); the workflow writes this into
  `appinfo.json` → `"id"` at build time, and reuses it to relaunch the
  app after install

Developer Mode sessions expire after a couple of days unless extended in
the Developer Mode app on the TV; the derived key stops working once the
session lapses and you'll need to regenerate it via the two commands
above with a fresh passphrase.

### c) Pairing backend URL

Add one repo secret — the workflow writes it into `app.js` in place of
the `CONFIG.PAIRING_BACKEND_URL` placeholder right before packaging:
- `PAIRING_BACKEND_URL` — e.g. `https://your-pairing-backend.vercel.app`
  (no trailing slash), from step 0

There's no Google client ID/secret to add here — those belong to the
pairing backend's *own* Vercel project env vars, set up separately per
`pairing-backend/README.md`, and this GitHub Action never touches them.

## Notes / things to adjust for your setup

- **15-second crossfade timing** lives in `CONFIG.SLIDE_INTERVAL_MS` and
  the CSS `--transition-duration` variable in `style.css`.
- **Image count cap** (`CONFIG.MAX_ITEMS_TO_LOAD`) guards against loading
  an enormous picked album into memory at once; raise it if you picked a
  large album and want the full set in rotation.
- **Pairing timeout**: `CONFIG.PAIRING_POLL_TIMEOUT_MS` (10 minutes)
  matches the pairing backend's KV entry TTL — if you change one, change
  the other (`ex: 600` in `pairing-backend/api/callback.js`).
- webOS's browser engine is Chromium-based and modern enough for all the
  `fetch`/`async`/`URLSearchParams` used here, but if you're targeting a
  very old webOS 4 firmware revision, test on the actual TV early —
  device-specific `fetch` quirks do occasionally show up.
