import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    // The import chain  thinking.ts → provider-thinking.ts → plugins/runtime.ts
    // pulls src/utils.ts (which uses node:path, node:os, process.cwd()) into
    // the browser bundle.  Provide lightweight stubs so the top-level
    // resolveOpenClawStateDir() side-effect doesn't crash at load time.
    define: {
      "process.cwd": "(() => '/')",
      "process.env": "{}",
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
      // Stub node:os and node:path for browser — the transitive import of
      // src/utils.ts uses os.homedir(), path.resolve(), path.join(), and
      // fs.existsSync() at module load time via resolveOpenClawStateDir().
      {
        name: "node-builtins-stub",
        enforce: "pre" as const,
        resolveId(source) {
          if (source === "node:os" || source === "os") {
            return "\0stub:os";
          }
          if (source === "node:path" || source === "path") {
            return "\0stub:path";
          }
          if (source === "node:fs" || source === "fs") {
            return "\0stub:fs";
          }
          return null;
        },
        load(id) {
          if (id === "\0stub:os") {
            return "export function homedir() { return '/'; } export default { homedir };";
          }
          if (id === "\0stub:path") {
            return [
              "export function resolve(...args) { return args.filter(Boolean).join('/'); }",
              "export function join(...args) { return args.filter(Boolean).join('/'); }",
              "export function dirname(p) { return p.replace(/\\/[^/]*$/, '') || '/'; }",
              "export default { resolve, join, dirname };",
            ].join("\n");
          }
          if (id === "\0stub:fs") {
            return "export function existsSync() { return false; } export default { existsSync };";
          }
          return null;
        },
      },
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
    ],
  };
});
