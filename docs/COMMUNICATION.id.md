# Referensi Komunikasi Perangkat

Bagaimana setiap perangkat di platform ini saling berkomunikasi: protokol mana,
topik / endpoint mana, ke arah mana, dan payload apa yang dibawa. Baca dokumen
ini bersama [`ARCHITECTURE.id.md`](./ARCHITECTURE.id.md) untuk gambaran
komponen tingkat tinggi.

---

## Aktor

| Perangkat / proses | Protokol | Terhubung ke | Identifier |
|------------------|----------|-------------|------------|
| Kamera ANPR Entry (RJ001) | MQTT (pub/sub) | Mosquitto :1883 | `sn = 265e1040-85e01fb7` |
| Kamera ANPR Exit (RJ002)  | MQTT (pub/sub) | Mosquitto :1883 | `sn = EXIT-CAM-001` |
| Robot Inspeksi S300       | HTTP (dua arah) | platform :80 + s300 :8086 | `channel_no = RJ001`, `s300_base_url` |
| Road blocker              | TCP socket | rb_ip : rb_port | `rb_device_no`, `rb_board_id` |
| Python worker             | MQTT + HTTP | broker :1883 + backend :80 | satu per platform |
| Frontend (browser tab)    | HTTP + MQTT WS | backend :80 + broker :8083 | satu per pengguna |

Platform sendiri berperan sebagai orchestrator. Platform tidak pernah
menjangkau perangkat secara langsung melalui alamat yang di-hardcode — setiap
endpoint diambil dari tabel `channels` saat runtime, sehingga mengganti
hardware adalah perubahan konfigurasi, bukan perubahan kode.

---

## Kamera ANPR (entry + exit)

Kedua kamera **hanya berbicara MQTT**. Broker adalah satu-satunya titik
integrasi — platform tidak pernah membuka TCP socket ke kamera, dan kamera
tidak pernah mem-POST HTTP balik ke platform.

### Up (kamera → platform)

| Topik | Kapan | Payload (field kunci) |
|-------|------|----------------------|
| `device/{sn}/message/up/ivs_result`     | setiap pengenalan plat | `AlarmInfoPlate.result.PlateResult.license` (base64), `confidence`, `direction`, `colorType`, `triggerType`, `unique_id` |
| `device/{sn}/message/up/keep_alive`     | setiap 10 detik | `timestamp` |
| `device/{sn}/message/up/gpio_in`        | trigger IO (loop detector dll.) | `AlarmGioIn.TriggerResult.source`, `value` |
| `device/{sn}/message/up/barr_gate_status` | barrier fisik naik / turun | `gate_status`, `connect_status`, `enable` |

### Down (platform → kamera)

| Topik | Kapan platform mengirimnya | Payload (field kunci) |
|-------|---------------------------|----------------------|
| `device/{sn}/message/down/white_list_operator` | add one-time-pass di kamera exit (saat entry PASS / VIP_PASS) dan delete (saat deteksi exit) | `operator_type`: `add` ‖ `delete`; untuk add: `dldb_rec[].plate`, `enable_time`, `overdue_time`; untuk delete: `plate` |
| `device/{sn}/message/down/tts_voice`           | prompt kegagalan ("silakan mundur") | audio terindeks |
| `device/{sn}/message/down/gate_direct_open`    | paksa-buka barrier (manual override) | — |
| `device/{sn}/message/down/{cmd}/reply`         | kamera meng-ACK setiap perintah down | `code`, `id` asli |

**Mode whitelist pada kamera exit** — ANPR exit menolak plat apa pun yang
tidak ada di whitelist lokalnya. Platform menulis ke whitelist tersebut melalui
`white_list_operator` ketika sebuah kendaraan lolos inspeksi di entry. Saat
kendaraan keluar, worker menghapus entri tersebut. Begitulah cara aturan "exit
hanya membuka untuk kendaraan yang sudah masuk" ditegakkan.

---

## Robot Inspeksi S300

**HTTP murni, dua arah.** Tanpa MQTT. Platform menjalankan HTTP server (di
`/overseas/s300/...`) untuk callback masuk, dan bertindak sebagai HTTP client
untuk perintah keluar.

### Inbound (S300 → platform)

