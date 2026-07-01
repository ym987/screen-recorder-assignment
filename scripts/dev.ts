// Dev runner: builds the single-file client and serves it together with the
// mock server on a single origin (http://localhost:3000). Same origin means no
// CORS and a secure context for getUserMedia; the client is rebuilt per request
// so source edits show up on refresh.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

import { createServer } from "../mock-server/src/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const PORT = 3000;

async function buildHtml(): Promise<string> {
  const result = await build({
    entryPoints: [join(root, "frontend", "src", "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const js = result.outputFiles[0].text;
  const html = await readFile(join(root, "frontend", "index.html"), "utf8");
  return html.replace(/<script type="module"[^>]*><\/script>/, `<script>\n${js}\n</script>`);
}

async function main(): Promise<void> {
  const dataDir = join(root, ".data", "sessions");
  const { app, store } = createServer(dataDir);
  await store.hydrate().catch(() => undefined);

  // Serve the freshly-built single-file client from the same origin as the API.
  app.get(["/", "/index.html"], async (_req, res) => {
    try {
      const html = await buildHtml(); // rebuild each request for live edits
      res.type("text/html; charset=utf-8").send(html);
    } catch (err) {
      res.status(500).type("text/plain").send(String(err));
    }
  });

  app.listen(PORT, () => console.log(`[dev] http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
