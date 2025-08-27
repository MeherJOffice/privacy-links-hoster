/* ============== DOM refs ============== */
const $ = (s) => document.querySelector(s);
const nameEl = $("#name");
const emailEl = $("#email");
const slugEl = $("#slug");
const genBtn = $("#genSlug");
const presetHidden = $("#preset");
const presetPills = document.querySelectorAll(".pill");

const urlPreview = $("#urlPreview");
const slugMsg = $("#slugMsg");
const slugError = $("#slugError");
let slugSug = $("#slugSug");
if (!slugSug) {
    slugSug = document.createElement("div");
    slugSug.id = "slugSug";
    slugSug.style.marginTop = "6px";
    slugMsg.insertAdjacentElement("afterend", slugSug);
}

const createBtn = $("#createBtn");
const randBtn = $("#randBtn");
const resetBtn = $("#resetBtn");
const statusBar = $("#status");
const st1 = $("#st1");
const st2 = $("#st2");
const out = $("#out");

/* ============== session gating (per tab) ============== */
const sessionKey = "plh:lastCreatedSlug"; // cleared automatically when tab closes
let lastCreatedSlug = sessionStorage.getItem(sessionKey) || null;
function setSessionSlug(slug) {
    lastCreatedSlug = slug;
    if (slug) sessionStorage.setItem(sessionKey, slug);
}
function clearSessionSlug() {
    lastCreatedSlug = null;
    sessionStorage.removeItem(sessionKey);
}

/* ============== helpers ============== */
const sanitizeSlug = (s) =>
    (s || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
const baseFromName = (n) => sanitizeSlug(n).replace(/-+/g, "-");
const randToken = (len = 5) => Math.floor(Math.random() * Math.pow(36, len)).toString(36).padStart(len, "0");

function suggestSlug(base, style = "professional") {
    base = base || "app";
    const core = baseFromName(base) || "app";
    const pools = {
        professional: [`get-${core}`, `${core}-hq`, `${core}-studio`, `${core}-works`, `${core}-labs`, `${core}-${randToken(3)}`, `use-${core}`, `try-${core}`],
        playful: [`${core}-buddies`, `super-${core}`, `happy-${core}`, `${core}-zone`, `${core}-spark`, `${core}-${randToken(4)}`, `go-${core}`],
        techy: [`${core}-dev`, `data-${core}`, `${core}-io`, `${core}-stack`, `safe-${core}`, `${core}-${randToken(5)}`, `user-${core}`],
    };
    const list = pools[style] || pools.professional;
    return sanitizeSlug(list[Math.floor(Math.random() * list.length)]);
}

function setMsgOk(msg) { slugError.style.display = "none"; slugMsg.className = "field-msg field-ok"; slugMsg.textContent = msg; slugSug.innerHTML = ""; }
function setMsgHint(msg) { slugError.style.display = "none"; slugMsg.className = "field-msg field-hint"; slugMsg.textContent = msg; slugSug.innerHTML = ""; }
function showError(msg) { slugMsg.className = "field-msg field-hint"; slugMsg.textContent = ""; slugError.style.display = "block"; slugError.textContent = msg; }
function renderSuggestions(list = []) {
    slugSug.innerHTML = "";
    list.slice(0, 3).forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = s;
        b.className = "chip";
        b.style.cssText = "margin-right:8px;padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:#0b1324;color:#cde;cursor:pointer";
        b.addEventListener("click", () => { slugEl.value = s; userEditedSlug = true; queueAvailabilityCheck(); });
        slugSug.appendChild(b);
    });
}
function setUrlPreview(slug) { const safe = sanitizeSlug(slug); urlPreview.textContent = safe ? `https://${safe}.web.app/PrivacyPolicies` : "https://…"; }
function setCreateEnabled(can) { createBtn.disabled = !can; }
function setRandomizeEnabled(can) { randBtn.disabled = !can; }

