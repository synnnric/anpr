#!/usr/bin/env python3
"""
ANPR MQTT Worker — headless production daemon.

Subscribes to the MQTT broker on behalf of the platform and is the sole
trigger source for S300 inspections. The React dashboard is monitoring +
admin only — it no longer initiates /come calls.

Responsibilities:
  1. Subscribe to  device/+/message/up/ivs_result
  2. Decode each plate, POST it to /api/vehicles (audit log)
  3. If auto_start_s300 setting is on AND the matched channel is free,
     POST /api/s300/come/{channelNo} (VIP / busy guard / decision engine
     are all enforced server-side)
  4. Every TICK_INTERVAL_S, POST /api/cron/tick to sweep UVIS timeouts

Dependencies: paho-mqtt only. HTTP uses stdlib urllib.

Configure via .env (loaded automatically) or process environment.
"""

import base64
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt

# Detect paho-mqtt version (v1.x lacks CallbackAPIVersion; v2.x has it)
_PAHO_V2 = hasattr(mqtt, "CallbackAPIVersion")

# ============================================================================
# Config
# ============================================================================
def _load_dotenv() -> None:
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("\"'")
        os.environ.setdefault(key, value)


_load_dotenv()


class Config:
    mqtt_broker: str = os.environ.get("MQTT_BROKER", "mqtt://127.0.0.1:1883")
    mqtt_username: str | None = os.environ.get("MQTT_USERNAME") or None
    mqtt_password: str | None = os.environ.get("MQTT_PASSWORD") or None
    mqtt_client_id: str = os.environ.get("MQTT_CLIENT_ID", f"anpr_worker_{int(time.time())}")
    backend_url: str = os.environ.get("BACKEND_URL", "http://127.0.0.1/anpr_backend").rstrip("/")
    tick_interval_s: float = float(os.environ.get("TICK_INTERVAL_S", "5"))
    settings_poll_s: float = float(os.environ.get("SETTINGS_POLL_S", "10"))
    channels_poll_s: float = float(os.environ.get("CHANNELS_POLL_S", "30"))
    # How fast the worker drains the outbound MQTT queue — this is the main
    # recognition→gate-open latency. Low = snappy gate (a couple tiny DB polls/s).
    outbound_poll_s: float = float(os.environ.get("OUTBOUND_POLL_S", "0.5"))
    dedupe_window_s: float = float(os.environ.get("DEDUPE_WINDOW_S", "10"))
    fallback_channel: str = os.environ.get("FALLBACK_CHANNEL", "RJ001")
    http_timeout_s: float = float(os.environ.get("HTTP_TIMEOUT_S", "10"))
    # How often to drain the global-log queue (partner gateCarEntry push).
    global_log_poll_s: float = float(os.environ.get("GLOBAL_LOG_POLL_S", "3"))
    # Singleton lock — first worker to claim this loopback port wins.
    # Any second instance gets OSError and exits with a friendly message.
    singleton_port: int = int(os.environ.get("WORKER_SINGLETON_PORT", "18923"))
    # Watchdog: if the heartbeat (cron-tick loop) goes silent longer than this,
    # the process force-exits so a supervisor (systemd Restart=on-failure, or a
    # plain re-run which auto-reclaims the lock) restarts it cleanly — instead of
    # lingering as a zombie that holds the lock but does no work.
    watchdog_timeout_s: float = float(os.environ.get("WATCHDOG_TIMEOUT_S", "60"))


# ============================================================================
# Logging — timestamps pinned to Asia/Jakarta (GMT+7) regardless of host TZ.
# ============================================================================
from datetime import datetime
from zoneinfo import ZoneInfo

_TZ = ZoneInfo("Asia/Jakarta")


class _JakartaFormatter(logging.Formatter):
    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created, tz=_TZ)
        return dt.strftime(datefmt or "%Y-%m-%dT%H:%M:%S")


_handler = logging.StreamHandler()
_handler.setFormatter(_JakartaFormatter("%(asctime)s [%(levelname)s] %(message)s",
                                       datefmt="%Y-%m-%dT%H:%M:%S"))
logging.basicConfig(level=logging.INFO, handlers=[_handler], force=True)
log = logging.getLogger("anpr-worker")


