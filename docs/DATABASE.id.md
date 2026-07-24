# Referensi Database

Skema PostgreSQL 13+ untuk platform ANPR + S300. Sumber kanonik:
[`backend/database/schema.sql`](../backend/database/schema.sql) — dokumen ini
mencerminkannya untuk dibaca manusia.

> **Prefix `anprc_` (namespacing database bersama).** Production berjalan di
> database PostgreSQL yang dipakai bersama platform lain, jadi setiap **tabel**,
> **tipe ENUM**, dan **fungsi** trigger `updated_at` ANPR memakai prefix `anprc_`
> (mis. `anprc_channels`, `anprc_inspection_state`). **Kolom TIDAK diberi prefix**
> — kolom ter-scope ke tabelnya sehingga tak pernah bentrok, dan membiarkannya
> menjaga nama field REST/JSON (dan frontend) tetap sama. Nama index, constraint,
> dan trigger tetap bentuk aslinya (mis. `idx_channels_kind`) — terikat ke objek
> yang di-rename lewat OID. Database lama dimigrasi oleh
> `backend/database/migrations/2026-06-26_rename_to_anprc_prefix.sql`.

---

## Konvensi

- **Engine:** PostgreSQL 13+, schema tunggal `public`, role koneksi tunggal `anpr`.
- **Timestamp:** semua kolom `TIMESTAMP` (tanpa time-zone) menyimpan **UTC**.
  Insert PHP menggunakan `gmdate()`, default Postgres menggunakan `NOW()` (UTC
  karena TZ container adalah `Etc/UTC`). Frontend merender di timezone lokal
  viewer melalui `parsePgTs()`.
- **ID:** `BIGSERIAL` untuk tabel volume tinggi, `SERIAL` untuk volume rendah.
- **Boolean:** disimpan sebagai `SMALLINT` (`0`/`1`) untuk paritas dengan skema
  MySQL legacy yang menjadi asalnya.
- **Payload JSON:** `JSONB` agar dapat di-query dengan operator `->`, `->>`,
  dan `@>`.
- **Trigger updated-at:** empat tabel mempertahankan `updated_at` secara
  otomatis melalui fungsi `anprc_trg_set_updated_at()` — `anprc_channels`, `anprc_inspections`,
  `anprc_visits`, `anprc_settings`. Setiap tabel lain bersifat append-only atau memakai
  update manual.

## Tipe enum

| Enum | Nilai |
|---|---|
| `anprc_inspection_state` | `pending`, `started`, `inspecting`, `resetting`, `completed`, `emergency_stop`, `failed`, `vip_skipped` |
| `anprc_inspection_decision` | `pending`, `pass`, `suspect`, `fail`, `vip_pass` |
| `anprc_channel_kind` | `entry`, `exit`, `xray` |
| `anprc_visit_status` | `active`, `completed`, `orphan_exit`, `denied_entry` |
| `anprc_user_role` | `admin`, `operator`, `viewer` |
| `anprc_op_status` | `success`, `failed` |
| `anprc_mqtt_queue_status` | `pending`, `sent`, `failed` |

`kind = 'xray'` menandai kamera entry milik ruang x-ray sendiri: plat apa pun
yang dikenali membuka gerbang MASUK ruang tersebut (gerbang KELUAR ruang
digerakkan vendor lewat x-ray receipt).

---

## Tabel — dikelompokkan berdasarkan concern

### 1. Topologi — `anprc_locations` + `anprc_channels`

#### `anprc_locations`

Daftar master lokasi/zona site (mengisi dropdown pada form channel). Channel
mereferensikannya **berdasarkan nama** (`anprc_channels.location`), bukan FK.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | VARCHAR(64) NOT NULL UNIQUE | mis. `Gerbang Pancasila`, `Gerbang 46` (keduanya di-seed) |
| `created_at` | TIMESTAMP NOT NULL DEFAULT NOW() | |

#### `anprc_channels`

Peta gerbang fisik platform. Setiap jalur / barrier adalah satu baris channel;
seluruh konfigurasi per-jalur (kamera ANPR mana, S300 mana, road blocker mana,
perilaku apa saja yang ditegakkan jalur itu) ada di sini.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | SERIAL PK | |
| `channel_no` | VARCHAR(32) UNIQUE | ID channel stabil (mis. `RJ001`); dipakai di path API |
| `anpr_device_sn` | VARCHAR(64) | SN MQTT kamera di jalur ini |
| `s300_base_url` | VARCHAR(255) NOT NULL | Base URL HTTP robot S300 |
| `uvis_timeout_sec` | INT NOT NULL DEFAULT 30 | Timeout scan UVIS; FAIL setelah ini |
| `failure_audio_index` | INT DEFAULT 7 | Index TTS yang diputar saat FAIL |
| `name` | VARCHAR(128) | Label yang bisa dibaca manusia |
| `location` | VARCHAR(64) | Zona site tempat jalur berada (cocok dengan `anprc_locations.name`) |
| `kind` | `anprc_channel_kind` NOT NULL DEFAULT `entry` | `entry`, `exit`, atau `xray` (kamera entry ruang x-ray) |
| `paired_channel_id` | INT | **DEPRECATED (2026-07-06)** — jalur tidak berpasangan; kendaraan masuk/keluar dari jalur mana pun, operasi whitelist di-fan-out ke SEMUA kamera exit |
| `enabled` | SMALLINT 0/1 | Soft-disable tanpa menghapus |

