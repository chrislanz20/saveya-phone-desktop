import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

// Persistent, append-only log for the desktop shell.
//
// Until now every recovery decision (reloads, cache wipes, relaunches, health
// checks) only ever went to the console — which nobody sees on a staffer's
// machine and which vanishes with the process. When something odd happens on
// a receptionist's desk mid-morning, there is currently zero forensic trail
// to reconstruct what the shell actually did. This module fixes that: a tiny
// hand-rolled file logger, deliberately NOT a new npm dependency (the app's
// only runtime dep is electron-updater and we want to keep the supply-chain
// surface that small).
//
// Design constraints, in priority order:
//   1. Logging must NEVER crash or stall the shell. Every fs call is wrapped;
//      any failure silently degrades to console-only.
//   2. Bounded disk use. Size-rotate at ~1MB to a single .log.1 sibling, so
//      the hard cap is ~2MB no matter how long the app runs.
//   3. Greppable. One line per event: `<ISO8601> [level] <msg>`.
//   4. No PII. Callers must never pass caller names/numbers or URLs with
//      query strings — this module doesn't sanitize, the call sites do.
//
// appendFileSync is intentional: log volume is a handful of lines per hour
// (recovery events, not request traffic), so a synchronous append is cheap
// and guarantees the line hits disk before a relaunch/exit tears us down —
// exactly the moments we most need captured.

const LOG_DIR_NAME = "logs";
const LOG_FILE_NAME = "saveya-desktop.log";
// Rotate when the live file crosses this. Checked before each append, so the
// file can overshoot by one line at most.
const MAX_LOG_BYTES = 1024 * 1024;

type LogLevel = "info" | "warn" | "error";

// Resolved lazily (and re-tried on every write if it failed) because
// app.getPath("userData") is valid before app.ready but could still throw in
// exotic startup states — and mkdir can fail on a full/read-only disk.
let logFilePath: string | null = null;

function ensureLogFile(): string | null {
  if (logFilePath) return logFilePath;
  try {
    const dir = path.join(app.getPath("userData"), LOG_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, LOG_FILE_NAME);
    return logFilePath;
  } catch {
    return null; // console mirror still works; try again next write
  }
}

// Single-generation rotation: current -> .log.1, previous .log.1 dropped.
// One old file is enough to cover "what happened yesterday" without turning
// a staffer's userData dir into a log archive.
function rotateIfNeeded(file: string): void {
  try {
    const { size } = fs.statSync(file);
    if (size < MAX_LOG_BYTES) return;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* stat fails when the file doesn't exist yet — nothing to rotate */
  }
}

function write(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  // Mirror to the console first — dev runs and terminal-launched sessions
  // keep the live view they've always had.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  const file = ensureLogFile();
  if (!file) return;
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Best effort — a failed append must never take the shell down. Drop the
    // cached path so the next write re-resolves and re-mkdirs (covers a logs/
    // dir deleted mid-session; otherwise we'd ENOENT silently until restart).
    logFilePath = null;
  }
}

export const log = {
  info: (msg: string): void => write("info", msg),
  warn: (msg: string): void => write("warn", msg),
  error: (msg: string): void => write("error", msg),
};