/* ============== availability check (project-scope) ============== */
let userEditedSlug = false;
let pendingTimer = null;

function queueAvailabilityCheck() {
    const s = sanitizeSlug(slugEl.value);
    setUrlPreview(s);
    if (!s) {
        setMsgHint("Enter a slug to check availability.");
        setCreateEnabled(false);
        setRandomizeEnabled(false);
        return;
    }
    setMsgHint("Checking availability…");
    setCreateEnabled(false);
    setRandomizeEnabled(false);

    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(async () => {
        try {
            const r = await fetch("/checkSlug", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ slug: s }),
            });
            const data = await r.json();

            if (data.status === "taken_project") {
                // If created in THIS session → allow Randomize; otherwise block create.
                if (lastCreatedSlug === s) {
                    setMsgOk("Existing site (this session) — you can Randomize the template.");
                    renderSuggestions([]);
                    setCreateEnabled(false);
                    setRandomizeEnabled(true);
                } else {
                    showError("That slug is already used in this project. Tap “Generate” or edit the slug.");
                    renderSuggestions([`${s}-${randToken(4)}`, `get-${s}`, `${s}-hq`]);
                    setCreateEnabled(false);
                    setRandomizeEnabled(false);
                }
            } else if (data.status === "maybe_free") {
                setMsgHint("No conflict in this project — we’ll verify globally on create.");
                setCreateEnabled(true);
                setRandomizeEnabled(false);
            } else if (data.status === "invalid") {
                showError("Slug format is invalid. Use 4–30 chars: a–z, 0–9, hyphen.");
                setCreateEnabled(false);
                setRandomizeEnabled(false);
            } else {
                setMsgHint("Couldn’t verify now — you can still try to create.");
                setCreateEnabled(true);
                setRandomizeEnabled(false);
            }
        } catch {
            setMsgHint("Couldn’t verify now — you can still try to create.");
            setCreateEnabled(true);
            setRandomizeEnabled(false);
        }
    }, 300);
}

/* ============== events ============== */
nameEl.addEventListener("input", () => {
    if (!userEditedSlug && !slugEl.value.trim()) {
        slugEl.value = suggestSlug(nameEl.value, presetHidden.value || "professional");
    }
    queueAvailabilityCheck();
});
slugEl.addEventListener("input", () => {
    userEditedSlug = true;
    slugEl.value = sanitizeSlug(slugEl.value);
    if (lastCreatedSlug && slugEl.value !== lastCreatedSlug) setRandomizeEnabled(false);
    queueAvailabilityCheck();
});
genBtn.addEventListener("click", () => {
    slugEl.value = suggestSlug(nameEl.value || "app", presetHidden.value || "professional");
    userEditedSlug = false;
    if (lastCreatedSlug && slugEl.value !== lastCreatedSlug) setRandomizeEnabled(false);
    queueAvailabilityCheck();
});
presetPills.forEach((btn) => {
    btn.addEventListener("click", () => {
        presetPills.forEach((b) => b.setAttribute("aria-pressed", "false"));
        btn.setAttribute("aria-pressed", "true");
        presetHidden.value = btn.dataset.value || "professional";
        if (!userEditedSlug || !slugEl.value.trim()) {
            slugEl.value = suggestSlug(nameEl.value || "app", presetHidden.value);
        }
        queueAvailabilityCheck();
    });
});
resetBtn.addEventListener("click", () => {
    nameEl.value = "";
    emailEl.value = "";
    slugEl.value = "";
    userEditedSlug = false;
    setUrlPreview("");
    setMsgHint("Policy URL → https://your-slug.web.app/PrivacyPolicies");
    slugError.style.display = "none";
    slugSug.innerHTML = "";
    setCreateEnabled(false);
    setRandomizeEnabled(false);
    out.hidden = true;
    out.innerHTML = "";
    statusBar.classList.remove("show");
    // session slug is kept until tab closes; typing it again will enable Randomize
});

