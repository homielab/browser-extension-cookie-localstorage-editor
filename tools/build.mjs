#!/usr/bin/env node
/**
 * Build the extension into dist/: a minified, unpacked copy that can be loaded
 * straight into a browser, and the zip that is uploaded to the Web Store.
 *
 * Everything under src/ ships; nothing else does. JavaScript and CSS are
 * minified with esbuild, HTML with the small conservative minifier below, JSON
 * is compacted, and anything else (icons) is copied as-is. Each file is
 * minified on its own rather than bundled, so the scripts keep sharing their
 * globals (`CookieUtils`, `Api`) exactly as they do when loaded from src/.
 *
 * Usage:  bun run build
 *         node tools/build.mjs --out ~/Desktop   # somewhere other than dist/
 *         node tools/build.mjs --no-minify       # readable output, for debugging
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { transform } from "esbuild";
import { zipSync } from "fflate";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, "src");

/**
 * Oldest browsers the manifest allows (`minimum_chrome_version`, gecko
 * `strict_min_version`); esbuild must not emit newer syntax. Read from the
 * manifest so the two cannot drift apart.
 */
function targets(manifest) {
  const chrome = parseInt(manifest.minimum_chrome_version, 10);
  const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
  const firefox = parseInt(gecko && gecko.strict_min_version, 10);
  if (!chrome || !firefox) fail("the manifest must set minimum_chrome_version and gecko.strict_min_version");
  return [`chrome${chrome}`, `firefox${firefox}`];
}

/** Icon sizes the Web Store expects the manifest to declare. */
const ICON_SIZES = ["16", "32", "48", "128"];

/** A store package must stay under this size. */
const LIMIT_BYTES = 2 * 1024 * 1024;

/** A fixed timestamp keeps the archive byte-for-byte reproducible. */
const ZIP_MTIME = new Date(1980, 0, 1);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------- checks -- */

/** The handful of manifest rules the Web Store enforces. */
function checkManifest(manifest) {
  const problems = [];

  const name = manifest.name || "";
  if (!name || name.length > 45) problems.push(`name must be 1-45 characters (is ${name.length})`);

  const description = manifest.description || "";
  if (!description || description.length > 132) {
    problems.push(`description must be 1-132 characters (is ${description.length})`);
  }

  const version = manifest.version || "";
  const parts = version.split(".");
  const validPart = (part) => /^\d+$/.test(part) && Number(part) <= 65535;
  if (parts.length < 1 || parts.length > 4 || !parts.every(validPart)) {
    problems.push(`version "${version}" is not one to four dot-separated integers`);
  }

  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");

  const icons = { ...manifest.icons, ...(manifest.action && manifest.action.default_icon) };
  for (const size of ICON_SIZES) {
    if (!icons[size]) problems.push(`no ${size}x${size} icon`);
  }

  if (problems.length) fail(`manifest: ${problems.join("; ")}`);
}

/**
 * Version in package.json, which `bun version` bumps, must match the manifest.
 * @returns {object} package.json, whose name the build output is named after
 */
function checkVersions(manifest) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.version !== manifest.version) {
    fail(`package.json is at ${pkg.version} but src/manifest.json is at ${manifest.version}`);
  }
  return pkg;
}

/** Every file the manifest and the HTML pages point at, relative to src/. */
function referencedFiles(manifest, files) {
  const refs = new Set();
  const icons = { ...manifest.icons, ...(manifest.action && manifest.action.default_icon) };
  Object.values(icons).forEach((icon) => refs.add(path.posix.normalize(icon)));
  if (manifest.action && manifest.action.default_popup) refs.add(manifest.action.default_popup);

  for (const file of files.filter((name) => name.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const [, url] of html.matchAll(/\s(?:src|href)="([^"#:]+)"/g)) {
      refs.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), url)));
    }
  }
  return refs;
}

/* --------------------------------------------------------- minifiers -- */

/** Tags whose neighbouring whitespace never renders, so it can go entirely. */
const BLOCK_TAGS = new Set(
  (
    "html head body meta link title script style template div header footer main section " +
    "p h1 h2 h3 form select option datalist svg symbol path use textarea ul ol li"
  ).split(" ")
);

/** Tags whose contents are whitespace-sensitive and must pass through untouched. */
const RAW_TAGS = new Set(["pre", "textarea", "script", "style"]);

/**
 * Conservative HTML minifier: drops comments, collapses whitespace inside tags
 * and in text to a single space, and removes whitespace only where it sits
 * next to a block-level tag. Whitespace between inline elements (`<kbd>N</kbd>
 * new`) is kept as one space, so nothing renders differently.
 */
