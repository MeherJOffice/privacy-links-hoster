
// Helpers
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const byId = id => document.getElementById(id);
const API = {
  checkSlug: '/checkSlug',
  create: '/createPolicySite',
  previewTemplate: '/previewTemplate',
  publishTemplate: '/publishTemplate',
  previewAi: '/previewPolicyHtml',
  publishAi: '/publishAiPolicy',
};

function sanitizeSlug(s=''){ return s.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/--+/g,'-').replace(/^-+|-+$/g,'').slice(0,30); }
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
async function readHtml(resp){
  const ct = resp.headers.get('content-type') || '';
  const txt = await resp.text();
  if (ct.includes('application/json') || txt.trim().startsWith('{')) {
    try { const j = JSON.parse(txt); if (j && j.html) return j.html; } catch {}
  }
  return txt;
}
function showLoading(frame){
  frame.srcdoc = "<!doctype html><meta charset='utf-8'><style>html,body{height:100%}body{margin:0;display:flex;align-items:center;justify-content:center;font-family:system-ui;color:#334;padding:20px}</style><div>Generating preview…</div>";
}

// --------- Step 1: App Gate ----------
const gName = byId('gName'), gEmail = byId('gEmail'), gSlug = byId('gSlug');
const gGen = byId('gGen'), gUrlPreview = byId('gUrlPreview'), gSlugMsg = byId('gSlugMsg');
const toMode = byId('toMode');
function updateGatePreview(){
  const s = sanitizeSlug(gSlug.value || gName.value || 'your-slug');
  gUrlPreview.textContent = `https://${s}.web.app/PrivacyPolicies`;
}
[gName,gSlug].forEach(el=> el.addEventListener('input', updateGatePreview));
gGen.addEventListener('click', ()=>{
  const base=(gName.value||'app').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');
  gSlug.value = sanitizeSlug(`${base}-` + Math.random().toString(36).slice(2,6));
  updateGatePreview(); checkGateSlug();
});
const checkGateSlug = debounce(async ()=>{
  const s = sanitizeSlug(gSlug.value); if(!s) return;
  gSlugMsg.textContent = 'Checking availability…';
  try{
    const r = await fetch(API.checkSlug, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:s})});
    const j = await r.json();
    gSlugMsg.textContent = j.available ? 'Looks good — slug is available ✓' : 'May be taken globally — verify on publish.';
  }catch{ gSlugMsg.textContent = 'Couldn’t verify right now — you can still try to create.'; }
}, 300);
gSlug.addEventListener('input', checkGateSlug);

// Gate → Mode
const appGate = byId('appGate'), modeGate = byId('modeGate'), fastPanel = byId('fastPanel'), aiPanel = byId('aiPanel');
toMode.addEventListener('click', ()=>{
  const app = gName.value.trim(); const email = gEmail.value.trim(); const slug = sanitizeSlug(gSlug.value.trim());
  if(!app||!email||!slug){ alert('Fill product name, email and slug first.'); return; }
  // seed both flows
  byId('name').value = app; byId('email').value = email; byId('slug').value = slug;
  byId('aiName').value = app; byId('aiEmail').value = email; byId('aiSlug').value = slug;
  // move to mode selection
  appGate.classList.add('hidden'); modeGate.classList.remove('hidden');
  updateUrlPreview();
});

// Mode selection
byId('chooseFast').addEventListener('click', ()=>{ modeGate.classList.add('hidden'); fastPanel.classList.remove('hidden'); });
byId('chooseAi').addEventListener('click', ()=>{ modeGate.classList.add('hidden'); aiPanel.classList.remove('hidden'); renderSteps(); updateNav(); });

// --------- FAST HOSTING ---------
const nameI = byId('name'), emailI = byId('email'), slugI = byId('slug');
const genSlugBtn = byId('genSlug'), presetBar = byId('presetBar');
const urlPreview = byId('urlPreview'), slugMsg = byId('slugMsg'), slugErr = byId('slugError');
const previewTplBtn = byId('previewTpl'), createBtn = byId('createBtn'), resetBtn = byId('resetBtn');
let preset = 'professional';

function updateUrlPreview(){
  const s = sanitizeSlug(slugI.value || nameI.value || 'your-slug');
  urlPreview.textContent = `https://${s}.web.app/PrivacyPolicies`;
}
[nameI, slugI].forEach(el=> el.addEventListener('input', updateUrlPreview));

genSlugBtn.addEventListener('click', ()=>{
  const base = (nameI.value||'app').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');
  const suffix = Math.random().toString(36).slice(2,6);
  slugI.value = sanitizeSlug(`${base}-${suffix}`); updateUrlPreview(); runSlugCheck();
});

