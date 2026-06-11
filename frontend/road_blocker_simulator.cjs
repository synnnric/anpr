/**
 * Road Blocker Simulator — Qigong AIoT lifting-column controller fake.
 *
 * Implements the two endpoints the platform + frontend hit:
 *   POST /open/operation         — raise/lower a column on a given board
 *   GET  /open/getStatus/{devNo} — read current state of every column
 *
 * Usage:
 *   node road_blocker_simulator.cjs [--port 8088] [--device DEV001]
 *                                   [--boards 01,02] [--columns 2]
 *                                   [--auto-close-ms 6000]
 *
 * Transitions are animated (Raised → Rising → Lowered etc.) on a short delay
 * so the polling page actually shows the intermediate state, just like real
 * hardware.
 *
 * SELF-CLOSE (models the real controller): the platform only ever commands the
 * column DOWN (open) — it never sends UP. On real hardware the controller's own
 * loop detector raises the column again once the vehicle has cleared. We mimic
 * that here: after a column settles Lowered, it auto-raises itself after
 * `--auto-close-ms` (simulating "vehicle cleared the loop"). A new command on
 * the same column cancels the pending self-close. Set `--auto-close-ms 0` to
 * disable (legacy: column only raises on an explicit UP command).
 *
 * Status codes (from frontend/src/types/roadblocker.ts):
 *   0 unknown · 1 descending · 3 lowered · 5 rising · 7 raised
 */

const http = require("http");
const { URL } = require("url");

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg("port", "8088"));
const DEVICE_NO = getArg("device", "DEV001");
const BOARDS = getArg("boards", "01").split(",").map(s => s.trim()).filter(Boolean);
const COLS_PER_BOARD = parseInt(getArg("columns", "1"));
const TRANSITION_MS = parseInt(getArg("transition-ms", "1500"));
// How long the column stays Lowered before the (simulated) controller raises it
// itself — i.e. how long until the loop detector reports the vehicle has cleared.
// 0 disables self-close (column only rises on an explicit UP command).
const AUTO_CLOSE_MS = parseInt(getArg("auto-close-ms", "6000"));

// --- State ---
// Every column starts Raised (closed) — vehicles can't pass until commanded down.
const state = {
  online: true,                       // controlTheDeviceOnline flag
  columns: {},                        // { [boardId]: { [columnId]: code } }
  pendingTimers: new Map(),           // key=`${board}|${col}` -> Timeout, so we can cancel mid-transition
  autoCloseTimers: new Map(),         // key=`${board}|${col}` -> Timeout for the controller's self-raise
};
for (const b of BOARDS) {
  state.columns[b] = {};
  for (let c = 1; c <= COLS_PER_BOARD; c++) {
    state.columns[b][String(c)] = 7;  // 7 = Raised
  }
}

console.log("===========================================");
console.log("  Road Blocker Simulator (Qigong AIoT)");
console.log("===========================================");
console.log(`  HTTP port:   ${PORT}`);
console.log(`  Device no:   ${DEVICE_NO}`);
console.log(`  Boards:      ${BOARDS.join(", ")}`);
console.log(`  Cols/board:  ${COLS_PER_BOARD}`);
console.log(`  Transition:  ${TRANSITION_MS}ms`);
console.log(`  Self-close:  ${AUTO_CLOSE_MS > 0 ? `${AUTO_CLOSE_MS}ms after Lowered (controller raises itself)` : "disabled (explicit UP only)"}`);
console.log("===========================================\n");

// --- Helpers ---
function respond(res, code, body) {
  // CORS so the browser can hit us directly from the Road Blocker page.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
  res.setHeader("Content-Type", "application/json");
  res.statusCode = code;
  res.end(JSON.stringify(body));
}

function ok(data, msg = "ok") {
  return { code: 200, msg, data };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
  });
}

function ts() {
  // App timezone is Asia/Jakarta (GMT+7) — keep logs aligned with backend timestamps.
  return new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour12: false });
}

function setColumn(boardId, colId, code) {
  state.columns[boardId][colId] = code;
}

/**
 * Animate a transition: schedules the intermediate state immediately, then the
 * settled state after TRANSITION_MS. Cancels any in-flight transition on the
 * same column so the latest command always wins.
 */
function schedule(boardId, colId, action) {
  const key = `${boardId}|${colId}`;
  const t = state.pendingTimers.get(key);
  if (t) clearTimeout(t);
  // A fresh command supersedes any pending controller self-close on this column.
  const ac = state.autoCloseTimers.get(key);
  if (ac) { clearTimeout(ac); state.autoCloseTimers.delete(key); }

  // action=down: 7 (Raised) → 1 (Descending) → 3 (Lowered) — vehicle can pass.
  // action=up:   3 (Lowered) → 5 (Rising)    → 7 (Raised)  — vehicle blocked.
  const [transient, settled] = action === "down" ? [1, 3] : [5, 7];
  setColumn(boardId, colId, transient);

  const timer = setTimeout(() => {
    setColumn(boardId, colId, settled);
    state.pendingTimers.delete(key);
    console.log(`[${ts()}] board ${boardId} col ${colId}  -> ${action === "down" ? "Lowered" : "Raised"} (${settled})`);

    // Controller self-close: once Lowered, the loop detector eventually reports
    // the vehicle has cleared and the controller raises the column on its own.
    // The platform never sends UP, so this is what closes the blocker.
    if (action === "down" && AUTO_CLOSE_MS > 0) {
      const closeTimer = setTimeout(() => {
        state.autoCloseTimers.delete(key);
        console.log(`[${ts()}] board ${boardId} col ${colId}  -- vehicle cleared, controller self-raising`);
        schedule(boardId, colId, "up");
      }, AUTO_CLOSE_MS);
      state.autoCloseTimers.set(key, closeTimer);
    }
  }, TRANSITION_MS);
  state.pendingTimers.set(key, timer);
}

