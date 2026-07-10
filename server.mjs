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
