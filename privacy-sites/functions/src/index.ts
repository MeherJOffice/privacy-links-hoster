import crypto from "node:crypto";
import zlib from "node:zlib";
import { GoogleAuth } from "google-auth-library";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { defineSecret } from "firebase-functions/params";
import { initializeApp, getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { GoogleGenerativeAI } from "@google/generative-ai";

setGlobalOptions({ region: "us-central1", memory: "512MiB", cpu: 1 });
if (!getApps().length) initializeApp();

const HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  (process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG).projectId : "");

const POLICY_DIR = "/PrivacyPolicies";
const POLICY_PATH = `${POLICY_DIR}/index.html`;
const TEMPLATES_PREFIX = "policy-templates/";

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
async function fetchJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}
function sanitizeSiteId(id: string) {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}
function seededIndex(key: string, n: number) {
  if (n <= 0) return 0;
  const h = crypto.createHash("sha256").update(key).digest();
  const num = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) | 0;
  return Math.abs(num) % n;
}
function fillPlaceholders(html: string, appName: string, email: string) {
  const namePats = [
    /\{\s*product\s*name\s*\}/gi, /\{\s*app\s*name\s*\}/gi,
    /\{\{\s*product\s*name\s*\}\}/gi, /\{\{\s*app\s*name\s*\}\}/gi,
    /%APP_NAME%/g, /%PRODUCT_NAME%/g, /\{\{\s*APP_NAME\s*\}\}/g, /\{\{\s*PRODUCT_NAME\s*\}\}/g,
    /\{APP_NAME\}/g
  ];
  const emailPats = [/\{\s*email\s*\}/gi, /\{\{\s*email\s*\}\}/gi, /%EMAIL%/g, /\{\{\s*CONTACT_EMAIL\s*\}\}/g];
  for (const p of namePats) html = html.replace(p, appName);
  for (const p of emailPats) html = html.replace(p, email);
  return html;
}
function fallbackPolicyHTML(appName: string, email: string) {
  const today = new Date().toISOString().slice(0, 10);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — ${appName}</title><style>body{font-family:system-ui;margin:40px;max-width:860px}</style><body><h1>Privacy Policy</h1><p><strong>App:</strong> ${appName} · <strong>Last Updated:</strong> ${today}</p><p>We collect minimal information necessary to operate and improve ${appName}. For questions contact <a href="mailto:${email}">${email}</a>.</p></body></html>`;
}

async function getPolicyHTML(appName: string, email: string, siteId: string, rotate: boolean, templateName?: string) {
  const bucket = getStorage().bucket();
  const [files] = await bucket.getFiles({ prefix: TEMPLATES_PREFIX });
  const htmlFiles = files.filter((f) => f.name.endsWith(".html") && f.name !== TEMPLATES_PREFIX);
  htmlFiles.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

  if (!htmlFiles.length) return { html: fallbackPolicyHTML(appName, email), templateName: "fallback" };

  let file = htmlFiles[0];
  if (templateName) {
    const exact = htmlFiles.find((f) => f.name.endsWith("/" + templateName) || f.name === templateName);
    if (exact) file = exact;
  } else {
    const n = htmlFiles.length;
    const idx = rotate ? crypto.randomInt(0, n) : seededIndex(siteId, n);
    file = htmlFiles[idx];
  }

  const [buf] = await file.download();
  return { html: fillPlaceholders(buf.toString("utf-8"), appName, email), templateName: file.name.split("/").pop() || file.name };
}

async function publishToHosting(siteId: string, html: string) {
  const gzBuf = zlib.gzipSync(Buffer.from(html, "utf-8"));
  const view = new Uint8Array(gzBuf);
  const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const sha256 = crypto.createHash("sha256").update(view).digest("hex");

  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase.hosting"] });
  const token = await auth.getAccessToken();

  const parent = `projects/${PROJECT_ID}`;
  const siteName = `sites/${siteId}`;

  const c = await fetch(`${HOSTING_API}/${parent}/sites?siteId=${encodeURIComponent(siteId)}`, { method: "POST", headers: authHeaders(token as string), body: JSON.stringify({}) });
  if (!c.ok) {
    const body = (await c.text()).toLowerCase();
    if (!(c.status === 409 && (body.includes("already exists") || body.includes("already in use")))) {
      throw new Error(body || `Create site failed ${c.status}`);
    }
  }

  const vResp = await fetchJSON<{ name: string }>(`${HOSTING_API}/${siteName}/versions`, {
    method: "POST", headers: authHeaders(token as string),
    body: JSON.stringify({ config: { headers: [{ glob: "**", headers: { "Cache-Control": "public, max-age=300" } }], redirects: [{ glob: "/", statusCode: 301, location: POLICY_DIR }] } })
  });
  const versionName = vResp.name;

  const pop = await fetchJSON<{ uploadUrl: string; uploadRequiredHashes: string[] }>(`${HOSTING_API}/${versionName}:populateFiles`, {
    method: "POST", headers: authHeaders(token as string), body: JSON.stringify({ files: { [POLICY_PATH]: sha256 } })
  });

  if (pop.uploadRequiredHashes?.includes(sha256)) {
    const up = await fetch(`${pop.uploadUrl}/${sha256}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: ab });
    if (!up.ok) throw new Error(`Upload failed ${up.status}: ${await up.text()}`);
  }

  const versionId = versionName.split("/")[3];
  await fetchJSON(`${HOSTING_API}/sites/${siteId}/versions/${versionId}?update_mask=status`, {
    method: "PATCH", headers: authHeaders(token as string), body: JSON.stringify({ status: "FINALIZED" })
  });
  await fetchJSON(`${HOSTING_API}/sites/${siteId}/releases?versionName=${encodeURIComponent(versionName)}`, { method: "POST", headers: authHeaders(token as string) });
}

