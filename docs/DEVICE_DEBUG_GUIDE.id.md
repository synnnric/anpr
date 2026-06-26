# Panduan Debug Per-Perangkat

Tujuan: membuktikan setiap titik dalam rantai **secara terisolasi**, dari bawah
ke atas, dan mencocokkan apa yang benar-benar Anda amati dengan dokumen protokol.
Jika sebuah perangkat berperilaku berbeda dari klaim dokumen, Anda menemukan
perangkat yang salah konfigurasi ATAU dokumen yang salah — keduanya layak
diperbaiki.

Rantainya:

```
Kamera ANPR ──MQTT──► broker ──MQTT──► worker ──HTTP──► backend ──HTTP──► S300
                                          │                  │
                                          │                  └─HTTP──► road blocker
                                          └──MQTT──► kamera ANPR exit (whitelist)
backend ◄──HTTP── callback S300 (/overseas/s300/*)
```

Debug dalam **urutan dependensi** — lampu hijau di lapisan N hanya berarti jika
N-1 sudah hijau.

---

## 0. Lingkungan & perkakas

Ada dua lingkungan dan perintahnya sedikit berbeda:

- **Produksi — AlmaLinux** (Linux). Probe ini Anda jalankan via SSH di mesin
  produksi. **Semua blok perintah di bawah ditulis dalam bash untuk AlmaLinux** —
  itulah lingkungan yang berbicara dengan hardware sungguhan.
- **Dev — Windows + XAMPP.** Probe sama, logika sama, hanya mekanik shell yang
  beda. Terjemahkan tiap perintah dengan tabel ini:

| Bash (AlmaLinux prod) | Windows dev (PowerShell) |
|-----------------------|--------------------------|
| `curl …` | `curl.exe …` (`curl` polos adalah alias `Invoke-WebRequest` dengan flag berbeda) |
| sambungan baris `\` | backtick `` ` `` |
| JSON kutip-tunggal `'{"k":1}'` | kutip-ganda + escape `"{\"k\":1}"` |
| `php` (di `PATH`) | `C:\xampp\php\php.exe` |
| `worker/.venv/bin/python worker/worker.py` | `worker\.venv\Scripts\python.exe worker\worker.py` |
| `/etc/.../backend/config/config.php` | `backend\config\config.php` |

Perkakas yang dibutuhkan (instal sekali):

| Perkakas | AlmaLinux (prod) | Windows (dev) |
|----------|------------------|---------------|
| `curl` | prainstal | `curl.exe` bawaan Windows 10/11 |
| `mosquitto_pub` / `mosquitto_sub` | `sudo dnf install -y mosquitto` (klien ikut paket broker) | instal Mosquitto → `C:\Program Files\mosquitto\` |
| `psql` | `sudo dnf install -y postgresql` | bawaan PostgreSQL |
| `php` | `sudo dnf install -y php-cli` | `C:\xampp\php\php.exe` |

Nilai acuan proyek ini (dari `backend/config/config.php`):

- Base URL backend: `http://127.0.0.1/anpr_backend`
  (di AlmaLinux ini adalah vhost/alias mana pun yang dipakai Apache/nginx untuk
  menyajikan `backend/public` — ganti dengan hostname produksi jika bukan `127.0.0.1`)
- MQTT broker: `127.0.0.1:1883`
- DB: host `127.0.0.1`, **port `5433`**, db `anpr_s300`, user `anpr`

> Catatan SELinux (AlmaLinux): jika Apache/nginx mengembalikan `502`/`permission
> denied` saat mencapai worker atau DB, cek `getenforce` dan boolean
> `httpd_can_network_connect` (`sudo setsebool -P httpd_can_network_connect 1`)
> sebelum menyalahkan config aplikasi.

---

## 1. PostgreSQL (fondasi)

**Isolasi:**

```bash
psql -h 127.0.0.1 -p 5433 -U anpr -d anpr_s300 -c "SELECT 1;"
```

**Diharapkan:** satu baris `?column? = 1`. Lalu cek skema:

