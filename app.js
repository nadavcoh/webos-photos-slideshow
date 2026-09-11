/* ============================================================
 * Ambient Photos — app.js
 *
 * Flow:
 *   1. If we have a stored refresh token, use it to get an
 *      access token silently and skip straight to the picker
 *      check / slideshow.
 *   2. Otherwise run the OAuth 2.0 Device Authorization Grant
 *      so the TV shows a code the user enters on google.com/device.
 *   3. Once signed in, if we don't yet have a completed Photos
 *      Picker session, create one and show its URL + a QR code
 *      so the user can pick photos/albums on their phone.
 *   4. Once photos are picked, list them and start the slideshow.
 *      Base URLs (the actual image bytes) expire after ~60
 *      minutes, so the media list is silently re-fetched on a
 *      timer without interrupting playback.
 *
 * IMPORTANT — read the README before running this:
 *   Google retired general library search in the Photos Library
 *   API on April 1, 2025. `mediaItems:search` now only returns
 *   items your app itself uploaded. To show a user's existing
 *   photos/albums you must use the Photos Picker API, which is
 *   what this file does. See README.md for full setup steps.
 * ============================================================ */

/* ---------------------- CONFIG ---------------------- */

const CONFIG = {
  // From Google Cloud Console → APIs & Services → Credentials.
  // Credential type MUST be "TVs and Limited Input devices".
  CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  CLIENT_SECRET: "YOUR_CLIENT_SECRET",

  // Photos Picker only needs this narrow, read-only scope.
  SCOPE: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",

  // Google endpoints
  DEVICE_CODE_URL: "https://oauth2.googleapis.com/device/code",
  TOKEN_URL: "https://oauth2.googleapis.com/token",
  PICKER_SESSION_URL: "https://photospicker.googleapis.com/v1/sessions",
  PICKER_MEDIA_ITEMS_URL: "https://photospicker.googleapis.com/v1/mediaItems",

  // Slideshow behavior
  SLIDE_INTERVAL_MS: 15 * 1000,          // 15 seconds per requirement
  MEDIA_LIST_REFRESH_MS: 50 * 60 * 1000, // re-fetch baseUrls before the 60 min expiry
  MAX_ITEMS_TO_LOAD: 200,                // cap memory/pagination for very large picks

  // localStorage keys
  LS_REFRESH_TOKEN: "ambient_photos_refresh_token",
  LS_PICKER_SESSION_ID: "ambient_photos_picker_session_id",
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

  pickerStep: document.getElementById("pairing-step-picker"),
  pickerUrl: document.getElementById("picker-url"),
  pickerQr: document.getElementById("picker-qr"),
  pickerStatus: document.getElementById("picker-status"),

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
          reject(new Error(`Token polling error: ${body.error || res.status}`));
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
 * STEP B — Google Photos Picker API
 * ============================================================ */

async function createPickerSession(token) {
  const res = await fetch(CONFIG.PICKER_SESSION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Picker session creation failed: ${res.status}`);
  return res.json(); // { id, pickerUri, pollingConfig: { pollInterval, timeoutIn }, mediaItemsSet }
}

async function getPickerSession(token, sessionId) {
  const res = await fetch(`${CONFIG.PICKER_SESSION_URL}/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Picker session lookup failed: ${res.status}`);
  return res.json();
}

/** Polls a picker session until the user finishes selecting media on their phone. */
function pollPickerSession(token, sessionId, pollIntervalSeconds, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Picker session timed out before a selection was made."));
        return;
      }
      let session;
      try {
        session = await getPickerSession(token, sessionId);
      } catch (err) {
        setTimeout(poll, pollIntervalSeconds * 1000);
        return;
      }
      if (session.mediaItemsSet) {
        resolve(session);
      } else {
        setTimeout(poll, pollIntervalSeconds * 1000);
      }
    };
    poll();
  });
}

/**
 * Runs the full picker UI + network sequence:
 * creates a session, shows the QR/URL, waits for completion.
 * Persists the session id so a restart doesn't force a re-pick.
 */
async function runPickerFlow(token) {
  el.pickerStep.classList.remove("hidden");
  el.pickerStatus.textContent = "Creating picker session…";

  const session = await createPickerSession(token);
  store.set(CONFIG.LS_PICKER_SESSION_ID, session.id);

  el.pickerUrl.textContent = session.pickerUri;
  el.pickerQr.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(el.pickerQr, {
    text: session.pickerUri,
    width: 220,
    height: 220,
  });

  el.pickerStatus.textContent = "Waiting for photo selection…";

  const pollInterval = session.pollingConfig?.pollInterval
    ? parseInt(session.pollingConfig.pollInterval, 10)
    : 3;
  const timeout = session.pollingConfig?.timeoutIn
    ? parseInt(session.pollingConfig.timeoutIn, 10)
    : 1800;

  await pollPickerSession(token, session.id, pollInterval, timeout);

  el.pickerStep.classList.add("hidden");
  return session.id;
}

/** Fetches every picked media item for a completed session (paginated). */
async function listPickedMediaItems(token, sessionId) {
  const items = [];
  let pageToken = "";

  do {
    const url = new URL(CONFIG.PICKER_MEDIA_ITEMS_URL);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`mediaItems.list failed: ${res.status}`);
    const body = await res.json();

    (body.mediaItems || []).forEach((item) => items.push(item));
    pageToken = body.nextPageToken || "";
  } while (pageToken && items.length < CONFIG.MAX_ITEMS_TO_LOAD);

  // Photos only — skip videos for a still-image ambient slideshow.
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
  const iso = item.mediaFile?.mediaFileMetadata?.creationTime || item.createTime;
  if (!iso) return "";
  const d = new Date(iso);
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
function scheduleMediaListRefresh(sessionId) {
  setInterval(async () => {
    try {
      const token = await ensureAccessToken();
      const fresh = await listPickedMediaItems(token, sessionId);
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
    showScreen("pairing"); // stays hidden unless runPickerFlow needs it

    let sessionId = store.get(CONFIG.LS_PICKER_SESSION_ID);
    let needsNewSession = true;

    if (sessionId) {
      try {
        const session = await getPickerSession(token, sessionId);
        needsNewSession = !session.mediaItemsSet;
      } catch (e) {
        needsNewSession = true;
      }
    }

    if (needsNewSession) {
      sessionId = await runPickerFlow(token);
    }

    mediaItems = await listPickedMediaItems(token, sessionId);
    if (mediaItems.length === 0) {
      throw new Error("No photos were found in the picker selection.");
    }

    scheduleMediaListRefresh(sessionId);
    startSlideshow();
  } catch (err) {
    console.error(err);
    showScreen("pairing");
    showError(err.message || "Something went wrong during setup.");
  }
}

boot();
