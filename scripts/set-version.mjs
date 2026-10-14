// Stamps a release version (from the git tag) into every file that carries one.
// Usage: node scripts/set-version.mjs v1.2.3
import fs from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
// SemVer, as Cargo requires: optional -prerelease and +build metadata.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a release version: ${process.argv[2]}`);
  process.exit(1);
}

const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
conf.version = version;
fs.writeFileSync("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n");

let cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
cargo = cargo.replace(/^version = "[^"]*"/m, `version = "${version}"`);
fs.writeFileSync("src-tauri/Cargo.toml", cargo);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = version;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// pacman versions can't contain '-' (it separates pkgver from pkgrel).
let pkgbuild = fs.readFileSync("packaging/arch/PKGBUILD", "utf8");
pkgbuild = pkgbuild.replace(/^pkgver=.*$/m, `pkgver=${version.replaceAll("-", "_")}`);
fs.writeFileSync("packaging/arch/PKGBUILD", pkgbuild);

console.log("Version set to", version);
