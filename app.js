/* ============================================================
 * Ambient Photos — app.js
 *
 * Flow:
 *   1. If we have a stored refresh token, use it to get an
 *      access token silently and skip straight to the device
 *      check / slideshow.
 *   2. Otherwise run the OAuth 2.0 Device Authorization Grant
 *      so the TV shows a code the user enters on google.com/device.
 *   3. Once signed in, if we don't yet have an Ambient API device
 *      with media sources configured, create one and show its
 *      settings URL + a QR code so the user can pick albums/photos
 *      on their phone.
 *   4. Once media sources are set, list curated media items and
 *      start the slideshow. Base URLs (the actual image bytes)
 *      expire after ~60 minutes, so the media list is silently
 *      re-fetched on a timer without interrupting playback.
 *
 * IMPORTANT — read the README before running this:
 *   Two Google Photos APIs were tried and rejected before landing
 *   here, in case you're comparing against older notes:
 *     - `mediaItems:search` (Library API) stopped supporting
 *       general library search on April 1, 2025.
 *     - The Picker API's scope
 *       (photospicker.mediaitems.readonly) is NOT on Google's
 *       allow-list for the Device Authorization Grant used here —
 *       requesting it returns `invalid_scope`.
 *   The **Ambient API** (scope: photosambient.mediaitems) is
 *   purpose-built for ambient displays like this one, its scope
 *   IS allowed over the device flow, and it gives a persistent
 *   "device" with an ongoing curated feed instead of a one-shot
 *   picker session. See README.md for full setup steps.
 * ============================================================ */

/* ---------------------- CONFIG ---------------------- */

const CONFIG = {
  // From Google Cloud Console → APIs & Services → Credentials.
  // Credential type MUST be "TVs and Limited Input devices".
  CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  CLIENT_SECRET: "YOUR_CLIENT_SECRET",

  // The Ambient API's scope, as documented for use with the device
  // flow. "profile" is included because Google's own Ambient API
  // sample requests it alongside the API scope.
  SCOPE: "profile https://www.googleapis.com/auth/photosambient.mediaitems",

  // Google endpoints
  DEVICE_CODE_URL: "https://oauth2.googleapis.com/device/code",
  TOKEN_URL: "https://oauth2.googleapis.com/token",
  AMBIENT_DEVICES_URL: "https://photosambient.googleapis.com/v1/devices",
  AMBIENT_MEDIA_ITEMS_URL: "https://photosambient.googleapis.com/v1/mediaItems",

  // Shown to the user in Google Photos' device settings list.
  DEVICE_DISPLAY_NAME: "Living Room TV",

  // How long to keep polling devices.get waiting for the user to
  // finish picking media sources, before giving up and showing an
  // error (they can retry from the pairing screen).
  MEDIA_SOURCE_POLL_TIMEOUT_MS: 30 * 60 * 1000,

  // Slideshow behavior
  SLIDE_INTERVAL_MS: 15 * 1000,          // 15 seconds per requirement
  MEDIA_LIST_REFRESH_MS: 50 * 60 * 1000, // re-fetch baseUrls before the 60 min expiry
  MAX_ITEMS_TO_LOAD: 100,                // mediaItems.list caps at 100/page for the curated feed

  // localStorage keys
  LS_REFRESH_TOKEN: "ambient_photos_refresh_token",
  LS_DEVICE_ID: "ambient_photos_device_id",
  LS_DEVICE_REQUEST_ID: "ambient_photos_device_request_id",
};

/* ---------------------- DOM ---------------------- */

const el = {
  boot: document.getElementById("boot-screen"),
  pairing: document.getElementById("pairing-screen"),
  slideshow: document.getElementById("slideshow-screen"),

  signinStep: document.getElementById("pairing-step-signin"),
  signinUrl: document.getElementById("signin-url"),
  signinCode: document.getElementById("signin-code"),
  signinStatus: document.getElementById("signin-status"),

  mediaStep: document.getElementById("pairing-step-media"),
  mediaUrl: document.getElementById("media-url"),
  mediaQr: document.getElementById("media-qr"),
  mediaStatus: document.getElementById("media-status"),

  pairingError: document.getElementById("pairing-error"),

  layerA: document.getElementById("layer-a"),
  layerB: document.getElementById("layer-b"),
  overlayDate: document.getElementById("overlay-date"),
};

function showScreen(name) {
  el.boot.classList.add("hidden");
  el.pairing.classList.add("hidden");
  el.slideshow.classList.add("hidden");
  ({ boot: el.boot, pairing: el.pairing, slideshow: el.slideshow })[name].classList.remove("hidden");
}

function showError(message) {
  el.pairingError.textContent = message;
  el.pairingError.classList.remove("hidden");
}

/* ---------------------- STORAGE ---------------------- */

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage disabled — session-only */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* no-op */ }
  },
};

/** RFC 4122 v4 UUID, without relying on crypto.randomUUID (unavailable on
 *  older Chromium builds that some webOS versions ship with). */
