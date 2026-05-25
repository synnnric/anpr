/**
 * S300 Device Simulator
 *
 * - Listens on http://0.0.0.0:8086 for platform calls (POST /api/v1/channel-s300/* and /api/v1/device-s300/*)
 * - When /come is invoked, simulates a full inspection lifecycle, pushing callbacks
 *   to the platform at PLATFORM_BASE_URL (default: http://127.0.0.1/anpr_backend).
 *
 * Run: node s300_simulator.cjs
 */
const http = require('http');
const url = require('url');

// --- Logging prefix (Asia/Jakarta / GMT+7) ---
const _origLog = console.log.bind(console);
console.log = (...a) =>
  _origLog(`[${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false })}]`, ...a);

const PORT = parseInt(process.env.S300_PORT || '8086', 10);
const PLATFORM_BASE_URL = process.env.PLATFORM_BASE_URL || 'http://127.0.0.1/anpr_backend';

// ============== state ==============
const channels = new Map(); // channelNo -> { plate, state, timers[] }

// 1x1 pixel JPEG (red dot) used as fake image data
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9k=';

// ============== platform push ==============
function pushToPlatform(path, body) {
  const target = new URL(PLATFORM_BASE_URL + path);
  const data = JSON.stringify(body);
  const opts = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  };
  return new Promise((resolve) => {
    const req = (target.protocol === 'https:' ? require('https') : http).request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        console.log(`[PUSH] ${target.href} -> ${res.statusCode}`);
        resolve({ status: res.statusCode, body: buf });
      });
    });
    req.on('error', (err) => {
      console.log(`[PUSH] ${target.href} -> ERROR ${err.message}`);
      resolve({ status: 0, error: err.message });
    });
    req.write(data);
    req.end();
  });
}

// ============== lifecycle ==============
function clearChannelTimers(ch) {
  if (channels.has(ch)) {
    channels.get(ch).timers.forEach((t) => clearTimeout(t));
    channels.get(ch).timers = [];
  }
}

function startInspection(channelNo, plate) {
  clearChannelTimers(channelNo);
  const session = { plate, state: 1, timers: [] };
  channels.set(channelNo, session);
  console.log(`[SIM] starting inspection ch=${channelNo} plate=${plate}`);

  // immediately: work-status 1 = inspecting
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/work-status', {
      cmdNo: 322, channelNo, data: { operatingState: 1 },
    });
  }, 500));

  // ~2s: video-record (6 RTSP streams)
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/video-record', {
      cmdNo: 325, channelNo, licensePlateNo: plate,
      data: [
        { code: 'z1', url: 'rtsp://192.168.1.100:8080/cam/z1' },
        { code: 'z2', url: 'rtsp://192.168.1.100:8080/cam/z2' },
        { code: 'z3', url: 'rtsp://192.168.1.100:8080/cam/z3' },
        { code: 'y1', url: 'rtsp://192.168.1.100:8080/cam/y1' },
        { code: 'y2', url: 'rtsp://192.168.1.100:8080/cam/y2' },
        { code: 'y3', url: 'rtsp://192.168.1.100:8080/cam/y3' },
      ],
    });
  }, 2000));

  // ~4s: face image #1
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/face-image', {
      cmdNo: 323, channelNo,
      data: { img: [`http://image-server/face/${Date.now()}_a.jpg`] },
    });
  }, 4000));

  // ~7s: face image #2
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/face-image', {
      cmdNo: 323, channelNo,
      data: { img: [`http://image-server/face/${Date.now()}_b.jpg`] },
    });
  }, 7000));

  // ~9s: UVIS undercarriage image
  session.timers.push(setTimeout(async () => {
    const hasObject = Math.random() > 0.5;
    await pushToPlatform('/overseas/s300/uvis', {
      channel: channelNo,
      params: {
        inspectionId: Date.now(),
        imageType: hasObject ? 1 : 0,
        imageData: TINY_JPEG_B64,
        objectCount: hasObject ? 1 : 0,
        coords: hasObject ? [{ conf: 0.76, x1: 50, y1: 100, x2: 100, y2: 200 }] : [],
      },
    });
  }, 9000));

  // ~12s: X-ray scan
  session.timers.push(setTimeout(async () => {
    const isAnomaly = Math.random() > 0.6;
    await pushToPlatform('/overseas/s300/x-ray', {
      SN: `SYS001${Date.now()}`,
      DateScanStarted: new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19),
      DateScanEnded: new Date().toISOString().replace('T', ' ').slice(0, 19),
      VehicleNumber: plate,
      ScannedImage: TINY_JPEG_B64,
      PlateImage: TINY_JPEG_B64,
      IsAnomaly: isAnomaly,
      AnomalyComments: isAnomaly ? 'Suspected dangerous item' : '',
      ScannerOperator: 'SIM-OP',
      AlarmInfo: isAnomaly ? [
        { Confidence: 0.98, Region: { x: 10, y: 30, Width: 100, Height: 100 }, Comments: 'Similar to a firearm' },
        { Confidence: 0.62, Region: { x: 200, y: 90, Width: 60, Height: 80 }, Comments: 'Similar to knives' },
      ] : [],
    });
  }, 12000));

  // ~14s: work-status 2 = resetting (inspection done, waiting for /leave)
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/work-status', {
      cmdNo: 322, channelNo, data: { operatingState: 2 },
    });
    session.state = 2;
  }, 14000));
}

