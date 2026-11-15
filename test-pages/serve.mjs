// Minimal static server for the test pages. No dependencies.
// Usage: npm run serve:test-pages   then open http://localhost:5173/
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  // Test forms post here. Discard the body and redirect, like a real sign-up would.
  if (req.method === "POST") {
    req.resume();
    req.on("end", () => {
      res.writeHead(303, { location: "/welcome.html" }).end();
    });
    return;
  }

  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Test pages on http://localhost:${port}/ (Ctrl+C to stop)`);
});