**Relay road blocker CORX per-jalur** (kolom NULL fallback ke setting
`blocker_relay_*` global):

| Kolom | Tipe | Catatan |
|---|---|---|
| `blocker_relay_enabled` | SMALLINT NOT NULL DEFAULT 0 | Jalur MEMILIKI blocker yang digerakkan relay |
| `blocker_relay_topic` | VARCHAR(64) | Topik perintah (subscribe) |
| `blocker_relay_pub_topic` | VARCHAR(64) | Topik status device (publish), untuk ACK |
| `blocker_relay_res` | VARCHAR(16) | Device id yang di-echo kembali (kunci jalur) |
| `blocker_relay_value` | INT | Angka magic pulse (default 210001) |
| `blocker_relay_open_ch`, `blocker_relay_close_ch`, `blocker_relay_stop_ch` | VARCHAR(8) | Channel relay (mis. `A01`/`A02`/`A03`) |
| `blocker_auto_open` | SMALLINT NOT NULL DEFAULT 0 | "Auto-open saat inspeksi pass" per-jalur (fallback: setting global `blocker_auto_open_enabled`) |
| `blocker_sensor` | VARCHAR(16) NOT NULL DEFAULT `clear` | State interlock runtime dari sensor kendaraan (masa depan): `clear` \| `passing` |
| `blocker_cycle` | VARCHAR(16) NOT NULL DEFAULT `idle` | `idle` \| `lowered` \| `passed` \| `raised` |
| `blocker_position` | VARCHAR(8) NOT NULL DEFAULT `unknown` | Posisi fisik yang dikonfirmasi ACK relay: `down` \| `up` \| `unknown` |
| `blocker_last_seen` | TIMESTAMP | Heartbeat terakhir dari topik publish relay (liveness) |

**Saklar perilaku per-jalur** (site multi-jalur berbeda hardware
terpasangnya). ANPR sendiri tidak punya saklar — pengenalan + buka barrier
ADALAH jalur entry:

| Kolom | Tipe | Catatan |
|---|---|---|
| `behavior_uvis_s300` | SMALLINT NOT NULL DEFAULT 1 | `0` meng-auto-PASS inspeksi dengan catatan `UVIS+S300 disabled` |
| `s300_inspection_mode` | VARCHAR(10) NOT NULL DEFAULT `full` | Dropdown UI; menjaga `behavior_uvis_s300` tetap sinkron (`none`→0, selainnya→1). `none`=auto-pass (tanpa S300); `skip`=complete saat UVIS tiba (+`/leave`); `timed`=`/leave` `s300_timed_seconds` detik setelah verdict, mengabaikan face image; `full`=`/leave` digerakkan face image |
| `s300_timed_seconds` | SMALLINT NOT NULL DEFAULT 15 | Hitung mundur mode `timed` |
| `behavior_vip` | SMALLINT NOT NULL DEFAULT 1 | Apakah jalur ini menegakkan daftar VIP? |
| `behavior_blacklist` | SMALLINT NOT NULL DEFAULT 1 | Apakah jalur ini menegakkan blacklist? |
| `behavior_whitelist_only` | SMALLINT NOT NULL DEFAULT 0 | `1` = hanya plat whitelist (daftar VIP) yang diterima normal; kendaraan tak terdaftar diarahkan ke x-ray |

**Mode keamanan jalur** (kebijakan routing x-ray):

| Kolom | Tipe | Catatan |
|---|---|---|
| `security_mode` | VARCHAR(8) NOT NULL DEFAULT `green` | `red` = semua kendaraan ke x-ray; `orange` = `security_random_pct` % kendaraan bersih diarahkan acak (yang tidak bersih selalu diarahkan); `green` = hanya berdasarkan hasil inspeksi |
| `security_random_pct` | SMALLINT NOT NULL DEFAULT 20 | Persentase routing acak yang dipakai mode `orange` |

Indeks: `idx_channels_anpr_sn`, `idx_channels_kind`, `idx_channels_paired`.

### 2. Deteksi — `anprc_vehicles`

Log audit append-only. **Setiap plat yang dilihat ANPR mendapat baris**,
terlepas dari apakah memicu inspeksi atau tidak.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `license_plate` | VARCHAR(32) NOT NULL | Teks plat yang sudah di-decode |
| `plate_type`, `plate_color`, `car_color`, `confidence`, `direction`, `trigger_type` | INT | Metadata ANPR mentah |
| `is_fake_plate` | SMALLINT | 0/1 — ditandai oleh kamera |
| `anpr_device_sn` | VARCHAR(64) | Kamera sumber |
| `image_path`, `image_fragment_path` | VARCHAR(512) | Path snapshot yang dilaporkan device (sering kosong) |
| `full_image_path` | VARCHAR(512) | Path relatif snapshot full-scene tersimpan (di-decode dari `full_image_content` ivs_result); JPEG-nya ada di disk di bawah `uploads/vehicles/`, DB hanya menyimpan path |
| `small_image_path` | VARCHAR(512) | Path relatif close-up plat (dari `small_image_content`) |
| `unique_id` | VARCHAR(64) | ID deteksi unik per-kamera |
| `detected_at` | TIMESTAMP NOT NULL | Kapan kamera menangkapnya |
| `created_at` | TIMESTAMP NOT NULL DEFAULT NOW() | Kapan backend mencatatnya |

