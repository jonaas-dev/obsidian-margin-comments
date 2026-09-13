import { readFileSync, writeFileSync } from "node:fs";

// Run by `npm version` through the "version" script, after package.json holds the new
// version and before npm commits and tags it, so the tag carries all three files.
const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("version-bump.mjs: run through `npm version`, which sets npm_package_version.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);

// Obsidian offers an older release to an app below the newest one's minAppVersion by
// reading this map, so no version ever loses its entry.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
