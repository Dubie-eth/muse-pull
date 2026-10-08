// POST /api/agent/x-media — Cardigan's media-posting endpoint (Vercel serverless).
// Lets Cardigan post images to @cardiganmuse35 without her ever touching
// the OAuth 1.0a keys: they live in the Vercel project's secret store,
// this function signs the requests server-side.
//
// Env required (Vercel dashboard -> Settings -> Environment Variables):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//   CARDIGAN_AGENT_SECRET  (shared secret Cardigan's agent sends)
//
// Request (POST, JSON):
//   { "text": "caption", "mediaBase64": "<base64>", "mediaType": "image/jpeg" }
//
// Response: { "ok": true, "id": "<tweet id>", "url": "https://x.com/cardiganmuse35/status/<id>" }

const { createHmac, randomBytes } = require("crypto");

const UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
const TWEETS_URL = "https://api.x.com/2/tweets";

// RFC3986 percent-encoding (encodeURIComponent leaves !'()* unescaped)
function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function oauthHeader(method, url, consumerKey, consumerSecret, token, tokenSecret) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  // For multipart/JSON bodies, only the oauth params go in the signature.
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const key = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  const sig = createHmac("sha1", key).update(base).digest("base64");
  const headerParams = { ...params, oauth_signature: sig };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${pct(k)}="${pct(headerParams[k])}"`)
      .join(", ")
  );
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  // --- agent auth ---
  const agentSecret = process.env.CARDIGAN_AGENT_SECRET;
  if (!agentSecret) {
    return res.status(500).json({ ok: false, error: "server not configured" });
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${agentSecret}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // --- env check ---
  const CK = process.env.X_API_KEY;
  const CS = process.env.X_API_SECRET;
  const AT = process.env.X_ACCESS_TOKEN;
  const AS = process.env.X_ACCESS_SECRET;
  if (!CK || !CS || !AT || !AS) {
    return res.status(500).json({ ok: false, error: "x credentials not configured" });
  }

  // --- input ---
  const body = req.body || {};
  const text = body.text || "";
  const mediaBase64 = body.mediaBase64;
  const mediaType = body.mediaType || "image/jpeg";
  if (!text && !mediaBase64) {
    return res.status(400).json({ ok: false, error: "text or mediaBase64 required" });
  }

  try {
    let mediaId;

    // --- 1. upload media (simple upload, images up to ~5MB) ---
    if (mediaBase64) {
      const bytes = Buffer.from(mediaBase64, "base64");
      if (bytes.length > 5 * 1024 * 1024) {
        return res.status(400).json({ ok: false, error: "media over 5MB needs chunked upload (not yet)" });
      }
      const form = new FormData();
      form.append("media", new Blob([bytes], { type: mediaType }), "upload");
      const upRes = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: { Authorization: oauthHeader("POST", UPLOAD_URL, CK, CS, AT, AS) },
        body: form,
      });
      const upJson = await upRes.json().catch(() => ({}));
      if (!upRes.ok || !upJson.media_id_string) {
        return res.status(502).json({ ok: false, error: "media upload failed", detail: upJson });
      }
      mediaId = upJson.media_id_string;
    }

    // --- 2. post the tweet ---
    const payload = { text };
    if (mediaId) payload.media = { media_ids: [mediaId] };
    const twRes = await fetch(TWEETS_URL, {
      method: "POST",
      headers: {
        Authorization: oauthHeader("POST", TWEETS_URL, CK, CS, AT, AS),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const twJson = await twRes.json().catch(() => ({}));
    if (!twRes.ok || !twJson?.data?.id) {
      return res.status(502).json({ ok: false, error: "tweet failed", detail: twJson });
    }
    const id = twJson.data.id;
    return res.status(200).json({
      ok: true,
      id,
      url: `https://x.com/cardiganmuse35/status/${id}`,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "exception", detail: String(e) });
  }
};