Indeks: `idx_vehicles_plate`, `idx_vehicles_detected`, `idx_vehicles_unique`.

### 3. Lifecycle inspeksi — `anprc_inspections`

Jantung dari sistem. Satu baris per siklus S300. Menampung **dua field state
paralel**:

- `state` (`anprc_inspection_state`) — lifecycle platform: pending → started →
  inspecting → resetting → completed
- `current_operating_state` (SMALLINT 0-6) — cermin langsung dari yang
  terbaru dilaporkan S300 via `work-status` (cmd 322)

Keduanya sengaja dipisah agar platform tidak prematur menandai inspeksi
sebagai complete pada heartbeat `op=3` yang sesaat. State hanya maju pada
event HTTP (`/come`, `/leave`) dan callback `reset-complete`.

Verdict **SUSPECT** ditahan untuk review manusia: baris tetap
`decision='suspect'` dengan `review_status='pending'` dan **tidak ada
side-effect yang berjalan** (tanpa road blocker, tanpa `/leave`) sampai
operator menyetujui atau menolaknya (tercatat di `reviewed_by` /
`reviewed_at`). Approve menjalankan jalur pass; reject menjalankan jalur fail.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `channel_no` | VARCHAR(32) NOT NULL | Jalur tempat inspeksi ini berjalan |
| `vehicle_id` | BIGINT | FK ke `vehicles.id` — diambil saat `/come` |
| `license_plate` | VARCHAR(32) NOT NULL | |
| `state` | `anprc_inspection_state` | Lifecycle platform |
| `decision` | `anprc_inspection_decision` | `pending`, `pass`, `suspect`, `fail`, `vip_pass` |
| `decision_reason` | VARCHAR(255) | Alasan (`Undercarriage clean`, `UVIS scan not received within timeout`, …) |
| `decision_at`, `decision_timeout_at` | TIMESTAMP | Kapan diputuskan, kapan akan timeout |
| `xray_route` | VARCHAR(16) | Alasan kendaraan diarahkan ke x-ray (NULL = tidak diarahkan): `inspection` (verdict fail/suspect) · `security_red` · `security_random` · `manual` (tombol operator) · `blacklist` · `whitelist_only` (tak terdaftar di jalur whitelist-only) |
| `review_status` | VARCHAR(16) | NULL normalnya; `pending` selama SUSPECT menunggu review manual; `approved`/`rejected` setelah operator memutuskan |
| `reviewed_by` | VARCHAR(64) | Username penyetuju/penolak |
| `reviewed_at` | TIMESTAMP | Kapan manusia memutuskan (UTC) |
| `blocker_opened` | SMALLINT 0/1 | Apakah kolom diturunkan? |
| `blocker_opened_at`, `blocker_closed_at` | TIMESTAMP | Cron menaikkan kolom ~8 dtk setelah open |
| `blocker_open_due_at` | TIMESTAMP | Open blocker tertunda: di-set saat verdict ke now + `blocker_open_delay_s`; sweep cron membuka blocker + menyelesaikan inspeksi saat jatuh tempo |
| `auto_leave_called` | SMALLINT 0/1 | Apakah platform memanggil `/leave`? |
| `current_operating_state` | SMALLINT | Angka cmd-322 terbaru dari S300 |
| `come_called_at`, `inspection_started_at`, `inspection_ended_at`, `leave_called_at`, `reset_completed_at` | TIMESTAMP | Timeline langkah-demi-langkah |

Indeks: `idx_insp_channel`, `idx_insp_plate`, `idx_insp_state`,
`idx_insp_vehicle`, `idx_insp_decision`, `idx_insp_timeout`.

**Constraint kritis:**

- **Partial unique index** `uq_one_active_inspection_per_channel` —
  ```
  CREATE UNIQUE INDEX uq_one_active_inspection_per_channel
      ON anprc_inspections (channel_no)
      WHERE state IN ('pending','started','inspecting','resetting');
  ```
  Membuat busy-guard race-proof. Dua `/come` yang tiba pada milidetik yang
  sama tidak bisa keduanya membuat inspeksi aktif; yang kedua akan menabrak
  pelanggaran `23505` yang dikonversi `S300Controller::come()` menjadi `409`
  yang bersih.

- **Partial index** `idx_insp_blocker_open` — mempercepat sweep cron yang
  menutup blocker yang sudah dibuka tapi belum ditutup lebih lama dari
  `blocker_auto_close_sec`.

### 4. Callback S300 — tabel detail anak

Semuanya di-key dengan `inspection_id` (soft FK — tanpa referensi yang
ditegakkan karena callback S300 bisa tiba sebelum platform membuat baris
inspeksinya, dan kita ingin menyimpan sinyal mentahnya).