# ============================================================================
# HTTP helpers (stdlib only)
# ============================================================================
def _http(method: str, url: str, body: dict | None = None) -> dict | None:
    """Returns parsed JSON dict on success or None on failure."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=Config.http_timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Backend returns 4xx/5xx with JSON body too — parse it.
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            log.warning("HTTP %s %s -> %d %s", method, url, e.code, e.reason)
            return None
    except Exception as e:  # noqa: BLE001
        log.warning("HTTP %s %s failed: %s", method, url, e)
        return None


def backend_get(path: str) -> dict | None:
    return _http("GET", Config.backend_url + path)


def backend_post(path: str, body: dict | None = None) -> dict | None:
    return _http("POST", Config.backend_url + path, body or {})


# ============================================================================
# Shared state (read by handlers, refreshed by background threads)
# ============================================================================
class State:
    settings: dict[str, str] = {}
    channels: list[dict] = []
    recent_plates: dict[str, float] = {}  # key = "sn|license" -> last seen epoch
    sn_layout: dict[str, str] = {}         # device_sn -> "standard" | "snfirst" (learned from up-topics)
    lock = threading.Lock()
    stop = threading.Event()
    mqtt_client: "mqtt.Client | None" = None
    # Liveness heartbeat: epoch of the last cron-tick iteration. The watchdog
    # watches this; the tick loop bumps it every pass. 0.0 until main() seeds it.
    last_tick_ok: float = 0.0
    # CORX relay ACK: buffer of recent device status msgs on the relay publish
    # topics, and the set of those topics we've subscribed to. Used to confirm a
    # relay command actually landed (device echoes our `res` within ~220ms).
    relay_pubs: list = []          # (recv_ts, topic, payload_dict)
    relay_subs: set = set()        # relay publish topics currently subscribed
    relay_last_seen: dict = {}     # pub_topic -> (last_recv_epoch, res/ID) for liveness


def dedupe_window() -> float:
    """Live dedup window: CP setting `dedupe_window_s` wins over the env default,
    so it can be changed without restarting the worker. 0 (or negative) disables
    dedup entirely — handy for re-testing the same plate."""
    try:
        return float(State.settings.get("dedupe_window_s", Config.dedupe_window_s))
    except (TypeError, ValueError):
        return Config.dedupe_window_s


def is_duplicate(sn: str, license_plain: str) -> bool:
    window = dedupe_window()
    if window <= 0:
        return False
    key = f"{sn}|{license_plain}"
    now = time.time()
    with State.lock:
        last = State.recent_plates.get(key)
        if last is not None and (now - last) < window:
            return True
        State.recent_plates[key] = now
        # Sweep stale entries occasionally
        if len(State.recent_plates) > 500:
            cutoff = now - window * 5
            for k in list(State.recent_plates.keys()):
                if State.recent_plates[k] < cutoff:
                    del State.recent_plates[k]
    return False


def decode_b64_utf8(value: str | None) -> str:
    if not value:
        return ""
    try:
        return base64.b64decode(value).decode("utf-8").strip()
    except Exception:  # noqa: BLE001
        return value


def resolve_channel_for_sn(sn: str) -> dict | None:
    """Return the channel row matching this device SN, or None."""
    with State.lock:
        for c in State.channels:
            if c.get("anpr_device_sn") == sn:
                return c
    return None


def is_registered_sn(sn: str) -> bool:
    """True if this SN belongs to one of our configured ANPR cameras. On the
    shared DPR broker many unrelated devices publish; we ignore everything whose
    SN is not a channel's anpr_device_sn. Fail-OPEN while channels haven't loaded
    yet (empty list) so a transient channel-load failure doesn't blind the worker."""
    if not sn:
        return False
    with State.lock:
        chans = State.channels
        if not chans:
            return True  # not loaded yet — don't drop traffic
        return any(c.get("anpr_device_sn") == sn for c in chans)


def fallback_channel_no() -> str:
    with State.lock:
        return State.settings.get("auto_start_channel") or Config.fallback_channel


def auto_start_enabled() -> bool:
    with State.lock:
        return State.settings.get("auto_start_s300") in ("1", "true", "True")


