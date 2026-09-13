const { kv } = require("@vercel/kv");

/**
 * GET /api/callback?code=...&state=...
 *
 * Google redirects the phone browser here after the user approves (or
 * denies) access. This handler:
 *   1. Exchanges the authorization `code` for tokens (server-side only —
 *      the client secret never leaves this function).
 *   2. Immediately creates a Photos Picker session with the fresh
 *      access token, so the user can be dropped straight into picking
 *      photos without a second QR code back on the TV.
 *   3. Stashes {refreshToken, accessToken, sessionId, ...} in a
 *      short-lived KV entry keyed by `state`, for the TV to collect via
 *      /api/poll.
 *   4. Redirects the phone browser straight into the Picker session.
 */
module.exports = async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`Google sign-in was not completed: ${error}`);
    return;
  }
  if (!code || !state) {
    res.status(400).send("Missing code or state parameter.");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code: String(code),
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    const sessionRes = await fetch("https://photospicker.googleapis.com/v1/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const session = await sessionRes.json();
    if (!sessionRes.ok) {
      throw new Error(`Picker session creation failed: ${JSON.stringify(session)}`);
    }

    await kv.set(
      `pairing:${state}`,
      JSON.stringify({
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        sessionId: session.id,
      }),
      { ex: 600 } // 10 minutes — comfortably longer than the TV's poll timeout
    );

    res.writeHead(302, { Location: `${session.pickerUri}/autoclose` });
    res.end();
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send("Something went wrong linking your account. Please return to the TV and try again.");
  }
};
