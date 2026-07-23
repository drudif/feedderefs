// Servidor do catálogo REFS.
// - Serve o site e o refs-data.js (do volume, se houver: DATA_DIR).
// - POST /api/save   → grava refs-data.js (auth).
// - POST /api/analyze → proxy do Gemini (chave só no servidor; auth).
// - POST /api/auth   → valida a senha de edição.
// Auth: LOCAL (sem PORT) é confiável e livre. No deploy (PORT definido) exige
// header x-edit-token === EDIT_TOKEN. Sem EDIT_TOKEN no deploy = ninguém edita.
// Uso local: duplo-clique em start.command (ou `npm start`).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// carrega .env local (se existir), sem depender de flag do Node (compat. c/ qualquer versão)
try {
  const envPath = path.join(DIR, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch { /* ignore */ }

const PORT = process.env.PORT || 4177;
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
const RAILWAY = !!process.env.PORT;                       // plataforma define PORT
const DATA_DIR = process.env.DATA_DIR || DIR;             // volume persistente no deploy
const EDIT_TOKEN = process.env.EDIT_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEPLOY_URL = (process.env.DEPLOY_URL || "").replace(/\/+$/, ""); // p/ sync local↔deploy
const COBALT_API = (process.env.COBALT_API || "").replace(/\/+$/, ""); // instância self-hosted (rede privada)
const COBALT_KEY = process.env.COBALT_KEY || "";
const GMODEL = "gemini-2.5-flash";
const DATA_FILE = path.join(DATA_DIR, "refs-data.js");

// seed do volume: na primeira vez copia o refs-data.js do repo para o volume
try {
  if (DATA_DIR !== DIR && !fs.existsSync(DATA_FILE) && fs.existsSync(path.join(DIR, "refs-data.js"))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(DIR, "refs-data.js"), DATA_FILE);
    console.log("volume seedado com refs-data.js do repo");
  }
} catch (e) { console.error("seed falhou:", e.message); }

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".md": "text/markdown; charset=utf-8",
};

function authed(req) {
  if (!RAILWAY) return true;              // local = confiável
  if (!EDIT_TOKEN) return false;          // deploy sem senha configurada = ninguém edita
  return req.headers["x-edit-token"] === EDIT_TOKEN;
}
function readBody(req, limit = 25e6) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > limit) req.destroy(); });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

