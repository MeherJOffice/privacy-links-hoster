import crypto from "node:crypto";
import zlib from "node:zlib";
import { GoogleAuth } from "google-auth-library";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { initializeApp, getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

setGlobalOptions({ region: "us-central1", memory: "512MiB", cpu: 1 });
if (!getApps().length) initializeApp();

/* ----------------- constants ----------------- */
const HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PROJECT_ID =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    (process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG).projectId : "");

const POLICY_DIR = "/PrivacyPolicies";
const POLICY_PATH = `${POLICY_DIR}/index.html`;
const TEMPLATES_PREFIX = "policy-templates/";

/* ----------------- helpers ----------------- */
function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
async function fetchJSON(url: string, init?: RequestInit) {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
}
function sanitizeSiteId(id: string) {
    return id
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
}
function seededIndex(key: string, n: number) {
    if (n <= 0) return 0;
    const h = crypto.createHash("sha256").update(key).digest();
    const num = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) | 0;
    return Math.abs(num) % n;
}
function fillPlaceholders(html: string, appName: string, email: string) {
    const nameP = [
        /\{\s*product\s*name\s*\}/gi,
        /\{\s*app\s*name\s*\}/gi,
        /\{\{\s*product\s*name\s*\}\}/gi,
        /\{\{\s*app\s*name\s*\}\}/gi,
        /%APP_NAME%/g,
        /%PRODUCT_NAME%/g,
        /\{\{\s*APP_NAME\s*\}\}/g,
        /\{\{\s*PRODUCT_NAME\s*\}\}/g,
    ];
    const emailP = [/\{\s*email\s*\}/gi, /\{\{\s*email\s*\}\}/gi, /%EMAIL%/g, /\{\{\s*CONTACT_EMAIL\s*\}\}/g];
    for (const p of nameP) html = html.replace(p, appName);
    for (const p of emailP) html = html.replace(p, email);
    return html;
}
function fallbackPolicyHTML(appName: string, email: string) {
    const today = new Date().toISOString().slice(0, 10);
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — ${appName}</title><style>body{font-family:system-ui;margin:40px;max-width:860px}</style><body><h1>Privacy Policy</h1><p><strong>App:</strong> ${appName} · <strong>Last Updated:</strong> ${today}</p><p>We collect minimal information necessary to operate and improve ${appName}. For questions contact <a href="mailto:${email}">${email}</a>.</p></body></html>`;
}
function randBase36(len = 5) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}
function suggestAltSlug(siteId: string) {
    return sanitizeSiteId(`${siteId}-${randBase36(5)}`);
}

/* ---------- templates from Storage ---------- */
async function getPolicyHTML(appName: string, email: string, siteId: string, rotate: boolean) {
    const bucket = getStorage().bucket(); // default: <project-id>.appspot.com
    const [files] = await bucket.getFiles({ prefix: TEMPLATES_PREFIX });
    const htmlFiles = files.filter((f) => f.name.endsWith(".html") && f.name !== TEMPLATES_PREFIX);
    htmlFiles.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

    if (!htmlFiles.length) return fallbackPolicyHTML(appName, email);

    const n = htmlFiles.length;
    const idx = rotate ? crypto.randomInt(0, n) : seededIndex(siteId, n);
    const file = htmlFiles[idx];
    const [buf] = await file.download();
    return fillPlaceholders(buf.toString("utf-8"), appName, email);
}

/* ---------- CREATE (idempotent) ---------- */
export const createPolicySite = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
    try {
        if (req.method !== "POST") {
            res.status(405).send("Use POST");
            return;
        }
        const { slug, productName, email, rotate } = (req.body ?? {}) as {
            slug?: string;
            productName?: string;
            email?: string;
            rotate?: boolean;
        };
        if (!slug || !productName || !email) {
            res.status(400).send("Missing slug, productName, or email");
            return;
        }

        const siteId = sanitizeSiteId(slug);
        const doRotate = rotate !== false; // default true

        const htmlToPublish = await getPolicyHTML(productName, email, siteId, doRotate);

        // gzip + hash (hash gzipped bytes)
        const gz = zlib.gzipSync(Buffer.from(htmlToPublish, "utf-8"));
        const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
        const abuf = new ArrayBuffer(gz.byteLength);
        new Uint8Array(abuf).set(gz);
        const blob = new Blob([abuf], { type: "application/octet-stream" });

        const auth = new GoogleAuth({
            scopes: [
                "https://www.googleapis.com/auth/cloud-platform",
                "https://www.googleapis.com/auth/firebase.hosting",
            ],
        });
        const token = await auth.getAccessToken();

        const parent = `projects/${PROJECT_ID}`;
        const siteName = `sites/${siteId}`;

        // 1) Create site (idempotent) — if it already exists in THIS project, proceed to redeploy
        {
            const resp = await fetch(`${HOSTING_API}/${parent}/sites?siteId=${encodeURIComponent(siteId)}`, {
                method: "POST",
                headers: authHeaders(token as string),
                body: JSON.stringify({}),
            });

            if (!resp.ok) {
                const body = await resp.text();
                const lower = body.toLowerCase();

                // same-project exists → OK, continue
                const sameProject = resp.status === 409 && (lower.includes("already exists") || lower.includes("already in use"));
                if (!sameProject) {
                    if (lower.includes("reserved by another project") || lower.includes("failed_precondition") || lower.includes("invalid name")) {
                        res.status(409).json({ code: "slug_taken", message: "Slug is reserved by another project." });
                        return;
                    }
                    if (resp.status === 429 || lower.includes("quota") || lower.includes("limit")) {
                        res.status(429).json({ code: "quota_sites", message: "Hosting site limit reached for this project." });
                        return;
                    }
                    if (resp.status === 403 || lower.includes("permission") || lower.includes("forbidden")) {
                        res.status(403).json({ code: "permission_denied", message: "Missing permission to create Hosting sites." });
                        return;
                    }
                    res.status(500).json({ code: "unknown", message: "Could not create the site." });
                    return;
                }
            }
        }

        // 2) Create version (redirect "/" -> "/PrivacyPolicies")
        const vResp = await fetchJSON(`${HOSTING_API}/${siteName}/versions`, {
            method: "POST",
            headers: authHeaders(token as string),
            body: JSON.stringify({
                config: {
                    headers: [{ glob: "**", headers: { "Cache-Control": "public, max-age=300" } }],
                    redirects: [{ glob: "/", statusCode: 301, location: POLICY_DIR }],
                },
            }),
        });
        const versionName: string = vResp.name;

        // 3) populate files
        const pop = await fetchJSON(`${HOSTING_API}/${versionName}:populateFiles`, {
            method: "POST",
            headers: authHeaders(token as string),
            body: JSON.stringify({ files: { [POLICY_PATH]: sha256 } }),
        });
        const uploadUrl: string = pop.uploadUrl;
        const needsUpload: string[] = pop.uploadRequiredHashes || [];

        // 4) upload gz if needed
        if (needsUpload.includes(sha256)) {
            const up = await fetch(`${uploadUrl}/${sha256}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
                body: blob,
            });
            if (!up.ok) throw new Error(`Upload failed ${up.status}: ${await up.text()}`);
        }

        // 5) finalize & 6) release
        const versionId = versionName.split("/")[3];
        await fetchJSON(`${HOSTING_API}/sites/${siteId}/versions/${versionId}?update_mask=status`, {
            method: "PATCH",
            headers: authHeaders(token as string),
            body: JSON.stringify({ status: "FINALIZED" }),
        });
        await fetchJSON(`${HOSTING_API}/sites/${siteId}/releases?versionName=${encodeURIComponent(versionName)}`, {
            method: "POST",
            headers: authHeaders(token as string),
        });

        res.status(200).json({
            siteId,
            webAppUrl: `https://${siteId}.web.app/`,
            firebaseAppUrl: `https://${siteId}.firebaseapp.com/`,
            policyUrl: `https://${siteId}.web.app${POLICY_DIR}`,
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ code: "internal", message: err?.message || "Internal error" });
    }
});

