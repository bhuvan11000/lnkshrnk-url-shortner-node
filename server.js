/**
 * lnkshrnk — URL shortener (Node.js port)
 * Express + SQLite (node:sqlite) + nanoid, single-file backend.
 *
 * Routes:
 *   POST /api/shorten  -> create short code (auto nanoid or custom)
 *   GET  /api/stats/{code} -> stats for a code
 *   GET  /{code} -> 307 redirect + click counting (or static file fallback)
 *   GET  /health -> liveness probe (used by Render / local)
 *   GET  /api/recent -> last N mappings
 *
 * DB: SQLite (shortener.db) — single DatabaseSync instance.
 * Table `urls` holds code (PK), original, clicks, created_at.
 *
 * Spec notes preserved:
 *   - Custom code regex ^[A-Za-z0-9_-]{3,20}$ and reserved set {api,admin,static,favicon.ico}
 *   - Dedup by original URL when no custom code supplied
 *   - nanoid(size=6) with 5 collision retries
 *   - StaticFiles mount AFTER redirect route (spec requirement) + dot-file fallback
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { customAlphabet } = require("nanoid");

// ---------------------------------------------------------------------------
// Logging & config
// ---------------------------------------------------------------------------

const LOG_LEVEL = (process.env.LOG_LEVEL || "INFO").toUpperCase();
const levelMap = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = levelMap[LOG_LEVEL] ?? 1;
function log(level, ...args) {
  if ((levelMap[level] ?? 1) >= currentLevel) {
    const ts = new Date().toISOString();
    console.log(`${ts} ${level} ${args.join(" ")}`);
  }
}
const logger = {
  debug: (...a) => log("DEBUG", ...a),
  info: (...a) => log("INFO", ...a),
  warn: (...a) => log("WARN", ...a),
  error: (...a) => log("ERROR", ...a),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DB_PATH || "shortener.db";
const RESERVED_CODES = new Set(["api", "admin", "static", "favicon.ico"]);
const CUSTOM_CODE_RE = /^[A-Za-z0-9_-]{3,20}$/;
const NANOID_SIZE = 6;
const NANOID_RETRIES = 5;
const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;

// nanoid generator with same alphabet and size as Python
const nanoidGenerate = customAlphabet(NANOID_ALPHABET, NANOID_SIZE);

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let db;

function initDb() {
  db = new DatabaseSync(DB_PATH);
  // WAL mode improves concurrent reads (best-effort)
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA foreign_keys=ON;");
  } catch (_) {
    // ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS urls (
      code       TEXT PRIMARY KEY,
      original   TEXT NOT NULL,
      clicks     INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_urls_original ON urls(original)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_urls_created_at ON urls(created_at)");
  logger.debug(`DB initialised at ${DB_PATH}`);
}

function dbHealthcheck() {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch (_) {
    return false;
  }
}

// init on import
initDb();
logger.info(`lnkshrnk started — DB=${DB_PATH} reserved=${[...RESERVED_CODES].sort().join(",")}`);

// ---------------------------------------------------------------------------
// Validation helpers — extracted for testability
// ---------------------------------------------------------------------------

function isValidUrl(url) {
  if (typeof url !== "string") return false;
  url = url.trim();
  if (!(url.startsWith("http://") || url.startsWith("https://"))) return false;
  const remainder = url.split("://")[1] || "";
  return remainder.length > 0 && (remainder.includes(".") || remainder === "localhost" || remainder.includes("/") || remainder.length >= 3);
}

function normalizeCustom(custom) {
  if (custom === undefined || custom === null) return null;
  if (typeof custom !== "string") return null;
  custom = custom.trim();
  return custom !== "" ? custom : null;
}

function validateCustomCode(code) {
  if (!CUSTOM_CODE_RE.test(code)) {
    return "Custom code must be 3-20 characters and contain only letters, numbers, hyphen or underscore";
  }
  if (RESERVED_CODES.has(code.toLowerCase())) {
    return `'${code}' is a reserved word and cannot be used as a custom code`;
  }
  return null;
}

function buildShortUrl(req, code) {
  const host = `${req.protocol}://${req.get("host")}`;
  return `${host.replace(/\/$/, "")}/${code}`;
}

function fetchExistingCodeForUrl(url) {
  try {
    const row = db.prepare("SELECT code FROM urls WHERE original = ? LIMIT 1").get(url);
    return row ? row.code : null;
  } catch (exc) {
    logger.warn(`dedup lookup failed: ${exc.message}`);
    const err = new Error("Database error");
    err.status = 500;
    throw err;
  }
}

function tryInsertCode(code, original) {
  try {
    db.prepare("INSERT INTO urls (code, original) VALUES (?, ?)").run(code, original);
  } catch (exc) {
    const msg = String(exc.message).toLowerCase();
    // SQLite constraint error for primary key
    if (msg.includes("unique") || msg.includes("constraint") || msg.includes("primary")) {
      const err = new Error("Custom code already taken");
      err.status = 409;
      throw err;
    }
    logger.error(`insert failed for code=${code}: ${exc.message}`);
    const err = new Error("Database error");
    err.status = 500;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", true);
app.use(express.json());

// ---------------------------------------------------------------------------
// Utility routes — health & recent
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  const ok = dbHealthcheck();
  res.json({ status: ok ? "ok" : "degraded", db: ok ? "up" : "down", ts: Math.floor(Date.now() / 1000) });
});

app.get("/api/health", (_req, res) => {
  const ok = dbHealthcheck();
  res.json({ status: ok ? "ok" : "degraded", db: ok ? "up" : "down", ts: Math.floor(Date.now() / 1000) });
});

app.get("/api/recent", (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit)) limit = DEFAULT_RECENT_LIMIT;
  limit = Math.max(1, Math.min(limit, MAX_RECENT_LIMIT));
  try {
    const rows = db.prepare("SELECT code, original, clicks, created_at FROM urls ORDER BY created_at DESC LIMIT ?").all(limit);
    res.json(rows.map((r) => ({ code: r.code, original: r.original, clicks: r.clicks, created_at: r.created_at })));
  } catch {
    res.status(500).json({ detail: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// API routes — must be defined BEFORE the catch-all redirect & static mount
// ---------------------------------------------------------------------------

app.post("/api/shorten", (req, res) => {
  const { url, custom: rawCustom } = req.body || {};

  // 1. Validate URL scheme + basic host check
  if (!isValidUrl(url)) {
    // Keep original error phrasing for backwards compat
    return res.status(400).json({ detail: "URL must start with http:// or https://" });
  }

  // 2. Validate & normalize custom code if provided
  let custom = normalizeCustom(rawCustom);
  if (custom !== null) {
    const err = validateCustomCode(custom);
    if (err) {
      return res.status(400).json({ detail: err });
    }
  } else {
    custom = null;
  }

  try {
    // 3. Dedup: if this exact original URL already exists, return existing code
    if (custom === null) {
      const existing = fetchExistingCodeForUrl(url);
      if (existing) {
        return res.json({ short: buildShortUrl(req, existing) });
      }
    }

    // 4. Custom code path
    if (custom !== null) {
      try {
        tryInsertCode(custom, url);
      } catch (e) {
        const status = e.status || 500;
        return res.status(status).json({ detail: e.message });
      }
      return res.json({ short: buildShortUrl(req, custom) });
    }

    // 5. Auto-generated nanoid path with collision retry
    let lastError = null;
    for (let i = 0; i < NANOID_RETRIES; i++) {
      const code = nanoidGenerate();
      try {
        db.prepare("INSERT INTO urls (code, original) VALUES (?, ?)").run(code, url);
        return res.json({ short: buildShortUrl(req, code) });
      } catch (exc) {
        const msg = String(exc.message).toLowerCase();
        if (msg.includes("unique") || msg.includes("constraint") || msg.includes("primary")) {
          lastError = exc;
          logger.debug(`nanoid collision for ${code}, retrying`);
          continue;
        }
        logger.error(`db error during nanoid insert: ${exc.message}`);
        return res.status(500).json({ detail: "Database error" });
      }
    }

    logger.error(`nanoid exhaustion after ${NANOID_RETRIES} retries, last_error=${lastError ? lastError.message : "unknown"}`);
    return res.status(500).json({ detail: "Failed to generate unique code, please try again" });
  } catch (e) {
    if (e.status) {
      return res.status(e.status).json({ detail: e.message });
    }
    logger.error(`shorten failed: ${e.message}`);
    return res.status(500).json({ detail: "Database error" });
  }
});

app.get("/api/stats/:code", (req, res) => {
  const { code } = req.params;
  try {
    const row = db.prepare("SELECT code, original, clicks, created_at FROM urls WHERE code = ?").get(code);
    if (!row) {
      return res.status(404).json({ detail: "Short code not found" });
    }
    return res.json({ code: row.code, original: row.original, clicks: row.clicks, created_at: row.created_at });
  } catch (exc) {
    logger.error(`stats lookup failed for ${code}: ${exc.message}`);
    return res.status(500).json({ detail: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Redirect route — registered AFTER all /api/* routes to avoid
// shadowing them. NOTE: Static serving below is defined AFTER this route
// (per spec), so requests for real files like /style.css would otherwise
// hit this handler first. To avoid that, we detect file-like codes
// (containing a dot) and serve the static file directly, letting the
// static middleware handle "/" and fallback cases.
// ---------------------------------------------------------------------------

app.get("/:code", (req, res) => {
  const { code } = req.params;

  // If code looks like a file (contains a dot), try to serve it from public/ directly
  if (code.includes(".")) {
    // Security: prevent directory traversal — only allow direct files in public/.
    if (code.includes("/") || code.includes("\\") || code.startsWith(".")) {
      return res.status(404).json({ detail: "Not Found" });
    }
    const filePath = path.join(__dirname, "public", code);
    try {
      const resolved = path.resolve(filePath);
      const publicResolved = path.resolve(path.join(__dirname, "public"));
      if (!resolved.startsWith(publicResolved)) {
        return res.status(404).json({ detail: "Not Found" });
      }
    } catch {
      return res.status(404).json({ detail: "Not Found" });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return res.sendFile(filePath);
    }
    return res.status(404).json({ detail: "Not Found" });
  }

  try {
    const row = db.prepare("SELECT original FROM urls WHERE code = ?").get(code);
    if (!row) {
      return res.status(404).json({ detail: "Short code not found" });
    }

    // Increment clicks (best-effort, non-fatal if it fails)
    try {
      db.prepare("UPDATE urls SET clicks = clicks + 1 WHERE code = ?").run(code);
    } catch (exc) {
      logger.warn(`click increment failed for ${code}: ${exc.message}`);
    }

    return res.redirect(307, row.original);
  } catch (exc) {
    logger.error(`redirect lookup failed for ${code}: ${exc.message}`);
    return res.status(500).json({ detail: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Static files — mounted AFTER all API routes and the redirect route
// (per spec) using express.static(directory="public").
// Serves index.html for "/" and any remaining static assets.
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

// Fallback for "/" handled by static; for SPA-like fallback, ensure index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 404 handler for unknown API routes
app.use((req, res) => {
  // If request was for an API route not matched, return JSON 404
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ detail: "Not Found" });
  }
  // For other routes, try to serve index.html if exists, else 404
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    return res.status(404).sendFile(indexPath);
  }
  return res.status(404).json({ detail: "Not Found" });
});

// ---------------------------------------------------------------------------
// Deployment notes (same as Python version)
// ---------------------------------------------------------------------------
// Runtime:       Node.js 18+
// Build command: npm install
// Start command: node server.js  or  npm start  (uses $PORT)
//
// Free tier caveats:
// - Filesystem is ephemeral and resets on redeploy — SQLite data will NOT
//   persist across deploys. Acceptable for now; migrate to Postgres/Redis
//   for persistence if needed.
// - Service sleeps after ~15 min of inactivity; first request after sleep
//   takes ~30-50 s to wake (cold start).

const PORT = parseInt(process.env.PORT || "8000", 10);

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`lnkshrnk listening on 0.0.0.0:${PORT}`);
  });
}

module.exports = app;
