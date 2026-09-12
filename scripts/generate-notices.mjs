#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md: the license texts of every third-party
// package that ends up inside the shipped app — Rust crates compiled into the
// binary (plus the C libraries some of them vendor) and the npm packages
// bundled into the frontend. Run `pnpm notices` after changing dependencies.
//
// Deliberately over-inclusive: it follows normal (non-build, non-dev)
// dependency edges for every target platform, so a crate used only on one OS
// is still listed. Listing extra notices is harmless; missing one is not.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "THIRD_PARTY_NOTICES.md");

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

// C sources vendored inside -sys crates. Their licenses aren't reflected in
// the crate's own license field, so they're listed by hand.
const VENDORED_C = {
  "libgit2-sys": [["libgit2", "libgit2/COPYING"]],
  "openssl-src": [["OpenSSL", "openssl/LICENSE.txt"]],
  "libssh2-sys": [["libssh2", "libssh2/COPYING"]],
  "libz-sys": [["zlib", "src/zlib/LICENSE"]],
};

// npm packages we ship only a stylesheet from; their own dependencies (for
// shadcn, an entire CLI) never reach the bundle.
const CSS_ONLY = new Set(["shadcn"]);

function licenseFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => path.join(dir, f));
}

// For packages offered under a choice that includes MIT ("MIT OR Apache-2.0",
// "Apache-2.0/MIT", ...) we elect MIT and ship only its text (plus any NOTICE).
// Otherwise the file would carry hundreds of near-identical Apache-2.0 copies.
function electMit(license, files) {
  const alternatives = license.split(/\s+OR\s+|\//).map((s) => s.trim());
  if (alternatives.length < 2 || !alternatives.includes("MIT")) return files;
  const mit = files.filter((f) => /mit/i.test(path.basename(f)));
  if (!mit.length) return files;
  return [...mit, ...files.filter((f) => /notice/i.test(path.basename(f)))];
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
}

// ---- Rust -----------------------------------------------------------------

function rustPackages() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--manifest-path", path.join(root, "src-tauri/Cargo.toml")],
      { maxBuffer: 1 << 28, encoding: "utf8" },
    ),
  );
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const isProcMacro = (p) => p.targets.some((t) => t.kind.includes("proc-macro"));

  const seen = new Set();
  const queue = [meta.resolve.root];
  while (queue.length) {
    const id = queue.shift();
    for (const dep of nodes.get(id).deps) {
      if (seen.has(dep.pkg)) continue;
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue; // build/dev edge
      if (isProcMacro(pkgs.get(dep.pkg))) continue; // runs at compile time only
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }

  const entries = [];
  for (const id of seen) {
    const p = pkgs.get(id);
    const dir = path.dirname(p.manifest_path);
    const files = licenseFiles(dir);
    if (p.license_file) files.push(path.resolve(dir, p.license_file));
    const license = p.license ?? "see license file";
    entries.push({
      name: p.name,
      version: p.version,
      license,
      url: `https://crates.io/crates/${p.name}/${p.version}`,
      files: electMit(license, [...new Set(files)]),
    });
  }

  // Vendored C libraries are compiled into the binary even when their crate is
  // only a build-dependency (openssl-src), so look at the whole resolved graph.
  for (const { id } of meta.resolve.nodes) {
    const p = pkgs.get(id);
    for (const [label, rel] of VENDORED_C[p.name] ?? []) {
      const file = path.join(path.dirname(p.manifest_path), rel);
      if (!fs.existsSync(file)) throw new Error(`vendored license missing: ${file}`);
      entries.push({
        name: `${label} (vendored in ${p.name})`,
        version: p.version,
        license: "see license text",
        url: `https://crates.io/crates/${p.name}/${p.version}`,
        files: [file],
      });
    }
  }
  return entries;
}

// ---- npm ------------------------------------------------------------------

// Node-style lookup: walk up from `fromDir` looking for node_modules/<name>.
// Works with pnpm's layout because we start from each package's real path.
function resolvePackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

function npmPackages() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const seen = new Map();
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => [name, root]);
  while (queue.length) {
    const [name, from] = queue.shift();
    const dir = resolvePackageDir(name, from);
    if (!dir) continue; // uninstalled optional dependency
    if (seen.has(dir)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    seen.set(dir, pkg);
    if (CSS_ONLY.has(name)) continue;
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      queue.push([dep, dir]);
    }
  }

  return [...seen].map(([dir, pkg]) => {
    const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "see license file");
    return {
      name: pkg.name,
      version: pkg.version,
      license,
      url: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      files: electMit(license, licenseFiles(dir)),
    };
  });
}

// ---- output ---------------------------------------------------------------

function render(title, entries) {
  // Group packages that ship byte-identical license texts so each text
  // appears once.
  const groups = new Map();
  for (const e of entries) {
    const text = e.files.map(readText).join("\n\n---\n\n");
    const key = text ? createHash("sha256").update(text.replace(/\s+/g, " ")).digest("hex") : `none:${e.license}`;
    if (!groups.has(key)) groups.set(key, { text, license: e.license, members: [] });
    groups.get(key).members.push(e);
  }

  const sorted = [...groups.values()].sort(
    (a, b) => a.license.localeCompare(b.license) || a.members[0].name.localeCompare(b.members[0].name),
  );
  let md = `## ${title}\n\n`;
  for (const g of sorted) {
    g.members.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
    const who = g.members.map((m) => `[${m.name} ${m.version}](${m.url})`).join(", ");
    md += `### ${g.license}\n\nUsed by: ${who}\n\n`;
    md += g.text
      ? `\`\`\`\`text\n${g.text}\n\`\`\`\`\n\n`
      : `_No license file is included in the published package. Its declared license is \`${g.license}\`; see the package page for the full terms._\n\n`;
  }
  return md;
}

const rust = rustPackages();
const npm = npmPackages();

const header = `# Third-party notices

Waypoint itself is released under the MIT License (see \`LICENSE\`). The
application also includes the third-party software listed below, each under
its own license. Packages that ship identical license texts are grouped.

Linux AppImage builds additionally bundle system libraries (GTK 3,
WebKitGTK, GLib, libsoup and their dependencies), most of them under the
LGPL 2.1 or later. Source for those libraries is available from their
upstream projects and from any Linux distribution that packages them.

This file is generated by \`pnpm notices\` (\`scripts/generate-notices.mjs\`).
Do not edit it by hand.

`;

fs.writeFileSync(out, header + render("Rust crates", rust) + render("JavaScript packages", npm).trimEnd() + "\n");
console.log(`Wrote ${path.relative(root, out)}: ${rust.length} Rust entries, ${npm.length} npm packages.`);