function completeInspection(channelNo) {
  const session = channels.get(channelNo);
  if (!session) return;
  clearChannelTimers(channelNo);
  console.log(`[SIM] leave called for ch=${channelNo}, finishing reset`);

  // ~2s: work-status 3 = reset complete
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/work-status', {
      cmdNo: 322, channelNo, data: { operatingState: 3 },
    });
  }, 2000));

  // ~3s: reset-complete callback
  session.timers.push(setTimeout(async () => {
    await pushToPlatform('/overseas/s300/reset-complete', {
      cmdNo: 326, channelNo, data: null,
    });
    channels.delete(channelNo);
  }, 3000));
}

// ============== HTTP server (receives platform calls) ==============
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function ok(res, extra = {}) {
  send(res, 200, { code: 200, message: 'success', data: { ...extra } });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = {};
    try { json = body ? JSON.parse(body) : {}; } catch {}
    handle(req.method, u.pathname, json, res);
  });
});

function handle(method, path, json, res) {
  console.log(`[S300] ${method} ${path}`);

  // 2.1.1 POST /api/v1/channel-s300/come/{channelNo}
  let m = path.match(/^\/api\/v1\/channel-s300\/come\/([^/]+)$/);
  if (method === 'POST' && m) {
    const channelNo = m[1];
    const plate = json.licensePlateNo || 'UNKNOWN';
    startInspection(channelNo, plate);
    return ok(res, { operatingState: 1, desc: 'inspection started' });
  }

  // 2.1.2 GET /api/v1/channel-s300/capture/{channelNo}
  m = path.match(/^\/api\/v1\/channel-s300\/capture\/([^/]+)$/);
  if (method === 'GET' && m) {
    const channelNo = m[1];
    setTimeout(async () => {
      await pushToPlatform('/overseas/s300/face-image', {
        cmdNo: 323, channelNo,
        data: { img: [`http://image-server/face/recapture_${Date.now()}.jpg`] },
      });
    }, 500);
    return ok(res);
  }

  // 2.1.3 GET /api/v1/channel-s300/leave/{channelNo}
  m = path.match(/^\/api\/v1\/channel-s300\/leave\/([^/]+)$/);
  if (method === 'GET' && m) {
    completeInspection(m[1]);
    return ok(res);
  }

  // 2.2.1 POST /api/v1/device-s300/read-work-status/{channelNo}
  m = path.match(/^\/api\/v1\/device-s300\/read-work-status\/([^/]+)$/);
  if (method === 'POST' && m) {
    const channelNo = m[1];
    const session = channels.get(channelNo);
    const state = session ? session.state : 0;
    setTimeout(async () => {
      await pushToPlatform('/overseas/s300/work-status', {
        cmdNo: 322, channelNo, data: { operatingState: state },
      });
    }, 300);
    return ok(res);
  }

  // 2.2.2 POST /api/v1/device-s300/emergency-stop/{channelNo}
  m = path.match(/^\/api\/v1\/device-s300\/emergency-stop\/([^/]+)$/);
  if (method === 'POST' && m) {
    const channelNo = m[1];
    clearChannelTimers(channelNo);
    setTimeout(async () => {
      await pushToPlatform('/overseas/s300/work-status', {
        cmdNo: 322, channelNo, data: { operatingState: 4 },
      });
    }, 300);
    return ok(res);
  }

  // 2.2.3 POST /api/v1/device-s300/manual-reset/{channelNo}
  m = path.match(/^\/api\/v1\/device-s300\/manual-reset\/([^/]+)$/);
  if (method === 'POST' && m) {
    const channelNo = m[1];
    setTimeout(async () => {
      await pushToPlatform('/overseas/s300/work-status', {
        cmdNo: 322, channelNo, data: { operatingState: 0 },
      });
    }, 1500);
    return ok(res);
  }

  // 2.2.4 POST /api/v1/device-s300/x-ray/{channelNo}
  m = path.match(/^\/api\/v1\/device-s300\/x-ray\/([^/]+)$/);
  if (method === 'POST' && m) {
    console.log(`[S300] X-ray receipt: SN=${json.SN}, Result=${json.Result}`);
    return ok(res);
  }

  // 2.3.1 POST /api/v1/device-s300/audio-prompt
  if (method === 'POST' && path === '/api/v1/device-s300/audio-prompt') {
    console.log(`[S300] audio-prompt cmdNo=${json.cmdNo}, items=${(json.data || []).length}`);
    return ok(res);
  }

  // 2.4 POST /api/v1/device-s300/video-playback
  if (method === 'POST' && path === '/api/v1/device-s300/video-playback') {
    return send(res, 200, {
      code: 200, message: 'success',
      data: [
        { code: 'z1', url: 'rtsp://192.168.1.100:8080/playback/z1' },
        { code: 'z2', url: 'rtsp://192.168.1.100:8080/playback/z2' },
        { code: 'z3', url: 'rtsp://192.168.1.100:8080/playback/z3' },
        { code: 'y1', url: 'rtsp://192.168.1.100:8080/playback/y1' },
        { code: 'y2', url: 'rtsp://192.168.1.100:8080/playback/y2' },
        { code: 'y3', url: 'rtsp://192.168.1.100:8080/playback/y3' },
      ],
    });
  }

  send(res, 404, { code: 404, message: 'not found', data: null });
}

server.listen(PORT, () => {
  console.log('================================================');
  console.log(`  S300 Device Simulator listening on port ${PORT}`);
  console.log(`  Platform target: ${PLATFORM_BASE_URL}`);
  console.log('================================================');
  console.log('Configure your S300Controller channel base URL to:');
  console.log(`  http://127.0.0.1:${PORT}`);
});
