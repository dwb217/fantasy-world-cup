// Vercel serverless function: writes edited results to data/overrides.js in the
// GitHub repo. Edits are gated by a shared password and committed with a GitHub
// token — both stored as Vercel environment variables (never sent to the browser).
//
// Required env vars (set in the Vercel dashboard):
//   GH_TOKEN       fine-grained PAT with "Contents: read & write" on the repo
//   GH_REPO        "owner/name", e.g. "dwb217/fantasy-world-cup"
//   EDIT_PASSWORD  the shared password editors must enter to save
// Optional:
//   GH_BRANCH      defaults to "main"
//   OVERRIDES_PATH defaults to "data/overrides.js"

const GH_API = "https://api.github.com";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { GH_TOKEN, GH_REPO, EDIT_PASSWORD } = process.env;
  const GH_BRANCH = process.env.GH_BRANCH || "main";
  const PATH = process.env.OVERRIDES_PATH || "data/overrides.js";

  if (!GH_TOKEN || !GH_REPO || !EDIT_PASSWORD) {
    return res.status(500).json({ error: "Server is not configured (missing GH_TOKEN, GH_REPO, or EDIT_PASSWORD)." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : safeJson(req.body);
  const { password, overrides } = body || {};

  if (!password || password !== EDIT_PASSWORD) {
    return res.status(401).json({ error: "Wrong edit password." });
  }
  const clean = validateOverrides(overrides);
  if (!clean) {
    return res.status(400).json({ error: "Invalid overrides payload." });
  }

  const content = renderOverridesFile(clean);
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fantasy-world-cup",
  };

  try {
    // Current file SHA (required to update; absent if the file doesn't exist yet).
    let sha;
    const getRes = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${PATH}?ref=${GH_BRANCH}`, { headers });
    if (getRes.ok) sha = (await getRes.json()).sha;
    else if (getRes.status !== 404) {
      return res.status(502).json({ error: `GitHub read failed (${getRes.status}).` });
    }

    const putRes = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${PATH}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: "Edit results via web app",
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: GH_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putRes.status === 409) {
      return res.status(409).json({ error: "Someone else just saved — reload and try again." });
    }
    if (!putRes.ok) {
      const detail = await putRes.text().catch(() => "");
      return res.status(502).json({ error: `GitHub write failed (${putRes.status}). ${detail.slice(0, 200)}` });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error: " + e.message });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Accept only the expected shape and coerce field types — never trust the client.
function validateOverrides(o) {
  if (!o || typeof o !== "object") return null;
  const out = { byEventId: {}, manualMatches: [] };

  const src = o.byEventId && typeof o.byEventId === "object" ? o.byEventId : {};
  for (const [id, patch] of Object.entries(src)) {
    if (!/^\d+$/.test(String(id)) || !patch || typeof patch !== "object") continue;
    out.byEventId[String(id)] = pickPatch(patch);
  }

  if (Array.isArray(o.manualMatches)) {
    for (const m of o.manualMatches) {
      if (!m || typeof m !== "object") continue;
      out.manualMatches.push({
        id: Number(m.id) || 0,
        source: "manual",
        date: String(m.date || ""),
        stage: m.stage === "knockout" ? "knockout" : "group",
        roundLabel: m.roundLabel ? String(m.roundLabel) : undefined,
        teamA: String(m.teamA || ""),
        teamB: String(m.teamB || ""),
        ...pickPatch(m),
      });
    }
  }
  return out;
}

function pickPatch(p) {
  const out = {};
  if (p.scoreA != null && p.scoreA !== "") out.scoreA = Number(p.scoreA);
  if (p.scoreB != null && p.scoreB !== "") out.scoreB = Number(p.scoreB);
  if (typeof p.extraTime === "boolean") out.extraTime = p.extraTime;
  if (typeof p.penalties === "boolean") out.penalties = p.penalties;
  if ("shootoutWinner" in p) out.shootoutWinner = p.shootoutWinner ? String(p.shootoutWinner) : null;
  return out;
}

function renderOverridesFile(o) {
  return (
`// Manual corrections applied on top of the API data. Written by the web app's
// "Edit results" feature (api/save-result.js) and also editable by hand.
// The importer (scripts/fetch_scores.js) applies these on every refresh, so
// edits survive the automatic updates.
window.OVERRIDES = ${JSON.stringify(o, null, 2)};
`);
}
