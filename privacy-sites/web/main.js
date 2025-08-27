// ---- helpers ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const ENDPOINTS = {
  checkSlug: "/checkSlug",
  create: "/createPolicySite",
  previewAI: "/previewPolicyHtml",
  publishAI: "/publishAiPolicy",
  previewTemplate: "/previewTemplate",
  publishTemplate: "/publishTemplate",
};

function sanitizeSlug(s){ return (s||"").toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,30); }
function slugFromName(name){ return sanitizeSlug((name||"").replace(/&/g," and ").replace(/[’'‘]/g,"").replace(/[^a-z0-9]+/gi,"-")); }

const state = { tone: "professional", slugStatus: "unknown", aiHtml: "", fast: { html: "", templateName: "" }, stylePack: null, aiVariation: "" };

const nameEl = $("#name"), emailEl = $("#email"), slugEl = $("#slug"), genSlug = $("#genSlug");
const slugMsg = $("#slugMsg"), slugError = $("#slugError"), urlPreview = $("#urlPreview");
const tonePills = $$(".pill[data-value]");
const btnPreviewTemplate = $("#btnPreviewTemplate"), btnCreateFast = $("#btnCreateFast");
const aiPrompt = $("#aiPrompt"), btnPreviewAI = $("#btnPreviewAI");
const statusFast = $("#statusFast"), outFast = $("#outFast");
const statusCustom = $("#statusCustom"), outCustom = $("#outCustom");

const aiModal = $("#aiModal"), aiTitle = $("#aiModalTitle"), aiFrame = $("#aiFrame");
const aiHint = $("#aiModalHint"), aiBody = $("#aiModalBody");
const aiRefreshBtn = $("#aiRefreshBtn"), aiPublishBtn = $("#aiPublishBtn"), aiCloseBtn = $("#aiCloseBtn");

function updateUrlPreview(){ if(!urlPreview) return; const s = sanitizeSlug(slugEl?.value); urlPreview.textContent = s ? `https://${s}.web.app/PrivacyPolicies` : "https://…"; }

function suggestSlug(){
  const base = slugFromName(nameEl?.value || "app");
  const lists = {
    professional: [`${base}`,`get-${base}`,`${base}-app`,`${base}-studio`,`${base}-labs`],
    playful: [`hey-${base}`,`super-${base}`,`app-${base}`,`${base}-fun`,`cool-${base}`],
    techy: [`${base}-dev`,`${base}-tech`,`use-${base}`,`run-${base}`,`data-${base}`],
  };
  const arr = lists[state.tone]||[base];
  return arr[Math.floor(Math.random()*arr.length)];
}

async function checkSlug(){
  const slug = sanitizeSlug(slugEl?.value);
  if(!slug || !/^[a-z0-9-]{4,30}$/.test(slug)){
    if(slugError){ slugError.style.display="block"; slugError.textContent="Please use 4–30 chars: a–z, 0–9, or -"; }
    if(slugMsg){ slugMsg.className="field-msg err"; }
    return;
  }
  if(slugError){ slugError.style.display="none"; }
  if(slugMsg){ slugMsg.className="field-msg muted"; slugMsg.textContent="Checking…"; }
  try{
    const r = await fetch(ENDPOINTS.checkSlug,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ slug }) });
    const data = await r.json();
    if(slugMsg){
      if(data.status==="taken_project"){ slugMsg.className="field-msg err"; slugMsg.textContent="That slug is taken. Try Generate."; }
      else if(data.status==="maybe_free"){ slugMsg.className="field-msg ok"; slugMsg.textContent="Looks good — slug is available ✓"; }
      else { slugMsg.className="field-msg muted"; slugMsg.textContent="We’ll verify globally on create."; }
    }
  }catch{
    if(slugMsg){ slugMsg.className="field-msg muted"; slugMsg.textContent="Couldn’t verify — you can still try."; }
  }
}

nameEl?.addEventListener("input", ()=>{ if(!slugEl.value.trim()){ slugEl.value = suggestSlug(); updateUrlPreview(); checkSlug(); } });
emailEl?.addEventListener("input", ()=>{});
slugEl?.addEventListener("input", ()=>{ slugEl.value = sanitizeSlug(slugEl.value); updateUrlPreview(); });
slugEl?.addEventListener("change", checkSlug);
genSlug?.addEventListener("click", ()=>{ slugEl.value = suggestSlug(); updateUrlPreview(); checkSlug(); });

tonePills.forEach(p=>p.addEventListener("click", ()=>{
  tonePills.forEach(x=>x.setAttribute("aria-pressed","false"));
  p.setAttribute("aria-pressed","true");
  state.tone = p.dataset.value;
}));

function openModal(title){
  aiModal?.classList.add("show");
  if(aiTitle) aiTitle.textContent = title || "Preview";
  if(aiPublishBtn) aiPublishBtn.disabled = true;
  if(aiHint){ aiHint.textContent="Generating preview…"; aiHint.style.display="flex"; }
  aiBody?.classList.add("busy");
}
function closeModal(){ aiModal?.classList.remove("show"); if(aiFrame) aiFrame.srcdoc=""; }
aiCloseBtn?.addEventListener("click", closeModal);
aiModal?.addEventListener("click", (e)=>{ if(e.target===aiModal) closeModal(); });

async function previewTemplate(randomize=true){
  const productName = nameEl?.value?.trim();
  const email = emailEl?.value?.trim();
  if(!productName || !email){ openModal("Template Preview"); if(aiHint){ aiHint.textContent="Fill Product & Email first."; } aiBody?.classList.remove("busy"); return; }
  openModal("Template Preview");
  try{
    const r = await fetch(ENDPOINTS.previewTemplate,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ productName, email, slug: sanitizeSlug(slugEl?.value || "preview"), rotate: !!randomize }) });
    const data = await r.json();
    if(!r.ok) throw new Error(data?.message || `Preview failed (${r.status})`);
    state.fast.html = data.html || ""; state.fast.templateName = data.templateName || "";
    if(aiFrame) aiFrame.srcdoc = state.fast.html;
    if(aiHint) aiHint.style.display="none";
    if(aiPublishBtn) aiPublishBtn.disabled = false;
  }catch(e){ if(aiHint){ aiHint.style.display="flex"; aiHint.textContent = `Preview error — ${e.message}`; } }
  finally{ aiBody?.classList.remove("busy"); }
}