/* ============== publish helpers ============== */
async function doPublish(slug, productName, email) {
    const r = await fetch("/createPolicySite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, productName, email, rotate: true }),
    });
    const ct = r.headers.get("content-type") || "";
    let payload = undefined;
    if (ct.includes("application/json")) { try { payload = await r.json(); } catch { } }
    return { ok: r.ok, status: r.status, data: payload };
}

/* ============== create ============== */
async function createPolicy() {
    const productName = nameEl.value.trim();
    const email = emailEl.value.trim();
    const slug = sanitizeSlug(slugEl.value);
    if (!productName || !email || !slug) { showError("Please fill product name, email, and a valid slug."); return; }

    setCreateEnabled(false);
    setRandomizeEnabled(false);
    statusBar.classList.add("show");
    st1.classList.add("active");
    st2.classList.remove("active");
    out.hidden = true;
    out.innerHTML = "";

    try {
        const { ok, status, data } = await doPublish(slug, productName, email);

        if (!ok) {
            const code = data?.code || "";
            if (status === 409 || code === "slug_taken") {
                showError("That slug is taken by another project. Try a different slug.");
                renderSuggestions([`${slug}-${randToken(5)}`, `get-${slug}`, `${slug}-labs`]);
            } else if (status === 429 || code === "quota_sites") {
                showError("Your Firebase project hit the limit for Hosting sites. Delete unused sites or use another project.");
            } else if (status === 403 || code === "permission_denied") {
                showError("This Firebase project’s service account lacks permission to create Hosting sites.");
            } else {
                showError("Couldn’t create the site. Please try again.");
            }
            return;
        }

        // success
        setSessionSlug(slug);
        setRandomizeEnabled(true); // enable Randomize for this session/slug
        st2.classList.add("active");
        out.hidden = false;
        out.innerHTML = `
      <div class="ok"><strong>Done!</strong></div>
      <div>Policy URL → <a href="${data.policyUrl}" target="_blank" rel="noopener">${data.policyUrl}</a></div>
      <div style="margin-top:6px">Root domains → 
        <a href="${data.webAppUrl}" target="_blank" rel="noopener">${data.webAppUrl}</a> · 
        <a href="${data.firebaseAppUrl}" target="_blank" rel="noopener">${data.firebaseAppUrl}</a>
      </div>
    `;
    } catch {
        showError("Network error — please try again.");
    } finally {
        statusBar.classList.remove("show");
    }
}
createBtn.addEventListener("click", createPolicy);

/* ============== randomize (session-limited) ============== */
randBtn.addEventListener("click", async () => {
    const slug = sanitizeSlug(slugEl.value);
    if (!slug || slug !== lastCreatedSlug) return; // safety
    const productName = nameEl.value.trim() || "App";
    const email = emailEl.value.trim() || "support@example.com";

    setRandomizeEnabled(false);
    statusBar.classList.add("show");
    st1.classList.add("active");
    st2.classList.remove("active");

    try {
        const { ok, data } = await doPublish(slug, productName, email);
        if (ok) {
            st2.classList.add("active");
            out.hidden = false;
            out.innerHTML = `
        <div class="ok"><strong>Re-published!</strong> A new template was applied.</div>
        <div>Policy URL → <a href="${data.policyUrl}" target="_blank" rel="noopener">${data.policyUrl}</a></div>
      `;
        } else {
            showError("Couldn’t randomize right now. Please try again.");
        }
    } catch {
        showError("Network error — please try again.");
    } finally {
        // keep randomize enabled for the same session slug
        setRandomizeEnabled(true);
        statusBar.classList.remove("show");
    }
});

/* ============== init ============== */
setUrlPreview("");
setCreateEnabled(false);
setRandomizeEnabled(false);
setMsgHint("Policy URL → https://your-slug.web.app/PrivacyPolicies");
