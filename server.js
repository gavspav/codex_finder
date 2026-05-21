#!/usr/bin/env node

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(
  process.env.CODEX_FINDER_ROOT || path.join(os.homedir(), "Documents", "Codex"),
);
const PORT = Number(process.env.CODEX_FINDER_PORT || process.env.PORT || 4821);
const CODEX_CLI =
  process.env.CODEX_CLI || "/Applications/Codex.app/Contents/Resources/codex";
const STATIC_DIR = path.join(__dirname, "public");
const STATE_FILE = path.join(__dirname, ".codex-finder-state.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    };
  } catch {
    return { favorites: [] };
  }
}

async function writeState(state) {
  const cleanState = {
    favorites: Array.from(new Set(state.favorites || [])).filter(Boolean).sort(),
  };
  await fs.writeFile(STATE_FILE, `${JSON.stringify(cleanState, null, 2)}\n`, "utf8");
  return cleanState;
}

function slugToTitle(slug) {
  const titled = slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bI\b/g, "I");

  return titled
    .replace(/\bI M\b/g, "I'm")
    .replace(/\bI Ve\b/g, "I've")
    .replace(/\bI Ll\b/g, "I'll")
    .replace(/\bCan T\b/g, "Can't")
    .replace(/\bDon T\b/g, "Don't")
    .replace(/\bYou Re\b/g, "You're")
    .replace(/\bWe Re\b/g, "We're");
}

function encodeId(value) {
  return Buffer.from(value).toString("base64url");
}

function markerForFile(name) {
  const lower = name.toLowerCase();
  if (lower === "package.json") return "Node";
  if (lower === "readme.md" || lower === "readme.txt") return "Readme";
  if (lower === "pyproject.toml" || lower === "requirements.txt") return "Python";
  if (lower === "cargo.toml") return "Rust";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv")) {
    return "Data";
  }
  if (lower.endsWith(".pptx") || lower.endsWith(".key")) return "Slides";
  if (lower.endsWith(".docx") || lower.endsWith(".pdf")) return "Docs";
  return null;
}

async function inspectProject(projectPath, projectStat) {
  const markers = new Set();
  let latestMs = projectStat.mtimeMs;
  let fileCount = 0;
  let dirCount = 0;
  let scanned = 0;
  const queue = [{ dir: projectPath, depth: 0 }];

  while (queue.length > 0 && scanned < 600) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scanned >= 600) break;
      scanned += 1;

      if (entry.name === ".git") {
        markers.add("Git");
        continue;
      }

      if (entry.name.startsWith(".") && entry.name !== ".codex") {
        continue;
      }

      const entryPath = path.join(current.dir, entry.name);
      let entryStat;
      try {
        entryStat = await fs.stat(entryPath);
      } catch {
        continue;
      }

      latestMs = Math.max(latestMs, entryStat.mtimeMs);

      if (entry.isDirectory()) {
        dirCount += 1;
        if (current.depth < 2) {
          queue.push({ dir: entryPath, depth: current.depth + 1 });
        }
      } else {
        fileCount += 1;
        const marker = markerForFile(entry.name);
        if (marker) markers.add(marker);
      }
    }
  }

  return {
    fileCount,
    dirCount,
    latestMs,
    markers: Array.from(markers).slice(0, 4),
    scanTruncated: scanned >= 600,
  };
}

async function projectFromPath(projectPath, dateFolder = null) {
  const stat = await fs.stat(projectPath);
  const inspection = await inspectProject(projectPath, stat);
  const folder = path.basename(projectPath);
  const relativePath = path.relative(ROOT, projectPath);

  return {
    id: encodeId(projectPath),
    title: slugToTitle(folder) || folder,
    folder,
    path: projectPath,
    relativePath,
    date: dateFolder,
    createdMs: stat.birthtimeMs,
    modifiedMs: stat.mtimeMs,
    latestMs: inspection.latestMs,
    fileCount: inspection.fileCount,
    dirCount: inspection.dirCount,
    markers: inspection.markers,
    scanTruncated: inspection.scanTruncated,
  };
}

