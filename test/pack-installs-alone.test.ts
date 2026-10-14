// Black-box coverage of scripts/pack-installs-alone.mjs: each case runs the
// real script under node, as the publish workflow runs it, in a throwaway
// stand-in for the host. The stand-in has no dependencies, so npm packs and
// installs it offline with its own cache. Its postinstall writes
// dist/web/index.html, as the host's builds the Web UI there, and its
// src/index.ts answers the smoke run as batch mode with the mock recipe
// does: '> line' for each line it reads, then an '[Echo] …' reply, and only
// with the Web UI off.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/pack-installs-alone.mjs", import.meta.url));
const TIMEOUT_MS = 60_000;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const HOST = `import { readFileSync } from "node:fs";
import { helper } from "./helper.ts";
const recipe = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (recipe.modules?.webui !== false) { console.error("zz: the Web UI is on"); process.exit(3); }
for (const line of readFileSync(0, "utf8").split("\\n").filter(Boolean)) console.log(\`> \${line}\\n[Echo] \${helper("user: the session's local time")}\`);
`;
const BUILDS_WEB_UI = `node -e "require('fs').mkdirSync('dist/web',{recursive:true});require('fs').writeFileSync('dist/web/index.html','')"`;

/** A stand-in host: package.json from `pkg` (its postinstall building the Web
 *  UI unless `pkg` says otherwise), and its files, `index` being
 *  src/index.ts's text. */
function standIn(pkg: Record<string, unknown>, index = HOST, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-test-"));
  made.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@zz/host", version: "1.0.0", type: "module", scripts: { postinstall: BUILDS_WEB_UI }, ...pkg }),
    "src/index.ts": index,
    "src/helper.ts": "export const helper = (line: string): string => line;\n",
    "recipes/mock-test.json": JSON.stringify({ name: "Mock", modules: { wake: false, webui: { host: "127.0.0.1" } } }),
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function check(dir: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  // npm's home and cache, outside the package, so npm pack doesn't take them in.
  const home = mkdtempSync(join(tmpdir(), "pack-installs-alone-home-"));
  made.push(home);
  return new Promise((resolve) => {
    execFile("node", [SCRIPT], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        npm_config_cache: join(home, ".npm-cache"),
        npm_config_userconfig: join(home, ".npmrc"),
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        ...env,
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const smokeRun = "the offline smoke run \\(recipes\\/mock-test\\.json in batch mode, Web UI off\\) of the installed zz-host-1\\.0\\.0\\.tgz";

test("a package that installs alone, builds its Web UI, resolves and echoes its smoke message with the Web UI off passes", async () => {
  const result = await check(standIn({}));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^> pack-installs-alone: hello\n\[Echo\] user: the session's local time$/m);
  assert.match(
    result.stdout,
    /^zz-host-1\.0\.0\.tgz \(\d+ files\) installs on its own; the Web UI built, src\/index\.ts's imports resolve, and the offline smoke run answered\.$/m,
  );
}, TIMEOUT_MS);

test("a postinstall that doesn't build the Web UI fails, so install scripts must run", async () => {
  const result = await check(standIn({ scripts: { postinstall: "echo 'zz: the Web UI build failed' >&2" } }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /zz: the Web UI build failed/);
  assert.match(
    result.stderr,
    /pack-installs-alone: the installed zz-host-1\.0\.0\.tgz has no dist\/web\/index\.html: its postinstall didn't build the Web UI \(its warning, if any, is above\)\. web\/ left out of the package does that, or a Web UI build that fails\.\n$/,
  );
}, TIMEOUT_MS);

test("a dependency that can't be installed fails the install, saying what does that", async () => {
  const result = await check(standIn({ dependencies: { "zz-not-on-the-registry": "1.0.0" } }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /pack-installs-alone: zz-host-1\.0\.0\.tgz didn't install on its own into an empty directory \(npm's output is above\)\. A dependency that isn't on the registry does that, or a registry or network error, which a re-run gets past\.\n$/,
  );
}, TIMEOUT_MS);

test("a file left out of the package fails the resolve, naming the entry", async () => {
  const result = await check(standIn({ files: ["src/index.ts", "recipes"] }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /pack-installs-alone: an import of src\/index\.ts doesn't resolve in the installed zz-host-1\.0\.0\.tgz \(bun's output is above\)\. A file missing from the package, or a dependency only devDependencies supplied, does that\.\n$/,
  );
}, TIMEOUT_MS);

test("a dependency only devDependencies supplied fails the resolve", async () => {
  const result = await check(standIn({ devDependencies: { "zz-dev-only": "1.0.0" } }, `import "zz-dev-only";\n${HOST}`));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /zz-dev-only/);
  assert.match(result.stderr, /pack-installs-alone: an import of src\/index\.ts doesn't resolve/);
}, TIMEOUT_MS);

test("a smoke recipe left out of the package fails, naming it", async () => {
  const result = await check(standIn({ files: ["src"] }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pack-installs-alone: the installed zz-host-1\.0\.0\.tgz has no readable recipes\/mock-test\.json: ENOENT/);
}, TIMEOUT_MS);

test("a smoke run that exits non-zero fails, with its exit code", async () => {
  const result = await check(standIn({}, `${HOST}process.exit(2);\n`));
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`pack-installs-alone: ${smokeRun} exited 2 \\(its output is above\\)\\.\\n$`));
}, TIMEOUT_MS);

test("a smoke run with no reply after the message it took fails, an '[Echo] …' before it included", async () => {
  const takes = `import { readFileSync } from "node:fs";\nimport { helper } from "./helper.ts";\nconst taken = readFileSync(0, "utf8").trim();\n`;
  for (const index of [
    `${takes}console.log(\`> \${helper(taken)}\`);\n`,
    `${takes}console.log(\`[Echo] a banner\\n> \${helper(taken)}\`);\n`,
    `${takes}console.log(\`[Echo] \${helper("no '> line' at all")}\`);\n`,
  ]) {
    const result = await check(standIn({}, index));
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /exited 0, but the mock agent didn't reply to 'pack-installs-alone: hello' \(no '\[Echo\] …' line after '> pack-installs-alone: hello'; its output is above\)\.\n$/,
    );
  }
}, TIMEOUT_MS * 3);

test("a smoke run that doesn't finish is stopped at its limit, and the limit must be a number", async () => {
  const slow = await check(
    standIn({}, `${HOST}await new Promise((resolve) => setTimeout(resolve, 30_000));\n`),
    { PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS: "2000" },
  );
  assert.equal(slow.code, 1);
  assert.match(slow.stderr, /didn't finish within 2 s \(its output is above\)\.\n$/);
  for (const value of ["", "2m", "0"]) {
    const bad = await check(standIn({}), { PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS: value });
    assert.equal(bad.code, 1);
    assert.equal(bad.stderr, `pack-installs-alone: PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS is '${value}', not a whole number of milliseconds.\n`);
  }
}, TIMEOUT_MS);
