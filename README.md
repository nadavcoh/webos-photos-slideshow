# Ambient Photos — webOS TV slideshow

## ⚠️ Read this first: the Library API can no longer search a user's whole library

Your original spec called for `mediaItems:search` filtered by album or
favorite status. As of **April 1, 2025**, Google removed that capability
for the `photoslibrary.readonly` scope — the Library API now only returns
items an app *itself* uploaded. General search/browse access moved to the
new **Photos Picker API**.

That's actually a decent fit for a TV: the device shows a link/QR code,
the user picks photos or whole albums on their phone in the Google Photos
app, and the TV polls until they're done. That's what this app implements.
The trade-off: the user re-picks periodically (session-based), rather than
you querying "the favorites album" programmatically forever. If you later
want zero re-picking, the alternative is to have a companion script upload
copies of the photos you want into an album *created by this app* (via the
`photoslibrary.appendonly` scope), which the Library API can then list
indefinitely — that's a bigger build and not included here.

## Directory layout

```
webos-photos-slideshow/
├── appinfo.json      ← webOS app manifest
├── icon.png           ← 80x80 app icon (placeholder — swap for your own)
├── index.html         ← markup for pairing screen + slideshow
├── style.css           ← dark-mode lean-back styling, crossfade CSS
└── app.js              ← OAuth device flow, Photos Picker flow, slideshow engine
```

Everything is plain HTML/CSS/JS — no build step, no bundler. This directory
is exactly what you hand to `ares-package`.

## 1. Google Cloud project setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or pick an existing one).
2. **APIs & Services → Library** → enable:
   - **Google Photos Picker API**
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

## 2. Configure the app

Open `app.js` and fill in:

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
2. It then shows a QR code / link for the **Photos Picker** — scan it (or
   open the link) on your phone, choose an album or individual photos in
   the Google Photos app, and confirm.
3. The slideshow starts automatically and keeps running; the picked-item
   list is silently refreshed every 50 minutes to keep image URLs
   (which expire hourly) valid. The refresh token is stored in
   `localStorage`, so a reboot skips step 1. The picker session id is
   stored too, so it also skips step 2 for as long as that session
   remains valid — pick again if it expires.

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
- `WEBOS_APP_ID` — must match `appinfo.json` → `"id"`

Developer Mode sessions expire after a couple of days unless extended in
the Developer Mode app on the TV; the derived key stops working once the
session lapses and you'll need to regenerate it via the two commands
above with a fresh passphrase.

## Notes / things to adjust for your setup

- **15-second crossfade timing** lives in `CONFIG.SLIDE_INTERVAL_MS` and
  the CSS `--transition-duration` variable in `style.css`.
- **Image count cap** (`CONFIG.MAX_ITEMS_TO_LOAD`) guards against loading
  an enormous picked album into memory at once; raise it if you picked a
  large album and want the full set in rotation.
- webOS's browser engine is Chromium-based and modern enough for all the
  `fetch`/`async`/`URLSearchParams` used here, but if you're targeting a
  very old webOS 4 firmware revision, test on the actual TV early —
  device-specific `fetch` quirks do occasionally show up.
