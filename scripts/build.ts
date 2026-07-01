// Build a single self-contained dist/index.html with inlined JS (and CSS).
// Runnable via double-click (file://) — talks to http://localhost:3000 by default.

import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function main(): Promise<void> {
  const result = await build({
    entryPoints: [join(root, "frontend", "src", "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    sourcemap: false,
  });

  const js = result.outputFiles[0].text;

  const html = await readFile(join(root, "frontend", "index.html"), "utf8");
  // Replace the module script tag with an inline bundle.
  const inlined = html.replace(
    /<script type="module"[^>]*><\/script>/,
    `<script>\n${js}\n</script>`,
  );

  const distDir = join(root, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "index.html"), inlined, "utf8");

  // eslint-disable-next-line no-console
  console.log(`[build] wrote dist/index.html (${(inlined.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
