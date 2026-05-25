import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { controlUiManualChunk } from "./config/control-ui-chunking.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.resolve(here, "../dist/control-ui");
const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");

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

function normalizeBuildId(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.slice(0, 96) || "dev";
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "dev";
  } catch {
    return "dev";
  }
}

function readGitShortSha(): string | null {
  try {
    const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function resolveControlUiBuildId(): string {
  const explicit =
    process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim() || process.env.OPENCLAW_VERSION?.trim();
  if (explicit) {
    return normalizeBuildId(explicit);
  }
  const version = readPackageVersion();
  const gitSha = readGitShortSha();
  return normalizeBuildId(gitSha ? `${version}-${gitSha}` : version);
}

function controlUiServiceWorkerBuildIdPlugin(buildId: string): Plugin {
  return {
    name: "control-ui-service-worker-build-id",
    apply: "build",
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      const publicSwPath = path.join(here, "public/sw.js");
      const source = fs.readFileSync(fs.existsSync(swPath) ? swPath : publicSwPath, "utf8");
      const placeholder = '"__OPENCLAW_CONTROL_UI_BUILD_ID__"';
      const updated = source.replace(placeholder, JSON.stringify(buildId));
      if (updated === source) {
        throw new Error(`Control UI service worker build id placeholder missing in ${swPath}`);
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(swPath, updated);
    },
  };
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const controlUiBuildId = resolveControlUiBuildId();
  return {
    base,
    define: {
      OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify(controlUiBuildId),
    },
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["ipaddr.js", "lit/directives/repeat.js", "markdown-it-task-lists"],
    },
    resolve: {
      alias: {
        json5: json5EsmPath,
      },
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
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: controlUiManualChunk,
        },
      },
      // Keep CI/onboard logs clean; the app chunk is split into stable runtime buckets above.
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
