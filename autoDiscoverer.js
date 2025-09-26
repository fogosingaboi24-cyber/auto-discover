/* AutoDiscoverer Universal - versão formatada
   - Observa mudanças no HTML
   - Detecta perguntas + alternativas
   - Envia para Pollinations API
   - Retorna apenas a letra (A–E)
   - Dispara eventos e pop-ups
*/

(() => {
  // ===== CONFIG =====
  let API_ENDPOINT = "https://text.pollinations.ai/openai?model=sur-mistral";
  let API_KEY = "dummy";
  const SYSTEM_PROMPT = "Você é uma IA que deve responder apenas com a letra da alternativa correta: A, B, C, D ou E. Responda apenas com a letra, nada mais.";
  const DEBOUNCE_MS = 1200;
  const MAX_CHARS = 8000;
  const TIMEOUT_MS = 30000;

  const log = (...a) => console.log("%c[AutoDiscoverer]", "color:teal;font-weight:700", ...a);

  // ===== Helpers =====
  const hash = s => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return h >>> 0;
  };

  function showPopup(text, ms = 4000) {
    const id = "auto-discoverer-univ-popup";
    const old = document.getElementById(id);
    if (old) old.remove();
    const p = document.createElement("div");
    p.id = id;
    p.innerText = text;
    Object.assign(p.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      padding: "12px 16px",
      background: "rgba(0,0,0,0.85)",
      color: "#fff",
      fontSize: "15px",
      borderRadius: "10px",
      zIndex: 2147483647,
      pointerEvents: "none",
      boxShadow: "0 6px 22px rgba(0,0,0,0.45)"
    });
    document.body.appendChild(p);
    setTimeout(() => p.remove(), ms);
  }

  function captureVisibleText() {
    let t = document.body?.innerText || "";
    document.querySelectorAll("img[alt], img[aria-label]").forEach(img => {
      const a = (img.getAttribute("alt") || img.getAttribute("aria-label") || "").trim();
      if (a) t += "\n" + a;
    });
    t = t.replace(/\s{2,}/g, " ").trim();
    if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS) + "\n...[texto cortado]";
    return t;
  }

  function findQuestionBlocks() {
    const candidates = [];
    const all = Array.from(document.querySelectorAll("body *")).filter(el => {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity||1) < 0.02) return false;
      } catch(e){}
      return el.innerText && el.innerText.trim().length > 20 && el.innerText.trim().length < 15000;
    });

    const altRegex = /(^|\n)[A-E][\)\.\-]\s*/i;
    const questionMarker = /\b(pergunta|questão|questao|question|q:|\?)\b/i;

    for (const el of all) {
      const text = el.innerText.trim();
      if (!text) continue;
      const hasAlts = altRegex.test(text);
      const hasQuestion = questionMarker.test(text);
      if ((hasAlts && text.match(/[A-E][\)\.\-]/g)?.length >= 2) || (hasAlts && hasQuestion) || (hasQuestion && (text.match(/[0-9]+\)/) || text.length < 800)) {
        candidates.push({ el, text, score: (hasAlts ? 2 : 0) + (hasQuestion ? 1 : 0) + Math.max(0, 1000 - text.length)/100 });
      }
    }

    const uniq = [];
    const seen = new Set();
    for (const c of candidates.sort((a,b)=>b.score-b.score)) {
      const key = c.text.slice(0,200);
      if (!seen.has(key)) { seen.add(key); uniq.push(c); }
      if (uniq.length >= 6) break;
    }
    return uniq.map(u => u.el);
  }

  function blockToText(el) {
    const text = el.innerText.trim().replace(/\s{2,}/g," ");
    return text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS) + "\n...[texto cortado]";
  }

  function extractLetterFromText(respText) {
    if (!respText) return null;
    const s = String(respText);
    const lines = s.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    for (const l of lines) {
      if (/^[A-E]$/i.test(l)) return l.toUpperCase();
      if (/^[A-E][\)\.\-]$/i.test(l)) return l[0].toUpperCase();
      const m = l.match(/^([A-E])[\)\.\-]\s*/i); if (m) return m[1].toUpperCase();
    }
    let m = s.match(/\b([A-E])\b(?=[\)\.\s:-]|$)/i);
    if (m) return m[1].toUpperCase();
    m = s.match(/[A-E][\)\.\-]/i); if (m) return m[0][0].toUpperCase();
    m = s.match(/alternativa[:\s]*([A-E])/i); if (m) return m[1].toUpperCase();
    return null;
  }

  async function callModelAPI(textToSend) {
    const payload = { messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:textToSend}] };
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_ENDPOINT, { method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${API_KEY}`}, body:JSON.stringify(payload), signal:controller.signal, credentials:"omit" });
      clearTimeout(t);
      if (!res.ok) { const txt = await res.text().catch(()=> ""); throw new Error(`HTTP ${res.status} ${res.statusText} ${txt?("- "+txt.slice(0,200)):""}`); }
      const data = await res.json().catch(()=>null);
      let raw = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.output_text || data?.text || (typeof data==="string"?data:null);
      if (!raw) raw = JSON.stringify(data).slice(0,2000);
      return { ok:true, raw, data };
    } catch(err) { clearTimeout(t); return { ok:false, error:err.message||String(err) }; }
  }

  let lastHashes = new Set();
  let processing = false;
  let debounceTimer = null;
  const observer = new MutationObserver(()=>{ debounceTimer && clearTimeout(debounceTimer); debounceTimer = setTimeout(processNow, DEBOUNCE_MS); });

  async function processNow() {
    if (processing) { log("Ainda processando anterior — pulando."); return; }
    processing = true;
    try {
      const blocks = findQuestionBlocks();
      const toProcess = blocks.length ? blocks.slice(0,4).map(el=>({source:el,text:blockToText(el)})) : [{source:document.body,text:captureVisibleText()}];
      for (const item of toProcess) {
        const h = hash(item.text);
        if (lastHashes.has(h)) { log("Texto já processado (hash):",h); continue; }
        lastHashes.add(h);
        showPopup("Enviando pergunta para IA...",2000);
        log("Enviando para API — tamanho:",item.text.length);
        const { ok, raw, error } = await callModelAPI(item.text);
        if (!ok) { console.error("Erro API:",error); showPopup("Erro API (ver console)",3500); window.dispatchEvent(new CustomEvent("autoDiscoverer:error",{detail:{error}})); continue; }
        const letra = extractLetterFromText(String(raw));
        if (letra) {
          log("Letra detectada:",letra);
          showPopup("Resposta: "+letra,3500);
          window.dispatchEvent(new CustomEvent("autoDiscoverer:result",{detail:{letter:letra,raw,selector:item.source?.id||item.source?.tagName?.toLowerCase()||null}}));
        } else {
          log("Não foi possível extrair A-E. Raw:",raw);
          showPopup("Sem letra válida (ver console)",3500);
          window.dispatchEvent(new CustomEvent("autoDiscoverer:raw",{detail:{raw}}));
        }
        await new Promise(r=>setTimeout(r,800));
      }
    } finally { processing = false; }
  }

  observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  debounceTimer = setTimeout(processNow,400);

  window.stopAutoDiscoverer = ()=>{ observer.disconnect(); debounceTimer&&clearTimeout(debounceTimer); showPopup("AutoDiscoverer parado",2000); log("Observador parado."); };
  window.setAutoDiscovererKey = k=>{ API_KEY=k; log("API key atualizada (não persistida)."); };
  window.setAutoDiscovererEndpoint = u=>{ API_ENDPOINT=u; log("API endpoint atualizada (não persistida)."); };

  log("AutoDiscoverer universal iniciado — observando mudanças e detectando questões automaticamente.");
  showPopup("AutoDiscoverer ativo (universal) 🔎",2000);

})();
