// Servidor local do catálogo REFS.
// Serve os arquivos e salva refs-data.js automaticamente (POST /api/save),
// para que adições/edições/exclusões feitas no site fiquem permanentes.
// Uso:  node server.mjs   (ou dê duplo-clique em start.command)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4177;
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1"; // Railway define PORT
const READONLY = process.env.PUBLIC === "1";             // no deploy: sem escrita
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".md": "text/markdown; charset=utf-8",
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const fp = path.join(DIR, p);
  if (!fp.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(d);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/save") {
    if (READONLY) { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "somente leitura (deploy público)" })); }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 25e6) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!data || !Array.isArray(data.refs)) throw new Error("payload inválido");
        const js = "/* Atualizado automaticamente pelo catálogo (server.mjs). */\nwindow.REFS_DATA = " + JSON.stringify(data, null, 2) + ";\n";
        const tmp = path.join(DIR, ".refs-data.tmp.js");
        fs.writeFileSync(tmp, js);
        fs.renameSync(tmp, path.join(DIR, "refs-data.js")); // troca atômica
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: data.refs.length }));
        console.log(new Date().toLocaleTimeString(), "salvo — " + data.refs.length + " refs");
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      }
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  if (process.env.PORT) {
    console.log("REFS catalog (deploy) na porta " + PORT + (READONLY ? " — somente leitura" : ""));
  } else {
    const url = "http://localhost:" + PORT;
    console.log("REFS catalog em " + url + " — refs-data.js é salvo automaticamente. (Ctrl+C encerra.)");
    exec('open "' + url + '"');
  }
});
