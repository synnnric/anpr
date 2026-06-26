# Checklist Setup Perangkat

Checklist langkah-demi-langkah untuk membawa hardware sungguhan online dan
menggantikan simulator. Centang kotak saat berjalan.

Dokumen pendamping:
- [`DEPLOYMENT.id.md`](./DEPLOYMENT.id.md) — install server / OS / service
- [`COMMUNICATION.id.md`](./COMMUNICATION.id.md) — topik, endpoint, payload yang tepat
- [`ARCHITECTURE.id.md`](./ARCHITECTURE.id.md) — alur tingkat tinggi
- [`DATABASE.id.md`](./DATABASE.id.md) — referensi tabel `anprc_channels`

---

## 0. Sebelum menyentuh perangkat apa pun

- [ ] Pastikan platform berjalan dan dashboard di `http(s)://<host>/` menampilkan **Backend / Database / Broker / Worker = OK** (baris System Health).
- [ ] Anda dapat login sebagai `admin` dan melihat halaman **Users**, **Channels**, dan **Dashboard**.
- [ ] **Hentikan setiap simulator** sebelum mencolokkan perangkat sungguhan dengan SN yang sama. Dua client dengan `sn` yang sama mempublikasi secara bersamaan akan menulis baris ganda.
  ```powershell
  Get-Process node, python -ErrorAction SilentlyContinue
  ```
- [ ] Catat IP/hostname production platform — setiap perangkat akan diarahkan ke sana.
- [ ] Catat serial number / IP setiap perangkat — Anda akan menempelkannya ke tabel `anprc_channels`.

---

## 1. Settings platform (sekali saja)

- [ ] Ubah `auth.secret` di `config/config.php` menjadi string acak 64 karakter baru. Membatalkan token dev.
- [ ] Ubah `app.debug` ke `false` di `config/config.php` agar stack trace tidak bocor.
- [ ] Setel `auth.dev_bypass` ke `false` di `config/config.php` dan isi `auth.parent_db` dengan kredensial DB portal induk + pemetaan kolom. Lihat [`DEV_LOGIN.id.md`](./DEV_LOGIN.id.md) untuk referensi pemetaan skema.
- [ ] Konfirmasi login SSO bekerja end-to-end dari portal induk: meng-klik tautan platform dari UI induk harus mendarat di dashboard dengan badge role yang benar, tanpa perlu parameter `?username=` manual.
- [ ] Verifikasi `settings.auto_start_s300 = 1` jika Anda ingin worker memicu inspeksi secara otomatis pada deteksi plat (kebanyakan instalasi begitu).
- [ ] Verifikasi `settings.blocker_auto_close_sec` sesuai dengan waktu traversal gerbang Anda (default 8 dtk; tingkatkan untuk gerbang yang lebih lambat).

---

## 2. Broker Mosquitto (sudah berjalan sesuai DEPLOYMENT.id.md)

- [ ] Firewall: izinkan inbound TCP **1883** (perangkat) dan **8083** (WebSocket browser) hanya dari VLAN kamera Anda.
- [ ] Jika perangkat berada di internet publik (hindari ini), terminate TLS di Nginx: port `8883` untuk MQTT-over-TLS, `8084` untuk WebSocket-secure.
- [ ] Opsional: aktifkan username/password Mosquitto (`mosquitto_passwd`) dan set `MQTT_USERNAME` / `MQTT_PASSWORD` di `worker/.env`. Update settings MQTT di firmware kamera supaya cocok.

---

## 3. Kamera ANPR Entry

### A. Konfigurasi sisi kamera

