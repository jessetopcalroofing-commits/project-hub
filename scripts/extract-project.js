#!/usr/bin/env node
/**
 * extract-project.js — Point at a project folder, extract everything, add/update in Project Hub.
 *
 * Deep-scans a single project directory for:
 *   - Name, description, dependencies (package.json, Cargo.toml, go.mod, etc.)
 *   - Host platform (wrangler.toml, vercel.json, netlify.toml, etc.)
 *   - Git remote URL, repo links
 *   - Cloudflare credentials (.env, .dev.vars, wrangler.toml)
 *   - All URLs found in config files (pages, routes, domains)
 *   - README links
 *   - Live URLs from deployment configs
 *
 * Usage:
 *   node scripts/extract-project.js <folder-path> [options]
 *
 * Options:
 *   --group "Name"    Set the group name
 *   --update          Update existing project if name matches (instead of creating new)
 *   --dry-run         Show what would be extracted without saving
 *   -h, --help        Show help
 *
 * Examples:
 *   node scripts/extract-project.js C:/Users/jesse/Downloads/cloudflare/campaign-phonebank
 *   node scripts/extract-project.js ./my-project --group "Side Projects"
 *   node scripts/extract-project.js ./my-project --update --dry-run
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
  if (args[i] === "--group" && args[i + 1]) flags.group = args[++i];
  else if (args[i] === "--update") flags.update = true;
  else if (args[i] === "--dry-run") flags.dryRun = true;
  else if (args[i] === "--help" || args[i] === "-h") flags.help = true;
  else positional.push(args[i]);
}

if (flags.help || positional.length === 0) {
  console.log(`
  extract-project.js — Extract project metadata from a folder and add/update in Project Hub.

  Usage:
    node scripts/extract-project.js <folder-path> [options]

  Options:
    --group "Name"   Set the group name for the project
    --update         Update existing project if name matches
    --dry-run        Show extraction results without saving
    -h, --help       Show this help
  `);
  process.exit(0);
}

const projectDir = path.resolve(positional[0]);

// --- Helpers ---
function readFile(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function dirExists(dirPath) {
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

// Extract URLs from text (http/https only)
function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s"'`<>\]\)},]+/g) || [];
  return [...new Set(matches.map(u => u.replace(/[.,;:]+$/, "")))];
}

// --- Extractors ---

function extractPackageJson(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return {};
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const depNames = Object.keys(allDeps);

  const keyDeps = depNames.filter(d =>
    /^(react|vue|svelte|next|nuxt|angular|express|hono|fastify|astro|remix|vite|wrangler|tailwindcss|prisma|drizzle|d1|better-sqlite3|turso)/.test(d)
  );

  let host = "";
  if (depNames.includes("wrangler") || pkg.scripts?.deploy?.includes("wrangler")) host = "Cloudflare Pages";
  else if (depNames.includes("next") || depNames.includes("vercel")) host = "Vercel";
  else if (depNames.includes("netlify-cli")) host = "Netlify";

  return {
    name: pkg.name || null,
    description: pkg.description || null,
    deps: keyDeps.length ? keyDeps.join(", ") : null,
    homepage: pkg.homepage || null,
    repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || null,
    host,
    scripts: pkg.scripts || {},
  };
}

function extractWranglerToml(dir) {
  const content = readFile(path.join(dir, "wrangler.toml")) || readFile(path.join(dir, "wrangler.jsonc"));
  if (!content) return {};

  const result = { host: "Cloudflare" };
  const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
  if (nameMatch) result.workerName = nameMatch[1];

  // Detect Pages vs Worker
  if (content.includes("[site]") || content.includes("pages_build_output")) {
    result.host = "Cloudflare Pages";
  }

  // Extract routes/domains
  const routes = [];
  const routeMatches = content.matchAll(/route\s*=\s*"([^"]+)"/g);
  for (const m of routeMatches) routes.push(m[1]);
  const patternMatches = content.matchAll(/pattern\s*=\s*"([^"]+)"/g);
  for (const m of patternMatches) routes.push(m[1]);
  if (routes.length) result.routes = routes;

  // Extract D1 database bindings
  if (content.includes("d1_databases") || content.includes("D1")) {
    result.hasD1 = true;
    const dbNameMatch = content.match(/database_name\s*=\s*"([^"]+)"/);
    if (dbNameMatch) result.d1Database = dbNameMatch[1];
    const dbIdMatch = content.match(/database_id\s*=\s*"([^"]+)"/);
    if (dbIdMatch) result.d1DatabaseId = dbIdMatch[1];
  }

  // Extract KV namespaces
  if (content.includes("kv_namespaces")) {
    result.hasKV = true;
  }

  // Extract vars
  const varMatches = content.matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm);
  const vars = {};
  for (const m of varMatches) {
    if (!["name", "main", "compatibility_date", "account_id"].includes(m[1])) {
      vars[m[1]] = m[2];
    }
  }
  if (Object.keys(vars).length) result.vars = vars;

  // Account ID
  const accountMatch = content.match(/account_id\s*=\s*"([^"]+)"/);
  if (accountMatch) result.accountId = accountMatch[1];

  return result;
}

function extractEnvFiles(dir) {
  const creds = {};
  const envFiles = [".env", ".env.local", ".env.production", ".dev.vars"];

  for (const envFile of envFiles) {
    const content = readFile(path.join(dir, envFile));
    if (!content) continue;

    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^["']|["']$/g, "");
        // Only grab credential-like keys
        if (/token|key|secret|password|api_key|auth|credential/i.test(key)) {
          creds[key] = val;
        }
        // Cloudflare-specific
        if (/^(CF_|CLOUDFLARE_|ACCOUNT_ID)/i.test(key)) {
          creds[key] = val;
        }
      }
    }
  }
  return creds;
}

function extractGitInfo(dir) {
  const result = {};
  const gitConfig = readFile(path.join(dir, ".git", "config"));
  if (!gitConfig) return result;

  const remoteMatch = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(\S+)/);
  if (remoteMatch) {
    let remote = remoteMatch[1];
    remote = remote.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
    result.repoUrl = remote;

    // Derive GitHub pages URL if applicable
    const ghMatch = remote.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (ghMatch) {
      result.githubUser = ghMatch[1];
      result.githubRepo = ghMatch[2];
    }
  }

  // Current branch
  const headRef = readFile(path.join(dir, ".git", "HEAD"));
  if (headRef) {
    const branchMatch = headRef.match(/ref: refs\/heads\/(\S+)/);
    if (branchMatch) result.branch = branchMatch[1];
  }

  return result;
}

function extractReadmeLinks(dir) {
  const readmeNames = ["README.md", "readme.md", "README.MD", "README", "README.txt"];
  for (const name of readmeNames) {
    const content = readFile(path.join(dir, name));
    if (!content) continue;

    const links = [];
    // Extract markdown links: [label](url)
    const mdLinks = content.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g);
    for (const m of mdLinks) {
      const label = m[1].trim();
      const url = m[2].trim();
      // Filter out badge/shield URLs
      if (!url.includes("shields.io") && !url.includes("badge") && !url.includes("img.shields")) {
        links.push({ label, url });
      }
    }

    // Also extract plain URLs with context
    const lines = content.split("\n");
    for (const line of lines) {
      const urls = extractUrls(line);
      for (const url of urls) {
        if (!links.some(l => l.url === url) && !url.includes("shields.io") && !url.includes("badge")) {
          // Try to get a label from the line context
          const cleanLine = line.replace(/[#*\-\[\]()]/g, "").trim();
          const label = cleanLine.length < 60 ? cleanLine : new URL(url).hostname;
          links.push({ label: label || url, url });
        }
      }
    }

    return links;
  }
  return [];
}

function extractVercelConfig(dir) {
  const vercel = readJson(path.join(dir, "vercel.json"));
  if (!vercel) return {};
  return {
    host: "Vercel",
    projectName: vercel.name || null,
  };
}

function extractNetlifyConfig(dir) {
  const content = readFile(path.join(dir, "netlify.toml"));
  if (!content) return {};
  return { host: "Netlify" };
}

function extractDeployedUrls(dir) {
  const urls = [];

  // Check for .pages.dev URLs in wrangler output or config
  const wrangler = readFile(path.join(dir, "wrangler.toml"));
  if (wrangler) {
    const pagesUrls = wrangler.match(/[\w-]+\.pages\.dev/g);
    if (pagesUrls) pagesUrls.forEach(u => urls.push("https://" + u));

    const workerUrls = wrangler.match(/[\w-]+\.workers\.dev/g);
    if (workerUrls) workerUrls.forEach(u => urls.push("https://" + u));
  }

  // Check for CNAME or custom domains
  const cname = readFile(path.join(dir, "CNAME"));
  if (cname) urls.push("https://" + cname.trim());

  // Check for deployment URLs in common output files
  const deployFiles = [".vercel/project.json", ".netlify/state.json"];
  for (const f of deployFiles) {
    const data = readJson(path.join(dir, f));
    if (data) {
      if (data.orgId) urls.push(`https://vercel.com`);
      if (data.siteId) urls.push(`https://app.netlify.com/sites/${data.siteId}`);
    }
  }

  return [...new Set(urls)];
}

function findSubProjects(dir) {
  // Look for worker/, api/, frontend/ subdirs that have their own configs
  const subDirs = ["worker", "api", "backend", "server", "frontend", "web", "app", "packages"];
  const subs = [];

  for (const sub of subDirs) {
    const subPath = path.join(dir, sub);
    if (!dirExists(subPath)) continue;

    const hasConfig = fileExists(path.join(subPath, "wrangler.toml")) ||
                      fileExists(path.join(subPath, "package.json")) ||
                      fileExists(path.join(subPath, "vercel.json"));
    if (hasConfig) {
      subs.push({ name: sub, path: subPath });
    }
  }
  return subs;
}

// --- ICON DETECTION ---
function detectIcon(info) {
  if (info.host?.includes("Cloudflare")) return "☁️";
  if (info.host === "Vercel") return "▲";
  if (info.host === "Netlify") return "◆";
  if (info.deps?.includes("react")) return "⚛️";
  if (info.deps?.includes("vue")) return "💚";
  if (info.language === "rust") return "🦀";
  if (info.language === "go") return "🐹";
  if (info.language === "python") return "🐍";
  return "📦";
}

// --- Main extraction ---
function extractProject(dir) {
  console.log(`\n  Scanning: ${dir}\n`);

  const dirName = path.basename(dir);
  const pkg = extractPackageJson(dir);
  const wrangler = extractWranglerToml(dir);
  const envCreds = extractEnvFiles(dir);
  const git = extractGitInfo(dir);
  const readmeLinks = extractReadmeLinks(dir);
  const vercel = extractVercelConfig(dir);
  const netlify = extractNetlifyConfig(dir);
  const deployedUrls = extractDeployedUrls(dir);
  const subProjects = findSubProjects(dir);

  // Also scan sub-projects for extra data
  const subData = {};
  for (const sub of subProjects) {
    const subWrangler = extractWranglerToml(sub.path);
    const subPkg = extractPackageJson(sub.path);
    const subEnv = extractEnvFiles(sub.path);
    subData[sub.name] = { wrangler: subWrangler, pkg: subPkg, env: subEnv };
  }

  // --- Assemble project ---
  const name = pkg.name || wrangler.workerName || dirName;
  const description = pkg.description || "";
  const host = wrangler.host || pkg.host || vercel.host || netlify.host || "";
  const url = git.repoUrl || pkg.homepage || (deployedUrls.length ? deployedUrls[0] : `file:///${dir.replace(/\\/g, "/")}`);

  // Build deps list including sub-project tech
  let deps = pkg.deps || "";
  if (wrangler.hasD1) deps += (deps ? ", " : "") + "D1 SQLite";
  if (wrangler.hasKV) deps += (deps ? ", " : "") + "KV";
  for (const [subName, sd] of Object.entries(subData)) {
    if (sd.wrangler.host) deps += (deps ? ", " : "") + `${sd.wrangler.host} (${subName})`;
    if (sd.pkg.deps) deps += (deps ? ", " : "") + sd.pkg.deps;
  }
  // Deduplicate
  deps = [...new Set(deps.split(", ").filter(Boolean))].join(", ");

  // Build links from README, deployed URLs, sub-projects
  const links = [];

  // Deployed URLs as links
  for (const dUrl of deployedUrls) {
    const label = dUrl.includes("workers.dev") ? "Worker" :
                  dUrl.includes("pages.dev") ? "Pages" :
                  new URL(dUrl).hostname;
    if (!links.some(l => l.url === dUrl)) {
      links.push({ label, url: dUrl });
    }
  }

  // Git repo link
  if (git.repoUrl && !links.some(l => l.url === git.repoUrl)) {
    links.push({ label: "GitHub Repo", url: git.repoUrl });
  }

  // Wrangler routes
  if (wrangler.routes) {
    for (const route of wrangler.routes) {
      const rUrl = route.startsWith("http") ? route : "https://" + route.replace(/\/\*$/, "");
      if (!links.some(l => l.url === rUrl)) {
        links.push({ label: "Route: " + route, url: rUrl });
      }
    }
  }

  // README links (filtered)
  for (const rl of readmeLinks.slice(0, 10)) {
    if (!links.some(l => l.url === rl.url)) {
      links.push(rl);
    }
  }

  // Sub-project worker URLs
  for (const [subName, sd] of Object.entries(subData)) {
    if (sd.wrangler.workerName) {
      const workerUrl = `https://${sd.wrangler.workerName}.workers.dev`;
      if (!links.some(l => l.url === workerUrl)) {
        links.push({ label: `${subName} worker`, url: workerUrl });
      }
    }
  }

  // Cloudflare credentials
  let cf_user = null;
  let cf_token = null;
  const allCreds = { ...envCreds };
  for (const sd of Object.values(subData)) {
    Object.assign(allCreds, sd.env);
  }

  if (allCreds.CF_API_TOKEN || allCreds.CLOUDFLARE_API_TOKEN) {
    cf_token = allCreds.CF_API_TOKEN || allCreds.CLOUDFLARE_API_TOKEN;
  }
  if (allCreds.CF_EMAIL || allCreds.CLOUDFLARE_EMAIL) {
    cf_user = allCreds.CF_EMAIL || allCreds.CLOUDFLARE_EMAIL;
  }
  if (wrangler.accountId && !cf_user) {
    cf_user = `account:${wrangler.accountId}`;
  }

  // Build notes from interesting findings
  const notes = [];
  if (wrangler.workerName) notes.push(`Worker: ${wrangler.workerName}`);
  if (wrangler.d1Database) notes.push(`D1 DB: ${wrangler.d1Database} (${wrangler.d1DatabaseId || "?"})`);
  if (subProjects.length) notes.push(`Sub-projects: ${subProjects.map(s => s.name).join(", ")}`);
  if (git.branch && git.branch !== "main" && git.branch !== "master") notes.push(`Branch: ${git.branch}`);

  // Extra credentials (non-CF) as notes
  const extraCreds = Object.entries(allCreds).filter(([k]) =>
    !k.startsWith("CF_") && !k.startsWith("CLOUDFLARE_")
  );
  if (extraCreds.length) {
    notes.push("Credentials found:");
    for (const [k, v] of extraCreds) {
      notes.push(`  ${k}=${v.slice(0, 20)}${v.length > 20 ? "..." : ""}`);
    }
  }

  const project = {
    name,
    description,
    group_name: flags.group || "Ungrouped",
    icon: detectIcon({ host, deps, language: null }),
    host,
    url,
    live_url: deployedUrls[0] || null,
    cf_user,
    cf_token,
    deps: deps || null,
    notes: notes.length ? notes.join("\n") : null,
    status: "active",
    links: links.length ? JSON.stringify(links) : null,
  };

  return { project, links, allCreds, subProjects, deployedUrls, readmeLinks };
}

// --- Display ---
function displayResults(result) {
  const { project, links, allCreds, subProjects } = result;

  console.log("  ┌─────────────────────────────────────────────────────");
  console.log(`  │  ${project.icon}  ${project.name}`);
  console.log("  ├─────────────────────────────────────────────────────");
  console.log(`  │  Description:  ${project.description || "(none)"}`);
  console.log(`  │  Group:        ${project.group_name}`);
  console.log(`  │  Host:         ${project.host || "(none)"}`);
  console.log(`  │  URL:          ${project.url}`);
  if (project.live_url) console.log(`  │  Live URL:     ${project.live_url}`);
  console.log(`  │  Status:       ${project.status}`);
  console.log(`  │  Dependencies: ${project.deps || "(none)"}`);
  console.log("  │");

  if (links.length) {
    console.log(`  │  Links (${links.length}):`);
    for (const l of links) {
      console.log(`  │    → ${l.label}: ${l.url}`);
    }
    console.log("  │");
  }

  if (project.cf_user || project.cf_token) {
    console.log("  │  Cloudflare:");
    if (project.cf_user) console.log(`  │    Account: ${project.cf_user}`);
    if (project.cf_token) console.log(`  │    Token:   ${project.cf_token.slice(0, 16)}...`);
    console.log("  │");
  }

  const credCount = Object.keys(allCreds).length;
  if (credCount) {
    console.log(`  │  Credentials found (${credCount}):`);
    for (const [k, v] of Object.entries(allCreds)) {
      console.log(`  │    ${k} = ${v.slice(0, 24)}${v.length > 24 ? "..." : ""}`);
    }
    console.log("  │");
  }

  if (subProjects.length) {
    console.log(`  │  Sub-projects: ${subProjects.map(s => s.name).join(", ")}`);
    console.log("  │");
  }

  if (project.notes) {
    console.log("  │  Notes:");
    for (const line of project.notes.split("\n")) {
      console.log(`  │    ${line}`);
    }
    console.log("  │");
  }

  console.log("  └─────────────────────────────────────────────────────\n");
}

// --- Main ---
async function main() {
  if (!fs.existsSync(projectDir)) {
    console.error(`  Error: Directory not found: ${projectDir}`);
    process.exit(1);
  }

  const result = extractProject(projectDir);
  displayResults(result);

  if (flags.dryRun) {
    console.log("  --dry-run: No changes made.\n");
    process.exit(0);
  }

  // Check for existing project
  let existing = [];
  try {
    const res = await fetch(API + "/projects");
    existing = await res.json();
  } catch {
    console.log("  Warning: Could not reach API.\n");
  }

  const match = existing.find(p => p.name.toLowerCase() === result.project.name.toLowerCase());

  if (match && !flags.update) {
    console.log(`  Project "${match.name}" already exists (ID ${match.id}).`);
    console.log(`  Use --update to update it, or change the name.\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question("  Update existing project? (y/n) ", resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log("  Cancelled.\n");
      process.exit(0);
    }
    flags.update = true;
  }

  if (match && flags.update) {
    // Merge: keep existing values if new value is empty
    const merged = { ...result.project };
    if (!merged.cf_user && match.cf_user) merged.cf_user = match.cf_user;
    if (!merged.cf_token && match.cf_token) merged.cf_token = match.cf_token;
    if (!merged.description && match.description) merged.description = match.description;
    if (merged.group_name === "Ungrouped" && match.group_name) merged.group_name = match.group_name;
    if (!merged.live_url && match.live_url) merged.live_url = match.live_url;

    // Merge links
    try {
      const existingLinks = JSON.parse(match.links || "[]");
      const newLinks = JSON.parse(merged.links || "[]");
      const allLinks = [...existingLinks];
      for (const nl of newLinks) {
        if (!allLinks.some(l => l.url === nl.url)) allLinks.push(nl);
      }
      merged.links = allLinks.length ? JSON.stringify(allLinks) : null;
    } catch {}

    // Merge notes
    if (match.notes && merged.notes) {
      merged.notes = merged.notes + "\n---\n" + match.notes;
    } else if (match.notes) {
      merged.notes = match.notes;
    }

    const res = await fetch(`${API}/projects/${match.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged),
    });

    if (res.ok) {
      console.log(`  ✓ Updated project: ${merged.name} (ID ${match.id})\n`);
    } else {
      console.log(`  ✗ Failed to update: ${res.status}\n`);
    }
  } else {
    // Create new
    const res = await fetch(API + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.project),
    });

    if (res.ok) {
      const created = await res.json();
      console.log(`  ✓ Created project: ${result.project.name} (ID ${created.id})\n`);
    } else {
      console.log(`  ✗ Failed to create: ${res.status}\n`);
    }
  }
}

main();