| Method + path | S300 cmd | Apa yang dibawa |
|---------------|----------|-----------------|
| `POST /overseas/s300/work-status`    | 322 | `operating_state`: 0=ready · 1=inspecting · 2=resetting · 3=completed · 4=e-stop · 5=failed · 6=started |
| `POST /overseas/s300/face-image`     | 323 | JPEG base64 pengemudi / penumpang |
| `POST /overseas/s300/video-record`   | 325 | path stream video |
| `POST /overseas/s300/uvis`           | 326 | hasil scan kolong — `result`: clean / suspect, koordinat kargo |
| `POST /overseas/s300/reset-complete` | 326 | "reset selesai, siap untuk kendaraan berikutnya" |

### Outbound (platform → S300)

| Method + path | Digunakan oleh | Apa yang platform minta |
|---------------|---------|------------------------|
| `POST {s300_base_url}/come/{ch}`             | worker (otomatis saat plat entry) atau operator | mulai siklus; body `{ licensePlateNo }` |
| `GET  {s300_base_url}/capture/{ch}`          | operator | paksa capture tambahan |
| `GET  {s300_base_url}/leave/{ch}`            | DecisionExecutor | lepaskan kendaraan, mulai reset |
| `POST {s300_base_url}/emergency-stop/{ch}`   | operator | abort |
| `POST {s300_base_url}/manual-reset/{ch}`     | operator | paksa-reset dari kondisi stuck |
| `POST {s300_base_url}/read-work-status/{ch}` | watchdog | baca ulang state saat dicurigai stall |
| `POST {s300_base_url}/audio-prompt`          | DecisionExecutor (fail) | putar audio terindeks (prompt kegagalan = index 7) |

### State S300 vs state platform

Tabel `inspections` melacak keduanya:

- `current_operating_state` — cermin dari yang terakhir dilaporkan S300 (kolom
  = angka mentah 0-5 dari cmd 322).
- `state` — lifecycle platform (`pending` → `started` → `inspecting` →
  `resetting` → `completed`).

Hanya event HTTP dari S300 dan callback `reset-complete` yang menggerakkan
`state` maju. Pemisahan ini sebabnya `work-status=3` sesaat tidak prematurly
menandai inspeksi sebagai selesai — platform menunggu `reset-complete`.

---

## Road Blocker

**TCP socket** mentah ke `rb_ip:rb_port`, dengan `rb_board_id` +
`rb_device_no` + `rb_column_num` perangkat dibingkai di dalam setiap request.
Dipanggil hanya oleh `RoadBlockerService` backend dari `DecisionExecutor` saat
keputusannya PASS / SUSPECT / VIP_PASS. Tidak ada sisi subscribe —
fire-and-forget.

Setiap baris `channels` membawa semua yang diperlukan:

```
rb_ip        VARCHAR(64)    mis. 127.0.0.1
rb_port      INT            mis. 8086
rb_device_no VARCHAR(64)    mis. DEV001
rb_board_id  VARCHAR(64)    mis. 01
rb_column_num INT           biasanya 1
```

---

## Python Worker (jembatan)

Worker tidak punya UI, tidak punya state persisten, dan tidak punya logika
bisnis selain "kenali, log, route". Worker ada agar platform tetap berjalan
ketika tidak ada yang membuka browser.

### Subscribe (MQTT)

| Topik | Tujuan |
|-------|---------|
| `device/+/message/up/+` | menangkap setiap pesan kamera (ivs_result, keep_alive, gpio_in, barr_gate_status) |

### Publish (MQTT)

| Topik | Sumber |
|-------|--------|
| `device/{sn}/message/down/{cmd}` | dikuras dari `mqtt_outbound_queue` |

### Panggilan backend (HTTP)

| Verb | Path | Kapan |
|------|------|------|
| POST | `/api/mqtt-log/inbound`        | setiap pesan MQTT diterima (fire-and-forget) |
| POST | `/api/vehicles`                | baris audit untuk setiap deteksi plat |
| GET  | `/api/channels/by-no/{ch}/status` | cek busy sebelum trigger `/come` |
| POST | `/api/s300/come/{ch}`          | deteksi entry pada channel bebas, saat `auto_start_s300=1` |
| POST | `/api/visits/record-exit`      | deteksi exit — menutup visit atau mencatat orphan_exit |
| POST | `/api/cron/tick`               | setiap 5 detik — menyapu UVIS timeout + watchdog reset |
| GET  | `/api/mqtt-queue/pending`      | menguras perintah outbound yang pending |
| POST | `/api/mqtt-queue/{id}/sent`    | ACK setelah publish MQTT sukses |
| POST | `/api/mqtt-queue/{id}/failed`  | melaporkan kegagalan (retry hingga 5x) |
| GET  | `/api/settings`                | refresh `auto_start_s300`, `auto_start_channel` (setiap 10 dtk) |
| GET  | `/api/channels`                | refresh routing SN perangkat ↔ channel (setiap 30 dtk) |

