// Black-box coverage of scripts/lockfiles-agree.mjs: each case runs the real
// script under node, as CI runs it, in a throwaway directory holding the two
// lockfiles it reads.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/lockfiles-agree.mjs", import.meta.url));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A tree as both lockfiles describe it: an install path ('a/b' for b
 *  nested under a) to the version there and the packages it depends on.
 *  `git` pins it to a GitHub commit instead, 'owner/repo#<sha40>', as each
 *  lockfile writes one; `source` gives each lockfile's text for a pin of
 *  another kind, such as a link. */
type Tree = Record<string, { version: string; deps?: string[]; git?: string; ssh?: boolean; source?: { bun: string; npm: string } }>;

const ROOT_DEPS = ["@animalabs/agent-framework", "@animalabs/context-manager", "@animalabs/membrane", "discord.js"];
/** An install path's packages: 'a/@s/b' is ['a', '@s/b']. */
function packagesOf(path: string): string[] {
  const parts = path.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i]!.startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  return names;
}
const nameOf = (path: string) => packagesOf(path).at(-1)!;
const depsOf = (deps: string[] = []) => Object.fromEntries(deps.map((dep) => [dep, "*"]));

/** bun.lock's text, as bun writes it, trailing commas included. */
function bunLock(tree: Tree, rootDeps = ROOT_DEPS, rootDevDeps: string[] = []): string {
  const entries = Object.entries(tree)
    .map(([path, { version, deps, git, source }]) => {
      const meta = JSON.stringify({ dependencies: depsOf(deps) });
      if (git) {
        // As bun writes a GitHub pin: its metadata second, then its id.
        const [repo, sha] = git.split("#") as [string, string];
        return `    "${path}": ["${nameOf(path)}@github:${repo}#${sha.slice(0, 7)}", ${meta}, "${repo.replace("/", "-")}-${sha.slice(0, 7)}", "sha512-zz=="],\n`;
      }
      return `    "${path}": ["${nameOf(path)}@${source?.bun ?? version}", "", ${meta}, "sha512-zz=="],\n`;
    })
    .join("");
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "zz",\n      "dependencies": ${JSON.stringify(depsOf(rootDeps))},\n      "devDependencies": ${JSON.stringify(depsOf(rootDevDeps))},\n    },\n  },\n  "packages": {\n${entries}  },\n}\n`;
}

/** package-lock.json for the same tree: 'a/b' is node_modules/a/node_modules/b. */
function npmLock(tree: Tree, rootDeps = ROOT_DEPS, rootDevDeps: string[] = []): string {
  const packages: Record<string, unknown> = { "": { name: "zz", dependencies: depsOf(rootDeps), devDependencies: depsOf(rootDevDeps) } };
  for (const [path, { version, deps, git, ssh, source }] of Object.entries(tree)) {
    // npm writes a GitHub pin over https, or over ssh as git@github.com.
    const resolved = git ? `${ssh ? "git+ssh://git@" : "git+https://"}github.com/${git.replace("#", ".git#")}` : source?.npm ?? "https://zz";
    packages[`node_modules/${packagesOf(path).join("/node_modules/")}`] = { version, resolved, integrity: "sha512-zz==", dependencies: depsOf(deps) };
  }
  return JSON.stringify({ name: "zz", lockfileVersion: 3, packages }, null, 2);
}

function project(bun: string | undefined, npm: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lockfiles-agree-"));
  made.push(dir);
  if (bun !== undefined) writeFileSync(join(dir, "bun.lock"), bun);
  writeFileSync(join(dir, "package-lock.json"), npm);
  return dir;
}

function check(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [SCRIPT], { cwd: dir, env: { PATH: process.env.PATH ?? "" } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const STACK: Tree = {
  "@animalabs/agent-framework": { version: "0.22.1", deps: ["@animalabs/context-manager", "@animalabs/membrane"] },
  "@animalabs/membrane": { version: "0.5.87" },
  "@animalabs/context-manager": { version: "0.14.0", deps: ["@animalabs/membrane"] },
  "@animalabs/context-manager/@animalabs/membrane": { version: "0.5.69" },
  "discord.js": { version: "14.25.1" },
};

test("the npm paths the fixture writes are npm's", () => {
  const paths = Object.keys(JSON.parse(npmLock(STACK)).packages);
  assert.deepEqual(paths, [
    "",
    "node_modules/@animalabs/agent-framework",
    "node_modules/@animalabs/membrane",
    "node_modules/@animalabs/context-manager",
    "node_modules/@animalabs/context-manager/node_modules/@animalabs/membrane",
    "node_modules/discord.js",
  ]);
});

test("lockfiles resolving each stack import the same way agree, and say what each resolves to", async () => {
  const result = await check(project(bunLock(STACK), npmLock(STACK)));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    "bun.lock and package-lock.json resolve the stack's packages the same way: " +
      "host > @animalabs/agent-framework 0.22.1; " +
      "host > @animalabs/agent-framework > @animalabs/context-manager 0.14.0; " +
      "host > @animalabs/agent-framework > @animalabs/context-manager > @animalabs/membrane 0.5.69; " +
      "host > @animalabs/agent-framework > @animalabs/membrane 0.5.87; " +
      "host > @animalabs/context-manager 0.14.0; " +
      "host > @animalabs/context-manager > @animalabs/membrane 0.5.69; " +
      "host > @animalabs/membrane 0.5.87.\n",
  );
});

test("a version moved in one lockfile only is named, with each side's version and how to move both", async () => {
  const npm = { ...STACK, "@animalabs/agent-framework": { ...STACK["@animalabs/agent-framework"]!, version: "0.22.2" } };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "The lockfiles resolve the stack's packages differently:\n" +
      "  host > @animalabs/agent-framework: bun.lock 0.22.1, package-lock.json 0.22.2\n" +
      "Make bun.lock follow package-lock.json: delete bun.lock and run `bun install --lockfile-only`, which builds " +
      "it from package-lock.json, so both pin the same versions.\n",
  );
});

test("the same versions placed so an importer gets a different one disagree", async () => {
  // npm keeps 0.5.69 at the top and nests 0.5.87 under agent-framework:
  // the same two versions, but the host now imports 0.5.69.
  const npm: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.69" } };
  delete npm["@animalabs/context-manager/@animalabs/membrane"];
  npm["@animalabs/agent-framework/@animalabs/membrane"] = { version: "0.5.87" };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/membrane: bun\.lock 0\.5\.87, package-lock\.json 0\.5\.69\n/);
  assert.doesNotMatch(result.stderr, /host > @animalabs\/agent-framework > @animalabs\/membrane:/, "agent-framework gets 0.5.87 in both");
});

test("a copy placed differently that every importer resolves the same way agrees", async () => {
  // A second, nested copy of the same version changes nothing anyone gets.
  const npm: Tree = { ...STACK, "@animalabs/agent-framework/@animalabs/membrane": { version: "0.5.87" } };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 0, result.stderr);
});

test("a stack package one lockfile has and the other lacks is named", async () => {
  const npm: Tree = {
    ...STACK,
    "@animalabs/agent-framework": { version: "0.22.1", deps: ["@animalabs/chronicle", "@animalabs/context-manager", "@animalabs/membrane"] },
    "@animalabs/chronicle": { version: "0.4.0" },
  };
  const result = await check(project(bunLock(STACK), npmLock(npm)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/agent-framework > @animalabs\/chronicle: bun\.lock none, package-lock\.json 0\.4\.0\n/);
});

test("the root's devDependencies are followed too, since both installs take them", async () => {
  const bun: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.0" } };
  const npm: Tree = { ...STACK, "@animalabs/chronicle": { version: "0.4.1" } };
  const result = await check(project(bunLock(bun, ROOT_DEPS, ["@animalabs/chronicle"]), npmLock(npm, ROOT_DEPS, ["@animalabs/chronicle"])));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\n {2}host > @animalabs\/chronicle: bun\.lock 0\.4\.0, package-lock\.json 0\.4\.1\n/);
});

test("other packages may differ", async () => {
  const result = await check(project(bunLock(STACK), npmLock({ ...STACK, "discord.js": { version: "14.26.0" } })));
  assert.equal(result.code, 0, result.stderr);
});

test("a missing, damaged or shapeless lockfile fails, naming it", async () => {
  const missing = await check(project(undefined, npmLock(STACK)));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^lockfiles-agree: couldn't read the lockfiles: .*bun\.lock/);
  const damaged = await check(project(bunLock(STACK), "{ not json"));
  assert.equal(damaged.code, 1);
  assert.match(damaged.stderr, /^lockfiles-agree: couldn't read the lockfiles: package-lock\.json doesn't parse: /);
  const shapeless = await check(project(`{ "lockfileVersion": 1, }`, npmLock(STACK)));
  assert.equal(shapeless.code, 1);
  assert.equal(shapeless.stderr, "lockfiles-agree: couldn't read the lockfiles: bun.lock has no packages map\n");
});

// From main's lockfiles at 065b034 (Sep 10 to 14), which pinned membrane to a
// commit: bun.lock writes `github:antra-tess/membrane#18a86e9`, with its
// metadata second, and package-lock.json the git source and membrane's own
// version, 0.5.84.
const MEMBRANE_PIN = "antra-tess/membrane#18a86e9eda277378acd982b07c7fe7c187721119";
const PINNED: Tree = {
  ...STACK,
  "@animalabs/membrane": { version: "0.5.84", git: MEMBRANE_PIN },
  "@animalabs/context-manager/@animalabs/membrane": { version: "0.5.84", git: MEMBRANE_PIN },
};