- [ ] Nyalakan kamera. Catat **IP factory**-nya (sering `192.168.1.100`).
- [ ] Buka web UI kamera (browser → IP factory, default `admin` / kosong atau `admin`).
- [ ] Set **IP statis** ke alamat yang routable di jaringan platform.
- [ ] **Setting MQTT** (biasanya di *Network → Cloud / MQTT*):
  - [ ] Broker host = IP platform
  - [ ] Broker port = `1883`
  - [ ] Client ID / SN = serial perangkat (pertahankan nilai factory, atau ubah — tapi cocokkan dengan yang akan Anda masukkan di DB)
  - [ ] Username/password = apa pun yang Anda konfigurasi di langkah 2 (atau kosong jika anonymous)
  - [ ] Interval Heartbeat / keep_alive = **≤ 30 dtk** (default 10 dtk sudah cukup)
- [ ] Save + reboot kamera.

### B. Konfigurasi sisi platform

- [ ] Di **psql**, insert/update channel entry:
  ```sql
  UPDATE channels
     SET anpr_device_sn = '<SN entry sungguhan>',
         s300_base_url  = 'http://<ip-camera-arm-sungguhan>:8086',
         rb_ip          = '<ip-road-blocker>',
         rb_port        = <port>,
         rb_device_no   = '<device-no>',
         rb_board_id    = '<board>',
         rb_column_num  = 1,
         name           = 'Main Gate Lane 1'
   WHERE channel_no = 'RJ001';
  ```
  (Atau gunakan tab **Camera Robotic Arm → Channels** untuk mengedit lewat UI.)

### C. Verifikasi

- [ ] Pada dashboard, chip perangkat `RJ001` berubah 🟢 **ONLINE** dengan "Heartbeat <30 dtk ago".
- [ ] Halaman **MQTT Logs** → filter dengan SN entry → Anda melihat `keep_alive` masuk secara reguler.
- [ ] Lewatkan (atau lambaikan) plat tes di depan kamera → `ivs_result` muncul di MQTT Logs dengan teks plat yang benar.

### D. Cek kepatuhan protokol