// Endpoints (ensure Promise<void> by not returning Response objects)
export const checkSlug = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
    const slug = sanitizeSiteId((req.body?.slug || "") as string);
    if (!slug || !/^[a-z0-9-]{4,30}$/.test(slug)) { res.status(200).json({ status: "invalid" }); return; }

    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.hosting"] });
    const token = await auth.getAccessToken();
    const list = await fetchJSON<{ sites?: { name: string }[] }>(`${HOSTING_API}/projects/${PROJECT_ID}/sites`, { headers: authHeaders(token as string) });
    const exists = (list.sites || []).some((s) => s.name?.endsWith(`/sites/${slug}`));
    res.status(200).json({ status: exists ? "taken_project" : "maybe_free" }); return;
  } catch (e: any) {
    console.error(e);
    res.status(200).json({ status: "unknown" }); return;
  }
});

export const createPolicySite = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
    const { slug, productName, email, rotate } = req.body || {};
    if (!slug || !productName || !email) { res.status(400).send("Missing slug/productName/email"); return; }
    const siteId = sanitizeSiteId(slug);
    const pick = await getPolicyHTML(productName, email, siteId, rotate !== false);
    await publishToHosting(siteId, pick.html);
    res.status(200).json({
      siteId, templateName: pick.templateName,
      webAppUrl: `https://${siteId}.web.app/`, firebaseAppUrl: `https://${siteId}.firebaseapp.com/`, policyUrl: `https://${siteId}.web.app${POLICY_DIR}`
    }); return;
  } catch (e: any) {
    console.error(e); res.status(500).send(e?.message || "Internal error"); return;
  }
});

export const previewTemplate = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
    const { productName, email, slug, templateName, rotate } = req.body || {};
    if (!productName || !email) { res.status(400).send("Missing productName/email"); return; }
    const siteId = sanitizeSiteId(slug || "preview-" + crypto.randomUUID().slice(0, 8));
    const pick = await getPolicyHTML(productName, email, siteId, rotate !== false, templateName);
    res.status(200).json({ html: pick.html, templateName: pick.templateName }); return;
  } catch (e: any) {
    console.error(e); res.status(500).json({ message: e?.message || "Preview failed" }); return;
  }
});