#### `anprc_inspection_status_logs`
Setiap callback `work-status` (cmd 322). Berguna untuk merekonstruksi timeline
S300 itu sendiri. `operating_state` adalah enum SMALLINT 0-6; `raw_payload`
menyimpan JSON penuhnya.

#### `anprc_inspection_face_images`
Foto pengemudi/penumpang yang dikirim via endpoint `face-image` (cmd 323).
Disimpan sebagai URL yang menunjuk ke direktori `uploads/` platform.

#### `anprc_inspection_video_streams`
URL video dari kamera S300. `camera_code` adalah label channel internal S300
(mis. `A`, `B`); `stream_kind` membedakan `record` (video rekaman protokol
3.7, default) dari `realtime` (stream live cmd 325).

#### `anprc_inspection_xray` (protokol 3.6 + receipt §2.2.4)
Satu baris per scan x-ray yang dikirim vendor. Scan itu sendiri
(`vehicle_number`, `scan_started_at`/`scan_ended_at`, `is_anomaly`,
`anomaly_comments`, `scanner_operator`, `scanned_image_path`,
`plate_image_path`, `alarm_info` JSONB) ditautkan ke inspeksi terbaru via
`inspection_id` bila ada dalam rentang `xray_clearance_window_s`.

Di atas scan tersebut ada **alur review + receipt**: scan normal (tanpa
anomali) di-receipt otomatis (`review_status='auto'`) saat
`xray_auto_receipt=1`; scan beranomali menunggu verdict operator di tab X-Ray.
Receipt (`POST {vendor}/x-ray/{channelNo}`) membuka barrier keluar ruang
x-ray saat `Result:true`.

| Kolom | Tipe | Catatan |
|---|---|---|
| `review_status` | VARCHAR(16) NOT NULL DEFAULT `pending` | `pending` (menunggu operator) · `auto` (auto-pass, tanpa anomali) · `passed` · `denied` |
| `reviewed_by` | VARCHAR(128) | Username operator |
| `reviewed_at` | TIMESTAMP | Kapan operator memutuskan (UTC) |
| `review_note` | VARCHAR(512) | Catatan operator opsional |
| `receipt_result` | SMALLINT | `1` = `Result:true` (buka barrier), `0` = `Result:false` |
| `receipt_status` | VARCHAR(16) | `sent` \| `failed` (NULL = belum dicoba) |
| `receipt_error` | VARCHAR(512) | Error vendor/transport saat gagal |
| `receipt_sent_at` | TIMESTAMP | Kapan POST receipt berhasil |

Indeks: `idx_xray_inspection`, `idx_xray_received (received_at DESC)`,
`idx_xray_review (review_status)`.

#### `anprc_inspection_uvis` + `anprc_inspection_uvis_coords`
Hasil scan undercarriage. `image_type` = 0 (clean) / 1 (suspect).
`object_count` adalah jumlah objek asing terdeteksi. Saat `>0`, baris anak di
`anprc_inspection_uvis_coords` memberikan koordinat bounding-box dan confidence
untuk setiap objek terdeteksi.

---

### 5. Kunjungan & laporan — `anprc_visits`

Catatan menghadap pengguna tentang "kendaraan X masuk di Y dan keluar di Z".
Satu baris per kedatangan; di-update di tempat saat keluar.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `license_plate` | VARCHAR(32) NOT NULL | |
| `entry_channel_no`, `exit_channel_no` | VARCHAR(32) | Dari mana masuk / dari mana keluar |
| `entry_inspection_id` | BIGINT | FK ke inspeksi yang mengizinkan masuk |
| `entry_at`, `exit_at` | TIMESTAMP | UTC; durasi = `exit_at - entry_at` |
| `status` | `anprc_visit_status` | `active` · `completed` · `orphan_exit` · `denied_entry` |
| `notes` | VARCHAR(255) | Free-form (dipakai untuk mencatat alasan FAIL pada `denied_entry`) |
| `orphan_review` | VARCHAR(16) | Konfirmasi manual orphan-exit: `pending` · `allowed` · `denied` (NULL pada baris non-orphan dan orphan legacy). `allowed` membuka barrier keluar |
| `orphan_reviewed_by` | VARCHAR(128) | Operator yang mengonfirmasi/menolak orphan exit |
| `orphan_reviewed_at` | TIMESTAMP | Kapan (UTC) |

Transisi status:

```
        VisitService::createEntry()                 VisitService::closeVisit()
inspections.PASS ───────────────────────► active ──────────────────────────► completed
                                            │
                                            │  DecisionExecutor (saat FAIL)
                                            ▼
                                       denied_entry

       kamera exit mendeteksi plat tapi tidak ada visit aktif
                            │
                            ▼
                       orphan_exit  (orphan_review='pending' → operator
                                     mengizinkan atau menolak membuka barrier)
```

Indeks: `idx_visits_plate`, `idx_visits_status`, `idx_visits_entry_at`,
`idx_visits_exit_at`, komposit `idx_visits_active_plate (license_plate, status)` —
dipakai agar `findActiveVisit()` menjadi O(index lookup) — dan partial
`idx_visits_orphan_review ON (orphan_review) WHERE orphan_review = 'pending'`
untuk polling konfirmasi-pending di CP.

