/**
 * Exit ANPR Simulator
 *
 * Simulates the EXIT camera (a second ANPR device on the same MQTT broker
 * but with a different device SN). Used to test the entry/exit + whitelist
 * sync flow without real hardware.
 *
 * What it does:
 *   - Connects to MQTT under its own device SN (default: EXIT-CAM-001)
 *   - Every 20-60 s, queries the backend for currently-active visits and
 *     publishes an exit plate. With probability `--orphan-rate` (default 20%)
 *     it publishes a random unknown plate instead, to exercise the
 *     orphan-exit path.
 *
 * Run:
 *   node exit_simulator.cjs
 *   node exit_simulator.cjs --sn EXIT-CAM-001 --orphan-rate 0.3
 */

const mqtt = require('mqtt');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// --- Logging prefix (Asia/Jakarta / GMT+7) ---
const _origLog = console.log.bind(console);
console.log = (...a) =>
  _origLog(`[${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false })}]`, ...a);

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BROKER = getArg('broker', '127.0.0.1');
const PORT = parseInt(getArg('port', '1883'));
const SN = getArg('sn', 'EXIT-CAM-001');
const DEVICE_IP = getArg('ip', '192.168.6.95');
const DEVICE_NAME = Buffer.from('ANPR-EXIT-SIM').toString('base64');
const BACKEND_URL = getArg('backend', 'http://127.0.0.1/anpr_backend').replace(/\/$/, '');
const ORPHAN_RATE = Math.max(0, Math.min(1, parseFloat(getArg('orphan-rate', '0.2'))));
const INTERVAL_MIN_S = parseInt(getArg('min-interval', '20'));
const INTERVAL_MAX_S = parseInt(getArg('max-interval', '60'));

console.log('===========================================');
console.log('  ANPR EXIT Camera Simulator');
console.log('===========================================');
console.log(`  Broker:        ${BROKER}:${PORT}`);
console.log(`  Device SN:     ${SN}`);
console.log(`  Backend:       ${BACKEND_URL}`);
console.log(`  Orphan rate:   ${(ORPHAN_RATE * 100).toFixed(0)}% (unknown plates)`);
console.log(`  Interval:      ${INTERVAL_MIN_S}-${INTERVAL_MAX_S}s between exits`);
console.log('===========================================\n');

// --- MQTT connect ---
const client = mqtt.connect(`mqtt://${BROKER}:${PORT}`, { clientId: SN, clean: true });

client.on('connect', () => {
  console.log('[CONNECTED] to MQTT broker');
  client.subscribe(`device/${SN}/message/down/+`, () => console.log(`[SUB] device/${SN}/message/down/+`));
  startHeartbeat();
  startExitLoop();
  console.log('\n[SIM] Exit simulator running. Press Ctrl+C to stop.\n');
});

client.on('error', (e) => console.error('[ERROR]', e.message));

// --- helpers ---
function genId() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < 16; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function ts() { return Math.floor(Date.now() / 1000); }
function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function randomOrphanPlate() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const n = '0123456789';
  return Array.from({ length: 3 }, () => a[Math.floor(Math.random() * a.length)]).join('')
    + Array.from({ length: 4 }, () => n[Math.floor(Math.random() * n.length)]).join('');
}

function publish(name, payload) {
  const topic = `device/${SN}/message/up/${name}`;
  client.publish(topic, JSON.stringify(payload));
  console.log(`[PUB] ${topic}`);
}