export const publishTemplate = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
    const { slug, html, productName, email, templateName } = req.body || {};
    if (!slug) { res.status(400).send("Missing slug"); return; }
    const siteId = sanitizeSiteId(slug);
    let outHtml: string | undefined = html as string | undefined;
    if (!outHtml && (productName && email && templateName)) {
      const pick = await getPolicyHTML(productName, email, siteId, false, templateName);
      outHtml = pick.html;
    }
    if (!outHtml) { res.status(400).send("No html provided"); return; }
    await publishToHosting(siteId, outHtml);
    res.status(200).json({
      siteId, webAppUrl: `https://${siteId}.web.app/`, firebaseAppUrl: `https://${siteId}.firebaseapp.com/`, policyUrl: `https://${siteId}.web.app${POLICY_DIR}`
    }); return;
  } catch (e: any) {
    console.error(e); res.status(500).json({ message: e?.message || "Publish failed" }); return;
  }
});

async function generateAiPolicyHtmlPreview(productName: string, email: string, customPrompt = "", tone = "professional", variation?: string, _answers?: any, stylePack?: any) {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const styleSeed = JSON.stringify(stylePack || {}, null, 2);
  const styleLine = tone === "playful" ? "friendly and colorful" : tone === "techy" ? "sleek and developer-facing" : "clean and formal";
  const userBlock = customPrompt?.trim() ? `USER STYLE NOTES:\n${customPrompt.trim()}\n` : "";

  const sys = `
ROLE: You are a senior UX writer & designer. Produce a single-file PRIVACY POLICY page.

STRICT VISUAL RULES:
- Use ONLY inline CSS + semantic HTML. NO external fonts, images, or scripts.
- Use and honor this STYLE PACK (as inspiration): 
${styleSeed}

STRICT CONTENT RULES:
- App name: ${productName}
- Contact email: ${email}

OUTPUT LAYOUT:
- Sticky header with app name and "Contact" anchor link.
- Sections: Intro (with today's date), Information We Collect, How We Use, Third Parties, Legal Bases (GDPR if relevant), Retention & Deletion, Security, Children's Privacy, Your Rights/Choices, Changes, Contact.
- Style: ${styleLine}. Use tasteful CSS-only micro-interactions (link hovers, separators). 
${userBlock}

OUTPUT:
- Return ONLY a complete HTML document (<!doctype html> … </html>).
`.trim();

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: { temperature: 1.25, topP: 0.95, topK: 64, maxOutputTokens: 5500 }
  });

  const resp = await model.generateContent(sys);
  let html = (resp.response.text() || "").trim();
  html = html.replace(/```html|```/gi, "").trim();
  if (!/<!doctype|<html/i.test(html)) {
    html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — ${productName}</title>` + html;
  }
  html = fillPlaceholders(html, productName, email);
  return html;
}

export const previewPolicyHtml = onRequest({ invoker: "public", cors: true, secrets: [GEMINI_API_KEY] }, async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
    const { productName, email, aiPrompt, tone, variation, answers, stylePack } = req.body ?? {};
    if (!productName || !email) { res.status(400).json({ code: "bad_request", message: "Missing productName or email" }); return; }
    const html = await generateAiPolicyHtmlPreview(productName, email, aiPrompt, tone || "professional", variation, answers, stylePack);
    res.status(200).json({ html, bytes: Buffer.byteLength(html, "utf8") }); return;
  } catch (e: any) {
    console.error(e); res.status(500).json({ code: "internal", message: e?.message || "Preview failed" }); return;
  }
});

export const publishAiPolicy = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
    const { slug, html } = req.body || {};
    if (!slug || !html) { res.status(400).send("Missing slug/html"); return; }
    const siteId = sanitizeSiteId(slug);
    await publishToHosting(siteId, html);
    res.status(200).json({
      siteId, webAppUrl: `https://${siteId}.web.app/`, firebaseAppUrl: `https://${siteId}.firebaseapp.com/`, policyUrl: `https://${siteId}.web.app${POLICY_DIR}`
    }); return;
  } catch (e: any) {
    console.error(e); res.status(500).json({ message: e?.message || "Publish failed" }); return;
  }
});