# ============================================================================
# Recognition handler
# ============================================================================
def handle_recognition(topic: str, payload: str) -> None:
    try:
        data: dict[str, Any] = json.loads(payload)
    except json.JSONDecodeError:
        log.warning("ivs_result JSON parse failed")
        return

    sn = data.get("sn")
    plate_info = (data.get("payload") or {}).get("AlarmInfoPlate") or {}
    result = (plate_info.get("result") or {}).get("PlateResult") or {}
    if not sn or not result:
        return

    license_plain = decode_b64_utf8(result.get("license"))
    if not license_plain:
        return

    if is_duplicate(sn, license_plain):
        log.info("duplicate plate within %ss: %s — skipping", dedupe_window(), license_plain)
        return

    # Resolve which channel this camera belongs to, and route by kind
    channel = resolve_channel_for_sn(sn)
    kind = (channel or {}).get("kind", "entry")
    channel_no = (channel or {}).get("channel_no") or fallback_channel_no()

    log.info(
        'detected plate "%s" sn=%s channel=%s(%s) confidence=%s direction=%s',
        license_plain, sn, channel_no, kind, result.get("confidence"), result.get("direction"),
    )

    # 1) record vehicle (audit log — every detection, both entry and exit)
    vehicle_body = {
        "license_plate":        license_plain,
        "plate_type":           result.get("type"),
        "plate_color":          result.get("colorType"),
        "car_color":            result.get("carColor"),
        "confidence":           result.get("confidence"),
        "direction":            result.get("direction"),
        "trigger_type":         result.get("triggerType"),
        "is_fake_plate":        result.get("is_fake_plate"),
        "anpr_device_sn":       sn,
        "image_path":           result.get("imagePath") or None,
        "image_fragment_path":  result.get("imageFragmentPath") or None,
        # Base64 JPEGs from ivs_result — the backend saves them to files.
        "full_image_b64":       result.get("full_image_content") or None,
        "small_image_b64":      result.get("small_image_content") or None,
        "unique_id":            result.get("unique_id") or None,
        "detected_at":          time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    veh_res = backend_post("/api/vehicles", vehicle_body)
    if veh_res and veh_res.get("code") == 200:
        log.info("  vehicle logged (id=%s)", veh_res["data"]["id"])
    else:
        log.warning("  vehicle log failed: %s", (veh_res or {}).get("message", "no response"))

    # 2) Route by channel kind
    if kind == "exit":
        # Exit detection: close out the visit (or log orphan)
        exit_res = backend_post(
            "/api/visits/record-exit",
            {"license_plate": license_plain, "exit_channel_no": channel_no},
        )
        if exit_res and exit_res.get("code") == 200:
            d = exit_res.get("data") or {}
            if d.get("kind") == "completed":
                log.info("  exit recorded — visit #%s closed", d.get("visitId"))
            elif d.get("kind") == "orphan_exit":
                log.warning("  ORPHAN EXIT — plate has no active entry record (visit #%s)", d.get("visitId"))
        else:
            log.warning("  exit record failed: %s", (exit_res or {}).get("message", "no response"))
        return

    if kind == "xray":
        # X-ray room entry camera: any recognized plate opens the room's entry
        # gate (the room's exit gate is vendor-driven by the x-ray receipt).
        room_res = backend_post(
            f"/api/xray/room-come/{urllib.parse.quote(channel_no)}",
            {"licensePlateNo": license_plain},
        )
        if room_res and room_res.get("code") == 200:
            log.info("  x-ray room — entry gate open queued")
        else:
            log.warning("  x-ray room come failed: %s", (room_res or {}).get("message", "no response"))
        return

    # Entry detection (kind == 'entry') — original flow
    if not auto_start_enabled():
        log.info("  auto_start_s300 OFF — not calling /come")
        return

    status = backend_get(f"/api/channels/by-no/{urllib.parse.quote(channel_no)}/status")
    if status and (status.get("data") or {}).get("busy"):
        active_plate = ((status["data"].get("active") or {}).get("license_plate"))
        log.info("  channel %s busy (%s) — skipping", channel_no, active_plate)
        return

    come_res = backend_post(
        f"/api/s300/come/{urllib.parse.quote(channel_no)}",
        {"licensePlateNo": license_plain},
    )
    if come_res and come_res.get("code") == 200:
        is_vip = bool((come_res.get("data") or {}).get("vip"))
        log.info(
            "  /come ok — inspection #%s%s",
            come_res["data"]["inspectionId"], " (VIP)" if is_vip else "",
        )
    elif come_res and come_res.get("code") == 409:
        log.info("  /come 409 — channel %s busy at backend", channel_no)
    else:
        log.warning("  /come failed: %s", (come_res or {}).get("message", "no response"))


# ============================================================================
# Periodic background tasks
# ============================================================================
def refresh_settings_loop() -> None:
    while not State.stop.is_set():
        res = backend_get("/api/settings")
        if res and res.get("code") == 200:
            with State.lock:
                State.settings = res["data"] or {}
        State.stop.wait(Config.settings_poll_s)


def refresh_channels_loop() -> None:
    while not State.stop.is_set():
        res = backend_get("/api/channels")
        if res and res.get("code") == 200:
            with State.lock:
                State.channels = res["data"] or []
        State.stop.wait(Config.channels_poll_s)


def cron_tick_loop() -> None:
    while not State.stop.is_set():
        # Bump the liveness heartbeat first thing: this proves the loop thread is
        # alive and running, independent of whether the backend answers. (A
        # backend outage is not our fault and restarting wouldn't help, so the
        # watchdog must not key off backend reachability — only off this loop.)
        State.last_tick_ok = time.time()
        res = backend_post("/api/cron/tick", {})
        # Defensive parsing: a single malformed item must never kill this thread
        # (that was the original zombie bug — an unguarded r["..."] KeyError).
        try:
            if res and res.get("code") == 200:
                data = res.get("data") or {}
                for r in (data.get("resolved") or []):
                    log.info(
                        "tick: forced %s for inspection #%s (%s) — %s",
                        r.get("decision"), r.get("inspectionId"), r.get("plate"), r.get("reason"),
                    )
                for r in (data.get("forced_complete") or []):
                    log.warning(
                        "tick: watchdog force-completed stuck reset on inspection #%s (%s)",
                        r.get("inspectionId"), r.get("plate"),
                    )
        except Exception:  # noqa: BLE001
            log.exception("tick loop: error processing /api/cron/tick response")
        State.stop.wait(Config.tick_interval_s)


def global_log_loop() -> None:
    """Drain the global-log queue: POST each pending payload to the partner
    receiver (gateCarEntry), then report sent/failed to the backend. The target
    URL + enabled flag come from the backend (settings), so this is a no-op
    until global_log_enabled=1."""
    while not State.stop.is_set():
        try:
            res = backend_get("/api/global-log/pending?limit=20")
            data = (res or {}).get("data") or {} if (res or {}).get("code") == 200 else {}
            url = data.get("url")
            if not data.get("enabled") or not url:
                State.stop.wait(max(5.0, Config.global_log_poll_s))
                continue
            for item in (data.get("items") or []):
                qid = item["id"]
                resp = _http("POST", url, item.get("payload") or {})
                # Success = the receiver's own resultCode 0 (or status 200).
                ok = bool(resp) and (resp.get("resultCode") == 0 or resp.get("status") == 200)
                if ok:
                    backend_post(f"/api/global-log/{qid}/sent", {})
                    log.info("global-log: sent %s/%s (queue#%s)",
                             item.get("event_id"), item.get("phase"), qid)
                else:
                    err = "no response" if resp is None else json.dumps(resp)[:200]
                    backend_post(f"/api/global-log/{qid}/failed", {"error": err})
                    log.warning("global-log: FAILED %s/%s (queue#%s): %s",
                                item.get("event_id"), item.get("phase"), qid, err)
        except Exception as e:  # noqa: BLE001
            log.warning("global_log_loop error: %s", e)
        State.stop.wait(Config.global_log_poll_s)


def run_supervised(fn, name: str, restart_delay_s: float = 3.0) -> None:
    """Run a background loop, restarting it if it ever raises.

    Background loops are daemon threads; without this, one unhandled exception
    silently kills the thread and leaves the worker a zombie — process alive and
    holding the singleton lock, but no longer doing its job. We log the crash
    and restart the loop until State.stop is set. A clean return means stop was
    requested, so we exit the supervisor too.
    """
    while not State.stop.is_set():
        try:
            fn()
            return
        except Exception:  # noqa: BLE001
            log.exception("thread '%s' crashed — restarting in %.0fs", name, restart_delay_s)
            State.stop.wait(restart_delay_s)


def watchdog_loop() -> None:
    """Last-resort liveness backstop.

    run_supervised handles ordinary crashes. This catches the kind of wedge it
    cannot — a thread blocked indefinitely, an unforeseen deadlock — that would
    otherwise reproduce the original zombie. If the heartbeat goes stale past
    Config.watchdog_timeout_s we log CRITICAL and force-exit; systemd
    'Restart=on-failure' (prod) brings us back, and any fresh start auto-reclaims
    the singleton lock via acquire_singleton_lock().
    """
    # Require TWO consecutive stale checks before acting. A single stale reading
    # can be a benign blip (e.g. a dev laptop resuming from sleep, where the tick
    # thread just hasn't been rescheduled yet); a genuinely dead heartbeat stays
    # stale across checks. This removes the only false-positive path.
    interval = max(5.0, Config.watchdog_timeout_s / 2)
    stale_strikes = 0
    while not State.stop.is_set():
        State.stop.wait(interval)
        if State.stop.is_set():
            break
        age = time.time() - State.last_tick_ok
        if age > Config.watchdog_timeout_s:
            stale_strikes += 1
            log.warning(
                "watchdog: heartbeat stale for %.0fs (> %.0fs) — strike %d/2",
                age, Config.watchdog_timeout_s, stale_strikes,
            )
            if stale_strikes >= 2:
                log.critical("watchdog: heartbeat dead — force-exiting for restart")
                os._exit(3)
        else:
            stale_strikes = 0


def gen_id() -> str:
    import secrets, string
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(16))