presetBar.addEventListener('click', e=>{
  const b = e.target.closest('.pill'); if(!b) return;
  preset = b.dataset.value; $$('#presetBar .pill').forEach(p=>p.setAttribute('aria-pressed', p===b ? 'true':'false'));
});

const runSlugCheck = debounce(async ()=>{
  const s = sanitizeSlug(slugI.value); if(!s){ slugErr.classList.add('hidden'); slugMsg.textContent=''; return; }
  slugErr.classList.add('hidden'); slugMsg.textContent = 'Checking availability…';
  try {
    const r = await fetch(API.checkSlug, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ slug:s })});
    const j = await r.json();
    if(j.available){ slugMsg.innerHTML = `<span class="ok">Looks good — slug is available ✓</span>`; }
    else{ slugMsg.innerHTML = `<span class="warn">May be taken globally — verify on publish.</span>`; }
  } catch { slugMsg.innerHTML = `<span class="warn">Couldn’t verify right now — you can still try to create.</span>`; }
}, 300);
slugI.addEventListener('input', runSlugCheck);

// Modal / preview state
const modal = byId('previewModal'); const frame = byId('previewFrame');
const closePreviewBtn = byId('closePreview');
const refreshPreviewBtn = byId('refreshPreview');
const usePreviewBtn = byId('usePreview');
let lastPreview = null; // {mode:'template'|'ai', payload:{}}
closePreviewBtn.onclick = ()=> modal.classList.remove('show');

refreshPreviewBtn.onclick = async ()=>{
  if(!lastPreview) return;
  if(lastPreview.mode==='template') await openTemplatePreview(lastPreview.payload, true);
  else await openAiPreview(lastPreview.payload, true);
};

usePreviewBtn.onclick = async ()=>{
  if(!lastPreview) return;
  usePreviewBtn.disabled = true;
  try{
    if(lastPreview.mode === 'template'){
      const p = lastPreview.payload;
      const r = await fetch(API.publishTemplate,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
      if(!r.ok) throw new Error(await r.text());
      const j = await r.json();
      alert(`Published: ${j.policyUrl}`);
    }else{
      const p = lastPreview.payload;
      const r = await fetch(API.publishAi,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
      if(!r.ok) throw new Error(await r.text());
      const j = await r.json();
      alert(`Published: ${j.policyUrl}`);
    }
    modal.classList.remove('show');
  }catch(e){ alert(`Publish failed: ${e}`); } finally{ usePreviewBtn.disabled=false; }
};

async function openTemplatePreview(payload, keepOpen=false){
  lastPreview = {mode:'template', payload};
  if(!keepOpen) modal.classList.add('show');
  showLoading(frame);
  const r = await fetch(API.previewTemplate,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const html = await readHtml(r);
  frame.srcdoc = html;
}

previewTplBtn.addEventListener('click', async ()=>{
  const app = nameI.value.trim(); const email = emailI.value.trim(); const slug = sanitizeSlug(slugI.value.trim());
  if(!app || !email || !slug){ alert('Fill name, email and slug.'); return; }
  await openTemplatePreview({productName:app,email,slug,preset}, false);
});

createBtn.addEventListener('click', async ()=>{
  const app = nameI.value.trim(); const email = emailI.value.trim(); const slug = sanitizeSlug(slugI.value.trim());
  if(!app || !email || !slug){ alert('Fill name, email and slug.'); return; }
  try{
    createBtn.disabled=true;
    const r = await fetch(API.create,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productName:app,email,slug,preset})});
    if(!r.ok) throw new Error(await r.text());
    const j = await r.json();
    byId('out').innerHTML = `<div class="ok">Done!</div> Policy URL → <a href="${j.policyUrl}" target="_blank">${j.policyUrl}</a>`;
  }catch(e){ byId('out').innerHTML = `<div class="err">Create failed: ${e}</div>`; }
  finally{ createBtn.disabled=false; }
});
byId('resetBtn').addEventListener('click', ()=>{ [nameI,emailI,slugI].forEach(i=>i.value=''); updateUrlPreview(); slugMsg.textContent=''; slugErr.classList.add('hidden'); });

// --------- AI FLOW ---------
const steps = [byId('s1'), byId('s2'), byId('s3'), byId('s4')];
let stepIndex = 0;
function renderSteps(){ steps.forEach((el,i)=> el.classList.toggle('hidden', i!==stepIndex)); $$('.step').forEach((s,i)=> s.classList.toggle('active', i===stepIndex)); }
function updateNav(){ byId('aiPrev').disabled = stepIndex===0; byId('aiNext').classList.toggle('hidden', stepIndex===3); byId('aiPreviewBtn').classList.toggle('hidden', stepIndex!==3); }
byId('aiPrev').onclick = ()=>{ if(stepIndex>0){ stepIndex--; renderSteps(); updateNav(); } };
byId('aiNext').onclick = ()=>{ if(stepIndex<steps.length-1){ stepIndex++; if(stepIndex===3){ buildPrompt(); } renderSteps(); updateNav(); } };