```bash
psql -h 127.0.0.1 -p 5433 -U anpr -d anpr_s300 -c "\dt"
psql -h 127.0.0.1 -p 5433 -U anpr -d anpr_s300 -c "SELECT key_name, value FROM settings;"
```

**Cek dokumen:** `docs/DATABASE.md` mencantumkan setiap tabel. Daftar dari `\dt`
harus cocok. Pastikan `anprc_settings` berisi `blocker_close_mode` (default `hardware`)
dan `auto_start_s300`.

**Kegagalan umum:**
- `could not connect` → port salah (yang benar **5433**, bukan 5432) atau service
  mati (`sudo systemctl status postgresql` di AlmaLinux).
- `password authentication failed` → `config.php` dan role tidak sama, atau
  `pg_hba.conf` belum diset `md5`/`scram-sha-256` untuk role `anpr`.

---

## 2. Backend (PHP / Apache)

**Isolasi (tanpa perangkat):**

```bash
curl -s http://127.0.0.1/anpr_backend/api/health
curl -s http://127.0.0.1/anpr_backend/
```

**Diharapkan:** `{"code":200,"message":"ok",...}`. Root mengembalikan versi + waktu.

Lalu buktikan rute berbasis DB jalan:

```bash
curl -s "http://127.0.0.1/anpr_backend/api/settings"
curl -s "http://127.0.0.1/anpr_backend/api/channels"
curl -s "http://127.0.0.1/anpr_backend/api/channels/by-no/RJ001/status"
```

**Diharapkan:** `/api/channels/by-no/RJ001/status` mengembalikan `{ busy: false }`
saat lajur idle. Panggilan inilah yang dipakai worker sebagai gerbang "lajur
bebas?" sebelum `/come`.

**Cek dokumen:** daftar rute lengkap di `backend/public/index.php` adalah sumber
kebenaran. `docs/COMMUNICATION.md` dan `ARCHITECTURE.md` menjelaskannya — jika
endpoint yang terdokumentasi malah 404, dokumennya basi.

**Kegagalan umum:**
- `500` dengan debug aktif → exception dicetak; baca pesannya. Di AlmaLinux
  pantau juga `sudo journalctl -u httpd` atau `/var/log/httpd/error_log`.
- `404` pada rute yang seharusnya ada → rewrite/alias web server `/anpr_backend`
  tidak menunjuk ke `backend/public` (cek vhost / `.htaccess` dan pastikan
  `AllowOverride All` aktif).

---

## 3. MQTT broker (mosquitto)

**Isolasi** — buka dua terminal (dua sesi SSH di prod).

Terminal A (subscribe semua):

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t "device/#" -v
```

Terminal B (publish pesan palsu):

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -t "device/TEST/message/up/keep_alive" -m '{"hello":1}'
```

**Diharapkan:** Terminal A langsung mencetak topik + payload. Itu membuktikan
broker meneruskan trafik `device/#` — terlepas dari kamera dan worker.

**Cek dokumen:** `docs/COMMUNICATION.md` mencantumkan topik asli:
`device/{sn}/message/up/{ivs_result|gpio_in|barr_gate_status|keep_alive}` dan
padanan `.../down/...` + `/reply`. Bentuk topik yang Anda publish di sini harus
sama persis, atau filter subscription worker tidak akan menangkap trafik asli.

> Di AlmaLinux pastikan broker hidup dan dapat dijangkau: `sudo systemctl status mosquitto`,
> dan firewall mengizinkan `1883` jika kamera ada di host lain
> (`sudo firewall-cmd --add-port=1883/tcp`).

---

## 4. Kamera ANPR — entry (pengenalan masuk)