function httpGetJson(targetUrl) {
  return new Promise((resolve) => {
    let u; try { u = new URL(targetUrl); } catch { resolve(null); return; }
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 3000,
    };
    const req = (u.protocol === 'https:' ? https : http).request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- heartbeat ---
function startHeartbeat() {
  const beat = () => publish('keep_alive', {
    id: genId(), bv: 12378, sn: SN, name: 'keep_alive',
    version: '1.0', timestamp: ts(),
    payload: { body: { timestamp: ts() } },
  });
  beat();
  setInterval(beat, 10000);
}

// --- pick a plate to exit ---
async function pickPlate() {
  if (Math.random() < ORPHAN_RATE) {
    return { plate: randomOrphanPlate(), source: 'orphan' };
  }
  const res = await httpGetJson(`${BACKEND_URL}/api/visits?status=active&limit=50`);
  const items = res?.data?.items || [];
  if (!items.length) {
    return { plate: randomOrphanPlate(), source: 'orphan (no active visits)' };
  }
  const pick = items[Math.floor(Math.random() * items.length)];
  return { plate: pick.license_plate, source: `visit#${pick.id}` };
}

// --- exit detection loop ---
function startExitLoop() {
  async function next() {
    try {
      const { plate, source } = await pickPlate();
      const plateB64 = Buffer.from(plate, 'utf-8').toString('base64');
      const startTime = Date.now();
      const recognition = {
        id: genId(), bv: 12378, sn: SN, name: 'ivs_result',
        version: '1.0', timestamp: ts(),
        payload: {
          AlarmInfoPlate: {
            channel: 0,
            deviceName: DEVICE_NAME,
            ipaddr: DEVICE_IP,
            serialno: SN,
            user_data: Buffer.from('ExitSimulator').toString('base64'),
            rule_id: 1,
            result: {
              PlateResult: {
                license: plateB64,
                confidence: rand(80, 99),
                type: 1, colorType: 1, carColor: rand(0, 9),
                direction: 3,   // 3 = up / driving away from camera
                triggerType: 1,
                is_fake_plate: 0,
                plates: [{ license: plateB64, color: 1, type: 1, plate_width: rand(200, 400),
                  pos: { bottom: 500, left: 300, right: 800, top: 300 }, is_danger: 0,
                  binimg_path: '', binImgSize: 0, binimg_content: '',
                  clipImgSize: 0, image_path: '', image_absolute_path: '',
                  image_relative_path: '', content: '' }],
                imagePath: '', imageAbsolutePath: '', imageRelativePath: '',
                imageFragmentPath: '', imageFragmentAbsolutePath: '', imageFragmentRelativePath: '',
                small_image_content: '', full_image_content: '',
                car_brand: { brand: rand(1, 50), type: 255, year: 65535 },
                car_extra: { enter_plate: [], leave_plate: [] },
                car_location: { RECT: { bottom: rand(500, 700), left: rand(100, 400), right: rand(500, 900), top: rand(200, 400) } },
                location: { RECT: { bottom: 600, left: 800, right: 1100, top: 400 } },
                bright: 120, carBright: 120, clean_time: 0, colorValue: 0,
                feature_code: true, gioouts: [], bucket: '', oss_type: '',
                is_encrypted: 0, isoffline: 0, lane_line: 0, reco_id: 0,
                plate_distance: 40, plate_true_width: 40, plateid: rand(100000, 999999),
                license_ext_type: 0, timeUsed: rand(50000, 5000000),
                begin_time: ts() - rand(1, 5), end_time: ts(),
                start_time: startTime, record_uuid: rand(10000000, 99999999),
                car_head_uuid: rand(10000000, 99999999),
                event_channel: 0, unique_id: `${SN}_${startTime}`,
              },
            },
          },
        },
      };
      publish('ivs_result', recognition);
      console.log(`       EXIT plate: ${plate}  source: ${source}`);
    } catch (e) {
      console.error('[ERROR] in exit loop:', e.message);
    }
    setTimeout(next, rand(INTERVAL_MIN_S, INTERVAL_MAX_S) * 1000);
  }
  setTimeout(next, 5000);
}

// --- handle commands sent to this device (mostly whitelist syncs from the worker) ---
client.on('message', (topic, message) => {
  if (topic.includes('/reply')) return;
  const name = topic.split('/').pop();
  let data; try { data = JSON.parse(message.toString()); } catch { return; }
  console.log(`\n[CMD] ${name}  id=${data.id}`);
  if (name === 'white_list_operator') {
    const body = data.payload?.body;
    const op = body?.operator_type;
    if (op === 'add')    console.log(`       -> ADD plate to whitelist:    ${body?.dldb_rec?.[0]?.plate}`);
    else if (op === 'delete') console.log(`       -> REMOVE plate from whitelist: ${body?.plate}`);
    else console.log(`       -> ${op}`);
  }
  // reply 200 to ack the command
  const reply = {
    id: data.id, sn: SN, name, code: 200, version: '1.0',
    timestamp: ts(), payload: null,
  };
  client.publish(`device/${SN}/message/down/${name}/reply`, JSON.stringify(reply));
});

process.on('SIGINT', () => {
  console.log('\n[SIM] Shutting down...');
  client.end(false, () => process.exit(0));
});