btnPreviewTemplate?.addEventListener("click", ()=> previewTemplate(true));
aiRefreshBtn?.addEventListener("click", ()=>{
  if(aiTitle?.textContent?.includes("Template")) return previewTemplate(true);
  return requestPreview(true);
});
aiPublishBtn?.addEventListener("click", async ()=>{
  const slug = sanitizeSlug(slugEl?.value);
  const productName = nameEl?.value?.trim();
  const email = emailEl?.value?.trim();
  if(!slug || !productName || !email) return;

  if(aiTitle?.textContent?.includes("Template")){
    if(!state.fast.html) return;
    aiPublishBtn.disabled = true; aiPublishBtn.classList.add("loading"); aiBody?.classList.add("busy"); if(aiHint){ aiHint.style.display="flex"; aiHint.textContent="Publishing…"; }
    try{
      const r = await fetch(ENDPOINTS.publishTemplate,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ slug, html: state.fast.html }) });
      const data = await r.json();
      if(!r.ok) throw new Error(data?.message || `Publish failed (${r.status})`);
      if(aiHint) aiHint.textContent = "Published! Your page is live.";
      if(outFast){ outFast.hidden=false; outFast.innerHTML = `
        <div class="ok">Published!</div>
        Policy URL → <a href="${data.policyUrl}" target="_blank" rel="noopener">${data.policyUrl}</a><br>
        Root → <a href="${data.webAppUrl}" target="_blank" rel="noopener">${data.webAppUrl}</a> ·
        <a href="${data.firebaseAppUrl}" target="_blank" rel="noopener">${data.firebaseAppUrl}</a>
      `; }
    }catch(e){ if(aiHint) aiHint.textContent = `Publish error — ${e.message}`; }
    finally{ aiPublishBtn.classList.remove("loading"); aiPublishBtn.disabled=false; aiBody?.classList.remove("busy"); }
  }
});

btnCreateFast?.addEventListener("click", async ()=>{
  const slug = sanitizeSlug(slugEl?.value);
  const productName = nameEl?.value?.trim();
  const email = emailEl?.value?.trim();
  if(!productName || !email || !slug) return;

  btnCreateFast.disabled = true;
  if(statusFast){ statusFast.style.display="block"; statusFast.textContent="Creating site with a fresh template…"; }
  try{
    const r = await fetch(ENDPOINTS.create,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ slug, productName, email, rotate:true }) });
    const data = await r.json();
    if(!r.ok) throw new Error(data?.message || `Create failed (${r.status})`);
    if(outFast){ outFast.hidden=false; outFast.innerHTML = `
      <div class="ok">Done!</div>
      Policy URL → <a href="${data.policyUrl}" target="_blank" rel="noopener">${data.policyUrl}</a><br>
      Root → <a href="${data.webAppUrl}" target="_blank" rel="noopener">${data.webAppUrl}</a> ·
      <a href="${data.firebaseAppUrl}" target="_blank" rel="noopener">${data.firebaseAppUrl}</a>
    `; }
  }catch(e){ if(outFast){ outFast.hidden=false; outFast.innerHTML = `<div class="err">Create failed: ${e.message}</div>`; } }
  finally{ btnCreateFast.disabled=false; if(statusFast) statusFast.style.display="none"; }
});

