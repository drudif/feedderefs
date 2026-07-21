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
      return json(res, 200, { ok: true, railway: RAILWAY, hasEditToken: !!EDIT_TOKEN, hasGeminiKey: !!GEMINI_API_KEY, usingVolume: DATA_DIR !== DIR, dataDir: DATA_DIR });
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
    // ---- ingerir link social: lê a thumbnail (og:image) e o Gemini analisa. NUNCA baixa mídia. ----
    if (req.method === "POST" && req.url === "/api/ingest") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      if (!GEMINI_API_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY não configurada" });
      const { url, prompt } = JSON.parse((await readBody(req)) || "{}");
      if (!url) return json(res, 400, { ok: false, error: "url ausente" });
      let og; try { og = await ogScrape(url); } catch { return json(res, 502, { ok: false, error: "não consegui abrir o link" }); }
      if (!og.image) return json(res, 422, { ok: false, error: "sem preview no link (post privado ou a rede bloqueia leitura)" });
      let imgBuf, mime;
      try { const ir = await fetch(og.image); if (!ir.ok) throw 0; imgBuf = Buffer.from(await ir.arrayBuffer()); mime = (ir.headers.get("content-type") || "image/jpeg").split(";")[0]; }
      catch { return json(res, 502, { ok: false, error: "não consegui baixar a thumbnail" }); }
      const ctx = `\n\nContexto do post (URL: ${url})` + (og.title ? `\nTítulo: ${og.title}` : "") + (og.desc ? `\nDescrição: ${og.desc}` : "") + `\nA imagem é a thumbnail/preview do post. Se o post divulga uma ferramenta/site/recurso, use a URL oficial dela; caso contrário, use a URL do post como "url".`;
      const gbody = { contents: [{ parts: [{ inline_data: { mime_type: mime, data: imgBuf.toString("base64") } }, { text: (prompt || "Produza um JSON {title,url,cat,types,desc} sobre o conteúdo.") + ctx }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 900, responseMimeType: "application/json" } };
      const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gbody) });
      const gj = await gr.json().catch(() => ({}));
      const text = ((((gj.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text).filter(Boolean).join("");
      if (!text) return json(res, 502, { ok: false, error: "Gemini não respondeu (chave/cota?)" });
      return json(res, 200, { ok: true, raw: text, thumb: og.image, source: url });
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
