#!/usr/bin/env node
/**
 * scan-projects.js — Scan a local folder for projects and add them to Project Hub.
 *
 * Usage:
 *   node scripts/scan-projects.js <folder-path> [--group "Group Name"] [--dry-run]
 *
 * Examples:
 *   node scripts/scan-projects.js C:/Users/jesse/projects
 *   node scripts/scan-projects.js C:/Users/jesse/projects --group "Side Projects"
 *   node scripts/scan-projects.js C:/Users/jesse/projects --dry-run
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const API = "https://project-hub-api.jesse-topcalroofing.workers.dev";

// --- Argument parsing ---
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--group" && args[i + 1]) { flags.group = args[++i]; }
  else if (args[i] === "--dry-run") { flags.dryRun = true; }
  else if (args[i] === "--help" || args[i] === "-h") { flags.help = true; }
  else { positional.push(args[i]); }
}

if (flags.help || positional.length === 0) {
  console.log(`
  scan-projects.js — Scan a folder for projects and add them to Project Hub.

  Usage:
    node scripts/scan-projects.js <folder-path> [options]

  Options:
    --group "Name"   Set the group name for all discovered projects
    --dry-run        Show what would be added without actually adding
    -h, --help       Show this help

  The scanner looks for: package.json, wrangler.toml, Cargo.toml,
  go.mod, pyproject.toml, requirements.txt, .git, and more.
  `);
  process.exit(0);
}

const scanDir = path.resolve(positional[0]);

// --- Project detection ---

const HOST_DETECTORS = [
  { file: "wrangler.toml", host: "Cloudflare", icon: "☁️" },
  { file: "wrangler.jsonc", host: "Cloudflare", icon: "☁️" },
  { file: "vercel.json", host: "Vercel", icon: "▲" },
  { file: "netlify.toml", host: "Netlify", icon: "◆" },
  { file: ".vercel", host: "Vercel", icon: "▲", isDir: true },
  { file: ".netlify", host: "Netlify", icon: "◆", isDir: true },
];

const PROJECT_MARKERS = [
  "package.json",
  "wrangler.toml",
  "wrangler.jsonc",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "composer.json",
  "Gemfile",
  "build.gradle",
  "pom.xml",
  "CMakeLists.txt",
  "Makefile",
  ".sln",
];

function hasMarker(dir) {
  for (const marker of PROJECT_MARKERS) {
    const p = path.join(dir, marker);
    try { if (fs.statSync(p)) return true; } catch {}
  }
  // Also check for .git directory
  try { if (fs.statSync(path.join(dir, ".git")).isDirectory()) return true; } catch {}
  return false;
}

function detectProject(dir) {
  const name = path.basename(dir);
  const info = {
    name,
    description: "",
    group_name: flags.group || "Ungrouped",
    icon: "📁",
    host: "",
    url: `file:///${dir.replace(/\\/g, "/")}`,
    deps: "",
    notes: "",
    status: "active",
  };

  // Detect host from config files
  for (const det of HOST_DETECTORS) {
    const target = path.join(dir, det.file);
    try {
      const stat = fs.statSync(target);
      if (det.isDir ? stat.isDirectory() : stat.isFile()) {
        info.host = det.host;
        info.icon = det.icon;
        break;
      }
    } catch {}
  }

  // Try to read package.json for richer metadata
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.name && !info.name) info.name = pkg.name;
    if (pkg.description) info.description = pkg.description;
    if (pkg.homepage) info.url = pkg.homepage;

    // Extract key deps
    const allDeps = Object.keys(pkg.dependencies || {});
    const keyDeps = allDeps.filter(d =>
      /^(react|vue|svelte|next|nuxt|angular|express|hono|fastify|astro|remix|vite|wrangler|tailwindcss|prisma|drizzle)/.test(d)
    );
    if (keyDeps.length) info.deps = keyDeps.join(", ");

    // Better icon based on framework
    if (!info.host) {
      if (allDeps.includes("next")) { info.icon = "▲"; info.host = "Vercel"; }
      else if (allDeps.includes("wrangler")) { info.icon = "☁️"; info.host = "Cloudflare"; }
      else if (allDeps.includes("astro")) info.icon = "🚀";
      else if (allDeps.includes("react")) info.icon = "⚛️";
      else if (allDeps.includes("vue")) info.icon = "💚";
      else if (allDeps.includes("svelte")) info.icon = "🔥";
      else if (allDeps.includes("express") || allDeps.includes("hono") || allDeps.includes("fastify")) info.icon = "⚡";
    }
  } catch {}

  // Try to read wrangler.toml for worker name
  try {
    const wrangler = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8");
    const nameMatch = wrangler.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) info.name = nameMatch[1];
  } catch {}

  // Try Cargo.toml
  try {
    const cargo = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) info.name = nameMatch[1];
    info.icon = "🦀";
  } catch {}

  // Try go.mod
  try {
    const gomod = fs.readFileSync(path.join(dir, "go.mod"), "utf8");
    const modMatch = gomod.match(/^module\s+(\S+)/m);
    if (modMatch) info.name = modMatch[1].split("/").pop();
    info.icon = "🐹";
  } catch {}

  // Try pyproject.toml
  try {
    const pyproj = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8");
    const nameMatch = pyproj.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) info.name = nameMatch[1];
    info.icon = "🐍";
  } catch {}

  // Try to get git remote URL
  try {
    const gitConfig = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    const remoteMatch = gitConfig.match(/url\s*=\s*(\S+)/);
    if (remoteMatch) {
      let remote = remoteMatch[1];
      // Convert SSH to HTTPS for display
      remote = remote.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
      info.url = remote;
    }
  } catch {}

  return info;
}

// --- Main ---

async function main() {
  if (!fs.existsSync(scanDir)) {
    console.error(`Error: Directory not found: ${scanDir}`);
    process.exit(1);
  }

  console.log(`\nScanning: ${scanDir}\n`);

  // Get all subdirectories (one level deep)
  const entries = fs.readdirSync(scanDir, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map(e => path.join(scanDir, e.name));

  const discovered = [];
  for (const dir of dirs) {
    if (hasMarker(dir)) {
      discovered.push(detectProject(dir));
    }
  }

  if (discovered.length === 0) {
    console.log("No projects found in that directory.");
    process.exit(0);
  }

  // Fetch existing projects to avoid duplicates
  let existing = [];
  try {
    const res = await fetch(API + "/projects");
    existing = await res.json();
  } catch {
    console.log("Warning: Could not reach API to check for duplicates.\n");
  }
  const existingNames = new Set(existing.map(p => p.name.toLowerCase()));

  // Display results
  console.log(`Found ${discovered.length} project(s):\n`);
  console.log("  #  Status     Name                           Host            Group");
  console.log("  -  ------     ----                           ----            -----");

  discovered.forEach((p, i) => {
    const isDupe = existingNames.has(p.name.toLowerCase());
    const status = isDupe ? "EXISTS" : "NEW   ";
    const num = String(i + 1).padStart(3);
    const name = p.name.padEnd(30).slice(0, 30);
    const host = (p.host || "-").padEnd(15).slice(0, 15);
    console.log(`  ${num}  ${status}  ${p.icon} ${name} ${host} ${p.group_name}`);
  });

  const newProjects = discovered.filter(p => !existingNames.has(p.name.toLowerCase()));
  console.log(`\n  ${newProjects.length} new, ${discovered.length - newProjects.length} already in hub.\n`);

  if (newProjects.length === 0) {
    console.log("Nothing new to add.");
    process.exit(0);
  }

  if (flags.dryRun) {
    console.log("--dry-run: No changes made.\n");
    console.log("Details of new projects:\n");
    newProjects.forEach(p => {
      console.log(`  ${p.icon} ${p.name}`);
      console.log(`    Description: ${p.description || "(none)"}`);
      console.log(`    URL:         ${p.url}`);
      console.log(`    Host:        ${p.host || "(none)"}`);
      console.log(`    Deps:        ${p.deps || "(none)"}`);
      console.log(`    Group:       ${p.group_name}`);
      console.log();
    });
    process.exit(0);
  }

  // Confirm with user
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`Add ${newProjects.length} new project(s) to Project Hub? (y/n) `, resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    process.exit(0);
  }

  // Send to API
  try {
    const res = await fetch(API + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    // Use individual POST calls since /seed doesn't return IDs cleanly
    let added = 0;
    for (const p of newProjects) {
      const res = await fetch(API + "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (res.ok) {
        added++;
        console.log(`  ✓ Added: ${p.name}`);
      } else {
        console.log(`  ✗ Failed: ${p.name} (${res.status})`);
      }
    }
    console.log(`\nDone! Added ${added}/${newProjects.length} projects.\n`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