// ---- og-scrape: lê meta tags do post (og:image/título/descrição). Não baixa mídia. ----
function decodeEnt(s) { return (s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function parseMetas(html) {
  const m = {};
  const re = /<meta[^>]+>/gi; let t;
  while ((t = re.exec(html))) {
    const tag = t[0];
    const p = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const c = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (p && c != null && m[p] == null) m[p] = c;
  }
  return m;
}
async function ogScrape(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; ToolsCatalog/1.0; +https://feedderefs.up.railway.app)" }, redirect: "follow" });
  const html = await r.text();
  const m = parseMetas(html);
  return {
    image: decodeEnt(m["og:image"] || m["twitter:image"] || m["twitter:image:src"] || ""),
    title: decodeEnt(m["og:title"] || m["twitter:title"] || ""),
    desc: decodeEnt(m["og:description"] || m["twitter:description"] || ""),
  };
}
// resolve um link social via Cobalt (self-hosted, rede privada). NÃO armazena nada.
async function cobalt(url, options = {}) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (COBALT_KEY) headers.authorization = "Api-Key " + COBALT_KEY;
  const r = await fetch(COBALT_API + "/", { method: "POST", headers, body: JSON.stringify({ url, ...options }) });
  return r.json();
}
async function fetchBuf(url, cap = 20 * 1024 * 1024) {
  const r = await fetch(url); if (!r.ok) throw new Error("fetch " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > cap) throw new Error("mídia grande demais (" + Math.round(buf.length / 1e6) + "MB)");
  return { buf, mime: (r.headers.get("content-type") || "application/octet-stream").split(";")[0] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// sobe um arquivo (vídeo) via Files API do Gemini e espera ficar ACTIVE. Retorna file_uri.
async function geminiUpload(buf, mime, displayName = "media") {
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(`${base}/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(buf.length), "X-Goog-Upload-Header-Content-Type": mime, "content-type": "application/json" },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) { const t = await start.text().catch(() => ""); throw new Error("start " + start.status + " " + t.slice(0, 140)); }
  const up = await fetch(uploadUrl, { method: "POST", headers: { "Content-Length": String(buf.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf });
  const upText = await up.text();
  let info; try { info = JSON.parse(upText); } catch { throw new Error("finalize não-JSON " + up.status + " " + upText.slice(0, 140)); }
  if (!info.file) throw new Error("finalize " + up.status + " " + JSON.stringify(info).slice(0, 140));
  let { name, state, uri } = info.file;
  for (let i = 0; i < 40 && state === "PROCESSING"; i++) {
    await sleep(1500);
    const st = await (await fetch(`${base}/v1beta/${name}?key=${encodeURIComponent(GEMINI_API_KEY)}`)).json();
    state = st.state; uri = st.uri || uri;
  }
  if (state !== "ACTIVE") throw new Error("estado " + (state || "?"));
  return uri;
}
// uma chamada multimodal ao Gemini que devolve {cards:[...]}. Thinking desligado + retry em erro transitório.
async function geminiCards(parts) {
  const body = { contents: [{ parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } };
  const TRANSIENT = new Set([429, 500, 502, 503, 504]);
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(1500 * attempt); // 1.5s, 3s, 4.5s, 6s
    let gr, gj;
    try {
      gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      gj = await gr.json().catch(() => ({}));
    } catch (e) { lastErr = "rede: " + e.message; continue; }
    if (gj.error) {
      const code = Number(gj.error.code || gr.status);
      lastErr = "Gemini " + code + ": " + String(gj.error.message || "").slice(0, 200);
      if (TRANSIENT.has(code)) continue;        // sobrecarga/cota → tenta de novo
      throw new Error(lastErr);                 // erro permanente → aborta
    }
    const cand = (gj.candidates || [])[0];
    const text = (((cand || {}).content || {}).parts || []).map((p) => p.text).filter(Boolean).join("");
    if (text) return text;
    lastErr = "Gemini retornou vazio" + (cand && cand.finishReason ? " (finishReason: " + cand.finishReason + ")" : " (sem candidato)");
  }
  throw new Error(lastErr + " — tente novamente em instantes");
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const fp = p === "/refs-data.js" ? DATA_FILE : path.join(DIR, p); // dados vêm do volume
  if (!fp.startsWith(DIR) && fp !== DATA_FILE) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(d);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true, railway: RAILWAY, hasEditToken: !!EDIT_TOKEN, hasGeminiKey: !!GEMINI_API_KEY, usingVolume: DATA_DIR !== DIR, dataDir: DATA_DIR, hasCobalt: !!COBALT_API });
    }
    if (req.method === "POST" && req.url === "/api/auth") {
      const { token } = JSON.parse((await readBody(req)) || "{}");
      return json(res, 200, { ok: !RAILWAY || (!!EDIT_TOKEN && token === EDIT_TOKEN) });
    }
    if (req.method === "POST" && req.url === "/api/save") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      const data = JSON.parse((await readBody(req)) || "{}");
      if (!data || !Array.isArray(data.refs)) return json(res, 400, { ok: false, error: "payload inválido" });
      const js = "/* Atualizado automaticamente pelo catálogo (server.mjs). */\nwindow.REFS_DATA = " + JSON.stringify(data, null, 2) + ";\n";
      const tmp = path.join(DATA_DIR, ".refs-data.tmp.js");
      fs.writeFileSync(tmp, js); fs.renameSync(tmp, DATA_FILE);
      console.log(new Date().toLocaleTimeString(), "salvo — " + data.refs.length + " refs");
      return json(res, 200, { ok: true, count: data.refs.length });
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      if (!GEMINI_API_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY não configurada no servidor" });
      const body = (await readBody(req)) || "{}";
      const gres = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await gres.text();
      res.writeHead(gres.status, { "content-type": "application/json" });
      return res.end(text);
    }
    // ---- ingerir link social via Cobalt: carrossel (todos os slides) ou vídeo (áudio→transcrição).
    //      NÃO armazena mídia. O Gemini devolve {cards:[...]} já filtrado e sem duplicatas. ----
    if (req.method === "POST" && req.url === "/api/ingest") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      if (!GEMINI_API_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY não configurada" });
      if (!COBALT_API) return json(res, 400, { ok: false, error: "COBALT_API não configurada (Cobalt fora do ar)" });
      const { url, prompt } = JSON.parse((await readBody(req)) || "{}");
      if (!url) return json(res, 400, { ok: false, error: "url ausente" });

      // 1) resolve o link no Cobalt
      let cj; try { cj = await cobalt(url); } catch (e) { return json(res, 502, { ok: false, error: "cobalt inacessível: " + e.message }); }

      // 2) monta as partes multimodais + descreve o modo
      const parts = []; let kind = "image", note = "";
      try {
        if (cj.status === "picker" && Array.isArray(cj.picker)) {
          const photos = cj.picker.filter((p) => p.type === "photo" && p.url).slice(0, 20);
          if (!photos.length) return json(res, 422, { ok: false, error: "carrossel sem imagens legíveis" });
          kind = "carousel";
          for (const p of photos) { const { buf, mime } = await fetchBuf(p.url, 8 * 1024 * 1024); parts.push({ inline_data: { mime_type: mime.startsWith("image/") ? mime : "image/jpeg", data: buf.toString("base64") } }); }
          parts.push({ text: `${prompt}\n\n== ENTRADA: ${photos.length} SLIDES de um carrossel (na ordem). ==` });
        } else if (cj.status === "tunnel" || cj.status === "redirect" || (cj.status === "picker" && cj.picker.some((p) => p.type === "video"))) {
          // vídeo → manda o VÍDEO pro Gemini (lê texto na tela + ouve o áudio). 480p p/ ficar leve. Nada é guardado.
          kind = "video";
          let vurl = "";
          try { const vj = await cobalt(url, { videoQuality: "480" }); vurl = (vj.status === "tunnel" || vj.status === "redirect") ? vj.url : ((vj.picker || []).find((p) => p.type === "video") || {}).url || ""; } catch { /* usa o cj abaixo */ }
          if (!vurl) vurl = (cj.status === "tunnel" || cj.status === "redirect") ? cj.url : ((cj.picker || []).find((p) => p.type === "video") || {}).url || "";
          if (!vurl) return json(res, 502, { ok: false, error: "não consegui obter o vídeo (" + (cj.error?.code || cj.status || "?") + ")" });
          let vid; try { vid = await fetchBuf(vurl, 120 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false, error: "vídeo " + e.message }); }
          const vmime = vid.mime.startsWith("video/") ? vid.mime : "video/mp4";
          if (vid.buf.length <= 12 * 1024 * 1024) {
            // pequeno: manda inline (evita a Files API)
            parts.push({ inline_data: { mime_type: vmime, data: vid.buf.toString("base64") } });
          } else {
            // grande: sobe pela Files API
            let fileUri; try { fileUri = await geminiUpload(vid.buf, vmime, "reel"); } catch (e) { return json(res, 502, { ok: false, error: "upload do vídeo pro Gemini falhou: " + e.message }); }
            parts.push({ file_data: { mime_type: vmime, file_uri: fileUri } });
          }
          const og = await ogScrape(url).catch(() => ({}));
          const cap = [og.title && "Legenda/título: " + og.title, og.desc && "Descrição do post: " + og.desc].filter(Boolean).join("\n");
          parts.push({ text: `${prompt}\n\n== ENTRADA: um VÍDEO curto (Reel/Short). Preste MUITA atenção ao TEXTO QUE APARECE NA TELA (overlays, nomes de sites/ferramentas/URLs exibidos) e TAMBÉM ao que é falado no áudio. Capte TODOS os sites, ferramentas e recursos citados ou mostrados — muitos aparecem só como texto na tela.${cap ? "\n\n" + cap : ""} ==` });
        } else {
          return json(res, 422, { ok: false, error: "cobalt não resolveu o link (" + (cj.error?.code || cj.status || "?") + ")" });
        }
      } catch (e) { return json(res, 502, { ok: false, error: "falha ao baixar mídia do cobalt: " + e.message }); }

      // 3) uma chamada ao Gemini → {cards:[...]}
      let raw; try { raw = await geminiCards(parts); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
      return json(res, 200, { ok: true, kind, raw, source: url });
    }
    // ---- sync local ↔ deploy (só no local) ----
    if (req.method === "POST" && (req.url === "/api/pull" || req.url === "/api/push")) {
      if (RAILWAY) return json(res, 403, { ok: false, error: "sync só funciona no servidor local" });
      if (!DEPLOY_URL) return json(res, 400, { ok: false, error: "DEPLOY_URL não configurada no .env" });
      if (req.url === "/api/pull") {
        const r = await fetch(DEPLOY_URL + "/refs-data.js", { headers: { "cache-control": "no-store" } });
        if (!r.ok) return json(res, 502, { ok: false, error: "deploy respondeu HTTP " + r.status });
        const txt = await r.text();
        const w = {}; new Function("window", txt)(w);
        if (!w.REFS_DATA || !Array.isArray(w.REFS_DATA.refs)) return json(res, 502, { ok: false, error: "refs-data.js inválido no deploy" });
        const tmp = path.join(DATA_DIR, ".refs-data.tmp.js"); fs.writeFileSync(tmp, txt); fs.renameSync(tmp, DATA_FILE);
        return json(res, 200, { ok: true, count: w.REFS_DATA.refs.length });
      } else { // push
        const token = (JSON.parse((await readBody(req)) || "{}").token) || EDIT_TOKEN;
        if (!token) return json(res, 400, { ok: false, error: "informe a senha de edição do deploy" });
        const local = fs.readFileSync(DATA_FILE, "utf8");
        const w = {}; new Function("window", local)(w);
        const r = await fetch(DEPLOY_URL + "/api/save", { method: "POST", headers: { "content-type": "application/json", "x-edit-token": token }, body: JSON.stringify(w.REFS_DATA) });
        const rt = await r.text();
        res.writeHead(r.status, { "content-type": "application/json" }); return res.end(rt);
      }
    }
    serveStatic(req, res);
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  if (RAILWAY) {
    console.log("REFS catalog (deploy) na porta " + PORT + (EDIT_TOKEN ? " — edição com senha" : " — somente leitura (sem EDIT_TOKEN)"));
  } else {
    const url = "http://localhost:" + PORT;
    console.log("REFS catalog em " + url + " — edição livre, refs-data.js auto-salvo. (Ctrl+C encerra.)");
    exec('open "' + url + '"');
  }
});
