// api/intake.js — Vercel serverless receiver for the rev11 intake form.
// Same-origin POST (no CORS) -> honest success/failure -> appends one row to the
// private Intakes sheet via the Google Sheets API, authenticated as a service
// account whose creds live in Vercel env vars (never in the repo):
//   GOOGLE_SA_EMAIL  service-account email (must be an Editor on the sheet)
//   GOOGLE_SA_KEY    the private key (paste with literal \n newlines)
//   SHEET_ID         the spreadsheet id
// Zero dependencies: JWT signed with node crypto, raw REST to Sheets.

const crypto = require("crypto");

// Column order = the Intakes sheet header row, exactly.
const HEADERS = [
  "ts", "name", "sells", "model", "currency", "period",
  "ltv", "ltv_basis", "ltv_trend",
  "cac", "cac_basis", "cac_trend",
  "conv", "conv_basis", "conv_trend",
  "leads", "leads_basis", "leads_trend",
  "aov", "aov_basis", "aov_trend",
  "referral", "referral_basis", "referral_trend",
  "churn", "churn_basis", "churn_trend",
  "activation", "compounding", "gross_margin", "pillars", "channels",
  "founder_indep", "payoff", "self_diagnosis", "notes", "submitted",
  // consultant block — filled at diagnosis time:
  "diag_date", "posture", "binding_constraint", "confidence", "frameworks", "status", "followup",
  "client_tag",
];

const METRIC_KEYS = { LTV: "ltv", CAC: "cac", CONVERSION: "conv", LEAD_VOLUME: "leads",
                      TRANSACTION_VALUE: "aov", REFERRAL: "referral", CHURN: "churn" };
const BASIS_OK = new Set(["books", "calc", "gut"]);
const TREND_OK = new Set(["better", "worse", "same", "cantsay"]);

function num(v, max) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return "";
  if (max != null && n > max) return "";
  return n;
}
function str(v, cap) { return typeof v === "string" ? v.slice(0, cap || 500) : ""; }
function choice(v, set) { return set.has(v) ? v : ""; }

function buildRow(p) {
  const row = {};
  row.ts = new Date().toISOString();
  row.name = str(p.name, 200);
  row.sells = str(p.sells, 300);
  row.model = str(p.model, 40);
  row.currency = str(p.currency, 10);
  row.period = p.period === "year" ? "year" : "month";
  for (const [K, base] of Object.entries(METRIC_KEYS)) {
    const m = (p.metrics && p.metrics[K]) || {};
    const capped = (K === "CONVERSION" || K === "REFERRAL" || K === "CHURN") ? 100 : null;
    row[base] = m.value == null || m.value === "" ? "" : num(m.value, capped);
    row[base + "_basis"] = row[base] === "" ? "" : choice(m.basis, BASIS_OK);
    row[base + "_trend"] = choice(m.trend, TREND_OK);
  }
  row.activation = ["onboarding", "later", "unsure"].includes(p.activation) ? p.activation : "";
  row.compounding = ["repeat", "once", "unsure"].includes(p.compounding) ? p.compounding : "";
  row.gross_margin = p.gross_margin == null || p.gross_margin === "" ? "" : num(p.gross_margin, 100);
  row.pillars = str(p.pillars, 300);
  row.channels = str(p.channels, 40);
  row.founder_indep = str(p.founder_indep, 20);
  row.payoff = str(p.payoff, 20);
  row.self_diagnosis = str(p.their_read, 2000);
  row.notes = str(p.notes, 2000);
  row.submitted = new Date().toISOString().slice(0, 10);
  row.client_tag = str(p.client_tag, 60);
  return HEADERS.map(h => row[h] ?? "");
}

async function getToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("missing service-account env vars");
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
          "&assertion=" + unsigned + "." + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token exchange failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const p = req.body && typeof req.body === "object" ? req.body : {};
    if (!str(p.name).trim()) return res.status(400).json({ ok: false, error: "name required" });
    const row = buildRow(p);
    const token = await getToken();
    const url = "https://sheets.googleapis.com/v4/spreadsheets/" + process.env.SHEET_ID +
      "/values/" + encodeURIComponent("Intakes!A1") + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    });
    if (!r.ok) throw new Error("sheets append " + r.status + ": " + (await r.text()).slice(0, 200));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("intake error:", e.message);
    return res.status(500).json({ ok: false, error: "could not save — use the copy option" });
  }
};