function minifyHtml(html) {
  const tokens = html.replace(/<!--(?!\[)[\s\S]*?-->/g, "").split(/(<[^>]+>)/);
  const tagName = (token) => (/^<\/?([a-zA-Z][\w-]*)/.exec(token) || [])[1]?.toLowerCase();
  const isBlock = (token) => token !== undefined && BLOCK_TAGS.has(tagName(token));

  const out = [];
  let raw = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (raw) {
      if (token.startsWith("</") && tagName(token) === raw) raw = null;
      out.push(token);
      continue;
    }

    if (token.startsWith("<")) {
      out.push(token.startsWith("<!") ? token : collapseTag(token));
      const name = tagName(token);
      if (!token.startsWith("</") && RAW_TAGS.has(name) && !token.endsWith("/>")) raw = name;
      continue;
    }

    if (/^\s+$/.test(token)) {
      const prev = out[out.length - 1];
      const next = tokens.slice(i + 1).find(Boolean);
      if (prev === undefined || isBlock(prev) || isBlock(next)) continue;
    }
    out.push(token.replace(/\s+/g, " "));
  }
  return out.join("").trim() + "\n";
}

/** Collapse whitespace inside a tag, leaving quoted attribute values alone. */
function collapseTag(tag) {
  let result = "";
  let quote = null;
  for (const char of tag) {
    if (quote) {
      if (char === quote) quote = null;
      result += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      result += char;
    } else if (/\s/.test(char)) {
      if (!result.endsWith(" ")) result += " ";
    } else {
      result += char;
    }
  }
  return result.replace(/\s+(\/?>)$/, "$1");
}

async function processFile(name, minify, target) {
  const source = fs.readFileSync(path.join(SRC, name));
  if (!minify) return source;

  const ext = path.extname(name);
  const text = () => source.toString("utf8");
  if (ext === ".js" || ext === ".css") {
    const result = await transform(text(), {
      loader: ext.slice(1),
      minify: true,
      target,
      legalComments: "none",
      charset: "utf8",
    });
    return Buffer.from(result.code);
  }
  if (ext === ".html") return Buffer.from(minifyHtml(text()));
  if (ext === ".json") return Buffer.from(JSON.stringify(JSON.parse(text())));
  return source;
}

/* ------------------------------------------------------------- build -- */

/** Every file under src/, as sorted forward-slash paths relative to it. */
function sourceFiles(dir = SRC) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(full) : [path.relative(SRC, full).split(path.sep).join("/")];
    })
    .sort();
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

async function main() {
  const { values: args } = parseArgs({
    options: {
      out: { type: "string", default: path.join(ROOT, "dist") },
      "no-minify": { type: "boolean", default: false },
    },
  });
  const minify = !args["no-minify"];

  const manifestPath = path.join(SRC, "manifest.json");
  if (!fs.existsSync(manifestPath)) fail("src/manifest.json not found");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  checkManifest(manifest);
  const pkg = checkVersions(manifest);

  const buildTargets = targets(manifest);
  const files = sourceFiles();
  const missing = [...referencedFiles(manifest, files)].filter((ref) => !files.includes(ref));
  if (missing.length) fail(`referenced but missing from src/: ${missing.sort().join(", ")}`);

  const outDir = path.resolve(args.out);
  const unpacked = path.join(outDir, `${pkg.name}-${manifest.version}`);
  const zipPath = `${unpacked}.zip`;
  fs.rmSync(unpacked, { recursive: true, force: true });

  const entries = {};
  const rows = [];
  for (const name of files) {
    const before = fs.statSync(path.join(SRC, name)).size;
    const output = await processFile(name, minify, buildTargets);
    fs.mkdirSync(path.dirname(path.join(unpacked, name)), { recursive: true });
    fs.writeFileSync(path.join(unpacked, name), output);
    entries[name] = [new Uint8Array(output), { mtime: ZIP_MTIME }];
    rows.push([name, before, output.length]);
  }

  const zip = zipSync(entries, { level: 9 });
  if (zip.length > LIMIT_BYTES) fail(`${zipPath} is ${zip.length} bytes, over the ${LIMIT_BYTES} byte limit`);
  fs.writeFileSync(zipPath, zip);

  const width = Math.max(...rows.map(([name]) => name.length));
  const totalBefore = rows.reduce((sum, [, before]) => sum + before, 0);
  const totalAfter = rows.reduce((sum, [, , after]) => sum + after, 0);
  console.log(path.relative(process.cwd(), unpacked) || unpacked);
  for (const [name, before, after] of rows) {
    const saved = before === after ? "" : `  −${Math.round((1 - after / before) * 100)}%`;
    console.log(`  ${name.padEnd(width)}  ${kib(before).padStart(9)} → ${kib(after).padStart(9)}${saved}`);
  }
  console.log(`  ${"total".padEnd(width)}  ${kib(totalBefore).padStart(9)} → ${kib(totalAfter).padStart(9)}`);
  console.log(path.relative(process.cwd(), zipPath) || zipPath);
  console.log(`  ${files.length} files, ${kib(zip.length)}${minify ? "" : " (not minified)"}`);
  console.log(`  sha256 ${createHash("sha256").update(zip).digest("hex")}`);
}

main().catch((error) => fail(error.message));