### 6. MQTT — antrian outbound + log inbound

#### `anprc_mqtt_outbound_queue`
Platform tidak pernah memanggil `mqtt.publish()` secara langsung. Apa pun
yang ditujukan ke perangkat MQTT diantrekan di sini; Python worker menguras
antrian setiap 3 detik dan meng-ACK via `/api/mqtt-queue/{id}/sent|failed`.
Bertahan terhadap restart backend.

| Kolom | Tipe | Catatan |
|---|---|---|
| `device_sn` | VARCHAR(64) NOT NULL | Perangkat tujuan |
| `command_name` | VARCHAR(64) NOT NULL | mis. `white_list_operator`, `tts_voice` |
| `payload` | JSONB NOT NULL | Body perintah MQTT |
| `status` | `anprc_mqtt_queue_status` | `pending` → `sent` ‖ `failed` |
| `attempts` | INT | Worker menambah setiap percobaan |
| `last_error` | TEXT | Alasan kegagalan terakhir |
| `created_at`, `sent_at` | TIMESTAMP | UTC |

Indeks: komposit `idx_mq_status_id (status, id)` untuk query worker
"beri saya N berikutnya yang pending"; `idx_mq_device` untuk filter per
perangkat di halaman MQTT Logs.

#### `anprc_mqtt_inbound_log`
Setiap pesan MQTT yang worker subscribe (`device/+/message/up/+`) mendapat
satu baris. Dipakai oleh halaman MQTT Logs dan feed "Recent Plates" pada
dashboard.

| Kolom | Tipe | Catatan |
|---|---|---|
| `device_sn` | VARCHAR(64) NOT NULL | Diparse dari topik |
| `topic` | VARCHAR(255) NOT NULL | String topik penuh |
| `message_name` | VARCHAR(64) NOT NULL | `ivs_result`, `keep_alive`, `gpio_in`, `barr_gate_status` |
| `license_plate` | VARCHAR(32) | Diekstrak sebelumnya saat ingest dari payload `ivs_result` — diindeks untuk filter plat cepat |
| `payload` | JSONB | Body pesan mentah penuh |
| `received_at` | TIMESTAMP NOT NULL DEFAULT NOW() | UTC |

Indeks: `idx_mqtt_in_sn`, `idx_mqtt_in_name`,
`idx_mqtt_in_received (received_at DESC)`,
komposit `idx_mqtt_in_sn_recv (device_sn, received_at DESC)`,
partial `idx_mqtt_in_plate ON (license_plate) WHERE license_plate IS NOT NULL`.

### 7. Audit HTTP inbound — `anprc_inbound_events_raw`

Robot S300 berbicara HTTP ke platform. Setiap callback S300 yang masuk
mendapat baris mentah di sini **sebelum** parsing apa pun, sehingga kita bisa
replay event yang korup kemudian jika ada bug kode yang memakannya.

| Kolom | Tipe | Catatan |
|---|---|---|
| `endpoint` | VARCHAR(64) NOT NULL | `work-status`, `face-image`, `video-record`, `uvis`, `reset-complete` |
| `cmd_no` | INT | Nomor perintah S300 (322, 323, 325, 326) |
| `channel_no` | VARCHAR(32) | Jika URL mengandungnya |
| `source_ip` | VARCHAR(45) | IP pemanggil — untuk mendeteksi S300 yang salah konfigurasi |
| `raw_body` | TEXT | Body POST verbatim |
| `received_at` | TIMESTAMP NOT NULL DEFAULT NOW() | UTC |

### 8. Daftar plat — `anprc_vip_plates` + `anprc_blacklist_plates`

Kedua daftar berbentuk sama: ter-scope per-jalur, soft-disable, kedaluwarsa
opsional.

#### `anprc_vip_plates` (whitelist)

Plat di sini melewati seluruh siklus S300: inspeksi dibuat dengan
`state='vip_skipped'`, `decision='vip_pass'`, blocker langsung terbuka, tanpa
panggilan S300. Hanya ditegakkan di jalur dengan `behavior_vip = 1`.

#### `anprc_blacklist_plates`

Daftar tahap-ANPR yang dicek saat `/come` **sebelum** bypass VIP, sehingga
mengalahkan VIP. Plat yang di-blacklist melewatkan inspeksi dan diarahkan ke
x-ray (`xray_route='blacklist'`, prompt suara `blacklist_voice_text`). Hanya
ditegakkan di jalur dengan `behavior_blacklist = 1`.

Kolom bersama:

| Kolom | Tipe | Catatan |
|---|---|---|
| `license_plate` | VARCHAR(32) NOT NULL | |
| `description` | VARCHAR(255) | |
| `enabled` | SMALLINT 0/1 | Soft-disable |
| `channel_no` | VARCHAR(32) | Scope jalur: NULL = berlaku di SEMUA jalur; selain itu hanya channel tersebut. Plat yang sama boleh ada di beberapa scope (satu baris per jalur) |
| `expires_at` | TIMESTAMP | NULL = permanen; `expires_at` yang lewat berarti entri tidak lagi cocok (`isVip` / `isBlacklisted` menyaringnya) tapi barisnya tetap terlihat di CP sebagai "expired" |

