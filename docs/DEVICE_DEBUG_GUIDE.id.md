# Panduan Debug Perangkat — memeriksa perangkat lapangan dari server

Buku pegangan teknisi lapangan: cara membuktikan, **dari server produksi**,
apakah tiap perangkat (kamera ANPR, robot S300, push X-Ray, gerbang) hidup dan
berkomunikasi dengan platform — dan sisi mana yang rusak saat tidak. Semua blok
perintah adalah **bash di AlmaLinux**, dijalankan lewat SSH pada host prod.
Baca bersama [`COMMUNICATION.md`](./COMMUNICATION.id.md) (siapa bicara dengan
siapa) dan [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.id.md)
(port/topologi).

## Host-host

| Host | Menjalankan | Debug di sini saat… |
|------|------|----------------------|
| `10.10.33.143` | Broker Mosquitto (`:8171`) + worker Python | semua hal MQTT: kamera, relay, perintah outbound |
| `10.10.33.144` | Apache: SPA + backend `/anpr_backend` + callback `/overseas/s300/*` | semua hal HTTP: callback S300/X-Ray, API, uploads |
| `10.10.34.95:18001` | platform vendor S300 (`s300_base_url`) | kegagalan outbound `/come`, `/leave`, `/recapture` |
| laptop dev | broker `127.0.0.1:1883` + backend `http://127.0.0.1/anpr_backend` | probe yang sama, kredensial dev |

**Kredensial broker wajib** — Mosquitto berjalan dengan `allow_anonymous
false`, jadi setiap `mosquitto_sub`/`mosquitto_pub` di bawah butuh `-u`/`-P`.
Kredensial dev: `admin` / `admin123`; **kredensial prod berbeda** (user `sigap`
+ password broker prod — tanyakan ke admin, jangan pernah berasumsi pasangan
dev berlaku di prod). Dalam contoh, `-u USER -P 'PASS'` berarti "kredensial
untuk environment tempat Anda berada".

```bash
# Tooling (sekali saja, di 10.10.33.143 — klien ikut dalam paket broker)
sudo dnf install -y mosquitto
```

---

## 1. Probing MQTT (selalu dengan auth)

Jalankan ini **di `10.10.33.143`** (broker lokal di sana; ganti dengan
`-h 127.0.0.1 -p 1883` di dev).

```bash
# Pantau SEMUA uplink kamera — kedua layout topic sekaligus (lihat §2)
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t 'device/+/message/up/#' -t '+/device/message/up/#'

# Pantau satu kamera tertentu berdasarkan SN (kedua layout)
SN=320dc55b-d6d6c442
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t "device/$SN/message/up/#" -t "$SN/device/message/up/#"

# Buktikan broker sendiri merutekan (publish + lihat gaungnya di terminal lain)
mosquitto_pub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' \
  -t 'device/TEST/message/up/keep_alive' -m '{"hello":1}'
```

- `Connection error: Connection Refused: not authorised.` → `-u`/`-P` salah
  atau tidak diisi (atau Anda memakai kredensial dev di prod).
- Connection refused (TCP) → broker mati (`sudo systemctl status mosquitto`)
  atau firewall (`sudo firewall-cmd --list-ports` — `8171/tcp` harus terbuka
  ke VLAN perangkat).

## 2. Dua layout topic — selalu probe keduanya

Dua layout aktif di lapangan, dan **platform menangani keduanya**
(`worker.py` subscribe ke `device/+/message/up/+` **dan**
`+/device/message/up/+`, lalu mem-publish perintah down ke layout yang
terpantau dipakai tiap perangkat — keduanya, sampai layoutnya dipelajari):

| Layout | Topic up | Topic down |
|--------|----------|-----------|
| standar (dok/simulator) | `device/{sn}/message/up/{name}` | `device/{sn}/message/down/{name}` |
| SN-dulu (sebagian kamera nyata) | `{sn}/device/message/up/{name}` | `{sn}/device/message/down/{name}` |

Jadi saat sebuah kamera "terlihat diam", **jangan pernah** subscribe hanya ke
`device/#` — bisa jadi Anda memantau layout yang salah. Selalu pakai
subscription ganda `-t` dari §1. Kalau trafik hanya muncul di layout SN-dulu,
itu normal — tidak perlu diperbaiki, worker mempelajarinya otomatis.

## 3. Liveness kamera — heartbeat `keep_alive`

Setiap kamera mem-publish `keep_alive` kira-kira **setiap 10 detik**. Heartbeat
itu adalah sinyal liveness untuk seluruh jalur MQTT: kalau terlihat, jalur
kamera → broker sehat, terlepas dari ada-tidaknya pengenalan plat.