Cross-check kamera sungguhan dengan [`COMMUNICATION.id.md` → Kamera ANPR](./COMMUNICATION.id.md#kamera-anpr-entry--exit). Parser worker hanya memahami bentuk topik dan payload yang terdokumentasi — apa pun selain itu akan didrop dalam diam.

- [ ] **Keempat up-topik tiba** — di **MQTT Logs → Inbound** filter dengan SN entry. Anda seharusnya melihat masing-masing:
  - [ ] `keep_alive` — setiap ~10 dtk · **tujuan:** *satu-satunya* sinyal yang menggerakkan ONLINE/STALE/OFFLINE di dashboard. Tidak ada keep_alive = perangkat dianggap offline meskipun masih mengirim plat.
  - [ ] `ivs_result` — pada setiap pengenalan plat · **tujuan:** event pemicu. Worker membacanya → memanggil `/api/s300/come/{ch}` untuk memulai inspeksi (entry) atau `/api/visits/record-exit` untuk menutup visit (exit).
  - [ ] `gpio_in` — pada setiap trigger loop-detector / IO · **tujuan:** informatif; memunculkan aktivitas presence/induction-loop di MQTT Logs dan memungkinkan Anda mengorelasi "mobil duduk di loop tapi kamera tidak ter-trigger".
  - [ ] `barr_gate_status` — pada setiap pergerakan barrier fisik · **tujuan:** diagnostik informatif; memungkinkan Anda membedakan apakah pass yang hilang adalah masalah kamera atau barrier-stuck.

  Topik hilang → buka web UI kamera → *Network → Cloud / MQTT → Event filter* dan aktifkan family event yang hilang.

- [ ] **Bentuk payload `ivs_result` cocok** — buka satu baris `ivs_result` di MQTT Logs, inspeksi JSON-nya, dan konfirmasi path terdokumentasi ada:
  - [ ] `AlarmInfoPlate.result.PlateResult.license` hadir dan ter-encode base64 (plat tampil benar di dashboard)
  - [ ] `AlarmInfoPlate.result.PlateResult.confidence`, `direction`, `colorType`, `triggerType`, `unique_id` terisi

  Jika plat ada di path berbeda (mis. `Result.Plate`), firmware berada pada revisi protokol berbeda — ekstraktor plat worker hanya menjalankan path terdokumentasi, jadi plat tidak akan dikenali. Buka tiket firmware mismatch.

- [ ] **Sanity di level broker** — konfirmasi kamera mencapai broker secara independen dari platform:
  ```powershell
  mosquitto_sub -h <ip-broker> -t "device/<sn-entry>/message/up/+" -v
  ```
  Sunyi >30 dtk → kamera tidak mencapai Mosquitto (firewall / host salah / port salah / kredensial client salah). Perbaiki di kamera, bukan di platform.

---

## 4. Kamera ANPR Exit

Langkah-langkah sama dengan Entry, kecuali:

- [ ] Baris channel: gunakan `channel_no = 'RJ002'` (atau nama yang Anda berikan untuk channel exit).
- [ ] `kind = 'exit'`.
- [ ] `paired_channel_id` = `id` channel entry (agar platform tahu entry mana yang dipasangkan dengan exit ini untuk sinkronisasi whitelist).
- [ ] `paired_channel_id` channel entry juga harus menunjuk balik ke channel exit ini — atau mengandalkan fallback "channel exit pertama yang enabled".

### Mode whitelist (kritis)

Kamera exit harus dalam **mode whitelist** agar hanya membuka untuk kendaraan yang sudah diotorisasi platform. Sesuai dokumen vendor kamera:

- [ ] Di web UI kamera, set "Recognition Mode" / "List Mode" = **Whitelist** (atau "Permit-only").
- [ ] Kosongkan whitelist lokal — platform akan mengisinya via perintah MQTT `white_list_operator` setiap kali inspeksi entry PASS.

### Verifikasi

- [ ] Setelah entry PASS untuk plat `X`, lihat tab **Outbound** di MQTT Logs — Anda seharusnya melihat `white_list_operator` dengan `operator_type: "add"` terkirim ke SN kamera exit.
- [ ] Lewatkan plat `X` di kamera exit → barrier terbuka, `ivs_result` exit muncul, platform memanggil `/api/visits/record-exit`, dan halaman MQTT Logs yang sama nantinya menampilkan `white_list_operator` follow-up dengan `operator_type: "delete"` yang membersihkan plat dari whitelist.

### Cek kepatuhan protokol (khusus exit)

Selain empat cek up-topik dari section 3.D, verifikasi arah **down** berfungsi — ini unik untuk kamera exit:

- [ ] **Pengiriman down-topik** — setelah entry PASS, **MQTT Logs → Outbound** harus menampilkan `device/<sn-exit>/message/down/white_list_operator` dengan bentuk body yang terdokumentasi:
  - [ ] `operator_type: "add"` · **tujuan:** mengotorisasi satu plat di kamera exit (kamera dalam mode *whitelist* dan menolak plat asing secara default).
  - [ ] `dldb_rec[].plate` cocok dengan plat entry · **tujuan:** mengidentifikasi persis plat mana yang sedang diotorisasi.
  - [ ] `enable_time` dan `overdue_time` di-set (window one-time-pass) · **tujuan:** kamera otomatis meng-expire entri — mencegah kendaraan kembali berjam-jam kemudian dengan otorisasi yang sama.

- [ ] **ACK kamera** — setelah down-publish, **MQTT Logs → Inbound** untuk SN exit harus menampilkan `device/<sn-exit>/message/down/white_list_operator/reply` yang cocok dengan `code: 0`. Tidak ada reply → firmware kamera tidak subscribe ke down topic, atau ACL MQTT-nya menolak subscribe pada `down/+`.
- [ ] **Whitelist benar-benar diterapkan** — lewatkan plat `X` di kamera exit dalam `enable_time` → barrier terbuka. Jika barrier tetap tertutup walaupun `add` sukses, kamera menerima pesan tapi tidak mendaftarkan plat (cek bahwa **Whitelist mode** benar-benar `Whitelist`, bukan `Blacklist` atau `Disabled`).
- [ ] **Delete setelah exit** — setelah kendaraan keluar, `white_list_operator { operator_type: "delete", plate: "X" }` follow-up seharusnya muncul di Outbound + reply Inbound dalam 5 dtk. Tidak ada → worker tidak berjalan, atau `paired_channel_id` tidak terhubung.

---

## 5. Camera Robotic Arm (S300)

Robot ini **HTTP, bukan MQTT**. Platform adalah HTTP server (untuk callback-nya) sekaligus HTTP client (untuk perintah).

### Sisi perangkat

- [ ] Nyalakan arm, set IP statisnya.
- [ ] Di UI controller arm, set **Platform callback base URL** ke:
  ```
  http://<host-platform>/anpr_backend/overseas/s300
  ```
  Ini adalah tempat arm mem-POST event `work-status`, `face-image`, `video-record`, `uvis`, dan `reset-complete`.
- [ ] Set **channel ID** yang arm laporkan — biasanya `RJ001` (cocok dengan `channels.channel_no`).
- [ ] Konfirmasi arm tidak punya modul X-ray yang dikonfigurasi — deployment ini mengabaikan callback X-ray.

### Sisi platform

- [ ] Di baris `anprc_channels` untuk channel entry: `s300_base_url = 'http://<ip-arm>:<port-arm>'`.
  Platform akan memanggil `/api/v1/channel-s300/come/{channelNo}`, `/leave/{channelNo}`, dll. di URL ini.
- [ ] `uvis_timeout_sec = 30` (atau berapa pun worst-case scan UVIS arm Anda). Inspeksi tanpa callback UVIS dalam tenggat ini otomatis FAIL.

### Verifikasi

- [ ] Dashboard → channel entry → kartu **Camera Robotic Arm** menampilkan **READY** (hijau) dengan latency.
- [ ] Picu satu deteksi entry. Kartu seharusnya berubah menjadi **BUSY** selama siklus berjalan.
- [ ] Web UI S300 seharusnya menampilkan siklus yang sama berjalan (Ready → Inspecting → Resetting → Ready).
- [ ] Setelah selesai, **Recent Decisions** di dashboard menampilkan baris `pass` / `suspect` / `fail`.

### Cek kepatuhan protokol

Cross-check arm sungguhan dengan [`COMMUNICATION.id.md` → Robot Inspeksi S300](./COMMUNICATION.id.md#robot-inspeksi-s300). Picu satu inspeksi, lalu telusuri kedua arah:

- [ ] **Kelima callback inbound mencapai platform selama satu siklus.** Tail access log Apache selagi siklus berjalan:
  ```powershell
  Get-Content C:\xampp\apache\logs\access.log -Tail 50 -Wait
  ```
  Anda seharusnya mengamati (urutan boleh berbeda; `work-status` banyak adalah normal):
  - [ ] `POST /overseas/s300/work-status` — setidaknya sekali untuk masing-masing op=6 (started) → 1 (inspecting) → 2 (resetting) → 3 (completed) · **tujuan:** menggerakkan state machine inspeksi platform (`inspections.state`). Tanpa ini inspeksi tidak akan maju dari `pending`.
  - [ ] `POST /overseas/s300/face-image` — dua kali (pengemudi + penumpang) · **tujuan:** menangkap foto pengemudi + penumpang yang muncul di halaman detail inspeksi; dipakai untuk audit / tinjauan pasca-insiden.
  - [ ] `POST /overseas/s300/video-record` — sekali · **tujuan:** mencatat path klip video inspeksi untuk pemutaran ulang.
  - [ ] `POST /overseas/s300/uvis` — sekali, body membawa `result` clean/suspect · **tujuan:** ini adalah *input keputusan* utama. DecisionEngine membaca `result` dan memutuskan `pass` / `suspect` / `fail`. Tanpa ini → inspeksi otomatis FAIL pada `uvis_timeout_sec`.
  - [ ] `POST /overseas/s300/reset-complete` — sekali, setelah op=2 · **tujuan:** sinyal "channel bebas lagi". Tanpa ini channel tetap BUSY dan kendaraan berikutnya tidak bisa diinspeksi.

  Route hilang → **callback base URL** arm salah, atau callback tersebut dinonaktifkan di firmware. Cek ulang section 5 "Sisi perangkat".

- [ ] **Nilai `operating_state` tetap dalam enum terdokumentasi** (0=ready · 1=inspecting · 2=resetting · 3=completed · 4=e-stop · 5=failed · 6=started). Buka inspeksi di halaman **Inspections** → kolom `current_operating_state` hanya boleh bernilai 0–6. Nilai di luar range (mis. 99) ⇒ revisi protokol berbeda di firmware.

- [ ] **Semua perintah outbound sukses.** Buka `anprc_inspection_status_logs` untuk inspeksi tes:
  ```sql
  SELECT created_at, event, http_status, error
    FROM inspection_status_logs
   WHERE inspection_id = <id>
   ORDER BY id;
  ```
  Setiap endpoint outbound terdokumentasi yang dipanggil platform selama siklus ini harus mengembalikan HTTP 200:
  - [ ] `POST {s300_base_url}/come/RJ001` (auto-trigger oleh worker) · **tujuan:** memberi tahu arm "kendaraan dengan plat X ada di sini, mulai siklus inspeksi".
  - [ ] `GET  {s300_base_url}/leave/RJ001` (DecisionExecutor saat selesai) · **tujuan:** memberi tahu arm "keputusan sudah ada, lepaskan kendaraan dan mulai reset Anda". Tanpa ini arm akan duduk di `inspecting` selamanya.

  HTTP timeout / connection refused → `s300_base_url` salah, atau HTTP server arm tidak di port terdokumentasi.

- [ ] **Path watchdog bekerja.** Paksa sebuah stall (matikan controller arm di tengah siklus). Dalam `uvis_timeout_sec`, `/api/cron/tick` seharusnya memanggil:
  - [ ] `POST /read-work-status/{ch}` · **tujuan:** menanyakan ulang state arm saat ini jika callback `work-status` hilang di tengah jalan.
  - [ ] `POST /manual-reset/{ch}` · **tujuan:** mereset paksa arm yang stuck agar channel tidak tetap BUSY selamanya.

  Keduanya terlihat di `anprc_inspection_status_logs`. Tidak ada baris itu → cron tidak berjalan.

---

## 6. Road blocker

REST API, bukan MQTT. Sesuai [spec Qigong AIoT](../%E3%80%90SSRD251030-04305%E3%80%91Road%20Blocker%20Communication%20Protocol.pdf):

### Sisi perangkat

- [ ] Nyalakan controller, set IP statisnya.
- [ ] Catat `deviceNo`, `boardId` (mis. `"01"`), dan berapa banyak kolom pada setiap board.

### Sisi platform

Di baris `anprc_channels` untuk channel entry:

- [ ] `rb_ip` = IP controller
- [ ] `rb_port` = port HTTP controller (default `8088`)
- [ ] `rb_device_no` = nilai yang controller harapkan (case sensitive — mis. `DEV001` bukan `DEVICE_001`)
- [ ] `rb_board_id` = board spesifik yang gerbang ini gunakan (mis. `01`)
- [ ] `rb_column_num` = nomor kolom pada board itu (biasanya `1`)

### Verifikasi

- [ ] Dashboard → channel entry → kartu **Road Blocker** menampilkan **ONLINE** dengan `controller_online = true`, dan kolom membaca `Raised (7)`.
- [ ] Picu satu deteksi entry yang berakhir PASS. Kartu seharusnya sekilas menampilkan `Descending (1)` → `Lowered (3)`, lalu 8 dtk kemudian `Rising (5)` → `Raised (7)`.
- [ ] Konfirmasi `inspections.blocker_closed_at` terisi dengan benar setelah setiap PASS:
  ```sql
  SELECT id, license_plate, decision,
         EXTRACT(EPOCH FROM (blocker_closed_at - blocker_opened_at))::int AS open_for_s
    FROM inspections WHERE blocker_opened = 1 ORDER BY id DESC LIMIT 5;
  ```

### Cek kepatuhan protokol

Cross-check dengan [`COMMUNICATION.id.md` → Road Blocker](./COMMUNICATION.id.md#road-blocker) dan [spec Qigong AIoT](../【SSRD251030-04305】Road%20Blocker%20Communication%20Protocol.pdf):

- [ ] **TCP reachability** — dari host platform:
  ```powershell
  Test-NetConnection <rb_ip> -Port <rb_port>
  ```
  `TcpTestSucceeded : True` → controller hidup dan routable. False → controller mati / firewall / port salah.

- [ ] **Status framing diterima** — kartu **Road Blocker** dashboard membaca `controller_online = true`. Jika tes TCP di atas sukses tapi ini menampilkan `false`, controller MEMANG terjangkau tapi framing `deviceNo` / `boardId` terdokumentasi tidak cocok dengan firmware — cek ulang `rb_device_no` dan `rb_board_id` (case sensitive: `DEV001` ≠ `dev001`).

- [ ] **Urutan state kolom pada PASS cocok dengan enum terdokumentasi.** Selama satu siklus PASS, kartu dashboard harus berjalan persis melalui:
  ```
  7 (Raised) → 1 (Descending) → 3 (Lowered) → 5 (Rising) → 7 (Raised)
  ```
  Setiap nilai adalah state kolom yang dilaporkan controller:
  - `7 (Raised)` — state default memblokir, tidak ada kendaraan diotorisasi
  - `1 (Descending)` — aktif menurun setelah DecisionExecutor membukanya pada PASS
  - `3 (Lowered)` — sepenuhnya turun, kendaraan bisa melintasi
  - `5 (Rising)` — re-arming setelah `blocker_auto_close_sec` (~8 dtk) berlalu
  - `7 (Raised)` — kembali ke default, siap untuk kendaraan berikutnya

  Penyimpangan umum:
  - [ ] Tetap di `7` → perintah tidak diterima (`rb_column_num` salah, atau backend tidak bisa menulis ke socket)
  - [ ] Melompat `7 → 5 → 7` → controller mendengar "raise" alih-alih "lower" (penomoran kolom terbalik)
  - [ ] Berhenti di `3` dan tidak pernah naik lagi → cron tidak berjalan jadi `blocker_auto_close_sec` tidak pernah memicu

- [ ] **Tes frame manual** (opsional, hanya jika di atas misbehaving) — gunakan `ncat` / tool tes TCP, kirim paket "raise column 1" terdokumentasi untuk `rb_device_no` + `rb_board_id`. Controller seharusnya membalas dengan frame status terdokumentasi. Jika reply berbeda, firmware berada di revisi protokol berbeda dan `RoadBlockerService` tidak akan parse.

---

## 7. Smoke test end-to-end

Setelah keempat perangkat sungguhan terpasang:

- [ ] **Live entry** — lewatkan plat yang dikenal melalui jalur entry. Konfirmasi dalam urutan ini:
  1. Plat muncul di **MQTT Logs → Inbound** untuk SN entry
  2. Baris `anprc_inspections` dibuat (state=`started` → `inspecting` → `resetting` → `completed`)
  3. Arm menyelesaikan scan UVIS-nya dalam `uvis_timeout_sec`
  4. **Recent Decisions** mencatat `pass` (atau `suspect` / `fail`)
  5. Pada PASS, road blocker turun, kendaraan melintas, ~8 dtk kemudian naik kembali
  6. Whitelist lokal kamera exit kini berisi plat ini
- [ ] **Live exit** — lewatkan kendaraan yang sama melalui jalur exit.
  1. Barrier kamera exit terbuka (whitelist hit)
  2. **MQTT Logs → Inbound** menampilkan `ivs_result` exit
  3. Baris visit berubah ke `status='completed'` dan `exit_at` terisi
  4. Whitelist kamera exit mendapat `delete` follow-up untuk plat itu
- [ ] **Path FAIL** — paksa timeout UVIS (mis. tutup sensor arm atau pakai undercarriage kotor yang dikenal). Konfirmasi:
  - Blocker **tetap raised**
  - `decision = 'fail'`
  - Audio TTS kegagalan diputar di kamera/speaker
  - `visits.status = 'denied_entry'`
- [ ] **Orphan exit** — lewatkan plat asing di kamera exit. Harus tetap terblok; baris `anprc_visits` dengan `status='orphan_exit'` muncul.
- [ ] **Alarm heartbeat-loss** — matikan satu kamera. Dalam 30 dtk chip dashboard-nya berubah 🔴 **STALE / OFFLINE**. Hidupkan kembali; seharusnya pulih dalam 30 dtk.

---

## 8. Operasi / monitoring (setelah go-live)

- [ ] Setup cron tick: timer systemd atau cron eksternal harus memanggil worker setiap 5 dtk (worker.py yang disertakan sudah melakukannya; cukup konfirmasi service `enabled`).
- [ ] Konfirmasi `worker_last_seen_at` di `anprc_settings` di-update setiap 5 dtk (kartu Worker dashboard hijau).
- [ ] Tambahkan rotasi log untuk:
  - `C:\xampp\htdocs\anpr_backend\logs\app-*.log` (error PHP)
  - `worker/worker.err.log`
  - `/var/log/mosquitto/mosquitto.log`
- [ ] Setup backup harian database `anpr_s300` (lihat DEPLOYMENT.id.md).
- [ ] Konfigurasi monitor uptime eksternal untuk hit `/api/health` setiap menit.
- [ ] Tentukan retention untuk `anprc_mqtt_inbound_log` — pada ~1 baris per kamera per 10 dtk, tabel ini tumbuh ~8.600 baris / kamera / hari. Jadwalkan harian `DELETE FROM mqtt_inbound_log WHERE received_at < NOW() - INTERVAL '30 days';` jika Anda tidak butuh history tak terbatas.

---

## Quick reference — di mana device ID disimpan

| Perangkat nyata          | Disimpan di                          |
|--------------------------|------------------------------------|
| Serial kamera entry      | `channels.anpr_device_sn` (RJ001)  |
| Serial kamera exit       | `channels.anpr_device_sn` (RJ002)  |
| URL Camera Robotic Arm   | `channels.s300_base_url` (RJ001)   |
| IP:port Road blocker     | `channels.rb_ip`, `channels.rb_port` (RJ001) |
| Device no. Road blocker  | `channels.rb_device_no` (RJ001)    |
| Board Road blocker       | `channels.rb_board_id` (RJ001)     |
| Column Road blocker      | `channels.rb_column_num` (RJ001)   |

---

## Saat ada yang rusak

| Gejala                                                | Tempat pertama untuk dicek                              |
|--------------------------------------------------------|--------------------------------------------------------|
| Dashboard menampilkan ANPR **STALE**                   | Daya kamera / network / IP broker salah di firmware    |
| Plat terdeteksi tapi inspeksi tidak mulai              | `settings.auto_start_s300 = 0`, atau `auto_start_channel` tidak cocok dengan channel kamera |
| Inspeksi selalu FAIL dengan "UVIS scan not received"  | Arm tidak terjangkau di `s300_base_url`, atau channel ID salah di firmware arm, atau `uvis_timeout_sec` terlalu pendek |
| Blocker tetap turun selamanya                          | Cron tidak berjalan (`worker_last_seen_at` stale), atau nilai `rb_*` salah konfigurasi |
| Kamera exit tidak terbuka untuk plat PASS              | Mode whitelist tidak diaktifkan di kamera, atau `paired_channel_id` tidak di-set di channel entry |
| Banyak orphan exit                                     | Kamera exit mendeteksi sebelum entry mendaftar, atau dua client mempublikasi di bawah SN yang sama |
