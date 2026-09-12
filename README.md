# Ambient Photos — webOS TV slideshow

## ⚠️ Read this first: two other Google Photos APIs were tried and rejected

Your original spec called for `mediaItems:search` filtered by album or
favorite status. As of **April 1, 2025**, Google removed that capability
for the `photoslibrary.readonly` scope — the Library API now only returns
items an app *itself* uploaded.

The obvious next choice, the **Photos Picker API**, turns out not to work
here either: its scope (`photospicker.mediaitems.readonly`) isn't on
Google's allow-list of scopes for the OAuth Device Authorization Grant —
requesting it returns `invalid_scope`, full stop.

What actually works, and what this app uses, is the **Photos Ambient
API** — a scope (`photosambient.mediaitems`) purpose-built by Google for
exactly this use case: ambient photo displays on TVs and screensavers.
It's arguably a better fit than either alternative: the device shows a
link/QR code, the user picks albums/photos on their phone in the Google
Photos app once, and Google Photos then serves an ongoing *curated feed*
from those sources — no repeated re-picking sessions to manage.

## Directory layout

```
webos-photos-slideshow/
├── appinfo.json      ← webOS app manifest
├── icon.png           ← 80x80 app icon (placeholder — swap for your own)
├── index.html         ← markup for pairing screen + slideshow
├── style.css           ← dark-mode lean-back styling, crossfade CSS
└── app.js              ← OAuth device flow, Ambient API flow, slideshow engine
```

Everything is plain HTML/CSS/JS — no build step, no bundler. This directory
is exactly what you hand to `ares-package`.

## 1. Google Cloud project setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or pick an existing one).
2. **APIs & Services → Library** → enable:
   - **Google Photos Ambient API**
3. **APIs & Services → OAuth consent screen** → configure it (External is
   fine for personal use; add your own Google account as a test user if
   the app stays in "Testing" mode, which is fine for a personal device).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type: **TVs and Limited Input devices**.
   This is what enables the Device Authorization Grant used in `app.js`.
5. Copy the generated **Client ID** and **Client Secret** into
   `app.js` → `CONFIG.CLIENT_ID` / `CONFIG.CLIENT_SECRET`.

   Note: for this credential type Google does issue a client secret, and
   TV apps are expected to ship it client-side (there's no way for a
   limited-input device to keep it confidential). Keep the OAuth consent
   screen in "Testing" mode with only your own account as a tester so the
   blast radius of that secret leaking is limited to your own data.

   Also note: before your app is Google-verified, you'll see an
   "unverified app" warning on the consent screen during sign-in — expected
   in Testing mode, just click through it (Advanced → Go to [app name]).

## 2. Configure the app

**If you're deploying via the GitHub Action (section 6 below), skip this
step** — leave the placeholders in `app.js` and `appinfo.json` as they
are. The workflow substitutes them from repo secrets at build time, so
your real Client ID/Secret and app ID never need to touch the repo.

For manual/local packaging instead, open `app.js` and fill in:

```js
CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",
CLIENT_SECRET: "YOUR_CLIENT_SECRET",
```

Also update `appinfo.json` → `"id"` to your own reverse-domain app ID
(e.g. `com.yourname.ambientphotos`) and `"vendor"` to your name.

## 3. Install the webOS CLI (on your dev machine, not the TV)

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

## 4. Package and install

From the parent directory of `webos-photos-slideshow/`:

```bash
ares-package webos-photos-slideshow/
# produces com.yourdomain.ambientphotos_1.0.0_all.ipk

ares-install -d livingroom-tv com.yourdomain.ambientphotos_1.0.0_all.ipk

ares-launch -d livingroom-tv com.yourdomain.ambientphotos
```

To iterate quickly during development, `ares-install` again after each
`ares-package` — no need to relaunch Developer Mode each time.

## 5. First run on the TV

1. The app shows a sign-in code and `google.com/device` — enter it on
   your phone/PC and approve access.
2. It then shows a QR code / link to this device's **Google Photos
   settings page** — scan it (or open the link) on your phone, choose the
   albums or photos you want this TV to draw from, and confirm.
3. The slideshow starts automatically and keeps running; the curated
   media list is silently refreshed every 50 minutes to keep image URLs
   (which expire hourly) valid. The refresh token and this device's id
   are stored in `localStorage`, so a reboot skips both steps above —
   reopen the settings link any time (from Google Photos app settings)
   if you want to change the selected sources.

## 6. Automatic deploys via GitHub Actions (`.github/workflows/deploy-webos.yml`)

The workflow packages the app, joins your tailnet, and pushes the result
straight to the TV on every push to `main`. Two things to set up first:

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

### c) Google OAuth credentials

Add these two as repo secrets — the workflow writes them into `app.js`
in place of the `CONFIG.CLIENT_ID` / `CONFIG.CLIENT_SECRET` placeholders
right before packaging:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Developer Mode sessions expire after a couple of days unless extended in
the Developer Mode app on the TV; the derived key stops working once the
session lapses and you'll need to regenerate it via the two commands
above with a fresh passphrase.

## Notes / things to adjust for your setup

- **15-second crossfade timing** lives in `CONFIG.SLIDE_INTERVAL_MS` and
  the CSS `--transition-duration` variable in `style.css`.
- **Image count cap** (`CONFIG.MAX_ITEMS_TO_LOAD`) guards against loading
  an enormous curated feed into memory at once — the Ambient API caps
  each page at 100 items anyway, matching this default.
- **Rate limit**: `mediaItems.list` is capped at 240 requests per device
  per day by Google. The 50-minute refresh interval works out to well
  under that on its own; only lower `MEDIA_LIST_REFRESH_MS` with that
  ceiling in mind.
- webOS's browser engine is Chromium-based and modern enough for all the
  `fetch`/`async`/`URLSearchParams` used here, but if you're targeting a
  very old webOS 4 firmware revision, test on the actual TV early —
  device-specific `fetch` quirks do occasionally show up.