def blocker_pub_topics() -> set:
    """Effective relay publish topics: each blocker-enabled lane's own pub topic,
    plus the global default (single-lane blocker)."""
    topics = set()
    with State.lock:
        for c in State.channels:
            if str(c.get("blocker_relay_enabled")) in ("1", "True", "true") and c.get("blocker_relay_pub_topic"):
                topics.add(c["blocker_relay_pub_topic"])
    topics.add(State.settings.get("blocker_relay_pub_topic") or "testpublish")
    return topics


def ensure_blocker_subs() -> None:
    """Subscribe to any relay publish topics we're not yet watching (lazy, picks
    up newly-configured lanes)."""
    if State.mqtt_client is None:
        return
    for t in blocker_pub_topics():
        if t not in State.relay_subs:
            try:
                State.mqtt_client.subscribe(t, qos=0)
                State.relay_subs.add(t)
                log.info("subscribed relay pub (monitor): %s", t)
            except Exception:  # noqa: BLE001
                pass


def blocker_heartbeat_loop() -> None:
    """Report relay liveness to the backend. The device publishes a heartbeat
    every ~10s; we forward a ping per active topic so the dashboard shows a real
    online/offline (not just the enabled flag)."""
    while not State.stop.is_set():
        ensure_blocker_subs()
        now = time.time()
        with State.lock:
            seen = list(State.relay_last_seen.items())
        for topic, (ts, res) in seen:
            if now - ts < 15:  # only report topics that actually got a heartbeat
                backend_post("/api/road-blocker/heartbeat", {"pub_topic": topic, "res": res})
        State.stop.wait(5.0)