test("a stack package pinned to a GitHub commit compares as its repository and commit", async () => {
  const result = await check(project(bunLock(PINNED), npmLock(PINNED)));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /host > @animalabs\/membrane github:antra-tess\/membrane#18a86e9[;.]/);
  assert.match(result.stdout, /host > @animalabs\/context-manager > @animalabs\/membrane github:antra-tess\/membrane#18a86e9[;.]/);
});

test("a git-pinned stack package's own stack dependencies are followed, from where bun keeps its metadata", async () => {
  // agent-framework pinned to a commit, its metadata in bun's second slot,
  // depending on a membrane only bun.lock moves.
  const pinned: Tree = { ...STACK, "@animalabs/agent-framework": { version: "0.22.1", deps: ["@animalabs/membrane"], git: "anima-research/agent-framework#1234567890abcdef1234567890abcdef12345678" } };
  const bumped: Tree = { ...pinned, "@animalabs/agent-framework/@animalabs/membrane": { version: "0.5.88" } };
  const result = await check(project(bunLock(bumped), npmLock(pinned)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /host > @animalabs\/agent-framework > @animalabs\/membrane: bun\.lock 0\.5\.88, package-lock\.json 0\.5\.87/);
});

test("another commit, or another repository, disagrees, naming each side's pin", async () => {
  const other: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: "antra-tess/membrane#0123456789abcdef0123456789abcdef01234567" } };
  const result = await check(project(bunLock(other), npmLock(PINNED)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /host > @animalabs\/membrane: bun\.lock github:antra-tess\/membrane#0123456, package-lock\.json git\+https:\/\/github\.com\/antra-tess\/membrane\.git#18a86e9eda277378acd982b07c7fe7c187721119/);
  const fork: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: "someone/membrane#18a86e9eda277378acd982b07c7fe7c187721119" } };
  assert.equal((await check(project(bunLock(fork), npmLock(PINNED)))).code, 1);
});