```bash
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t 'device/+/message/up/keep_alive' -t '+/device/message/up/keep_alive'
```

Di mana CP menampilkan sinyal yang sama:

- **Dashboard** — pill perangkat berubah online/offline berdasarkan heartbeat
  terakhir.
- Halaman **MQTT Logs** — filter nama pesan `keep_alive` untuk melihat stream
  mentah per SN perangkat (worker meneruskan setiap pesan MQTT masuk ke
  `POST /api/mqtt-log/inbound`, jadi kekosongan di sini bisa juga berarti
  *worker*-nya mati — silang-periksa dengan `mosquitto_sub` di atas; lihat §7).

Tidak ada heartbeat di kedua layout → masalah di sisi kamera: daya/jaringan,
IP/port broker salah (`10.10.33.143:8171`), atau kredensial broker yang
dikonfigurasi di kamera salah.

## 4. Tes gerbang via `gpio_out`

Tombol "Buka Gerbang" di halaman **Device Control** mengirim **pulsa relay
polos** (tanpa plat, tanpa inspeksi): `POST /api/anpr/gate-open {channel_no}`
membangun perintah `gpio_out` dari setting `entry_gate_io` (default `0`),
`entry_gate_value` (default `2` = pulse), dan `entry_gate_pulse_ms` (default
`1000`), memasukkannya ke antrean outbound (`anprc_mqtt_outbound_queue`), lalu
**worker** mem-publish-nya ke topic down kamera. Kamera meng-ACK di
`.../down/gpio_out/reply` dengan `code:200`.

Picu dari shell (ke `10.10.33.144`) sambil memantau MQTT:

```bash
# Terminal A (di 10.10.33.143): pantau perintah down + ACK
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t 'device/+/message/down/#' -t '+/device/message/down/#'

# Terminal B: tekan tombolnya, atau setara dengan
curl -s -X POST "http://10.10.33.144/anpr_backend/api/anpr/gate-open" \
  -H "Content-Type: application/json" -d '{"channel_no":"RJ001"}'
```

Verifikasi perintahnya benar-benar keluar:

```bash
# Masih ada yang pending? (harusnya kosong dalam ~1 dtk — worker menguras tiap 0,5 dtk)
curl -s "http://10.10.33.144/anpr_backend/api/mqtt-queue/pending"
```

- **MQTT Logs → tab Outbound** menampilkan tiap perintah antrean beserta
  statusnya (`pending` → `sent` / `failed`).
- Perintah **macet di `pending`** = tidak ada yang menguras antrean = **worker
  mati** (§7). Backend hanya meng-enqueue; ia tidak pernah publish MQTT
  sendiri.
- `sent` tapi gerbang tidak bergerak → lihat Terminal A: apakah kamera meng-ACK
  di `/reply`? Tanpa ACK → kamera offline atau SN salah di baris channel
  (`anpr_device_sn`). ACK tapi tidak ada gerakan → wiring relay /
  `entry_gate_io` menunjuk output yang salah.

## 5. Callback vendor S300 (`/overseas/s300/*`)

Sisi S300/X-Ray mem-POST ke backend di `10.10.33.144`. Setiap kedatangan
tercatat di `anprc_inbound_events_raw` dan terlihat di CP pada halaman **API
Log** (endpoint, IP sumber, pratinjau body, waktu) — halaman itu tempat pertama
memeriksa "apakah panggilan vendor sampai ke kita".

Rute (dari `backend/public/index.php`):

| Endpoint | Membawa |
|----------|---------|
| `POST /overseas/s300/work-status` | `data.operatingState` 0-6 (cmd 322) |
| `POST /overseas/s300/face-image` | `data.img[]` — **URL** gambar di platform vendor |
| `POST /overseas/s300/uvis` | `params` — hasil pindai kolong + koordinat |
| `POST /overseas/s300/video-real-time` | alamat stream live `data[]{code,url}` |
| `POST /overseas/s300/video-record` | alamat stream rekaman, bentuk sama |
| `POST /overseas/s300/reset-complete` | "siap untuk kendaraan berikutnya" |
| `POST /overseas/s300/x-ray` | gambar pindai X-Ray + hasil anomali |

POST uji minimal dari server (host mana pun yang menjangkau `10.10.33.144`).
**Hati-hati:** perintah ini membuat baris sungguhan, dan `work-status`/`uvis`
memberi umpan ke decision engine pada inspeksi aktif — uji di jalur yang idle.

