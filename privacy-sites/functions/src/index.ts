import crypto from "node:crypto";
import zlib from "node:zlib";
import { GoogleAuth } from "google-auth-library";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { initializeApp, getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

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

/* ---------- utils ---------- */
function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
async function fetchJSON(url: string, init?: RequestInit) {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
}
function sanitizeSiteId(id: string) {
    return id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
}
function seededIndex(key: string, n: number) {
    if (n <= 0) return 0;
    const h = crypto.createHash("sha256").update(key).digest();
    const num = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) | 0;
    return Math.abs(num) % n;
}
function fillPlaceholders(html: string, appName: string, email: string) {
    const namePatterns = [
        /\{\s*product\s*name\s*\}/gi, /\{\s*app\s*name\s*\}/gi,
        /\{\{\s*product\s*name\s*\}\}/gi, /\{\{\s*app\s*name\s*\}\}/gi,
        /%APP_NAME%/g, /%PRODUCT_NAME%/g, /\{\{\s*APP_NAME\s*\}\}/g, /\{\{\s*PRODUCT_NAME\s*\}\}/g
    ];
    const emailPatterns = [
        /\{\s*email\s*\}/gi, /\{\{\s*email\s*\}\}/gi, /%EMAIL%/g, /\{\{\s*CONTACT_EMAIL\s*\}\}/g
    ];
    for (const p of namePatterns) html = html.replace(p, appName);
    for (const p of emailPatterns) html = html.replace(p, email);
    return html;
}
function fallbackPolicyHTML(appName: string, email: string) {
    const today = new Date().toISOString().slice(0, 10);
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — ${appName}</title><style>body{font-family:system-ui;margin:40px;max-width:860px}</style><body><h1>Privacy Policy</h1><p><strong>App:</strong> ${appName} · <strong>Last Updated:</strong> ${today}</p><p>We collect minimal information necessary to operate and improve ${appName}. For questions contact <a href="mailto:${email}">${email}</a>.</p></body></html>`;
}

/** Pick a template from Storage. If `rotate=true`, pick random every run. Else deterministic by slug. */
async function getPolicyHTML(appName: string, email: string, siteId: string, rotate: boolean) {
    const bucket = getStorage().bucket(); // default bucket <project-id>.appspot.com
    const [files] = await bucket.getFiles({ prefix: TEMPLATES_PREFIX });
    const htmlFiles = files.filter(f => f.name.endsWith(".html") && f.name !== TEMPLATES_PREFIX);
    htmlFiles.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

    if (!htmlFiles.length) return fallbackPolicyHTML(appName, email);

    const n = htmlFiles.length;
    const idx = rotate ? crypto.randomInt(0, n) : seededIndex(siteId, n);
    const file = htmlFiles[idx];
    const [buf] = await file.download();
    return fillPlaceholders(buf.toString("utf-8"), appName, email);
}

export const createPolicySite = onRequest({ invoker: "public", cors: true }, async (req, res) => {
    try {
        if (req.method !== "POST") { res.status(405).send("Use POST"); return; }
        const { slug, productName, email, rotate } = (req.body ?? {}) as {
            slug?: string; productName?: string; email?: string; rotate?: boolean;
        };
        if (!slug || !productName || !email) {
            res.status(400).send("Missing slug, productName, or email");
            return;
        }

        const siteId = sanitizeSiteId(slug);
        const doRotate = rotate !== false; // default true

        // Choose a template
        const htmlToPublish = await getPolicyHTML(productName, email, siteId, doRotate);

        // gzip + hash (hash the gzipped bytes)
        const gz = zlib.gzipSync(Buffer.from(htmlToPublish, "utf-8"));
        const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
        const ab = new ArrayBuffer(gz.byteLength);
        new Uint8Array(ab).set(gz);

        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase.hosting"]
        });
        const token = await auth.getAccessToken();

        const parent = `projects/${PROJECT_ID}`;
        const siteName = `sites/${siteId}`;

        // 1) create site (idempotent)
        try {
            await fetchJSON(`${HOSTING_API}/${parent}/sites?siteId=${encodeURIComponent(siteId)}`, {
                method: "POST", headers: authHeaders(token as string), body: JSON.stringify({})
            });
        } catch (e: any) {
            const msg = String(e.message || "");
            if (!msg.includes("ALREADY_EXISTS")) {
                if (msg.includes("SITE_ID_ALREADY_EXISTS")) { res.status(409).send("Site ID is already in use globally."); return; }
                throw e;
            }
        }

        // 2) create version (with redirect "/" -> "/PrivacyPolicies")
        const vResp = await fetchJSON(`${HOSTING_API}/${siteName}/versions`, {
            method: "POST",
            headers: authHeaders(token as string),
            body: JSON.stringify({
                config: {
                    headers: [{ glob: "**", headers: { "Cache-Control": "public, max-age=300" } }],
                    redirects: [{ glob: "/", statusCode: 301, location: POLICY_DIR }]
                }
            })
        });
        const versionName: string = vResp.name;

        // 3) populate files at /PrivacyPolicies/index.html
        const pop = await fetchJSON(`${HOSTING_API}/${versionName}:populateFiles`, {
            method: "POST", headers: authHeaders(token as string),
            body: JSON.stringify({ files: { [POLICY_PATH]: sha256 } })
        });
        const uploadUrl: string = pop.uploadUrl;
        const needsUpload: string[] = pop.uploadRequiredHashes || [];

        // 4) upload gz content if required
        if (needsUpload.includes(sha256)) {
            const up = await fetch(`${uploadUrl}/${sha256}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
                body: ab
            });
            if (!up.ok) throw new Error(`Upload failed ${up.status}: ${await up.text()}`);
        }

        // 5) finalize version
        const versionId = versionName.split("/")[3];
        await fetchJSON(`${HOSTING_API}/sites/${siteId}/versions/${versionId}?update_mask=status`, {
            method: "PATCH", headers: authHeaders(token as string), body: JSON.stringify({ status: "FINALIZED" })
        });

        // 6) release
        await fetchJSON(`${HOSTING_API}/sites/${siteId}/releases?versionName=${encodeURIComponent(versionName)}`, {
            method: "POST", headers: authHeaders(token as string)
        });

        res.status(200).json({
            siteId,
            webAppUrl: `https://${siteId}.web.app/`,
            firebaseAppUrl: `https://${siteId}.firebaseapp.com/`,
            policyUrl: `https://${siteId}.web.app${POLICY_DIR}`
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).send(err.message || "Internal error");
    }
});