Keunikan: `uq_vip_plate_scope` / `uq_blacklist_plate_scope` pada
`(license_plate, COALESCE(channel_no, '*'))` — satu baris per plat per scope.

### 9. Prompt audio — `anprc_audio_prompts`

Tabel referensi dari klip audio TTS terindeks yang dapat diminta platform
untuk diputar S300 (`/api/v1/device-s300/audio-prompt`). Default
`failure_audio_index` pada `anprc_channels` adalah `7` ("silakan mundur").

Keunikan komposit: `(audio_index, language)`.

### 10. Auth — `anprc_users`

Platform melakukan autentikasi via SSO dari portal induk (lihat
[`DEV_LOGIN.id.md`](./DEV_LOGIN.id.md)). Tabel ini menyimpan **shadow rows** —
satu baris per username yang pernah dilihat oleh endpoint SSO. Shadow row
menjadi source-of-truth untuk role + atribusi token; kolom `password_hash`
tetap ada (untuk memenuhi NOT NULL) tetapi diisi nilai acak yang tidak dapat
ditebak karena user SSO tidak pernah login dengan password.

| Kolom | Tipe | Catatan |
|---|---|---|
| `username` | VARCHAR(64) UNIQUE | Mencerminkan username portal induk |
| `password_hash` | VARCHAR(255) NOT NULL | Acak untuk user SSO — tidak pernah diverifikasi |
| `display_name` | VARCHAR(128) | Disinkron dari induk pada setiap login |
| `role` | `anprc_user_role` | `admin` · `operator` · `viewer` — dipetakan dari peran induk |
| `enabled` | SMALLINT 0/1 | Diset 1 pada setiap SSO sukses; 0 untuk mengunci |

Baris di-upsert oleh `AuthController::sso` pada setiap login sukses. Dengan
`auth.dev_bypass = true` di `config.php`, username apa pun membuat baris
dengan `role = 'admin'` (memudahkan pengembangan lokal).

### 11. Konfigurasi — `anprc_settings`

Penyimpanan key/value sederhana. Hot-reload oleh worker setiap 10 detik.

Key yang di-seed (dari `schema.sql`):

| Key | Default | Tujuan |
|---|---|---|
| `platform_name` | "ANPR + S300 Integrated Platform" | Nama tampilan |
| `default_s300_base_url` | `http://192.168.1.50:8080` | Dipakai saat membuat channel baru |
| `mqtt_broker_url` | `ws://localhost:8083/mqtt` | Endpoint MQTT WebSocket frontend |
| `uvis_image_dir` | `uploads/uvis` | Path penyimpanan gambar UVIS |
| `vip_plates` | kosong | Daftar comma-separated legacy (pakai tabel `anprc_vip_plates` saja) |
| `auto_start_s300` | `0` | Worker auto-trigger `/come` pada deteksi saat `1` |
| `auto_start_channel` | `RJ001` | Channel fallback saat SN tidak ter-mapping |
| `blacklist_voice_enabled` | `1` | Bersuara di kamera entry saat plat blacklist terlihat |
| `blacklist_voice_text` | `Blacklisted Vehicle. Go To X-RAY` | Prompt suara blacklist (mengarahkan ke x-ray, tidak lagi menolak) |
| `blacklist_led_enabled` | `1` | Tampilkan teks LED untuk plat blacklist |
| `blacklist_led_text` | `BLACKLIST` | Teks LED |
| `whitelist_deny_voice_text` | `Unregistered Vehicle. Go To X-RAY` | Prompt jalur whitelist-only untuk kendaraan tak terdaftar (diarahkan ke x-ray; saklar on suara/LED dipakai bersama blacklist) |
| `whitelist_deny_led_text` | `NOT REGISTERED` | Teks LED pada jalur whitelist-only |
| `s300_audio_failure_url` | kosong | URL file WAV yang diunduh S300 untuk prompt mundur saat FAIL (kosong = belum ada yang terdaftar) |
| `videotron_xray_text` | `GO TO X-RAY` | Teks yang ditampilkan videotron ke kendaraan yang diarahkan maju ke x-ray |
| `xray_channel_no` | `XRAY01` | Channel yang dipakai pada receipt `POST /x-ray/{channelNo}` (protokol §2.2.4) |
| `xray_base_url` | kosong | Base URL vendor untuk receipt (kosong = fallback ke `default_s300_base_url`) |
| `xray_auto_receipt` | `1` | Auto-receipt scan normal (tanpa anomali) dengan `Result:true` |
| `xray_clearance_window_s` | `3600` | Rentang (detik) untuk menautkan scan ke inspeksi terbaru DAN untuk masuk-kembali tanpa inspeksi di jalur utama setelah scan PASSED |
| `s300_auto_leave_enabled` | `1` | `/leave` langsung ke S300 setelah keputusan (device asli membutuhkannya untuk reset + memancarkan video rekaman) |
| `face_leave_delay_s` | `3` | `/leave` menembak sekian detik setelah face image PERTAMA |
| `blocker_open_delay_s` | `60` | Delay fallback open tertunda saat face image tidak pernah tiba (dihitung dari verdict UVIS) |
| `blocker_reset_interval_s` | `7` | Jeda ekstra antara `/leave` dan menurunkan blocker, agar S300 sempat reset sebelum barrier bergerak |
| `blocker_auto_close_sec` | `8` | Detik kolom tetap Lowered setelah PASS |
| `blocker_close_mode` | `hardware` | `hardware` = controller naik sendiri via loop detector-nya (default aman); `backend_timer` = naik ber-timer software legacy (risiko tergencet) |
| `blocker_relay_enabled` | `1` | Saklar global relay CORX CX-5104E-L (kolom per-jalur meng-override) |
| `blocker_relay_topic` | `testsubscribe` | Topik perintah relay |
| `blocker_relay_value` | `210001` | Nilai magic "pulse" vendor |
| `blocker_relay_res` | `123` | Equipment id (≤15 karakter) |
| `blocker_relay_open_ch` / `blocker_relay_close_ch` / `blocker_relay_stop_ch` | `A01` / `A02` / `A03` | Channel relay |
| `blocker_auto_open_enabled` | `0` | Fallback auto-open global; OFF = alur inspeksi tidak pernah menyentuh blocker (risiko tabrakan) |

