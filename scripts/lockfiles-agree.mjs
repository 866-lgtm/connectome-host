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
// depends on wouldn't be reached (none does today). CI runs it beside
// `bun install --frozen-lockfile`, which checks bun.lock against
// package.json. Exits 1 naming each disagreement.
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

/** bun.lock as a tree: an install path ('a/b' for b nested under a) to the
 *  version there and the stack packages it declares. Each entry's first
 *  element is `<name>@<version or source>`, and its third holds its
 *  dependencies. */
function bunTree(lock) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    tree.set(path, { version: entry[0].slice(entry[0].indexOf("@", 1) + 1), deps: declared(entry[2]) });
  }
  const root = lock.workspaces?.[""] ?? {};
  return { tree, root: declared({ ...root, dependencies: { ...root.dependencies, ...root.devDependencies } }) };
}

/** package-lock.json as the same tree: 'node_modules/a/node_modules/b' is
 *  'a/b'. A version is the entry's `version`; anything else (a link, say)
 *  compares as its `resolved` source, and agrees only with the same text. */
function npmTree(lock) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    tree.set(path.replace(/(^|\/)node_modules\//g, "$1"), {
      version: entry.version ?? entry.resolved ?? "(no version)",
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
      out.set(key, path ? tree.get(path).version : "none");
      if (path) visit(path, [...chain, name], tree.get(path).deps);
    }
  };
  visit("", ["host"], root);
  return out;
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
  const differ = chains.filter((chain) => bun.get(chain) !== npm.get(chain));
  if (differ.length === 0) {
    console.log(
      `bun.lock and package-lock.json resolve the stack's packages the same way: ` +
        `${chains.map((chain) => `${chain} ${bun.get(chain)}`).join("; ")}.`,
    );
    return 0;
  }
  console.error(
    `The lockfiles resolve the stack's packages differently:\n` +
      differ.map((chain) => `  ${chain}: bun.lock ${bun.get(chain) ?? "none"}, package-lock.json ${npm.get(chain) ?? "none"}\n`).join("") +
      "Make bun.lock follow package-lock.json: delete bun.lock and run `bun install --lockfile-only`, which builds " +
      "it from package-lock.json, so both pin the same versions.",
  );
  return 1;
}

process.exitCode = main();