---

## Frontend (browser tab)

Dua kanal paralel:

- **HTTP** ke `http://host/anpr_backend/api/*` — semua tampilan yang
  berbasis DB (visits, inspections, MQTT logs, channel admin, plat VIP,
  settings).
- **MQTT WebSocket** ke `ws://host:8083/mqtt` via `mqtt.js` — panel
  pengenalan live, indikator heartbeat, event IO. **Topik yang sama dengan
  kamera**, hanya saja dikonsumsi di JS.

Frontend tidak pernah men-trigger `/come`. Keputusan itu sengaja dipindahkan
ke worker agar platform tetap mencatat dan menginspeksi meskipun browser
ditutup.

---

## End-to-end: siklus tipikal jalur entry

```
1. mobil mendekat → ANPR entry mendeteksi plat "粤A12345"
   └─ MQTT: device/265e1040-85e01fb7/message/up/ivs_result   (kamera → broker)

2. worker menerima pesan tersebut
   ├─ POST /api/mqtt-log/inbound          (log setiap pesan, async)
   ├─ POST /api/vehicles                  (baris audit)
   ├─ GET  /api/channels/by-no/RJ001/status   → busy=false
   └─ POST /api/s300/come/RJ001            (body { licensePlateNo })

3. backend
   ├─ membuat baris inspection (state=pending)
   ├─ cek vip_plates → jika cocok, short-circuit ke vip_pass + buka blocker
   └─ HTTP POST → {s300_base_url}/come/RJ001

4. S300 memulai siklus, mem-POST balik secara periodik:
   ├─ POST /overseas/s300/work-status  (op=1 inspecting)
   ├─ POST /overseas/s300/face-image
   ├─ POST /overseas/s300/uvis         (clean / suspect)
   └─ POST /overseas/s300/work-status  (op=3 completed)

5. backend.DecisionEngine melihat UVIS tiba → memutuskan pass / suspect / fail
   └─ DecisionExecutor bercabang:
      pass / suspect / vip_pass:
        ├─ buka road blocker via TCP                   (rb_ip:rb_port)
        ├─ INSERT mqtt_outbound_queue                  (white_list_operator → kamera exit, add)
        └─ HTTP GET /leave/{ch}                        (lepaskan kendaraan)
      fail:
        ├─ INSERT mqtt_outbound_queue                  (tts_voice "mundur")
        ├─ tandai baris visits denied_entry
        └─ HTTP GET /leave/{ch}

6. worker menguras outbound queue
   └─ MQTT publish device/EXIT-CAM-001/message/down/white_list_operator
                                                 ↓
                                kamera exit kini mengizinkan plat tersebut lewat

7. S300 selesai reset → POST /overseas/s300/reset-complete
   └─ baris inspection state=completed, channel bebas lagi

8. nanti, mobil yang sama keluar → ANPR exit mendeteksi "粤A12345"
   ├─ worker POST /api/visits/record-exit  → tutup visit, tandai completed
   └─ worker enqueue white_list_operator { delete } → MQTT ke kamera exit
                       (pembersihan one-time-pass)
```

---

## Cara mengamati setiap langkah secara real time

| Langkah | Di mana melihat |
|------|---------------|
| 1, 6, 8 (MQTT) | Halaman **MQTT Logs** — filter berdasarkan plat untuk melihat setiap pesan kamera terkait kendaraan tersebut |
| 2 (keputusan worker) | stdout worker / `worker.err.log` |
| 3-5 (S300 ↔ platform HTTP) | Halaman **S300 Inspection** → klik baris inspeksi untuk panel detail; event mentah juga terlihat di `inbound_events_raw` |
| 5 (decision + executor) | Tabel `inspection_status_logs` |
| 6 (queue) | Halaman **MQTT Logs** → tab Outbound |
| 8 (penutupan visit) | Halaman **Visits & Reports** |