Key runtime / di-set lewat CP (tidak di-seed oleh `schema.sql`):

| Key | Tujuan |
|---|---|
| `entry_gate_open` | Saat `1`, platform membuka gerbang milik kamera ANPR sendiri (via `gpio_out`) saat `/come` |
| `entry_gate_io` | Index output kamera (0-3) yang terhubung ke gerbang itu |
| `entry_gate_value` | Nilai gpio_out: 0=OFF, 1=ON, 2=Pulse |
| `entry_gate_pulse_ms` | Durasi pulse (ms) saat `entry_gate_value=2` |
| `worker_last_seen_at` | Heartbeat ditulis oleh setiap cron tick; disimpan sebagai string ISO-8601 GMT+7 ber-offset (bukan UTC naif) agar terbaca tanpa ambigu |

### 12. Jejak audit — `anprc_operation_log`

Log append-only dari setiap aksi platform — baik keputusan otomatis maupun
intervensi manual operator. Memberi tenaga pada tab "Operations" pada detail
inspeksi dan halaman **Log Audit** di sidebar (Diagnostik → Log Audit).

| Kolom | Tipe | Catatan |
|---|---|---|
| `actor_username` | VARCHAR(64) | Username SSO yang memicu aksi. NULL untuk aksi sistem (cron, dorongan keputusan, callback inbound S300). |
| `channel_no` | VARCHAR(32) | |
| `inspection_id` | BIGINT | |
| `action` | VARCHAR(64) NOT NULL | Lihat katalog aksi di bawah |
| `request_payload`, `response_payload` | JSONB | Kedua sisi pemanggilan |
| `status` | `anprc_op_status` | `success` · `failed` |
| `error_message` | TEXT | Diisi saat gagal |

Indeks pada `(actor_username)`, `(channel_no)`, `(inspection_id)`, `(action)`,
`(created_at)` — setiap drill-down umum memiliki indeks.

> **Catatan migrasi**: Tabel ini sebelumnya memiliki kolom `user_id INT`.
> Diubah menjadi `actor_username VARCHAR(64)` agar username SSO menjadi kunci
> audit (tanpa juggling user-id internal). Skrip migrasi:
> `backend/database/migrations/2026-05-25_oplog_actor_username.sql`.

#### Katalog aksi (tidak lengkap)

| Kategori | Aksi |
|---|---|
| Auth | `auth.sso_login` |
| Channels | `channel.create`, `channel.update`, `channel.delete` |
| Settings | `settings.update` |
| Plat VIP | `vip.create`, `vip.update`, `vip.delete` |
| S300 (operator) | `come`, `come_vip_bypass`, `capture`, `leave`, `read_work_status`, `emergency_stop`, `manual_reset`, `audio_prompt`, `video_playback` |
| S300 (sistem) | `auto_decision`, `open_blocker`, `blocker_close`, `send_backup_audio`, `auto_leave`, `reset_watchdog`, `whitelist_enqueue_add`, `route_to_xray` |

---

## Hubungan soft

Skema sengaja tidak memakai constraint `FOREIGN KEY`. Setiap tabel "anak"
menyimpan ID integer parent, tapi FK ditegakkan di lapisan aplikasi. Alasan:

- Callback S300 (`anprc_inspection_status_logs`, `face_images`, dll.) bisa tiba
  sebelum platform membuat baris inspeksi parent.
- Tabel audit append-only (`anprc_vehicles`, `anprc_inbound_events_raw`, `anprc_operation_log`,
  `anprc_mqtt_inbound_log`) harus menerima baris meskipun entity terkait sudah
  hard-deleted.
- Migrasi skema selama fase pengembangan aktif lebih mudah tanpa harus
  memelihara cascade FK.

Peta hubungan di bawah ini karenanya implisit, tidak ditegakkan oleh
constraint:

```
       ┌──────────────┐     ┌────────────────────────────────────────┐
       │  locations   │◄────│              channels                  │
       │  id, name    │name │  id, channel_no, kind, location,       │
       └──────────────┘     │  behavior_*, security_mode, blocker_*  │
                            └───────┬──────────────────┬─────────────┘
                                    │                  │
                                    │ channel_no       │ channel_no
                                    ▼                  ▼
       ┌──────────────────────────┐    ┌────────────────────┐
       │       inspections        │    │       visits       │
       │ id, channel_no,          │◄──┐│ id, plate,         │
       │ vehicle_id, plate,       │   ││ entry_inspection   │
       │ state, decision,         │   ││ status, entry_at   │
       │ xray_route, blocker_*    │   ││ exit_at, orphan_*  │
       └─┬──────┬──────┬───┬───┬──┘   │└────────────────────┘
         │      │      │   │   │      │
         │      │      │   │   │      │ entry_inspection_id
         │      │      │   │   │      └─────────────────────────────────
         │      │      │   │   │
         ▼      ▼      ▼   ▼   ▼
  status_logs face_  video_ uvis ──► uvis_coords
              images streams
                            xray  (scan + review/receipt)

                            ▲
                            │ vehicle_id
       ┌──────────────────┐ │
       │     vehicles     │─┘
       │ id, plate, sn    │
       │ detected_at      │
       └──────────────────┘

       ┌──────────────────┐    ┌──────────────────┐
       │ mqtt_outbound_   │    │ mqtt_inbound_log │
       │      queue       │    │  device_sn,      │
       │ device_sn, cmd,  │    │  topic, plate    │
       │ payload, status  │    │  payload         │
       └──────────────────┘    └──────────────────┘
              │                          ▲
              │ dikuras worker           │ ditulis worker
              └──────────────────────────┘

  ┌────────────────┐ ┌──────────────────┐ ┌──────────────┐ ┌────────────────┐
  │   vip_plates   │ │ blacklist_plates │ │   settings   │ │ operation_log  │
  │ plate, scope,  │ │  plate, scope,   │ │  key, value  │ │ inspection_id  │
  │ expires_at     │ │  expires_at      │ └──────────────┘ │ action, status │
  └────────────────┘ └──────────────────┘                  └────────────────┘
```

---

## Pola proteksi race yang patut diperhatikan

1. **Satu inspeksi aktif per channel** — partial unique index pada
   `inspections.channel_no WHERE state IN (active states)`. Menggantikan
   busy-guard "check-then-insert" dengan pelanggaran constraint atomik yang
   ditangkap controller sebagai 409.

2. **Antrian perintah MQTT, bukan publish langsung** — mencegah backend
   memblok pada broker yang tidak terjangkau, membuat retry bisa terjadi
   out-of-band, dan memberi setiap perintah catatan permanen.

3. **Heartbeat di tabel settings** — `worker_last_seen_at` di-update oleh
   tick cron, dibaca oleh dashboard. Tidak perlu tabel heartbeat khusus,
   tidak perlu IPC.

4. **Log inbound append-only** (`anprc_inbound_events_raw`, `anprc_mqtt_inbound_log`) —
   bahkan saat parsing downstream gagal, sinyal mentah tetap tersimpan untuk
   replay atau analisis forensik.

---

## Migrasi

`schema.sql` bersifat **konsolidasi** — sudah memuat semua perubahan di
bawah, jadi instalasi baru tidak memerlukan skrip migrasi apa pun. File di
`backend/database/migrations/` hanya untuk meng-upgrade database yang dibuat
sebelum perubahan yang dibawanya. Yang terbaru:

| File | Fungsinya |
|---|---|
| `2026-07-17_xray_review.sql` | Kolom review/receipt x-ray + `idx_xray_review`; `security_mode` / `security_random_pct` di channels; `inspections.xray_route`; default suara blacklist → "Go To X-RAY"; seed `xray_channel_no` / `xray_base_url` / `xray_auto_receipt` |
| `2026-07-19_orphan_review.sql` | Kolom `visits.orphan_review*` + partial `idx_visits_orphan_review` |
| `2026-07-19_xray_room.sql` | Menambah `xray` ke `anprc_channel_kind`; seed `xray_clearance_window_s` |
| `2026-07-20_list_expiry.sql` | `expires_at` pada `anprc_vip_plates` + `anprc_blacklist_plates` |
| `2026-07-20_whitelist_xray.sql` | Default suara penolakan whitelist-only → "Unregistered Vehicle. Go To X-RAY" |

---

## Data seed yang di-insert pada first run

- Satu shadow user `admin` (tidak ada password yang dapat dipakai — SSO satu-
  satunya jalur login; lihat [`DEV_LOGIN.id.md`](./DEV_LOGIN.id.md))
- Dua baris `anprc_locations`: `Gerbang Pancasila`, `Gerbang 46`
- Baris `anprc_settings` default — nama platform, broker MQTT, flag auto-start,
  teks suara + LED blacklist/whitelist, konfigurasi receipt x-ray, timing
  leave/delay S300, dan default relay blocker CORX (lihat §11)
- Satu starter `channel` `RJ001` (entry)

Jalankan `psql -f backend/database/schema.sql` terhadap database kosong —
transaksi `BEGIN ... COMMIT` membuat seluruh import atomik, dan setiap
`CREATE` adalah `IF NOT EXISTS` sehingga menjalankan ulang adalah no-op.