function stylePacks(){ return [
  { name:"Nebula Glow", palette:{bg:"#0b1020",fg:"#e9edf7",accent:"#7aa8ff",accent2:"#6ef3ff"}, fonts:{heading:"Outfit, Inter, system-ui", body:"Inter, system-ui"}, layout:"bold hero, glass cards, neon glows on buttons, pill chips", ornaments:"starfield/gradient background, soft inner shadows", spacing:"cozy"}, 
  { name:"Minimal Cream", palette:{bg:"#f6f5f2",fg:"#121319",accent:"#4b6bfb",accent2:"#ff7a59"}, fonts:{heading:"Plus Jakarta Sans, Inter", body:"Inter, system-ui"}, layout:"left hero, crisp dividers, rounded cards", ornaments:"subtle noise texture", spacing:"airy"}, 
  { name:"Retro Terminal", palette:{bg:"#0b0f0b",fg:"#d6ffe1",accent:"#22e584",accent2:"#7cf4ff"}, fonts:{heading:"IBM Plex Mono, ui-monospace", body:"Inter, system-ui"}, layout:"grid columns, code headings, borders", ornaments:"scanline gradient", spacing:"tight"}, 
  { name:"Gradient Aurora", palette:{bg:"#0a0f2a",fg:"#eaf0ff",accent:"#a67cff",accent2:"#00d4ff"}, fonts:{heading:"Poppins, Inter", body:"Inter, system-ui"}, layout:"center hero with gradient blob; soft cards", ornaments:"aurora + subtle grid", spacing:"balanced"}, 
  { name:"Paper Blue", palette:{bg:"#0f1322",fg:"#e6edff",accent:"#6aa7ff",accent2:"#66e0a3"}, fonts:{heading:"Sora, Inter", body:"Inter, system-ui"}, layout:"paper-card look, drop shadows, tidy bullets", ornaments:"paper grain", spacing:"balanced"} 
];}
function pickPack(){ const packs = stylePacks(); return packs[Math.floor(Math.random()*packs.length)]; }

function openAi(){ openModal("AI Preview"); }
async function requestPreview(forceNew){
  const productName = nameEl?.value?.trim();
  const email = emailEl?.value?.trim();
  if(!productName || !email){ openAi(); if(aiHint){ aiHint.textContent="Fill Product & Email first."; } aiBody?.classList.remove("busy"); return; }
  if(forceNew || !state.aiVariation) state.aiVariation = Math.random().toString(36).slice(2,10);
  state.stylePack = pickPack();

  openAi();
  if(aiRefreshBtn) aiRefreshBtn.classList.add("loading");
  try{
    const payload = { productName, email, aiPrompt: aiPrompt?.value || "", tone: state.tone, variation: state.aiVariation, stylePack: state.stylePack };
    const r = await fetch(ENDPOINTS.previewAI,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const data = await r.json();
    if(!r.ok) throw new Error(data?.message || `Preview failed (${r.status})`);
    state.aiHtml = data.html || "";
    if(aiFrame) aiFrame.srcdoc = state.aiHtml;
    if(aiHint) aiHint.style.display="none";
    if(aiPublishBtn) aiPublishBtn.disabled=false;
  }catch(e){ if(aiHint){ aiHint.style.display="flex"; aiHint.textContent=`Preview error — ${e.message}`; } }
  finally{ aiBody?.classList.remove("busy"); aiRefreshBtn?.classList.remove("loading"); }
}

btnPreviewAI?.addEventListener("click", ()=> requestPreview(true));
aiRefreshBtn?.addEventListener("click", ()=>{ if(!(aiTitle?.textContent||"").includes("Template")) requestPreview(true); });
aiPublishBtn?.addEventListener("click", async ()=>{
  if((aiTitle?.textContent||"").includes("Template")) return;
  const slug = sanitizeSlug(slugEl?.value);
  const productName = nameEl?.value?.trim();
  const email = emailEl?.value?.trim();
  if(!slug || !productName || !email || !state.aiHtml) return;
  aiPublishBtn.disabled = true; aiPublishBtn.classList.add("loading"); aiBody?.classList.add("busy"); if(aiHint){ aiHint.style.display="flex"; aiHint.textContent="Publishing…"; }
  try{
    const r = await fetch(ENDPOINTS.publishAI,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ slug, html: state.aiHtml }) });
    const data = await r.json();
    if(!r.ok) throw new Error(data?.message || `Publish failed (${r.status})`);
    if(outCustom){ outCustom.hidden=false; outCustom.innerHTML = `
      <div class="ok">Published!</div>
      Policy URL → <a href="${data.policyUrl}" target="_blank" rel="noopener">${data.policyUrl}</a><br>
      Root → <a href="${data.webAppUrl}" target="_blank" rel="noopener">${data.webAppUrl}</a> ·
      <a href="${data.firebaseAppUrl}" target="_blank" rel="noopener">${data.firebaseAppUrl}</a>
    `; }
    if(aiHint) aiHint.textContent = "Published! Your AI page is live.";
  }catch(e){ if(aiHint) aiHint.textContent = `Publish error — ${e.message}`; }
  finally{ aiPublishBtn.classList.remove("loading"); aiPublishBtn.disabled=false; aiBody?.classList.remove("busy"); }
});

(function init(){ updateUrlPreview(); if(slugEl?.value) checkSlug(); })();