Kamera **push secara otonom**; Anda tidak polling. Pantau trafiknya:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t "device/+/message/up/ivs_result" -v
```

**Diharapkan:** lewatkan sebuah plat (atau pakai simulator di bawah) dan JSON
`ivs_result` muncul. Plat ada di
`payload.AlarmInfoPlate.result.PlateResult.license` (base64) — persis jalur yang
di-decode worker (`worker.py: handle_recognition`).

**Simulasi tanpa hardware:**

```bash
node frontend/simulator.cjs        # kamera entry
node frontend/exit_simulator.cjs   # kamera exit
```

**Cek dokumen:** `COMMUNICATION.md` "typical entry-lane cycle" langkah 1, dan PDF
protokol MQTT bagian ivs_result. Verifikasi `triggerType` dan jalur base64
`license` — jika kamera asli menyusunnya berbeda, jalur decode worker yang harus
diubah, dan dokumen disesuaikan.

**Kegagalan umum:**
- Pesan masuk tapi worker abai → SN tidak ada di channel yang dikonfigurasi, atau
  isu prefix `\x00` pada `keep_alive` (worker membuangnya; cek dengan output `-v` mentah).

---

## 5. Robot inspeksi S300

Dua arah — uji masing-masing terpisah.

**5a. Platform → S300 (outbound).** Backend memanggil base URL S300. Picu lewat
rute platform:

```bash
curl -s -X POST "http://127.0.0.1/anpr_backend/api/s300/come/RJ001" \
  -H "Content-Type: application/json" -d '{"licensePlateNo":"B1234XYZ"}'
