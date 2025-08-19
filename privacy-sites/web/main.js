(function () {
    const ready = (fn) => (document.readyState !== "loading" ? fn() : document.addEventListener("DOMContentLoaded", fn));

    ready(() => {
        const $ = (id) => document.getElementById(id);
        const slugEl = $("slug"), nameEl = $("name"), emailEl = $("email"), rotateEl = $("rotate");
        const out = $("out"), preview = $("urlPreview"), createBtn = $("createBtn"), resetBtn = $("resetBtn");
        const statusBar = $("status"), st1 = $("st1"), st2 = $("st2"), st3 = $("st3");

        const missing = [["#slug", slugEl], ["#name", nameEl], ["#email", emailEl], ["#rotate", rotateEl], ["#out", out], ["#urlPreview", preview], ["#createBtn", createBtn], ["#resetBtn", resetBtn], ["#status", statusBar], ["#st1", st1], ["#st2", st2], ["#st3", st3]]
            .filter(([_, el]) => !el);
        if (missing.length) { console.error("Missing elements:", missing.map(([id]) => id).join(", ")); return; }

        const sanitizeSlug = (v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
        const validateEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

        const setSteps = (n) => {
            [st1, st2, st3].forEach((el, i) => el.classList.toggle("active", i < n));
        };
        const setStatusVisible = (show) => statusBar.classList.toggle("show", show);
        const showOut = (html) => { out.innerHTML = html; out.hidden = false; };
        const hideOut = () => { out.hidden = true; out.innerHTML = ""; };

        function updatePreview() {
            const slug = sanitizeSlug(slugEl.value.trim() || "your-slug");
            preview.textContent = `https://${slug}.web.app/PrivacyPolicies`;
        }
        updatePreview();
        slugEl.addEventListener("input", updatePreview);

        async function callAPI({ slug, productName, email, rotate }) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 60000);
            try {
                const r = await fetch("/createPolicySite", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ slug, productName, email, rotate }),
                    signal: ctrl.signal
                });
                if (!r.ok) throw new Error(await r.text());
                return await r.json();
            } finally {
                clearTimeout(timer);
            }
        }

        createBtn.addEventListener("click", async () => {
            const slug = sanitizeSlug(slugEl.value.trim());
            const productName = nameEl.value.trim();
            const contact = emailEl.value.trim();
            const rotate = !!rotateEl.checked;

            hideOut();
            if (!slug || !productName || !contact) { showOut(`<span class="err">Please fill slug, product name, and email.</span>`); return; }
            if (!validateEmail(contact)) { showOut(`<span class="warn">That email doesn't look valid.</span>`); return; }

            createBtn.disabled = true;
            setSteps(1); setStatusVisible(true);

            try {
                const res = await callAPI({ slug, productName, email: contact, rotate });
                setSteps(2);
                await new Promise(r => setTimeout(r, 300)); // tiny pause for UX
                setSteps(3);

                const link = res.policyUrl || `${res.webAppUrl.replace(/\/$/, "")}/PrivacyPolicies`;
                showOut(
                    `<div class="ok"><strong>Done!</strong></div>
           <div>Policy URL → <a class="url" href="${link}" target="_blank">${link}</a></div>
           <div>Root domains → <a class="url" href="${res.webAppUrl}" target="_blank">${res.webAppUrl}</a>
           &middot; <a class="url" href="${res.firebaseAppUrl}" target="_blank">${res.firebaseAppUrl}</a></div>`
                );
            } catch (err) {
                const msg = (err && err.message) ? err.message : String(err);
                showOut(`<div class="err"><strong>Error:</strong> ${msg}</div><div class="hint">Check Cloud Functions logs if this persists.</div>`);
            } finally {
                createBtn.disabled = false;
                setStatusVisible(false);
            }
        });

        resetBtn.addEventListener("click", () => {
            slugEl.value = ""; nameEl.value = ""; emailEl.value = "";
            hideOut(); updatePreview(); setStatusVisible(false); setSteps(1);
        });
    });
})();