/* ---------- CHECK (read-only, project scope, no side-effects) ---------- */
export const checkSlug = onRequest({ invoker: "public", cors: true }, async (req, res): Promise<void> => {
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
    }
    const { slug } = (req.body ?? {}) as { slug?: string };
    if (!slug || !/^[a-z0-9-]{4,30}$/.test(slug)) {
        res.status(200).json({ status: "invalid", taken: true });
        return;
    }

    const siteId = sanitizeSiteId(slug);

    try {
        const auth = new GoogleAuth({
            scopes: [
                "https://www.googleapis.com/auth/cloud-platform",
                "https://www.googleapis.com/auth/firebase.hosting",
            ],
        });
        const token = await auth.getAccessToken();

        const parent = `projects/${PROJECT_ID}`;
        const targetName = `sites/${siteId}`;
        let pageToken: string | undefined;

        while (true) {
            const qs = new URLSearchParams();
            if (pageToken) qs.set("pageToken", pageToken);
            const r = await fetch(`${HOSTING_API}/${parent}/sites?${qs}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) {
                res.status(200).json({ status: "unknown" });
                return;
            }
            const data = (await r.json()) as { sites?: Array<{ name: string }>; nextPageToken?: string };
            if (data.sites?.some((s) => s.name === targetName)) {
                res.status(200).json({ status: "taken_project" });
                return;
            }
            if (!data.nextPageToken) break;
            pageToken = data.nextPageToken;
        }

        res.status(200).json({ status: "maybe_free" });
    } catch {
        res.status(200).json({ status: "unknown" });
    }
});