def confirm_relay_ack(cmd_id, ack: dict, publish_ts: float, timeout: float = 1.3) -> None:
    """Confirm a CORX relay command landed: the device publishes a status echoing
    our `res` (and the pulsed relay going high) within ~220ms. Reports the outcome
    to the backend so a dead/unresponsive relay is visible, not silently lost."""
    res = str(ack.get("res"))
    expect_ch = ack.get("expect_ch")
    matched = None
    while time.time() < publish_ts + timeout and not State.stop.is_set():
        with State.lock:
            for recv_ts, _tp, j in reversed(State.relay_pubs):
                if recv_ts < publish_ts:
                    break
                if str(j.get("res")) == res:
                    matched = (recv_ts, j)
                    break
        if matched:
            break
        State.stop.wait(0.05)
    if matched:
        recv_ts, j = matched
        ms = int((recv_ts - publish_ts) * 1000)
        log.info("relay ACK res=%s +%dms %s=%s", res, ms, expect_ch, j.get(expect_ch))
        backend_post("/api/road-blocker/ack", {
            "queue_id": cmd_id, "res": res, "ok": True,
            "latency_ms": ms, "expect_ch": expect_ch, "ch_state": j.get(expect_ch),
        })
    else:
        log.warning("relay NO ACK res=%s within %.1fs — relay offline?", res, timeout)
        backend_post("/api/road-blocker/ack", {
            "queue_id": cmd_id, "res": res, "ok": False, "latency_ms": None,
        })


