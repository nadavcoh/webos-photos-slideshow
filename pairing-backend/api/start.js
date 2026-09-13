/**
 * GET /api/start?state=<pairing-code>
 *
 * The TV generates a random, single-use `state` value and shows it (as
 * part of this URL) as a QR code. Opening it on a phone lands here,
 * which immediately redirects into Google's standard OAuth consent
 * screen. `state` rides along through the whole redirect chain and is
 * how /api/callback knows which TV pairing session this approval
 * belongs to.
 */
module.exports = (req, res) => {
  const { state } = req.query;

  if (!state || typeof state !== "string") {
    res.status(400).send("Missing state parameter.");
    return;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent",      // force a fresh refresh_token on every pairing
    state,
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  res.end();
};
