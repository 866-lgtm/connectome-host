// Checks that bun.lock and package-lock.json resolve the stack's packages
// (@animalabs/*) the same way. The README's `bun install` installs a
// checkout from bun.lock, while CI and the publish workflow install with npm
// from package-lock.json, so a change that moves one lockfile and not the
// other would test one tree and hand README installs another. It compares
// what each stack package the host depends on, and each one those depend on
// in turn, resolves to, following Node's lookup through each lockfile's tree
// from the root's dependencies: 'host > @animalabs/agent-framework >
// @animalabs/membrane' is the membrane that agent-framework gets. Where a
// copy sits doesn't matter, only what each importer gets. Other packages
// aren't compared, and a stack package that only a third-party package
// depends on wouldn't be reached (none does today). A registry version
// compares as its version, and a GitHub pin as its repository and commit,
// which bun.lock writes as `github:owner/repo#<sha7>` and package-lock.json
// as a `git+…github.com/owner/repo.git#<sha40>` source. A source of any
// other kind can't be compared, and fails saying so. CI runs it beside
// `bun install --frozen-lockfile`, which checks bun.lock against
// package.json, and `npm ci`, which checks package-lock.json against it.
// Exits 1 naming each disagreement.
import { readFileSync } from "node:fs";

const SCOPE = "@animalabs/";

/** A lockfile parsed, naming the file when it doesn't parse or has no
 *  `packages` map. bun.lock's trailing commas are removed first. */
function parseLock(file, trailingCommas) {
  const text = readFileSync(file, "utf8");
  let lock;
  try {
    lock = JSON.parse(trailingCommas ? text.replace(/,(\s*[}\]])/g, "$1") : text);
  } catch (error) {
    throw new Error(`${file} doesn't parse: ${error.message}`);
  }
  if (!lock?.packages || typeof lock.packages !== "object") throw new Error(`${file} has no packages map`);
  return lock;
}

const declared = (meta = {}) =>
  Object.keys({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies }).filter((name) =>
    name.startsWith(SCOPE),
  );

/** What a lockfile pins a package to: a registry version, a GitHub
 *  repository and commit, or a source this check can't compare. `text` is
 *  how the lockfile writes it. */
function pinOf(text, source) {
  const git = /^(?:github:|git\+(?:https|ssh):\/\/(?:git@)?github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?#([0-9a-f]{7,40})$/i.exec(source ?? text);
  if (git) return { kind: "git", repo: git[1].toLowerCase(), commit: git[2].toLowerCase(), text };
  if (source === undefined && /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(text)) return { kind: "version", text };
  return { kind: "other", text };
}

/** bun.lock as a tree: an install path ('a/b' for b nested under a) to the
 *  pin there and the stack packages it declares. Each entry's first element
 *  is `<name>@<version or source>`, and its first object element holds its
 *  dependencies: the third for a registry package, the second for a git
 *  one. */
function bunTree(lock) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const meta = entry.slice(1).find((element) => element && typeof element === "object" && !Array.isArray(element));
    tree.set(path, { pin: pinOf(entry[0].slice(entry[0].indexOf("@", 1) + 1)), deps: declared(meta) });
  }
  const root = lock.workspaces?.[""] ?? {};
  return { tree, root: declared({ ...root, dependencies: { ...root.dependencies, ...root.devDependencies } }) };
}

/** package-lock.json as the same tree: 'node_modules/a/node_modules/b' is
 *  'a/b'. A registry package pins its `version`; a git one, its `resolved`
 *  source (its `version` is its own package.json's); anything else, such as
 *  a link, its `resolved` text. */
function npmTree(lock) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    const resolved = typeof entry.resolved === "string" ? entry.resolved : undefined;
    const fromRegistry = resolved === undefined || /^https?:\/\//.test(resolved);
    tree.set(path.replace(/(^|\/)node_modules\//g, "$1"), {
      pin: fromRegistry && entry.version !== undefined ? pinOf(entry.version) : pinOf(resolved ?? "(no version)", resolved ?? ""),
      deps: declared(entry),
    });
  }
  const root = lock.packages[""] ?? {};
  return { tree, root: declared({ ...root, dependencies: { ...root.dependencies, ...root.devDependencies } }) };
}

/** An install path's packages: 'a/@s/b' is ['a', '@s/b']. */
function packagesOf(path) {
  const parts = path.split("/");
  const names = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return names;
}

/** Where `name` resolves from a package installed at `from` ('' for the
 *  root): its own nested copy, then each enclosing package's, then the top. */
function lookup(tree, from, name) {
  const chain = from ? packagesOf(from) : [];
  for (let depth = chain.length; depth >= 0; depth--) {
    const path = [...chain.slice(0, depth), name].join("/");
    if (tree.has(path)) return path;
  }
  return undefined;
}

/** Each chain of stack imports from the root, to the version it resolves to. */
function resolutions({ tree, root }) {
  const out = new Map();
  const visit = (from, chain, deps) => {
    for (const name of deps) {
      const key = [...chain, name].join(" > ");
      if (out.has(key) || chain.includes(name)) continue;
      const path = lookup(tree, from, name);
      out.set(key, path ? tree.get(path).pin : undefined);
      if (path) visit(path, [...chain, name], tree.get(path).deps);
    }
  };
  visit("", ["host"], root);
  return out;
}

/** Whether two pins agree: the same registry version, or the same GitHub
 *  repository at the same commit, one hash a prefix of the other. */
function samePin(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "version") return a.text === b.text;
  return a.repo === b.repo && (a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit));
}

function main() {
  let bun;
  let npm;
  try {
    bun = resolutions(bunTree(parseLock("bun.lock", true)));
    npm = resolutions(npmTree(parseLock("package-lock.json", false)));
  } catch (error) {
    console.error(`lockfiles-agree: couldn't read the lockfiles: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const chains = [...new Set([...bun.keys(), ...npm.keys()])].sort();
  const shown = (pin) => pin?.text ?? "none";
  const unknown = chains.filter((chain) => bun.get(chain)?.kind === "other" || npm.get(chain)?.kind === "other");
  const differ = chains.filter((chain) => !unknown.includes(chain) && !samePin(bun.get(chain), npm.get(chain)));
  if (differ.length === 0 && unknown.length === 0) {
    console.log(
      `bun.lock and package-lock.json resolve the stack's packages the same way: ` +
        `${chains.map((chain) => `${chain} ${shown(bun.get(chain))}`).join("; ")}.`,
    );
    return 0;
  }
  if (differ.length > 0) {
    console.error(
      `The lockfiles resolve the stack's packages differently:\n` +
        differ.map((chain) => `  ${chain}: bun.lock ${shown(bun.get(chain))}, package-lock.json ${shown(npm.get(chain))}\n`).join("") +
        "Make bun.lock follow package-lock.json: delete bun.lock and run `bun install --lockfile-only`, which builds " +
        "it from package-lock.json, so both pin the same versions.",
    );
  }
  if (unknown.length > 0) {
    console.error(
      `These pins are of a kind this check can't compare (it reads registry versions and GitHub commits):\n` +
        unknown.map((chain) => `  ${chain}: bun.lock ${shown(bun.get(chain))}, package-lock.json ${shown(npm.get(chain))}\n`).join("") +
        "Compare them by hand, and teach scripts/lockfiles-agree.mjs the kind if it's to stay.",
    );
  }
  return 1;
}

process.exitCode = main();