def mqtt_outbound_loop() -> None:
    """Drain mqtt_outbound_queue: publish each pending command, then report back."""
    while not State.stop.is_set():
        try:
            res = backend_get("/api/mqtt-queue/pending?limit=20")
            items = (res or {}).get("data") or [] if (res or {}).get("code") == 200 else []
            for item in items:
                cmd_id = item["id"]
                device_sn = item["device_sn"]
                command = item["command_name"]
                payload = item["payload"]

                # CORX road-blocker relay: publish the raw JSON body to the relay's
                # own subscribe topic (no camera envelope, no device/{sn}/ topic).
                if command == "corx_relay":
                    topic = (payload or {}).get("topic")
                    body = (payload or {}).get("body") or {}
                    ack = (payload or {}).get("ack") or {}
                    pub_topic = ack.get("pub_topic")
                    # Subscribe to the device's status topic BEFORE publishing so we
                    # can catch its ~220ms reply echoing our `res`.
                    if pub_topic and pub_topic not in State.relay_subs:
                        try:
                            State.mqtt_client.subscribe(pub_topic, qos=0)
                            State.relay_subs.add(pub_topic)
                        except Exception:  # noqa: BLE001
                            pass
                    publish_ts = time.time()
                    try:
                        # The CORX relay firmware parses the raw payload strictly and
                        # ignores anything with whitespace — it needs COMPACT JSON
                        # ({"A02":210001,"res":"123"}), not json.dumps' default spaced
                        # form ({"A02": 210001, "res": "123"}). Force compact separators.
                        raw = json.dumps(body, separators=(",", ":"))
                        rc = State.mqtt_client.publish(topic, raw, qos=0).rc
                        if rc == mqtt.MQTT_ERR_SUCCESS:
                            backend_post(f"/api/mqtt-queue/{cmd_id}/sent", {})
                            log.info("outbound: corx_relay %s -> %s %s (queue#%s)",
                                     (payload or {}).get("label"), topic, raw, cmd_id)
                            if pub_topic and ack.get("res"):
                                confirm_relay_ack(cmd_id, ack, publish_ts)
                        else:
                            backend_post(f"/api/mqtt-queue/{cmd_id}/failed", {"error": f"paho rc={rc}"})
                            log.warning("outbound: corx_relay publish rc=%s for queue#%s", rc, cmd_id)
                    except Exception as e:  # noqa: BLE001
                        backend_post(f"/api/mqtt-queue/{cmd_id}/failed", {"error": str(e)})
                        log.warning("outbound: corx_relay exception for queue#%s: %s", cmd_id, e)
                    continue

                # Two down-topic layouts exist in the field:
                #   standard (sim/docs):  device/{sn}/message/down/{name}
                #   sn-first (some cams): {sn}/device/message/down/{name}
                # Publish to the ONE layout this device actually uses (learned from
                # its up-messages) — some cameras act on BOTH, which double-fires
                # the command (e.g. gate opens twice per recognition). Fall back to
                # both only when the device's layout is not yet known.
                layout = State.sn_layout.get(device_sn)
                if layout == "standard":
                    topics = [f"device/{device_sn}/message/down/{command}"]
                elif layout == "snfirst":
                    topics = [f"{device_sn}/device/message/down/{command}"]
                else:
                    topics = [
                        f"device/{device_sn}/message/down/{command}",
                        f"{device_sn}/device/message/down/{command}",
                    ]
                envelope = {
                    "id": gen_id(),
                    "sn": device_sn,
                    "name": command,
                    "version": "1.0",
                    "timestamp": int(time.time()),
                    # payload.type is required by the camera protocol (e.g. §7.8); it
                    # mirrors the command name, same as the top-level `name` field.
                    "payload": {"type": command, "body": payload},
                }
                try:
                    rcs = [State.mqtt_client.publish(tp, json.dumps(envelope), qos=0).rc for tp in topics]
                    if any(rc == mqtt.MQTT_ERR_SUCCESS for rc in rcs):
                        backend_post(f"/api/mqtt-queue/{cmd_id}/sent", {})
                        log.info("outbound: published %s -> %s (queue#%s)", command, device_sn, cmd_id)
                    else:
                        backend_post(f"/api/mqtt-queue/{cmd_id}/failed",
                                     {"error": f"paho rc={rcs}"})
                        log.warning("outbound: publish rc=%s for queue#%s", rcs, cmd_id)
                except Exception as e:  # noqa: BLE001
                    backend_post(f"/api/mqtt-queue/{cmd_id}/failed", {"error": str(e)})
                    log.warning("outbound: exception for queue#%s: %s", cmd_id, e)
        except Exception:  # noqa: BLE001
            log.exception("outbound loop error")
        State.stop.wait(Config.outbound_poll_s)


# ============================================================================
# MQTT callbacks
# ============================================================================
def on_connect(client, userdata, flags, reason_code, properties=None):
    # paho v1.x passes an int rc; v2.x passes a ReasonCode object whose numeric
    # code lives in .value (int() is NOT supported on ReasonCode).
    if reason_code is None:
        rc = 0
    else:
        rc = int(getattr(reason_code, "value", reason_code))
    if rc != 0:
        log.error("MQTT connect failed rc=%s", rc)
        return
    log.info("MQTT connected")
    # Catch every up/* message (ivs_result, keep_alive, gpio_in, gate_status...).
    # Two layouts exist in the field, so subscribe to both:
    #   device/{sn}/message/up/{name}  (simulator / docs)
    #   {sn}/device/message/up/{name}  (some real cameras put the SN first)
    for filt in ("device/+/message/up/+", "+/device/message/up/+"):
        client.subscribe(filt, qos=0)
        log.info("subscribed: %s", filt)
    # Re-subscribe to relay publish topics (heartbeat/ACK) — a reconnect drops
    # broker-side subscriptions, so resubscribe everything we know about.
    for t in blocker_pub_topics() | set(State.relay_subs):
        client.subscribe(t, qos=0)
        State.relay_subs.add(t)


