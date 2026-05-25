/**
 * ANPR Device Simulator
 * Simulates an R3/R5 License Plate Recognition camera over MQTT.
 *
 * Usage:
 *   node simulator.js [--broker 127.0.0.1] [--port 1883] [--sn 265e1040-85e01fb7]
 *
 * What it does:
 *   - Sends heartbeat every 10s
 *   - Sends random license plate recognition results every 5-15s
 *   - Sends IO input events occasionally
 *   - Sends barrier gate status changes
 *   - Responds to commands: ivs_trigger, gpio_out, snapshot, reboot_dev,
 *     set_time, tts_voice, gate_direct_open, white_list_operator, etc.
 */

const mqtt = require("mqtt");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// --- Logging prefix (Asia/Jakarta / GMT+7) ---
// Keeps simulator logs aligned with backend timestamps regardless of host TZ.
const _origLog = console.log.bind(console);
console.log = (...a) =>
  _origLog(`[${new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour12: false })}]`, ...a);

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BROKER = getArg("broker", "127.0.0.1");
const PORT = parseInt(getArg("port", "1883"));
const SN = getArg("sn", "265e1040-85e01fb7");
const DEVICE_IP = "192.168.6.94";
const DEVICE_NAME = Buffer.from("ANPR-SIM-01").toString("base64");

// Channel-busy awareness: when set, simulator polls the backend
// and refuses to emit a new plate while a previous inspection is in progress
// (mimics a real physical barrier gating the queue).
const BACKEND_URL = getArg("backend", "http://127.0.0.1/anpr_backend");
const CHANNEL_NO = getArg("channel", "RJ001");
const RESPECT_BUSY = getArg("respect-busy", "1") !== "0";
// "Silent" mode: keep_alive + IO events still fire so the dashboard sees the
// camera as online, but no plate recognitions are emitted. Useful for testing
// the "camera healthy, no traffic" scenario without killing the simulator.
const NO_PLATES = args.includes("--no-plates");

console.log("===========================================");
console.log("  ANPR Device Simulator");
console.log("===========================================");
console.log(`  Broker:        ${BROKER}:${PORT}`);
console.log(`  Device SN:     ${SN}`);
console.log(`  Device IP:     ${DEVICE_IP}`);
console.log(`  Respect busy:  ${RESPECT_BUSY ? `yes (channel ${CHANNEL_NO} @ ${BACKEND_URL})` : "no"}`);
console.log(`  Plates:        ${NO_PLATES ? "DISABLED (heartbeat-only)" : "enabled"}`);
console.log("===========================================\n");

// --- MQTT connect ---
const client = mqtt.connect(`mqtt://${BROKER}:${PORT}`, {
  clientId: SN,
  clean: true,
});

client.on("connect", () => {
  console.log("[CONNECTED] to MQTT broker\n");

  // Subscribe to all downlink commands
  const downTopic = `device/${SN}/message/down/+`;
  client.subscribe(downTopic, () => {
    console.log(`[SUB] ${downTopic}`);
  });

  // Start simulation loops
  startHeartbeat();
  if (!NO_PLATES) startRecognitionLoop();
  startIoEventLoop();
  startGateStatusLoop();

  console.log("\n[SIM] Simulator running. Press Ctrl+C to stop.\n");
});

client.on("error", (err) => {
  console.error("[ERROR]", err.message);
});

