"use strict";

// Read-only loopback server. It has no game-save endpoints or filesystem write API.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const root = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function createServer() {
  const server = http.createServer((request, response) => {
    try {
      const port = server.address().port;
      if (
        !["127.0.0.1:" + port, "localhost:" + port].includes(
          request.headers.host,
        )
      ) {
        response.writeHead(400);
        return response.end("Invalid local address.");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        return response.end("This Builder is read-only.");
      }
      const pathname = decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname,
      );
      if (pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(
          JSON.stringify({
            application: "DauntlessBuilderLocal",
            version: "1.0.0",
          }),
        );
      }
      const documents = {
        "/README.md": "README.md",
        "/LICENSE": "LICENSE",
        "/NOTICE.txt": "NOTICE.txt",
      };
      let file;
      if (Object.hasOwn(documents, pathname))
        file = path.join(__dirname, documents[pathname]);
      else {
        file = path.resolve(
          root,
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
        const relative = path.relative(root, file);
        if (relative.startsWith("..") || path.isAbsolute(relative))
          throw Error("Outside public folder.");
        const real = fs.realpathSync(file),
          realRelative = path.relative(fs.realpathSync(root), real);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative))
          throw Error("Outside public folder.");
      }
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw Error("Not a file.");
      response.writeHead(200, {
        "Content-Type":
          MIME[path.extname(file).toLowerCase()] || "text/plain; charset=utf-8",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      if (request.method === "HEAD") return response.end();
      fs.createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
    } catch {
      if (!response.headersSent)
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      response.end("File not found.");
    }
  });
  return server;
}

function openBrowser(url) {
  if (process.platform === "win32")
    execFile(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      { windowsHide: true },
      () => {},
    );
  else if (process.platform === "darwin") execFile("open", [url], () => {});
  else execFile("xdg-open", [url], () => {});
}

if (require.main === module) {
  const port = Number(process.env.BUILDER_PORT || 49316),
    server = createServer();
  server.on("error", async (error) => {
    if (error.code === "EADDRINUSE") {
      try {
        const url = "http://127.0.0.1:" + port;
        const response = await fetch(url + "/health", {
          signal: AbortSignal.timeout(2000),
        });
        if ((await response.json()).application === "DauntlessBuilderLocal") {
          console.log("Builder already running: " + url);
          if (process.argv.includes("--open")) openBrowser(url);
          return;
        }
      } catch {}
    }
    console.error("Could not start the local Builder: " + error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + server.address().port;
    console.log("Dauntless Builder Local ready: " + url);
    console.log(
      "Keep this window open while using the Builder. Close it to stop the local server.",
    );
    if (process.argv.includes("--open")) openBrowser(url);
  });
}
module.exports = { createServer };