// --- Request handlers ---
function handleGetStatus(req, res, deviceNo) {
  if (deviceNo !== DEVICE_NO) {
    return respond(res, 200, { code: 404, msg: `unknown device ${deviceNo}`, data: null });
  }
  // Shape mirrors RoadBlockerStatusResponse in the frontend types.
  respond(res, 200, ok({
    controlTheDeviceOnline: state.online,
    liftingColumnsStatus: state.columns,
  }));
}

async function handleOperation(req, res) {
  const body = await readBody(req);
  const { deviceNo, ipCode, operationType, action, liftingColumnNum } = body || {};

  if (deviceNo !== DEVICE_NO) {
    return respond(res, 200, { code: 404, msg: `unknown device ${deviceNo}`, data: null });
  }
  if (action !== "up" && action !== "down") {
    return respond(res, 200, { code: 400, msg: `invalid action ${action}`, data: null });
  }

  // device_level / ip_level / liftingColumn_level — we treat them as scoped sweeps.
  if (operationType === "device_level") {
    for (const b of BOARDS) {
      for (const c of Object.keys(state.columns[b])) schedule(b, c, action);
    }
    console.log(`[${ts()}] DEVICE-LEVEL ${action.toUpperCase()} on ${DEVICE_NO}`);
    return respond(res, 200, ok({ deviceNo, action, scope: "device" }, "scheduled"));
  }

  if (!ipCode || typeof ipCode !== "object") {
    return respond(res, 200, { code: 400, msg: "ipCode required", data: null });
  }

  let affected = 0;
  for (const [boardId, col] of Object.entries(ipCode)) {
    if (!state.columns[boardId]) {
      console.warn(`[${ts()}] WARN unknown board ${boardId}`);
      continue;
    }
    if (operationType === "ip_level") {
      // Whole board — flip every column on this board.
      for (const c of Object.keys(state.columns[boardId])) { schedule(boardId, c, action); affected++; }
    } else {
      // liftingColumn_level — flip just one column (col from ipCode value, or liftingColumnNum).
      const colId = String(liftingColumnNum ?? col);
      if (state.columns[boardId][colId] === undefined) {
        console.warn(`[${ts()}] WARN unknown column ${colId} on board ${boardId}`);
        continue;
      }
      schedule(boardId, colId, action);
      affected++;
    }
  }
  console.log(`[${ts()}] ${operationType} ${action.toUpperCase()} affected ${affected} column(s)`);
  respond(res, 200, ok({ deviceNo, action, affected }, "scheduled"));
}

// --- Server ---
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return respond(res, 204, null);
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path.startsWith("/open/getStatus/")) {
    const devNo = decodeURIComponent(path.slice("/open/getStatus/".length));
    return handleGetStatus(req, res, devNo);
  }

  if (req.method === "POST" && path === "/open/operation") {
    return handleOperation(req, res);
  }

  // Tiny landing page for sanity checks.
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return respond(res, 200, ok({
      simulator: "road_blocker",
      device_no: DEVICE_NO,
      boards: BOARDS,
      columns_per_board: COLS_PER_BOARD,
      self_close_ms: AUTO_CLOSE_MS,
      endpoints: ["GET /open/getStatus/{deviceNo}", "POST /open/operation"],
    }));
  }

  respond(res, 404, { code: 404, msg: `not found: ${req.method} ${path}`, data: null });
});

// Fail fast (and obviously) when the port is already taken. Without this
// handler Node leaves the process running as a zombie that never serves
// traffic — confusing during diagnosis.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[${ts()}] port ${PORT} already in use — another road blocker simulator is running. Exiting.`);
  } else {
    console.error(`[${ts()}] server error:`, err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[${ts()}] listening on http://127.0.0.1:${PORT}\n`);
  console.log("Try:");
  console.log(`  curl http://127.0.0.1:${PORT}/open/getStatus/${DEVICE_NO}`);
  console.log(`  curl -X POST http://127.0.0.1:${PORT}/open/operation \\`);
  console.log(`       -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"deviceNo":"${DEVICE_NO}","ipCode":{"01":1},"operationType":"liftingColumn_level","action":"down","liftingColumnNum":1}'`);
  console.log();
});

process.on("SIGINT", () => {
  console.log(`\n[${ts()}] shutting down`);
  for (const t of state.pendingTimers.values()) clearTimeout(t);
  for (const t of state.autoCloseTimers.values()) clearTimeout(t);
  server.close(() => process.exit(0));
});