// Pillbars
function bindPillbar(id){ const bar = byId(id); if(!bar) return;
  bar.addEventListener('click', ev=>{ const b = ev.target.closest('.pill'); if(!b) return;
    const multi = bar.dataset.multi === 'true';
    if(multi){ b.setAttribute('aria-pressed', b.getAttribute('aria-pressed')==='true' ? 'false':'true'); }
    else { $$('#'+id+' .pill').forEach(p=>p.setAttribute('aria-pressed','false')); b.setAttribute('aria-pressed','true'); }
  });
}
['qCompliance','qDataTypes','qAnalytics','qTone'].forEach(bindPillbar);

// AI slug
const aiName = byId('aiName'), aiEmail = byId('aiEmail'), aiSlug = byId('aiSlug'), aiSlugMsg = byId('aiSlugMsg');
function genAiSlug(){ const base=(aiName.value||'app').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-'); aiSlug.value=sanitizeSlug(`${base}-${Math.random().toString(36).slice(2,5)}`); }
aiName.addEventListener('input', debounce(()=>{ if(!aiSlug.value) genAiSlug(); }, 300));
aiSlug.addEventListener('input', debounce(async ()=>{
  const s = sanitizeSlug(aiSlug.value); aiSlugMsg.textContent = 'Checking availability…';
  try{ const r = await fetch(API.checkSlug,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:s})});
       const j = await r.json(); aiSlugMsg.textContent = j.available ? 'Looks good — slug is available ✓' : 'May be taken globally — verify on publish.'; }
  catch{ aiSlugMsg.textContent = 'Couldn’t verify right now — you can still try to create.'; }
}, 300));

// Prompt from answers
function selectedValues(id){ return $$('#'+id+' .pill[aria-pressed="true"]').map(b=>b.dataset.value); }
function buildPrompt(){
  const app = aiName.value.trim();
  const email = aiEmail.value.trim();
  const comp = selectedValues('qCompliance'); 
  const dt = selectedValues('qDataTypes'); 
  const an = selectedValues('qAnalytics'); 
  const retention = byId('qRetention').value.trim() || 'Not specified';
  const tone = selectedValues('qTone')[0] || 'professional';
  const theme = byId('qTheme').value; 
  const accent = byId('qAccent').value || '#6aa7ff'; 
  const bg = byId('qBg').value;
  const extra = byId('qExtra').value.trim();

  const prompt =
`You are generating a COMPLETE, self-contained privacy policy WEB PAGE as HTML5.
Requirements:
- Use the following values exactly.
  App name: ${app}
  Contact email: ${email}
  Compliance frameworks to mention: ${comp.length?comp.join(', '):'None'}
  Data types collected: ${dt.length?dt.join(', '):'Minimal'}
  Analytics/Monetization: ${an.length?an.join(', '):'None'}
  Retention: ${retention}
  Design tone: ${tone}; Theme: ${theme}; Accent color: ${accent}; Background effect: ${bg}.
  Today's ISO date for "Last updated": (must be the current date when rendering).
- Replace any placeholders like {{APP_NAME}} or {{EMAIL}} with the real values.
- Do NOT include backticks or markdown fences; return RAW HTML only.
- Include light, modern CSS inside a <style> tag. Respect the accent color and the theme.
- Include section headings: Introduction; Information We Collect; How We Use Information; Legal/Compliance; Retention & Deletion; Security; Children’s Privacy ${comp.includes('COPPA') ? '(must include COPPA language)' : ''}; Your Rights; Contact.
- Footer must display © CURRENT YEAR ${app}.
${extra ? ('- Extra instructions from user: ' + extra) : ''}
`;

  byId('aiPrompt').value = prompt;
}

// AI preview
const aiPreviewBtn = byId('aiPreviewBtn');
aiPreviewBtn.addEventListener('click', async ()=>{
  const payload = {
    slug: sanitizeSlug(aiSlug.value||aiName.value||'ai-page'),
    productName: aiName.value.trim(),
    email: aiEmail.value.trim(),
    prompt: byId('aiPrompt').value.trim()
  };
  await openAiPreview(payload, false);
});

async function openAiPreview(payload, keepOpen=false){
  lastPreview = {mode:'ai', payload};
  if(!keepOpen) $('#previewModal').classList.add('show');
  showLoading(byId('previewFrame'));
  const r = await fetch(API.previewAi,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const html = await readHtml(r);
  byId('previewFrame').srcdoc = html;
}

// Init
updateGatePreview();