def on_disconnect(client, userdata, *args):
    # paho v1.x: on_disconnect(client, userdata, rc)
    # paho v2.x: on_disconnect(client, userdata, flags, reason_code, properties)
    rc = args[-2] if len(args) >= 2 else (args[0] if args else "?")
    log.warning("MQTT disconnected (rc=%s) — paho will auto-reconnect", rc)


def on_message(client, userdata, msg):
    raw = msg.payload.decode("utf-8", errors="replace")

    # CORX relay status topic: buffer for command-ACK matching, then stop — these
    # are not camera messages and must not run the camera pipeline below.
    if msg.topic in State.relay_subs:
        try:
            j = json.loads(raw)
        except Exception:  # noqa: BLE001
            j = None
        if isinstance(j, dict):
            with State.lock:
                State.relay_pubs.append((time.time(), msg.topic, j))
                if len(State.relay_pubs) > 200:
                    State.relay_pubs = State.relay_pubs[-200:]
                # Liveness: the relay publishes a status/heartbeat every ~10s.
                State.relay_last_seen[msg.topic] = (time.time(), str(j.get("res") or j.get("ID") or ""))
        return
    # Parse topic to extract device_sn and message_name. The SN position depends
    # on the layout:
    #   device/{sn}/message/up/{name} -> parts[0]=='device', sn=parts[1]
    #   {sn}/device/message/up/{name} -> parts[1]=='device', sn=parts[0]
    parts = msg.topic.split("/")
    if len(parts) >= 2 and parts[0] == "device":
        device_sn = parts[1]
        State.sn_layout[device_sn] = "standard"
    elif len(parts) >= 2 and parts[1] == "device":
        device_sn = parts[0]
        State.sn_layout[device_sn] = "snfirst"
    else:
        device_sn = parts[1] if len(parts) > 1 else ""
    message_name = parts[-1] if parts else ""

    # Ignore devices that aren't ours. The shared broker carries many unrelated
    # SNs; only messages from a configured ANPR camera get logged + processed.
    if not is_registered_sn(device_sn):
        return

    # 1) Fire-and-forget log to backend (every inbound message)
    try:
        payload_obj = json.loads(raw)
    except Exception:  # noqa: BLE001
        payload_obj = {"_raw": raw[:2000]}
    try:
        backend_post("/api/mqtt-log/inbound", {
            "device_sn":    device_sn,
            "topic":        msg.topic,
            "message_name": message_name,
            "payload":      payload_obj,
        })
    except Exception:  # noqa: BLE001
        log.exception("mqtt-log/inbound POST failed")

    # 2) Existing recognition routing (only for ivs_result)
    if message_name == "ivs_result":
        try:
            handle_recognition(msg.topic, raw)
        except Exception:  # noqa: BLE001
            log.exception("unhandled error in handle_recognition")


# ============================================================================
# Main
# ============================================================================
def parse_broker_url(url: str) -> tuple[str, int]:
    """Returns (host, port) from a mqtt://host:port URL."""
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("mqtt", "tcp", ""):
        log.warning("Unrecognised MQTT scheme %r — treating as raw TCP", p.scheme)
    host = p.hostname or "127.0.0.1"
    port = p.port or 1883
    return host, port


def _find_pid_holding_port(port: int) -> int | None:
    """Return the PID listening on 127.0.0.1:port, or None.

    Cross-platform stdlib only: parses `netstat -ano` on Windows and
    `lsof -ti tcp:PORT -sTCP:LISTEN` on POSIX.
    """
    import subprocess
    try:
        if sys.platform == "win32":
            out = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=5,
            ).stdout
            needle = f":{port} "
            for line in out.splitlines():
                if needle in line and "LISTENING" in line:
                    parts = line.split()
                    if parts and parts[-1].isdigit():
                        return int(parts[-1])
        else:
            out = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            if out:
                return int(out.splitlines()[0])
    except Exception:  # noqa: BLE001
        return None
    return None


def _kill_pid(pid: int) -> bool:
    """Terminate a process by PID. Returns True if we believe it's dead."""
    import subprocess
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=5)
        else:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.3)
            try: os.kill(pid, 0)  # still alive?
            except ProcessLookupError: return True
            os.kill(pid, signal.SIGKILL)
        return True
    except Exception:  # noqa: BLE001
        return False