function uuidv4() {
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/* In-memory access token (never persisted — only the refresh token is) */
let accessToken = null;
let accessTokenExpiresAt = 0;

/* ============================================================
 * STEP A — OAuth 2.0 Device Authorization Grant
 * ============================================================ */

async function requestDeviceCode() {
  const res = await fetch(CONFIG.DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`device/code failed: ${res.status}`);
  return res.json();
  // -> { device_code, user_code, verification_url, expires_in, interval }
}

/**
 * Polls the token endpoint at the interval Google gives us until the
 * user finishes signing in on their phone/PC, or the device_code expires.
 */
function pollForDeviceToken(deviceCode, intervalSeconds) {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      let res, body;
      try {
        res = await fetch(CONFIG.TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: CONFIG.CLIENT_ID,
            client_secret: CONFIG.CLIENT_SECRET,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        body = await res.json();
      } catch (networkErr) {
        setTimeout(poll, intervalSeconds * 1000);
        return;
      }

      if (res.ok) {
        resolve(body); // { access_token, refresh_token, expires_in, ... }
        return;
      }

      switch (body.error) {
        case "authorization_pending":
          setTimeout(poll, intervalSeconds * 1000);
          break;
        case "slow_down":
          intervalSeconds += 5;
          setTimeout(poll, intervalSeconds * 1000);
          break;
        case "expired_token":
          reject(new Error("Device code expired before sign-in completed."));
          break;
        case "access_denied":
          reject(new Error("Sign-in was denied."));
          break;
        default:
          reject(new Error(`Token polling error: ${body.error || res.status}${body.error_description ? " — " + body.error_description : ""}`));
      }
    };
    poll();
  });
}

/** Runs the full device flow UI + network sequence and stores the refresh token. */
async function runDeviceSignIn() {
  el.signinStep.classList.remove("hidden");
  el.signinStatus.textContent = "Requesting a sign-in code…";

  const { device_code, user_code, verification_url, interval } = await requestDeviceCode();

  el.signinUrl.textContent = verification_url.replace(/^https?:\/\//, "");
  el.signinCode.textContent = user_code;
  el.signinStatus.textContent = "Waiting for sign-in…";

  const tokenResponse = await pollForDeviceToken(device_code, interval || 5);

  accessToken = tokenResponse.access_token;
  accessTokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000;
  if (tokenResponse.refresh_token) {
    store.set(CONFIG.LS_REFRESH_TOKEN, tokenResponse.refresh_token);
  }

  el.signinStatus.textContent = "Signed in.";
  el.signinStep.classList.add("hidden");
}

/** Exchanges a stored refresh token for a fresh access token. */
async function refreshAccessToken() {
  const refreshToken = store.get(CONFIG.LS_REFRESH_TOKEN);
  if (!refreshToken) throw new Error("No refresh token stored.");

  const res = await fetch(CONFIG.TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    // Refresh token itself is invalid/revoked — force a fresh sign-in.
    store.remove(CONFIG.LS_REFRESH_TOKEN);
    throw new Error(`refresh_token exchange failed: ${res.status}`);
  }

  const body = await res.json();
  accessToken = body.access_token;
  accessTokenExpiresAt = Date.now() + body.expires_in * 1000;
}

/** Returns a valid access token, refreshing or running sign-in as needed. */
async function ensureAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) {
    return accessToken;
  }
  if (store.get(CONFIG.LS_REFRESH_TOKEN)) {
    await refreshAccessToken();
    return accessToken;
  }
  await runDeviceSignIn();
  return accessToken;
}

/* ============================================================
 * STEP B — Google Photos Ambient API
 * ============================================================ */

async function createAmbientDevice(token, requestId) {
  const url = new URL(CONFIG.AMBIENT_DEVICES_URL);
  url.searchParams.set("requestId", requestId);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName: CONFIG.DEVICE_DISPLAY_NAME }),
  });
  if (!res.ok) throw new Error(`devices.create failed: ${res.status}`);
  return res.json(); // AmbientDevice: { id, displayName, settingsUri, mediaSourcesSet, pollingConfig, ... }
}

