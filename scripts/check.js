#!/usr/bin/env node
/**
 * Pemeriksaan statis proyek:
 *  1. Syntax seluruh file JavaScript (node --check)
 *  2. Validitas file JSON
 *  3. Encoding: BOM & mojibake (mis. "â†’", "ðŸ“") di file teks
 *  4. Secret: API key Groq / token di file yang akan masuk Git
 *  5. File sensitif (.env, sesi WhatsApp) tidak ter-track Git
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".vercel", ".wwebjs_auth", ".wwebjs_cache", "test-results"]);
let failures = 0;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function fail(message) {
  failures++;
  console.log(`  ✖ ${message}`);
}

const rel = file => path.relative(ROOT, file).replace(/\\/g, "/");
const files = walk(ROOT).filter(f => !/\.backup$/.test(f));

console.log("1. Syntax JavaScript");
const jsFiles = files.filter(f => f.endsWith(".js"));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    fail(`${rel(file)}: ${error.stderr.toString().split("\n").slice(0, 4).join(" ")}`);
  }
}
console.log(`  ${jsFiles.length} file diperiksa`);

console.log("2. Validitas JSON");
const jsonFiles = files.filter(f => f.endsWith(".json"));
for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    fail(`${rel(file)}: ${error.message}`);
  }
}
console.log(`  ${jsonFiles.length} file diperiksa`);

console.log("3. Encoding (BOM & mojibake)");
const textFiles = files.filter(f => /\.(js|json|html|css|md|example)$/.test(f) || f.endsWith(".env.example"));
// Pola UTF-8 yang terbaca sebagai Windows-1252, mis. "â†’", "â€œ", "ðŸ“", "Ã©"
const MOJIBAKE = /(â[\u0080-¿‘-›€Œ-Ÿˆ˜]|ð[Ÿ\u0080-¿]|Ã[\u0080-¿‘-›])/;
for (const file of textFiles) {
  const content = fs.readFileSync(file, "utf8");
  if (content.charCodeAt(0) === 0xfeff && !file.endsWith(".csv")) fail(`${rel(file)}: diawali BOM`);
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (MOJIBAKE.test(line) && !rel(file).startsWith("scripts/check.js")) {
      fail(`${rel(file)}:${i + 1}: karakter rusak -> ${line.trim().slice(0, 80)}`);
    }
  });
}
console.log(`  ${textFiles.length} file diperiksa`);

console.log("4. Secret di file yang bisa masuk Git");
let gitFiles = [];
try {
  gitFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT })
    .toString()
    .split("\n")
    .filter(Boolean);
} catch {
  console.log("  (git tidak tersedia, dilewati)");
}
const SECRET_PATTERNS = [
  /gsk_[A-Za-z0-9]{20,}/, // Groq API key
  /VERCEL_OIDC_TOKEN\s*=\s*\S{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
for (const file of gitFiles) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
  const content = fs.readFileSync(full, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) fail(`${file}: mengandung pola secret ${pattern}`);
  }
}
console.log(`  ${gitFiles.length} file diperiksa`);

console.log("5. File sensitif tidak masuk Git");
const forbidden = gitFiles.filter(f =>
  /^\.env($|\.)/.test(path.basename(f)) && path.basename(f) !== ".env.example" ||
  f.startsWith(".wwebjs_auth/") ||
  f.startsWith(".wwebjs_cache/") ||
  f.startsWith(".vercel/")
);
forbidden.forEach(f => fail(`${f} akan ikut ter-commit`));

console.log(failures ? `\nGAGAL: ${failures} masalah ditemukan.` : "\nSemua pemeriksaan statis lulus.");
process.exit(failures ? 1 : 0);