// --- Helpers ---
function genId() {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 16; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function ts() {
  return Math.floor(Date.now() / 1000);
}

function publish(name, payload) {
  const topic = `device/${SN}/message/up/${name}`;
  const msg = JSON.stringify(payload);
  client.publish(topic, msg);
  console.log(`[PUB] ${topic}`);
}

function reply(name, id, code, payload) {
  const topic = `device/${SN}/message/down/${name}/reply`;
  const msg = JSON.stringify({
    id,
    sn: SN,
    name,
    code,
    version: "1.0",
    timestamp: ts(),
    payload: payload || null,
  });
  client.publish(topic, msg);
  console.log(`[REPLY] ${topic}  code=${code}`);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Sample data ---
// Indonesian-style plates: <area><digits><letters>, no spaces — matches
// what production cameras actually emit on the wire. The dashboard / printed
// receipts are responsible for adding spaces when displaying.
// Area codes: B=Jakarta, D=Bandung, F=Bogor, L=Surabaya, N=Malang,
// W=Sidoarjo, AB=Yogyakarta, AD=Solo, AG=Kediri, AA=Magelang, BK=Medan,
// BG=Palembang, DK=Bali, DD=Makassar, E=Cirebon, T=Karawang.
const PLATES = [
  "B1234ABC", "B5678XYZ", "B9999RI",  "B1111JKT",
  "D4567CD",  "D2222AB",  "F2345EF",  "L9876GH",
  "N1234IJ",  "W5555KL",  "AB1234MN", "AD9999OP",
  "AG7777QR", "AA3456ST", "BK8888UV", "BG1212WX",
  "DK1888YZ", "DD4321AA", "E6789BB",  "T1357CC",
];

const PLATE_TYPES = [1, 2, 3, 4, 5, 19, 20, 31];
const PLATE_COLORS = [1, 2, 3, 4, 5];
const CAR_COLORS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255];
const TRIGGER_TYPES = [1, 2, 4, 8, 67, 86];
const DIRECTIONS = [0, 1, 2, 3, 4];

// --- Heartbeat ---
function startHeartbeat() {
  setInterval(() => {
    publish("keep_alive", {
      id: genId(),
      bv: 12378,
      sn: SN,
      name: "keep_alive",
      version: "1.0",
      timestamp: ts(),
      payload: { body: { timestamp: ts() } },
    });
  }, 10000);
  // send first one immediately
  publish("keep_alive", {
    id: genId(),
    bv: 12378,
    sn: SN,
    name: "keep_alive",
    version: "1.0",
    timestamp: ts(),
    payload: { body: { timestamp: ts() } },
  });
}

// --- Recognition results ---
function generateRecognition() {
  const plate = pick(PLATES);
  const plateB64 = Buffer.from(plate, "utf-8").toString("base64");
  const plateType = pick(PLATE_TYPES);
  const plateColor = pick(PLATE_COLORS);
  const carColor = pick(CAR_COLORS);
  const confidence = rand(75, 100);
  const triggerType = pick(TRIGGER_TYPES);
  const direction = pick(DIRECTIONS);
  const now = new Date();
  const startTime = Date.now();
  const isFake = Math.random() < 0.05 ? 1 : 0;

  return {
    id: genId(),
    bv: 12378,
    sn: SN,
    name: "ivs_result",
    version: "1.0",
    timestamp: ts(),
    payload: {
      AlarmInfoPlate: {
        channel: 0,
        deviceName: DEVICE_NAME,
        ipaddr: DEVICE_IP,
        serialno: SN,
        user_data: Buffer.from("Simulator").toString("base64"),
        rule_id: 1,
        result: {
          PlateResult: {
            bright: rand(50, 200),
            carBright: rand(50, 200),
            carColor,
            car_brand: { brand: rand(1, 50), type: 255, year: 65535 },
            car_extra: { enter_plate: [], leave_plate: [] },
            car_location: {
              RECT: { bottom: rand(500, 700), left: rand(100, 400), right: rand(500, 900), top: rand(200, 400) },
            },
            plates: [
              {
                binimg_path: "",
                binImgSize: 0,
                binimg_content: "",
                clipImgSize: 0,
                image_path: "",
                image_absolute_path: "",
                image_relative_path: "",
                color: plateColor,
                content: "",
                license: plateB64,
                plate_width: rand(200, 400),
                is_danger: 0,
                pos: { bottom: rand(400, 500), left: rand(300, 500), right: rand(600, 800), top: rand(300, 400) },
                type: plateType,
              },
            ],
            clean_time: 0,
            colorType: plateColor,
            colorValue: 0,
            confidence,
            direction,
            feature_code: true,
            gioouts: [],
            bucket: "",
            oss_type: "",
            imageFragmentPath: "",
            imageFragmentAbsolutePath: "",
            imageFragmentRelativePath: "",
            small_image_content: "",
            imagePath: "",
            imageAbsolutePath: "",
            imageRelativePath: "",
            full_image_content: "",
            is_encrypted: 0,
            is_fake_plate: isFake,
            isoffline: 0,
            lane_line: 0,
            reco_id: 0,
            license: plateB64,
            license_ext_type: 0,
            location: {
              RECT: { bottom: rand(500, 600), left: rand(800, 1000), right: rand(1000, 1200), top: rand(400, 500) },
            },
            plate_distance: rand(20, 80),
            plate_true_width: rand(30, 50),
            plateid: rand(100000, 999999),
            timeStamp: {
              Timeval: {
                decday: now.getDate(),
                dechour: now.getHours(),
                decmin: now.getMinutes(),
                decmon: now.getMonth() + 1,
                decsec: now.getSeconds(),
                decyear: now.getFullYear(),
                sec: ts(),
                usec: rand(0, 999999),
              },
            },
            timeUsed: rand(50000, 5000000),
            triggerType,
            type: plateType,
            begin_time: ts() - rand(1, 10),
            end_time: ts(),
            start_time: startTime,
            record_uuid: rand(10000000, 99999999),
            car_head_uuid: rand(10000000, 99999999),
            event_channel: 0,
            unique_id: `${SN}_${startTime}`,
          },
        },
      },
    },
  };
}

// HTTP GET helper for backend channel status
function httpGetJson(targetUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch { resolve(null); return; }
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { Accept: "application/json" },
      timeout: 3000,
    };
    const req = (u.protocol === "https:" ? https : http).request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function isChannelBusy() {
  if (!RESPECT_BUSY) return false;
  const url = `${BACKEND_URL.replace(/\/$/, "")}/api/channels/by-no/${encodeURIComponent(CHANNEL_NO)}/status`;
  const res = await httpGetJson(url);
  if (!res || res.code !== 200 || !res.data) return false; // backend unreachable -> emit anyway
  return !!res.data.busy;
}

function startRecognitionLoop() {
  async function next() {
    try {
      if (await isChannelBusy()) {
        console.log(`       [queue] channel ${CHANNEL_NO} busy — next vehicle holds at the barrier`);
        setTimeout(next, 3000);
        return;
      }
    } catch { /* fall through and emit */ }

    const rec = generateRecognition();
    publish("ivs_result", rec);
    const decoded = Buffer.from(rec.payload.AlarmInfoPlate.result.PlateResult.license, "base64").toString("utf-8");
    console.log(`       Plate: ${decoded}  Confidence: ${rec.payload.AlarmInfoPlate.result.PlateResult.confidence}%`);
    setTimeout(next, rand(5000, 15000));
  }
  setTimeout(next, 2000);
}

// --- IO Input events ---
function startIoEventLoop() {
  function next() {
    const source = rand(0, 1);
    const value = pick([0, 1, 2]);
    publish("gpio_in", {
      id: genId(),
      bv: 12378,
      sn: SN,
      name: "gpio_in",
      version: "1.0",
      timestamp: ts(),
      payload: {
        body: {
          AlarmGioIn: {
            deviceName: DEVICE_NAME,
            ipaddr: DEVICE_IP,
            result: { TriggerResult: { source, value } },
            serialno: SN,
          },
        },
      },
    });
    console.log(`       IO${source} = ${value === 0 ? "OFF" : value === 1 ? "ON" : "PULSE"}`);
    setTimeout(next, rand(20000, 60000));
  }
  setTimeout(next, 8000);
}

// --- Barrier gate status ---
let currentGateStatus = 0;
function startGateStatusLoop() {
  function next() {
    currentGateStatus = currentGateStatus === 0 ? 1 : currentGateStatus === 1 ? 0 : 0;
    publish("barr_gate_status", {
      bv: 12378,
      id: genId(),
      name: "barr_gate_status",
      payload: {
        body: {
          connect_status: 1,
          enable: 1,
          gate_ctrl_id: 1,
          gate_status: currentGateStatus,
        },
      },
      sn: SN,
      timestamp: ts(),
      version: "1.0",
    });
    console.log(`       Gate: ${currentGateStatus === 0 ? "CLOSED" : "OPENED"}`);
    setTimeout(next, rand(30000, 90000));
  }
  setTimeout(next, 5000);
}

// --- Handle incoming commands ---
client.on("message", (topic, message) => {
  // Only handle downlink commands (not replies)
  if (topic.includes("/reply")) return;

  const parts = topic.split("/");
  const name = parts[parts.length - 1];

  let data;
  try {
    data = JSON.parse(message.toString());
  } catch {
    return;
  }

  console.log(`\n[CMD] Received: ${name}  id=${data.id}`);

  switch (name) {
    case "ivs_trigger":
      console.log("       -> Triggering recognition...");
      reply(name, data.id, 200);
      // Send a recognition result after short delay
      setTimeout(() => {
        const rec = generateRecognition();
        publish("ivs_result", rec);
        const decoded = Buffer.from(rec.payload.AlarmInfoPlate.result.PlateResult.license, "base64").toString("utf-8");
        console.log(`       Triggered plate: ${decoded}`);
      }, rand(500, 2000));
      break;

    case "gpio_out": {
      const body = data.payload?.body;
      console.log(`       -> IO Output: IO${body?.io} = ${body?.value} delay=${body?.delay}ms`);
      reply(name, data.id, 200);
      break;
    }

    case "snapshot":
      console.log("       -> Taking snapshot...");
      reply(name, data.id, 200);
      // Send snapshot result
      setTimeout(() => {
        publish("snapshot", {
          id: genId(),
          bv: 12378,
          sn: SN,
          name: "snapshot",
          version: "1.0",
          timestamp: ts(),
          payload: {
            state_code: 200,
            imageformat: "jpg",
            imgPath: "",
            imgAbsolutePath: "",
            bucket: "",
            oss_type: "",
            imgRelativePath: "",
            image_content: "",
          },
        });
      }, 500);
      break;

    case "set_time": {
      const time = data.payload?.body;
      console.log(`       -> Setting time: ${time?.year}-${time?.month}-${time?.day} ${time?.hour}:${time?.min}:${time?.sec}`);
      reply(name, data.id, 200);
      break;
    }

    case "get_device_timestamp":
      console.log("       -> Returning device timestamp");
      reply(name, data.id, 200, { timestamp: ts() });
      break;

    case "reboot_dev":
      console.log("       -> REBOOTING DEVICE (simulated)...");
      // No reply for reboot per protocol
      console.log("       -> Device would restart now. Simulator continues.");
      break;

    case "tts_voice": {
      const voice = data.payload?.body;
      const text = voice?.voice_data ? Buffer.from(voice.voice_data, "base64").toString("utf-8") : "";
      console.log(`       -> TTS: "${text}" (${voice?.voice_male === 0 ? "Male" : "Female"}, vol=${voice?.voice_volume})`);
      reply(name, data.id, 200, { type: "play_voice" });
      break;
    }

    case "gate_direct_open":
      console.log("       -> Opening gate directly...");
      currentGateStatus = 1;
      reply(name, data.id, 200);
      // Send gate status update
      setTimeout(() => {
        publish("barr_gate_status", {
          bv: 12378,
          id: genId(),
          name: "barr_gate_status",
          payload: {
            body: { connect_status: 1, enable: 1, gate_ctrl_id: 1, gate_status: 1 },
          },
          sn: SN,
          timestamp: ts(),
          version: "1.0",
        });
        // Auto-close after 5s
        setTimeout(() => {
          currentGateStatus = 0;
          publish("barr_gate_status", {
            bv: 12378,
            id: genId(),
            name: "barr_gate_status",
            payload: {
              body: { connect_status: 1, enable: 1, gate_ctrl_id: 1, gate_status: 0 },
            },
            sn: SN,
            timestamp: ts(),
            version: "1.0",
          });
          console.log("       Gate auto-closed");
        }, 5000);
      }, 300);
      break;

    case "white_list_operator": {
      const op = data.payload?.body;
      console.log(`       -> Whitelist: ${op?.operator_type} plate=${op?.plate || op?.dldb_rec?.plate || "ALL"}`);
      if (op?.operator_type === "select") {
        reply(name, data.id, 200, {
          body: {
            dldb_rec: [
              {
                context: "",
                enable: 1,
                enable_time: "2025-12-31 23:59:00",
                need_alarm: 0,
                overdue_time: "2026-12-31 23:59:00",
                plate: op.plate || "TEST001",
                seg_time_end: "00:00:00",
                seg_time_start: "00:00:00",
                time_seg_enable: 0,
              },
            ],
            operator_type: "select",
            state_code: 200,
          },
          type: "white_list_operator",
        });
      } else {
        reply(name, data.id, 200);
      }
      break;
    }

    case "set_cloud_ctrl": {
      const ctrl = data.payload?.body;
      const moves = { 0: "Timeout", 1: "Continue", 2: "Up", 3: "KeepUp", 4: "Down", 5: "KeepDown", 8: "StopV", 16: "Left", 17: "KeepLeft", 32: "Right", 33: "KeepRight", 64: "StopH" };
      console.log(`       -> Cloud Control: ${moves[ctrl?.type] || ctrl?.type}`);
      reply(name, data.id, 200);
      break;
    }

    case "serial_data": {
      const sd = data.payload?.body;
      console.log(`       -> Serial Data forward: ${sd?.serialData?.length || 0} entries`);
      reply(name, data.id, 200);
      break;
    }

    case "io_lock":
    case "set_io_lock_status": {
      const lock = data.payload?.body;
      console.log(`       -> IO Lock: port=${lock?.ioout} status=${lock?.status}`);
      reply(name, data.id, 200);
      break;
    }

    case "get_io_lock_status":
      console.log("       -> Returning IO lock status");
      reply(name, data.id, 200, {
        body: [{ ioout: 0, status: 0 }, { ioout: 1, status: 0 }],
        type: "get_io_lock_status",
      });
      break;

    case "get_io_status": {
      const io = data.payload?.body;
      console.log(`       -> Returning IO status: type=${io?.type} gpio=${io?.gpio}`);
      reply(name, data.id, 200, {
        body: { gpio: io?.gpio || 0, status: rand(0, 1) },
        type: "get_io_status",
      });
      break;
    }

    case "check_offline_record": {
      const off = data.payload?.body;
      console.log(`       -> Offline record: ${off?.enable}`);
      reply(name, data.id, 200, {
        type: "check_offline_record",
        body: { enable: off?.enable, max_count: 0, min_id: 0 },
      });
      if (off?.enable === "push") {
        publish("offline_record", {
          bv: 12378,
          id: genId(),
          name: "offline_record",
          payload: { body: { offline_record: 0 } },
          sn: SN,
          timestamp: ts(),
          version: "1.0",
        });
      }
      break;
    }

    default:
      console.log(`       -> Unknown command, sending 200 OK`);
      reply(name, data.id, 200);
      break;
  }
});

// --- Graceful shutdown ---
process.on("SIGINT", () => {
  console.log("\n[SIM] Shutting down simulator...");
  client.end(false, () => {
    console.log("[SIM] Disconnected. Bye!");
    process.exit(0);
  });
});
