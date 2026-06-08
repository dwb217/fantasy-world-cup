// Verifies the shared site password and sets the auth cookie that middleware.js
// checks. Reuses the same EDIT_PASSWORD env var as the edit feature.
import crypto from "node:crypto";

const SALT = "::fwc-site"; // must match middleware.js
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const password = process.env.EDIT_PASSWORD;
  if (!password) return res.status(500).json({ error: "Server not configured (EDIT_PASSWORD missing)." });

  const body = req.body && typeof req.body === "object" ? req.body : safeJson(req.body);
  if (!body || body.password !== password) {
    return res.status(401).json({ error: "Wrong password." });
  }

  const token = crypto.createHash("sha256").update(password + SALT).digest("hex");
  res.setHeader(
    "Set-Cookie",
    `fwc_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`
  );
  return res.status(200).json({ ok: true });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
