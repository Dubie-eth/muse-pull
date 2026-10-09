// POST /api/agent/x-media — Cardigan's media-posting endpoint (Vercel serverless).
// Lets Cardigan post images AND video to @cardiganmuse35 without her ever
// touching the OAuth 1.0a keys: they live in the Vercel project's secret
// store, this function signs the requests server-side.
//
// Env required (Vercel dashboard -> Settings -> Environment Variables):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//   CARDIGAN_AGENT_SECRET  (shared secret Cardigan's agent sends)
//
// Request (POST, JSON):
//   { "text": "caption", "mediaBase64": "<base64>", "mediaType": "image/jpeg" }
//   mediaType "video/mp4" triggers chunked upload (up to ~50MB).
//   Optional: "replyTo": "<tweet id>" threads as a reply,
//             "quoteTweetId": "<tweet id>" posts as a quote tweet,
//             { "action": "delete", "id": "<tweet id>" } deletes a tweet.
//
// Response: { "ok": true, "id": "<tweet id>", "url": "https://x.com/cardiganmuse35/status/<id>" }

const { createHmac, randomBytes } = require("crypto");

const UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
const TWEETS_URL = "https://api.x.com/2/tweets";
const CHUNK_SIZE = 1024 * 1024; // 1MB APPEND segments
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// RFC3986 percent-encoding (encodeURIComponent leaves !'()* unescaped)
function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// extraParams: non-oauth params (query/form) to include in the signature base
function oauthHeader(method, url, consumerKey, consumerSecret, token, tokenSecret, extraParams = {}) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
    ...extraParams,
  };
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const key = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  const sig = createHmac("sha1", key).update(base).digest("base64");
  const headerParams = {
    oauth_consumer_key: params.oauth_consumer_key,
    oauth_nonce: params.oauth_nonce,
    oauth_signature: sig,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: params.oauth_timestamp,
    oauth_token: params.oauth_token,
    oauth_version: "1.0",
  };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${pct(k)}="${pct(headerParams[k])}"`)
      .join(", ")
  );
}

function qs(params) {
  return Object.keys(params)
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
}

async function chunkedVideoUpload(bytes, creds) {
  const { CK, CS, AT, AS } = creds;
  // Query-string params are ALWAYS part of the OAuth signature base string,
  // even on multipart requests (only the multipart body itself is excluded).
  const sign = (method, params) =>
    oauthHeader(method, UPLOAD_URL, CK, CS, AT, AS, params);

  // --- INIT ---
  const initParams = {
    command: "INIT",
    total_bytes: String(bytes.length),
    media_type: "video/mp4",
    media_category: "tweet_video",
  };
  let r = await fetch(`${UPLOAD_URL}?${qs(initParams)}`, {
    method: "POST",
    headers: { Authorization: sign("POST", initParams) },
  });
  let j = await r.json().catch(() => ({}));
  if (!r.ok || !j.media_id_string) {
    throw new Error("INIT failed: " + JSON.stringify(j).slice(0, 300));
  }
  const mediaId = j.media_id_string;

  // --- APPEND (1MB segments, multipart; body excluded from signature) ---
  const totalSegs = Math.ceil(bytes.length / CHUNK_SIZE);
  for (let i = 0; i < totalSegs; i++) {
    const chunk = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const appendParams = { command: "APPEND", media_id: mediaId, segment_index: String(i) };
    const form = new FormData();
    form.append("media", new Blob([chunk], { type: "video/mp4" }), "chunk.mp4");
    r = await fetch(`${UPLOAD_URL}?${qs(appendParams)}`, {
      method: "POST",
      headers: { Authorization: sign("POST", appendParams) },
      body: form,
    });
    if (r.status !== 204 && !r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`APPEND seg ${i} failed (${r.status}): ` + t.slice(0, 200));
    }
  }

  // --- FINALIZE ---
  const finParams = { command: "FINALIZE", media_id: mediaId };
  r = await fetch(`${UPLOAD_URL}?${qs(finParams)}`, {
    method: "POST",
    headers: { Authorization: sign("POST", finParams) },
  });
  j = await r.json().catch(() => ({}));
  if (!r.ok || !j.media_id_string) {
    throw new Error("FINALIZE failed: " + JSON.stringify(j).slice(0, 300));
  }

  // --- wait for async video processing ---
  let processing = j.processing_info;
  const statusParams = { command: "STATUS", media_id: mediaId };
  for (let attempt = 0; attempt < 30 && processing && processing.state !== "succeeded"; attempt++) {
    if (processing.state === "failed") {
      throw new Error("video processing failed: " + JSON.stringify(processing).slice(0, 300));
    }
    await new Promise((res) => setTimeout(res, (processing.check_after_secs || 5) * 1000));
    r = await fetch(`${UPLOAD_URL}?${qs(statusParams)}`, {
      headers: { Authorization: sign("GET", statusParams) },
    });
    j = await r.json().catch(() => ({}));
    processing = j.processing_info;
  }
  if (processing && processing.state !== "succeeded") {
    throw new Error("video processing timed out: " + JSON.stringify(processing).slice(0, 200));
  }
  return mediaId;
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
  const creds = { CK, CS, AT, AS };

  // --- input ---
  const body = req.body || {};
  const text = body.text || "";
  const mediaBase64 = body.mediaBase64;
  const mediaType = body.mediaType || "image/jpeg";
  const replyTo = body.replyTo || body.in_reply_to_tweet_id;
  const quoteTweetId = body.quoteTweetId || body.quote_tweet_id;

  // --- delete action ---
  if (body.action === "delete" && body.id) {
    const delRes = await fetch(`${TWEETS_URL}/${body.id}`, {
      method: "DELETE",
      headers: {
        Authorization: oauthHeader("DELETE", `${TWEETS_URL}/${body.id}`, CK, CS, AT, AS),
      },
    });
    const delJson = await delRes.json().catch(() => ({}));
    if (!delRes.ok || delJson?.data?.deleted !== true) {
      return res.status(502).json({ ok: false, error: "delete failed", detail: delJson });
    }
    return res.status(200).json({ ok: true, deleted: body.id });
  }

  if (!text && !mediaBase64) {
    return res.status(400).json({ ok: false, error: "text or mediaBase64 required" });
  }
  const isVideo = mediaType.startsWith("video/");

  try {
    let mediaId;

    if (mediaBase64) {
      const bytes = Buffer.from(mediaBase64, "base64");

      if (isVideo) {
        if (bytes.length > MAX_VIDEO_BYTES) {
          return res.status(400).json({ ok: false, error: `video over ${MAX_VIDEO_BYTES / 1024 / 1024}MB` });
        }
        if (mediaType !== "video/mp4") {
          return res.status(400).json({ ok: false, error: "only video/mp4 supported" });
        }
        mediaId = await chunkedVideoUpload(bytes, creds);
      } else {
        if (bytes.length > 5 * 1024 * 1024) {
          return res.status(400).json({ ok: false, error: "image over 5MB" });
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
    }

    // --- post the tweet ---
    const payload = { text };
    if (mediaId) payload.media = { media_ids: [mediaId] };
    if (replyTo) payload.reply = { in_reply_to_tweet_id: String(replyTo) };
    if (quoteTweetId) payload.quote_tweet_id = String(quoteTweetId);
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
    return res.status(500).json({ ok: false, error: "exception", detail: String(e).slice(0, 500) });
  }
};