test("a pin of a kind the check can't compare fails, saying so, without the relock remedy", async () => {
  const linked: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.87", source: { bun: "file:../membrane", npm: "../membrane" } } };
  const result = await check(project(bunLock(linked), npmLock(linked)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /can't compare/);
  assert.match(result.stderr, /host > @animalabs\/membrane: bun\.lock file:\.\.\/membrane, package-lock\.json \.\.\/membrane/);
  assert.doesNotMatch(result.stderr, /delete bun\.lock/);
});

test("npm's ssh form of a GitHub pin, and a repository named in another case, compare as the same pin", async () => {
  const ssh: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: MEMBRANE_PIN, ssh: true } };
  const viaSsh = await check(project(bunLock(PINNED), npmLock(ssh)));
  assert.equal(viaSsh.code, 0, viaSsh.stderr);
  const cased: Tree = { ...PINNED, "@animalabs/membrane": { version: "0.5.84", git: "Antra-Tess/Membrane#18a86e9eda277378acd982b07c7fe7c187721119" } };
  const inCase = await check(project(bunLock(cased), npmLock(PINNED)));
  assert.equal(inCase.code, 0, inCase.stderr);
});

test("a stack package that neither lockfile installs agrees, shown as none", async () => {
  // context-manager declares an optional stack package that installs on
  // neither side, as one for another platform wouldn't.
  const optional: Tree = { ...STACK, "@animalabs/context-manager": { version: "0.14.0", deps: ["@animalabs/membrane", "@animalabs/zz-optional"] } };
  const result = await check(project(bunLock(optional), npmLock(optional)));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /host > @animalabs\/context-manager > @animalabs\/zz-optional none[;.]/);
});

test("a pin of another kind against a version differs, with the relock remedy, and isn't called incomparable", async () => {
  const linked: Tree = { ...STACK, "@animalabs/membrane": { version: "0.5.87", source: { bun: "0.5.87", npm: "../membrane" } } };
  const result = await check(project(bunLock(linked), npmLock(linked)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /resolve the stack's packages differently:\n/);
  // agent-framework's chain to membrane differs the same way, and sorts first.
  assert.match(result.stderr, /^ {2}host > @animalabs\/membrane: bun\.lock 0\.5\.87, package-lock\.json \.\.\/membrane$/m);
  assert.match(result.stderr, /^ {2}host > @animalabs\/agent-framework > @animalabs\/membrane: bun\.lock 0\.5\.87, package-lock\.json \.\.\/membrane$/m);
  assert.match(result.stderr, /delete bun\.lock/);
  assert.doesNotMatch(result.stderr, /can't compare/);
});

test("lockfiles whose roots depend on no stack package fail: there's nothing to compare", async () => {
  const result = await check(project(bunLock(STACK, ["discord.js"]), npmLock(STACK, ["discord.js"])));
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "lockfiles-agree: neither lockfile's root depends on a stack package (@animalabs/*), so there is nothing to compare: run it from the host's repository root.\n",
  );
});
