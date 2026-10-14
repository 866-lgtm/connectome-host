// Packs connectome-host as `npm publish` packs it, installs the tarball
// alone into an empty directory with its dependencies from the registry, as
// `npm install @animalabs/connectome-host` does (install scripts included,
// so the postinstall builds the Web UI), and runs it there under bun:
//   1. the Web UI built: dist/web/index.html is in the installed package;
//   2. `bun build` resolves src/index.ts's static imports, and its dynamic
//      ones with a literal specifier, in the installed tree, on paths a run
//      doesn't reach too (a recipe extension, loaded by a computed path, isn't
//      among them);
//   3. the README's offline smoke run, recipes/mock-test.json in batch mode,
//      with the Web UI off: membrane's mock adapter, so no credentials and no
//      provider call. It must exit 0, taking the message it was sent and
//      then printing the mock agent's '[Echo] …' reply. Starting, the host
//      loads @opentui/core and its native package for this platform, so a
//      missing one fails here; whether the library itself loads shows only
//      when the TUI starts, which batch mode doesn't.
// A file missing from the package, or a dependency only devDependencies
// supplied, then fails here, before the release is published, and not for
// whoever installs it. The publish workflow runs it in a job of its own,
// without the publish credential, since install scripts run here; to check
// by hand, run it from the repository root, for example before
// `git push --follow-tags`. PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS sets the
// smoke run's limit in milliseconds (default 120000).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = "src/index.ts";
const SMOKE_RECIPE = "recipes/mock-test.json";
const SMOKE_MESSAGE = "pack-installs-alone: hello";
const WEB_UI = "dist/web/index.html";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

class CheckError extends Error {}

function smokeTimeout() {
  const value = process.env.PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS;
  if (value === undefined) return 120_000;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CheckError(`PACK_INSTALLS_ALONE_SMOKE_TIMEOUT_MS is '${value}', not a whole number of milliseconds.`);
  }
  return Number(value);
}

/** Runs a command, its output going to ours; a failure throws `message`. */
function run(file, args, options, message) {
  try {
    execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  } catch (error) {
    if (error?.code === "ENOENT") throw new CheckError(`couldn't run ${file}: it isn't on PATH.`);
    if (error?.code === "ETIMEDOUT") throw new CheckError(`${message.split(" (")[0]}: it didn't finish within ${options.timeout / 1000} s.`);
    throw new CheckError(message);
  }
}

function main() {
  const smokeTimeoutMs = smokeTimeout();
  const work = mkdtempSync(join(tmpdir(), "pack-installs-alone-"));
  try {
    let packed;
    let out = "";
    try {
      out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: MAX_BUFFER,
      });
      packed = JSON.parse(out)[0];
    } catch (error) {
      if (error?.code === "ENOENT") throw new CheckError("couldn't run npm: it isn't on PATH.");
      process.stderr.write(error?.stdout ?? out);
      throw new CheckError("npm pack failed (its output is above).");
    }
    const tarball = join(work, packed.filename);
    const dir = join(work, "install");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pack-installs-alone", private: true }));
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", tarball],
      { cwd: dir, timeout: INSTALL_TIMEOUT_MS },
      `${packed.filename} didn't install on its own into an empty directory (npm's output is above). A dependency ` +
        "that isn't on the registry does that, or a registry or network error, which a re-run gets past.",
    );
    const installed = join(dir, "node_modules", ...packed.name.split("/"));

    if (!existsSync(join(installed, WEB_UI))) {
      throw new CheckError(
        `the installed ${packed.filename} has no ${WEB_UI}: its postinstall didn't build the Web UI (its warning, if any, ` +
          "is above). web/ left out of the package does that, or a Web UI build that fails.",
      );
    }

    run(
      "bun",
      ["build", "--target=bun", join(installed, ENTRY), "--outdir", join(work, "bundle")],
      { cwd: dir, stdio: ["ignore", "ignore", "inherit"], timeout: BUILD_TIMEOUT_MS },
      `an import of ${ENTRY} doesn't resolve in the installed ${packed.filename} (bun's output is above). ` +
        "A file missing from the package, or a dependency only devDependencies supplied, does that.",
    );

    // The smoke run's recipe, with the Web UI off: batch mode keeps a Web UI
    // serving after the run, and nothing here would end it.
    let recipe;
    try {
      recipe = JSON.parse(readFileSync(join(installed, SMOKE_RECIPE), "utf8"));
    } catch (error) {
      throw new CheckError(`the installed ${packed.filename} has no readable ${SMOKE_RECIPE}: ${error.message}.`);
    }
    recipe.modules = { ...recipe.modules, webui: false };
    const smokeRecipe = join(work, "smoke-recipe.json");
    writeFileSync(smokeRecipe, JSON.stringify(recipe));
    const smoke = spawnSync("bun", [join(installed, ENTRY), smokeRecipe], {
      cwd: dir,
      input: `${SMOKE_MESSAGE}\n`,
      encoding: "utf8",
      timeout: smokeTimeoutMs,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, DATA_DIR: join(work, "data") },
    });
    process.stdout.write(smoke.stdout ?? "");
    process.stderr.write(smoke.stderr ?? "");
    const smokeRun = `the offline smoke run (${SMOKE_RECIPE} in batch mode, Web UI off) of the installed ${packed.filename}`;
    if (smoke.error?.code === "ETIMEDOUT") {
      throw new CheckError(`${smokeRun} didn't finish within ${smokeTimeoutMs / 1000} s (its output is above).`);
    }
    if (smoke.error?.code === "ENOENT") throw new CheckError("couldn't run bun: it isn't on PATH.");
    if (smoke.error) throw new CheckError(`${smokeRun} failed: ${smoke.error.message}.`);
    if (smoke.status !== 0) {
      throw new CheckError(`${smokeRun} exited ${smoke.status ?? `on ${smoke.signal}`} (its output is above).`);
    }
    // Batch mode prints each line it takes as '> line'; the mock agent's reply
    // to it follows as '[Echo] …' (an echo of the conversation's first user
    // text, the session's local time, not of this line).
    const lines = (smoke.stdout ?? "").split("\n");
    const taken = lines.indexOf(`> ${SMOKE_MESSAGE}`);
    if (taken === -1 || !lines.slice(taken + 1).some((line) => line.startsWith("[Echo] "))) {
      throw new CheckError(
        `${smokeRun} exited 0, but the mock agent didn't reply to '${SMOKE_MESSAGE}' (no '[Echo] …' line after ` +
          `'> ${SMOKE_MESSAGE}'; its output is above).`,
      );
    }
    console.log(
      `${packed.filename} (${packed.entryCount} files) installs on its own; the Web UI built, ${ENTRY}'s imports ` +
        "resolve, and the offline smoke run answered.",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof CheckError)) throw error;
  console.error(`pack-installs-alone: ${error.message}`);
  process.exitCode = 1;
}