async function scanProjects() {
  if (!(await pathExists(ROOT))) {
    throw new Error(`Codex root does not exist: ${ROOT}`);
  }

  const rootEntries = await fs.readdir(ROOT, { withFileTypes: true });
  const dateDirs = rootEntries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  const projects = [];

  for (const dateEntry of dateDirs) {
    const datePath = path.join(ROOT, dateEntry.name);
    let children = [];
    try {
      children = await fs.readdir(datePath, { withFileTypes: true });
    } catch {
      continue;
    }

    const projectDirs = children
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    const dateProjects = await Promise.all(
      projectDirs.map((entry) => projectFromPath(path.join(datePath, entry.name), dateEntry.name)),
    );
    projects.push(...dateProjects);
  }

  const nonDateProjects = rootEntries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const rootProjects = await Promise.all(
    nonDateProjects.map((entry) => projectFromPath(path.join(ROOT, entry.name), null)),
  );
  projects.push(...rootProjects);

  return projects.sort((a, b) => b.latestMs - a.latestMs);
}

async function requireProjectPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("A project path is required");
  }

  const targetPath = path.resolve(rawPath);
  if (!isInside(ROOT, targetPath)) {
    throw new Error("Project path is outside the configured Codex root");
  }

  const stat = await fs.stat(targetPath);
  if (!stat.isDirectory()) {
    throw new Error("Project path is not a folder");
  }

  return targetPath;
}

async function launchDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openInCodex(targetPath) {
  if (await pathExists(CODEX_CLI)) {
    await launchDetached(CODEX_CLI, ["app", targetPath]);
    return { command: CODEX_CLI, args: ["app", targetPath] };
  }

  await launchDetached("open", ["-a", "Codex", targetPath]);
  return { command: "open", args: ["-a", "Codex", targetPath] };
}

async function revealInFinder(targetPath) {
  await launchDetached("open", ["-R", targetPath]);
  return { command: "open", args: ["-R", targetPath] };
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        root: ROOT,
        codexCli: CODEX_CLI,
        codexCliAvailable: await pathExists(CODEX_CLI),
        version: "0.1.0",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/projects") {
      const [projects, state] = await Promise.all([scanProjects(), readState()]);
      const favoriteSet = new Set(state.favorites);
      return sendJson(res, 200, {
        root: ROOT,
        count: projects.length,
        favorites: state.favorites,
        projects: projects.map((project) => ({
          ...project,
          favorite: favoriteSet.has(project.path),
        })),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, await readState());
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      const body = await readJsonBody(req);
      const targetPath = await requireProjectPath(body.path);
      const launch = await openInCodex(targetPath);
      return sendJson(res, 200, { ok: true, path: targetPath, launch });
    }

    if (req.method === "POST" && url.pathname === "/api/reveal") {
      const body = await readJsonBody(req);
      const targetPath = await requireProjectPath(body.path);
      const launch = await revealInFinder(targetPath);
      return sendJson(res, 200, { ok: true, path: targetPath, launch });
    }

    if (req.method === "POST" && url.pathname === "/api/favorite") {
      const body = await readJsonBody(req);
      const targetPath = await requireProjectPath(body.path);
      const state = await readState();
      const favorites = new Set(state.favorites);
      if (body.favorite === false) {
        favorites.delete(targetPath);
      } else {
        favorites.add(targetPath);
      }
      return sendJson(res, 200, await writeState({ favorites: Array.from(favorites) }));
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, "Bad request");
  }

  const staticPath = path.resolve(path.join(STATIC_DIR, decodedPath));
  if (!isInside(STATIC_DIR, staticPath)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const stat = await fs.stat(staticPath);
    if (!stat.isFile()) {
      return sendText(res, 404, "Not found");
    }

    const ext = path.extname(staticPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fsSync.createReadStream(staticPath).pipe(res);
  } catch {
    return sendText(res, 404, "Not found");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Codex Finder running at http://127.0.0.1:${PORT}`);
  console.log(`Scanning ${ROOT}`);
});