```bash
B=http://10.10.33.144/anpr_backend

curl -s -X POST $B/overseas/s300/work-status -H "Content-Type: application/json" \
  -d '{"cmdNo":322,"channelNo":"RJ001","data":{"operatingState":1}}'

curl -s -X POST $B/overseas/s300/face-image -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","data":{"img":["http://10.10.34.95/test-face.jpg"]}}'

curl -s -X POST $B/overseas/s300/uvis -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","params":{"inspectionId":"DBG-1","imageType":0,"objectCount":0,"coords":[]}}'

curl -s -X POST $B/overseas/s300/video-real-time -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","data":[{"code":"CAM1","url":"rtsp://10.10.34.95/live/1"}]}'

curl -s -X POST $B/overseas/s300/video-record -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","data":[{"code":"CAM1","url":"rtsp://10.10.34.95/rec/1"}]}'

curl -s -X POST $B/overseas/s300/reset-complete -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001"}'
```

Push X-Ray — perhatikan: **SN adalah id unik pindaian**: SN yang berulang
**sengaja di-dedup** (pengaman retry vendor — backend membalas `200 success`
tapi tidak mencatat apa-apa). Jadi setiap push uji butuh SN baru, dan "saya
POST dua kali tapi hanya muncul satu baris" adalah perilaku benar, bukan bug.
`IsAnomaly:true` membuat pindaian tetap `pending` di tab X-Ray (tanpa receipt,
palang keluar tetap tertutup) — nilai uji yang aman; pindaian bersih akan
di-auto-receipt saat `xray_auto_receipt` aktif, yang memanggil balik vendor dan
membuka palang keluar.

```bash
curl -s -X POST $B/overseas/s300/x-ray -H "Content-Type: application/json" \
  -d '{"SN":"DBG-'$(date +%s)'","VehicleNumber":"B1234XYZ","IsAnomaly":true,
       "AnomalyComments":"debug test","ScannerOperator":"field-eng",
       "DateScanStarted":"2026-07-22 10:00:00","DateScanEnded":"2026-07-22 10:01:00"}'
```

Balasan yang diharapkan dari setiap endpoint: `{"code":200,"message":
"success",...}`. Lalu konfirmasi barisnya di **API Log** (filter per
endpoint). Kalau push *vendor* tidak pernah muncul di sana tapi push Anda
muncul, perangkatnya mem-POST ke URL yang salah — konfigurasi
`OVERSEAS_*_URL` miliknya harus menunjuk
`http://10.10.33.144/anpr_backend/overseas/s300/...`.

## 6. Media terunggah (`backend/uploads/`)

Gambar hasil decode ditulis di bawah `backend/uploads/` dan disajikan di
`/anpr_backend/uploads/...` (config `uploads.public_url`):

| Subfolder | Ditulis oleh | Isi |
|-----------|-----------|---------|
| `vehicles/` | `POST /api/vehicles` | JPEG ANPR: scene penuh + close-up plat |
| `uvis/` | `/overseas/s300/uvis` | gambar pindai kolong |
| `xray/` | `/overseas/s300/x-ray` | pindaian X-Ray + gambar plat |
| `audio/` | ditaruh manual | **prompt WAV yang diunduh S300** (URL audio-prompt) |

(Gambar wajah *tidak* disimpan di sini — vendor mengirim URL, disimpan apa
adanya di `anprc_inspection_face_images`.)

Saat gambar 404 di CP atau gagal tersimpan, periksa — berurutan, di
`10.10.33.144`:

```bash
BACKEND_DIR=/var/www/anpr_backend   # sesuaikan dengan path deploy sebenarnya

# 1. Apache harus memiliki tree-nya (penulisan berjalan sebagai apache)
ls -lZ $BACKEND_DIR/uploads
sudo chown -R apache:apache $BACKEND_DIR/uploads

# 2. SELinux: uploads harus konten writable (httpd_sys_rw_content_t)
sudo semanage fcontext -a -t httpd_sys_rw_content_t "$BACKEND_DIR/uploads(/.*)?"
sudo restorecon -Rv $BACKEND_DIR/uploads

# 3. Cek penyajian — file apa pun di folder harus menjawab 200
curl -sI "http://10.10.33.144/anpr_backend/uploads/vehicles/$(ls $BACKEND_DIR/uploads/vehicles | head -1)"
```

Peta gejala: gambar **gagal tersimpan** (backend mencatat error tulis, path
NULL di DB) → kepemilikan atau label SELinux; gambar **tersimpan tapi 404** →
alias Apache untuk `/anpr_backend` tidak mengekspos `uploads/`, atau filenya
memang hilang. S300 gagal memutar prompt kustom → WAV di `uploads/audio/`
tidak terjangkau dari VLAN perangkat (curl URL audionya dari jaringan
`10.10.34.95`, bukan dari localhost).

## 7. Kesehatan worker (`10.10.33.143`)

Worker adalah satu-satunya jembatan MQTT⇄HTTP. Saat ia mati, broker dan
backend sama-sama tampak "sehat" secara terpisah padahal platform praktis
mati:

- pengenalan plat berhenti diproses (kamera tetap publish — terlihat lewat
  `mosquitto_sub` — tapi tidak ada baris kendaraan, tidak ada `/come`);
- antrean outbound **membengkak**: perintah gerbang/blocker/whitelist
  menumpuk sebagai `pending` dan tidak ada yang bergerak secara fisik;
- MQTT Logs berhenti menerima entri inbound;
- `POST /api/cron/tick` berhenti — worker memicunya setiap ~5 dtk, dan itulah
  yang menyapu timeout UVIS serta watchdog reset, jadi inspeksi yang macet
  juga berhenti terselesaikan.

```bash
# Apakah berjalan? (unit systemd di prod)
sudo systemctl status anpr-worker
sudo journalctl -u anpr-worker -f          # log live; sehat = "MQTT connected",
                                           # "subscribed: device/+/message/up/+", baris tick

# Kunci singleton — tepat satu worker boleh memegang 127.0.0.1:18923
ss -tlnp | grep 18923

# Antrean terkuras? pending harusnya kosong/kecil dan menyusut
curl -s "http://10.10.33.144/anpr_backend/api/mqtt-queue/pending"
```

Restart dengan `sudo systemctl restart anpr-worker`. Salinan yang dijalankan
manual (`worker/.venv/bin/python worker/worker.py`) otomatis mematikan
instance hantu yang memegang kunci, dan watchdog bawaan memaksa keluar proses
yang macet sehingga systemd (`Restart=on-failure`) menghidupkannya lagi.
Ingat: backend milik worker itu **remote**
(`BACKEND_URL=http://10.10.33.144/anpr_backend` di `worker/.env`) — kalau
`.144` tak terjangkau dari `.143`, worker mencatat kegagalan HTTP tapi tetap
berjalan; perbaiki jaringannya, bukan worker-nya.

## 8. Tabel triase cepat

| Gejala | Kemungkinan penyebab | Cek |
|---------|--------------|-------|
| Kamera "diam" padahal menyala | hanya memantau satu layout topic | `mosquitto_sub` ganda dari §1 (kedua layout) |
| Tidak ada `keep_alive` di kedua layout | kamera→broker: jaringan / IP:port broker salah / kredensial salah di kamera | sub §3; `sudo systemctl status mosquitto`; firewall `8171/tcp` |
| `not authorised` dari tool mosquitto | `-u`/`-P` hilang/salah (kredensial dev di prod) | pakai kredensial environment (§1) |
| Heartbeat terlihat di `mosquitto_sub` tapi tidak di halaman MQTT Logs | worker mati (ia yang meneruskan ke `/api/mqtt-log/inbound`) | `sudo systemctl status anpr-worker` (§7) |
| Plat terkenali, tidak terjadi apa-apa | worker mati, atau `auto_start_s300` nonaktif | §7; `curl .../api/settings` → `auto_start_s300` |
| Tombol gerbang "queued" tapi gerbang tak pernah bergerak | antrean macet `pending` → worker mati; atau kamera tidak meng-ACK | `curl .../api/mqtt-queue/pending` (§4); pantau topic `/reply` |
| Gerbang meng-ACK (`code:200`) tapi tak bergerak | wiring relay / `entry_gate_io` salah | setting `entry_gate_io/value/pulse_ms`; coba io lain |
| Gerbang terbuka **dua kali** per perintah | kamera bereaksi pada kedua layout down sebelum worker mempelajari layoutnya | transien pasca-restart; kalau menetap → cek MQTT Logs outbound untuk `sent` ganda |
| Event S300 hilang di CP | perangkat mem-POST ke URL salah / port 80 diblokir di VLAN perangkat | halaman **API Log**; POST uji §5; `access_log` Apache di `.144` |
| Push X-Ray "hilang" | SN berulang → sengaja di-dedup | cek `anprc_inspection_xray` untuk SN itu; push ulang dengan SN baru (§5) |
| Gambar 404 / tidak tersimpan | kepemilikan `apache:apache` atau label SELinux di `uploads/` | §6: `ls -lZ`, `chown`, `restorecon` |
| S300 tidak memutar WAV kustom | URL `uploads/audio/` tak terjangkau dari VLAN perangkat | curl URL audionya dari jaringan perangkat (§6) |
| Inspeksi macet, timeout UVIS tak pernah menembak | cron tick berhenti → worker mati | `journalctl -u anpr-worker -f` untuk baris tick (§7) |
| `/come`/`/leave` ke vendor gagal | platform vendor mati / envelope `success:false` | `curl -s http://10.10.34.95:18001/` dari `.144`; API Log + operation log untuk body respons |