async function getAmbientDevice(token, deviceId) {
  const res = await fetch(`${CONFIG.AMBIENT_DEVICES_URL}/${deviceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`devices.get failed: ${res.status}`);
  return res.json();
}

/** Polls a device until the user finishes picking media sources on their phone. */
function pollUntilMediaSourcesSet(token, deviceId, pollIntervalSeconds, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for media sources to be selected."));
        return;
      }
      let device;
      try {
        device = await getAmbientDevice(token, deviceId);
      } catch (err) {
        setTimeout(poll, pollIntervalSeconds * 1000);
        return;
      }
      if (device.mediaSourcesSet) {
        resolve(device);
      } else {
        setTimeout(poll, pollIntervalSeconds * 1000);
      }
    };
    poll();
  });
}

/**
 * Runs the full "choose media sources" UI + network sequence: creates (or
 * reuses) an Ambient device, shows its settings QR/URL, waits for the user
 * to finish picking sources. Persists the device id and the requestId used
 * to create it, so a restart doesn't create a duplicate device.
 */
async function runMediaSourceSetup(token) {
  el.mediaStep.classList.remove("hidden");
  el.mediaStatus.textContent = "Setting up this device in Google Photos…";

  let requestId = store.get(CONFIG.LS_DEVICE_REQUEST_ID);
  if (!requestId) {
    requestId = uuidv4();
    store.set(CONFIG.LS_DEVICE_REQUEST_ID, requestId);
  }

  const device = await createAmbientDevice(token, requestId);
  store.set(CONFIG.LS_DEVICE_ID, device.id);

  el.mediaUrl.textContent = device.settingsUri;
  el.mediaQr.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(el.mediaQr, {
    text: device.settingsUri,
    width: 220,
    height: 220,
  });

  el.mediaStatus.textContent = "Waiting for photo selection…";

  const pollInterval = device.pollingConfig?.pollInterval
    ? parseFloat(device.pollingConfig.pollInterval)
    : 5;

  await pollUntilMediaSourcesSet(token, device.id, pollInterval, CONFIG.MEDIA_SOURCE_POLL_TIMEOUT_MS);

  el.mediaStep.classList.add("hidden");
  return device.id;
}

/** Fetches curated ambient media items for a device (paginated). */
async function listAmbientMediaItems(token, deviceId) {
  const items = [];
  let pageToken = "";

  do {
    const url = new URL(CONFIG.AMBIENT_MEDIA_ITEMS_URL);
    url.searchParams.set("deviceId", deviceId);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`mediaItems.list failed: ${res.status}`);
    const body = await res.json();

    (body.mediaItems || []).forEach((item) => items.push(item));
    pageToken = body.nextPageToken || "";
  } while (pageToken && items.length < CONFIG.MAX_ITEMS_TO_LOAD);

  // Photos only — skip any videos for a still-image ambient slideshow.
  return items.filter((item) => item.mediaFile?.mimeType?.startsWith("image/"));
}

/* ============================================================
 * STEP C — Slideshow engine
 * ============================================================ */

let mediaItems = [];
let currentIndex = 0;
let visibleLayer = el.layerA;
let hiddenLayer = el.layerB;
let slideTimer = null;

/** Google Photos base URLs need a size suffix and expire after ~60 min. */
function fullResUrl(item) {
  return `${item.mediaFile.baseUrl}=w1920-h1080`;
}

function formatDate(item) {
  if (!item.createTime) return "";
  const d = new Date(item.createTime);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function preload(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = reject;
    img.src = url;
  });
}

async function showNextSlide() {
  if (mediaItems.length === 0) return;

  const item = mediaItems[currentIndex];
  currentIndex = (currentIndex + 1) % mediaItems.length;

  let url;
  try {
    url = await preload(fullResUrl(item));
  } catch (e) {
    // Skip a broken/expired item and try the next one immediately.
    showNextSlide();
    return;
  }

  hiddenLayer.src = url;
  el.overlayDate.textContent = formatDate(item);

  // Crossfade: fade the new layer in, fade the old one out, then swap roles.
  hiddenLayer.classList.add("visible");
  visibleLayer.classList.remove("visible");
  [visibleLayer, hiddenLayer] = [hiddenLayer, visibleLayer];
}

function startSlideshow() {
  showScreen("slideshow");
  showNextSlide();
  clearInterval(slideTimer);
  slideTimer = setInterval(showNextSlide, CONFIG.SLIDE_INTERVAL_MS);
}

/** Re-fetches the media list (fresh baseUrls) without interrupting playback. */
function scheduleMediaListRefresh(deviceId) {
  setInterval(async () => {
    try {
      const token = await ensureAccessToken();
      const fresh = await listAmbientMediaItems(token, deviceId);
      if (fresh.length) mediaItems = fresh;
    } catch (err) {
      // Keep showing the current (possibly stale) list; next tick retries.
      console.error("Media list refresh failed:", err);
    }
  }, CONFIG.MEDIA_LIST_REFRESH_MS);
}

/* ============================================================
 * BOOT SEQUENCE
 * ============================================================ */

async function boot() {
  showScreen("boot");
  try {
    const token = await ensureAccessToken();
    showScreen("pairing"); // stays hidden unless runMediaSourceSetup needs it

    let deviceId = store.get(CONFIG.LS_DEVICE_ID);
    let needsSetup = true;

    if (deviceId) {
      try {
        const device = await getAmbientDevice(token, deviceId);
        needsSetup = !device.mediaSourcesSet;
      } catch (e) {
        // Device was deleted, or belongs to a client ID we no longer use — redo setup.
        needsSetup = true;
      }
    }

    if (needsSetup) {
      deviceId = await runMediaSourceSetup(token);
    }

    mediaItems = await listAmbientMediaItems(token, deviceId);
    if (mediaItems.length === 0) {
      throw new Error("No photos were found for this device's media sources.");
    }

    scheduleMediaListRefresh(deviceId);
    startSlideshow();
  } catch (err) {
    console.error(err);
    showScreen("pairing");
    showError(err.message || "Something went wrong during setup.");
  }
}

boot();