def acquire_singleton_lock(port: int) -> socket.socket:
    """Bind a loopback TCP port as a process-wide singleton lock.

    The OS guarantees only one process can hold the port; on any process
    exit (graceful or crash) the OS frees it — no stale-lock cleanup.

    If a previous worker (or some other process) is already holding the port,
    we identify it, terminate it, and take over. This makes restart-after-crash
    trivial: just run the script again.
    """
    def _bind() -> socket.socket:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # SO_REUSEADDR not set — we want bind() to fail loudly when port is taken.
        s.bind(("127.0.0.1", port))
        s.listen(1)
        return s

    try:
        return _bind()
    except OSError:
        # Someone else owns the port. Find them and kill them.
        old_pid = _find_pid_holding_port(port)
        if old_pid is None:
            raise RuntimeError(
                f"Port {port} is in use but the owning PID could not be identified. "
                f"Free the port manually or override WORKER_SINGLETON_PORT in .env."
            )
        if old_pid == os.getpid():
            # Defensive — should be impossible
            raise RuntimeError(f"Port {port} is held by this very process (PID {old_pid})")
        log.warning("Phantom worker holding port %d (PID %d) — terminating", port, old_pid)
        if not _kill_pid(old_pid):
            raise RuntimeError(
                f"Failed to terminate phantom worker PID {old_pid} on port {port}. "
                f"Kill it manually and retry."
            )
        # Wait for the OS to release the port. Windows can take a beat.
        for _ in range(20):  # up to ~2s
            time.sleep(0.1)
            try:
                return _bind()
            except OSError:
                continue
        raise RuntimeError(
            f"Killed PID {old_pid} but port {port} still busy. The OS may need a moment — try again."
        )


def main() -> int:
    # Acquire singleton lock BEFORE any side effects (no MQTT, no DB writes).
    try:
        singleton_sock = acquire_singleton_lock(Config.singleton_port)
    except RuntimeError as e:
        # Print to stderr too so it shows up clearly when run from a terminal.
        print(f"ERROR: {e}", file=sys.stderr)
        log.error(str(e))
        return 2

    log.info("Singleton lock acquired on 127.0.0.1:%d", Config.singleton_port)
    log.info("Starting ANPR MQTT Worker")
    log.info("  MQTT broker:    %s", Config.mqtt_broker)
    log.info("  Backend URL:    %s", Config.backend_url)
    log.info("  Client ID:      %s", Config.mqtt_client_id)
    log.info("  Tick interval:  %ss", Config.tick_interval_s)
    log.info("  Dedupe window:  %ss", Config.dedupe_window_s)

    # Background threads — every loop runs under run_supervised so a crash is
    # logged and auto-restarted instead of silently killing the thread. The
    # watchdog is the backstop for wedges the supervisor can't catch.
    State.last_tick_ok = time.time()  # seed before the watchdog can fire
    loops = [
        (refresh_settings_loop, "settings-loop"),
        (refresh_channels_loop, "channels-loop"),
        (cron_tick_loop,        "tick-loop"),
        (mqtt_outbound_loop,    "outbound-loop"),
        (global_log_loop,       "global-log"),
        (blocker_heartbeat_loop, "blocker-hb"),
        (watchdog_loop,         "watchdog"),
    ]
    threads = [
        threading.Thread(target=run_supervised, args=(fn, name), name=name, daemon=True)
        for fn, name in loops
    ]
    for t in threads:
        t.start()

    # MQTT client (compat with paho-mqtt 1.x and 2.x)
    if _PAHO_V2:
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=Config.mqtt_client_id,
            clean_session=True,
        )
    else:
        client = mqtt.Client(client_id=Config.mqtt_client_id, clean_session=True)
    if Config.mqtt_username:
        client.username_pw_set(Config.mqtt_username, Config.mqtt_password or "")
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    State.mqtt_client = client

    host, port = parse_broker_url(Config.mqtt_broker)

    def shutdown(signum, frame):  # noqa: ARG001
        log.info("received signal %s — shutting down...", signum)
        State.stop.set()
        try:
            client.disconnect()
        except Exception:  # noqa: BLE001
            pass

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        client.connect(host, port, keepalive=60)
    except Exception as e:  # noqa: BLE001
        log.error("Initial MQTT connect failed: %s — paho will retry in background", e)

    # Blocks until disconnect()
    client.loop_forever(retry_first_connection=True)

    State.stop.set()
    try:
        singleton_sock.close()
    except Exception:  # noqa: BLE001
        pass
    log.info("Bye.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
