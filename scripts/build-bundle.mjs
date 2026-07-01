#!/usr/bin/env node
/**
 * Build logos-bundle zip + manifest.json for GitHub Releases.
 * Usage: node scripts/build-bundle.mjs --version 1.0.0 [--out dist]
 */
import { createHash } from "node:crypto";
import {
  createWriteStream,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGOS_DIR = path.join(ROOT, "logos");
const MANIFESTS_DIR = path.join(ROOT, "manifests");

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".jfif", ".pjpeg", ".webp", ".gif", ".bmp", ".dib",
  ".ico", ".cur", ".svg", ".svgz", ".avif", ".heic", ".heif", ".tif", ".tiff",
  ".apng", ".xbm", ".xpm", ".jp2", ".j2k", ".jpx", ".jxl",
]);

const GITHUB_REPO = "vunf1/Stream_Futebol_Artifacts";

function parseArgs(argv) {
  let version = "";
  let outDir = path.join(ROOT, "dist");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--version" && argv[i + 1]) {
      version = argv[++i];
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("Usage: build-bundle.mjs --version MAJOR.MINOR.PATCH [--out dist]");
    process.exit(1);
  }
  return { version, outDir };
}

/** @returns {{ major: number, minor: number, patch: number } | null} */
export function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** True when `a` is strictly less than `b`. */
export function semverLt(a, b) {
  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  return a.patch < b.patch;
}

/** @returns {{ name: string, abs: string, sha256: string }[]} */
export function listLogoFiles(logosDir) {
  if (!statSync(logosDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`logos directory missing: ${logosDir}`);
  }
  const entries = readdirSync(logosDir, { withFileTypes: true });
  const files = [];
  const seenLower = new Set();

  for (const ent of entries) {
    if (!ent.isFile()) {
      throw new Error(`nested paths not allowed: ${ent.name}`);
    }
    const name = ent.name;
    if (name.startsWith("._") || name.startsWith(".")) continue;
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      throw new Error(`duplicate basename (case-insensitive): ${name}`);
    }
    seenLower.add(lower);
    const abs = path.join(logosDir, name);
    const bytes = readFileSync(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.push({ name, abs, sha256 });
  }

  files.sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (files.length === 0) {
    throw new Error("logos/ has no image files");
  }
  return files;
}

/** @param {{ name: string, sha256: string }[]} files */
export function contentFingerprint(files) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const lines = sorted.map((f) => `${f.name}:${f.sha256}`);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/**
 * @param {{ name: string, sha256: string }[]} previousFiles
 * @param {{ name: string, sha256: string }[]} currentFiles
 */
export function buildChangelog(previousFiles, currentFiles, previousVersion) {
  const prevByLower = new Map(
    previousFiles.map((f) => [f.name.toLowerCase(), f]),
  );
  const currByLower = new Map(
    currentFiles.map((f) => [f.name.toLowerCase(), f]),
  );

  const added = [];
  const updated = [];

  for (const file of currentFiles) {
    const prev = prevByLower.get(file.name.toLowerCase());
    if (!prev) {
      added.push(file.name);
    } else if (prev.sha256 !== file.sha256) {
      updated.push(file.name);
    }
  }

  const removed = [];
  for (const file of previousFiles) {
    if (!currByLower.has(file.name.toLowerCase())) {
      removed.push(file.name);
    }
  }

  added.sort((a, b) => a.localeCompare(b, "en"));
  updated.sort((a, b) => a.localeCompare(b, "en"));
  removed.sort((a, b) => a.localeCompare(b, "en"));

  return {
    previous_version: previousVersion ?? null,
    added,
    updated,
    removed,
  };
}

/** @returns {{ version: string, files: { name: string, sha256: string }[] } | null} */
export function loadPreviousManifestSnapshot(version, manifestsDir = MANIFESTS_DIR) {
  const current = parseSemver(version);
  if (!current) return null;
  if (!statSync(manifestsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return null;
  }

  let bestVersion = null;
  let bestParsed = null;

  for (const ent of readdirSync(manifestsDir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const candidate = ent.name.replace(/\.json$/i, "");
    const parsed = parseSemver(candidate);
    if (!parsed || !semverLt(parsed, current)) continue;
    if (!bestParsed || semverLt(bestParsed, parsed)) {
      bestParsed = parsed;
      bestVersion = candidate;
    }
  }

  if (!bestVersion) return null;

  const raw = JSON.parse(
    readFileSync(path.join(manifestsDir, `${bestVersion}.json`), "utf8"),
  );
  if (!raw || !Array.isArray(raw.files)) return null;
  return { version: bestVersion, files: raw.files };
}

function zipFlat(files, zipPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    out.on("close", () => resolve(archive.pointer()));
    archive.on("error", reject);
    out.on("error", reject);
    archive.pipe(out);
    for (const f of files) {
      archive.file(f.abs, { name: f.name });
    }
    archive.finalize();
  });
}

export async function buildBundle({
  version,
  outDir,
  logosDir = LOGOS_DIR,
  manifestsDir = MANIFESTS_DIR,
}) {
  const files = listLogoFiles(logosDir);
  await mkdir(outDir, { recursive: true });
  await mkdir(manifestsDir, { recursive: true });

  const zipName = `logos-bundle-${version}.zip`;
  const zipPath = path.join(outDir, zipName);
  await zipFlat(files, zipPath);

  const zipBytes = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(zipBytes).digest("hex");
  const fingerprint = contentFingerprint(files);
  const manifestFiles = files.map(({ name, sha256: fileSha }) => ({
    name,
    sha256: fileSha,
  }));

  const previous = loadPreviousManifestSnapshot(version, manifestsDir);
  const changelog = previous
    ? buildChangelog(previous.files, manifestFiles, previous.version)
    : {
        previous_version: null,
        added: manifestFiles.map((f) => f.name),
        updated: [],
        removed: [],
      };

  const tag = `v${version}`;
  const manifest = {
    schema: 1,
    version,
    published_at: new Date().toISOString(),
    bundle_url: `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${zipName}`,
    sha256,
    content_fingerprint: fingerprint,
    size_bytes: zipBytes.length,
    file_count: files.length,
    files: manifestFiles,
    changelog,
  };

  const manifestPath = path.join(outDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const shaPath = path.join(outDir, `${zipName}.sha256`);
  await writeFile(shaPath, `${sha256}  ${zipName}\n`, "utf8");

  const snapshotPath = path.join(manifestsDir, `${version}.json`);
  await writeFile(
    snapshotPath,
    `${JSON.stringify({ version, files: manifestFiles }, null, 2)}\n`,
    "utf8",
  );

  return { manifest, zipPath, manifestPath, shaPath, snapshotPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, outDir } = parseArgs(process.argv);
  buildBundle({ version, outDir })
    .then(({ manifest, zipPath, manifestPath, snapshotPath }) => {
      console.log(`[build-bundle] ${manifest.file_count} files → ${zipPath}`);
      console.log(`[build-bundle] manifest → ${manifestPath}`);
      console.log(`[build-bundle] snapshot → ${snapshotPath}`);
      console.log(`[build-bundle] sha256=${manifest.sha256}`);
      if (manifest.changelog) {
        const c = manifest.changelog;
        console.log(
          `[build-bundle] changelog: +${c.added.length} ~${c.updated.length} -${c.removed.length}`,
        );
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