```

**Diharapkan:** `code:200` dan baris inspection dibuat. Verifikasi:

```bash
curl -s "http://127.0.0.1/anpr_backend/api/inspections?limit=1"
```

Untuk memukul perangkat langsung (lewati platform), curl base URL-nya — ada di
baris channel (`s300_base_url`) dan panggil `/api/v1/channel-s300/leave/RJ001`,
dll. Jalur persis yang dipakai platform ada di pemanggilan `S300Client` dalam
`DecisionExecutor.php` dan `S300Controller.php`.

**5b. S300 → Platform (callback).** Perangkat POST balik ke `/overseas/s300/*`.
Simulasikan tiap callback untuk membuktikan backend menanganinya tanpa perangkat
asli:

```bash
# work-status: op=1 inspecting
curl -s -X POST "http://127.0.0.1/anpr_backend/overseas/s300/work-status" \
  -H "Content-Type: application/json" -d '{"channelNo":"RJ001","op":1}'

# hasil uvis: clean
curl -s -X POST "http://127.0.0.1/anpr_backend/overseas/s300/uvis" \
  -H "Content-Type: application/json" -d '{"channelNo":"RJ001","result":"clean"}'

# reset-complete
curl -s -X POST "http://127.0.0.1/anpr_backend/overseas/s300/reset-complete" \
  -H "Content-Type: application/json" -d '{"channelNo":"RJ001"}'
```

**Diharapkan:** callback UVIS memicu `DecisionEngine` → verdict; cek `decision`
pada baris inspection berubah dari `pending`. `reset-complete` membebaskan channel
(`/api/channels/by-no/RJ001/status` → `busy:false`).

**Cek dokumen:** jalur inbound di `index.php` (`/overseas/s300/*`) **wajib** sama
persis dengan PDF protokol S300 (perangkat hard-coded ke URL itu). Nama field
(`op`, `result`, dll.) yang Anda kirim harus cocok dengan `InboundController` dan
PDF. `COMMUNICATION.md` langkah 4–7 menjelaskan urutannya.

**Kegagalan umum:**
- Perangkat dapat `404` pada callback → jalur rute backend tidak cocok dengan URL
  yang dikonfigurasi di perangkat → perangkat retry selamanya. Ini mismatch
  dokumen/konfigurasi nomor 1.
- UVIS tak pernah tiba → watchdog `cron tick` 30 dtk memaksa `decision=fail`; lihat §8.

---

## 6. Road blocker (lifting column Qigong)

> **Catatan dokumen:** ini perangkat **HTTP REST** (`RoadBlockerClient` →
> `http://{rb_ip}:{rb_port}`), *bukan* TCP. Salinan lama `COMMUNICATION.md`
> menulis "TCP open road blocker" — itu keliru; API-nya HTTP.

**Isolasi — baca status (aman, read-only):**

```bash
curl -s "http://{rb_ip}:{rb_port}/open/getStatus/{rb_device_no}"
```

**Diharapkan:** JSON berisi kode posisi kolom — `01` turun, `03` rendah, `05`
naik, `07` tinggi, plus `controlTheDeviceOnline`.

**Isolasi — operasikan (menggerakkan hardware; kosongkan lajur dulu):**

```bash
# TURUNKAN (buka) kolom — kendaraan bisa lewat
curl -s -X POST "http://{rb_ip}:{rb_port}/open/operation" \
  -H "Content-Type: application/json" \
  -d '{"deviceNo":"{rb_device_no}","ipCode":{"{rb_board_id}":1},"operationType":"liftingColumn_level","action":"down","liftingColumnNum":1}'
```

Ini persis body yang dikirim `RoadBlockerClient::openColumn`. `action:"up"`
menaikkannya.

**Cek dokumen:** `ROAD BLOCKER API.pdf` adalah satu-satunya otoritas. Pastikan dua
endpoint (`GET /open/getStatus/{deviceNo}`, `POST /open/operation`) dan kode
statusnya. **Fakta desain kunci untuk diverifikasi di lokasi:** API ini *tidak*
punya field kendaraan-ada / tutup-otomatis — jadi penutupan harus dilakukan loop
detector controller-nya sendiri (`blocker_close_mode='hardware'`, default). Jika
lajur tetap terbuka setelah lolos, wiring tutup-sendiri controller belum
dikerjakan; lihat `docs/DEVICE_SETUP_CHECKLIST.md`.

**Kegagalan umum:**
- `getStatus` jalan tapi `operation` tidak bereaksi → `ipCode`/`board_id`/nomor
  kolom salah untuk wiring Anda.
- Connection refused → `rb_port` di baris channel salah (dan di AlmaLinux,
  pastikan egress ke subnet blocker tidak diblok `firewalld`).

---

## 7. Kamera ANPR — exit (whitelist + buka otomatis)

Kamera exit membuka palangnya sendiri saat plat ada di whitelist lokalnya.
Platform hanya **pra-otorisasi** plat.

**Isolasi — push whitelist add seperti yang dilakukan worker:**

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 \
  -t "device/{exit_sn}/message/down/white_list_operator" \
  -m '{"id":"dbg1","sn":"{exit_sn}","name":"white_list_operator","version":"1.0","timestamp":1700000000,"payload":{"type":"white_list_operator","body":{"operator_type":"update_or_add","dldb_rec":{"plate":"B1234XYZ","enable":1,"create_time":"2026-06-11 10:00:00","enable_time":"2026-06-11 10:00:00","overdue_time":"2026-07-11 10:00:00","need_alarm":0,"time_seg_enable":0,"seg_time_start":"00:00:00","seg_time_end":"00:00:00"}}}}'
```

**Diharapkan:** kamera ACK di
`device/{exit_sn}/message/down/white_list_operator/reply` dengan `code:200`.
Pantau dengan `mosquitto_sub -t "device/+/message/down/+/reply" -v`. Lalu
mengeluarkan plat itu seharusnya membuka palang exit.

**Cek dokumen:** PDF protokol MQTT **§7.8**. Ini skema yang sekarang dikirim
backend (`MqttOutbound::whitelistAdd`):
- `operator_type` = `update_or_add` (add) / `delete` / `select`
- `dldb_rec` adalah **objek tunggal** (bukan array)
- `create_time` **wajib**; `need_alarm:0` = whitelist
- envelope membawa `payload.type` = `white_list_operator`

Jika kamera menolak pesan, bandingkan payload Anda dengan §7.8 field demi field —
ini pesan paling sensitif skema di seluruh sistem.

**Kegagalan umum:**
- Kamera tidak dalam mode **Whitelist** → daftar diabaikan total.
- Format plat tidak cocok (spasi, karakter provinsi) → tidak match saat exit.

---

## 8. Worker (perekat) — uji terakhir

Hanya bermakna setelah 1–7 hijau, karena worker hanya menyatukan semuanya.

**Jalankan di foreground dan baca log:**

```bash
worker/.venv/bin/python worker/worker.py
```

> Di produksi worker biasanya berjalan di bawah **systemd** (mis.
> `anpr-worker.service`), bukan di foreground. Untuk debug, hentikan unit lalu
> jalankan manual: `sudo systemctl stop anpr-worker` lalu perintah di atas; log
> live dari unit terkelola: `sudo journalctl -u anpr-worker -f`.

**Baris log yang diharapkan saat start sehat:** dotenv termuat, MQTT terhubung
(`rc=0`), subscribe ke `device/+/message/up/...`, dan tiap ~5 dtk `cron tick`.

**Buktikan tiap tanggung jawab worker terpisah:**
1. **Pemicu inbound** — publish `ivs_result` palsu (lihat §4). Worker harus
   me-log decode dan POST `/api/s300/come/...` (pantau backend / `anprc_operation_log`).
2. **Drain outbound** — enqueue perintah lewat verdict apa pun, lalu lihat worker
   publish (baris log `outbound: published ...`) dan menandai baris antrian `sent`.
3. **Cron tick** — pastikan `/api/cron/tick` di-POST tiap `TICK_INTERVAL_S`.

**Cek dokumen:** docstring atas `worker/worker.py` mencantumkan 4 tanggung
jawabnya; `ARCHITECTURE.md` §13 menyebut apa yang dilakukan worker vs tidak.
Worker bicara **hanya** MQTT + HTTP backend — tanpa DB — jadi tempat yang tepat
untuk dijalankan di server terpisah (cukup ubah `MQTT_BROKER` / `BACKEND_URL`).

**Kegagalan umum:**
- `int() argument ... ReasonCode` → paho-mqtt 2.x; sudah ditangani di `on_connect`.
- `ZoneInfoNotFoundError 'Asia/Jakarta'` → `pip install tzdata` (ada di
  requirements); di AlmaLinux bisa juga `sudo dnf install -y tzdata`.
- Dua worker bentrok → singleton lock di port `18923`; instance kedua keluar
  (waspadai ini jika unit systemd dan salinan manual sama-sama hidup).

---

## 9. Smoke test menyeluruh

Saat semua hijau, jalankan satu mobil dan pantau empat log sekaligus (empat sesi
SSH di prod):

```bash
# Terminal 1: semua MQTT
mosquitto_sub -h 127.0.0.1 -p 1883 -t "device/#" -v
# Terminal 2: worker
worker/.venv/bin/python worker/worker.py
# Terminal 3: simulasi plat masuk
node frontend/simulator.cjs
# Terminal 4: pantau jejak audit
curl -s "http://127.0.0.1/anpr_backend/api/operation-log?limit=20"
```

**Urutan yang diharapkan di audit log** (cocok dengan siklus `COMMUNICATION.md`):
`come` → `auto_decision` → `open_blocker` → `whitelist_enqueue_add` →
`auto_leave`, lalu nanti `record-exit` + whitelist `delete`.

`status` tiap baris (`success`/`failed`) memberi tahu persis hop mana yang putus,
dan label aksi yang mudah dibaca (halaman Audit Log) memetakan ke sini.

---

## Lampiran — ketidaksesuaian dokumen yang ditemukan saat menulis panduan ini

| Dokumen | Klaim | Kenyataan (kode) | Status |
|---------|-------|------------------|--------|
| `COMMUNICATION.md` | "TCP open road blocker" | `RoadBlockerClient` pakai **HTTP REST** di `rb_ip:rb_port` | diperbaiki |
| payload whitelist (pra-perbaikan) | `operator_type:add`, `dldb_rec` array, tanpa `create_time` | §7.8 minta `update_or_add`, objek tunggal, `create_time` + `payload.type` | diperbaiki di `MqttOutbound` / `worker.py` |
| `DEPLOYMENT.md` | "Deployment produksi Ubuntu" | produksi memakai **AlmaLinux** (set perintah panduan ini mengasumsikan itu) | tandai untuk ditinjau |

Saat Anda mengonfirmasi perilaku perangkat asli vs dokumen di sini dan keduanya
berbeda, tambahkan baris — menjaga tabel ini tetap mutakhir adalah cara dokumen
tetap dapat dipercaya.
