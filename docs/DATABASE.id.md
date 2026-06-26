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
| `anprc_channel_kind` | `entry`, `exit` |
| `anprc_visit_status` | `active`, `completed`, `orphan_exit`, `denied_entry` |
| `anprc_user_role` | `admin`, `operator`, `viewer` |
| `anprc_op_status` | `success`, `failed` |
| `anprc_mqtt_queue_status` | `pending`, `sent`, `failed` |

---

## Tabel — dikelompokkan berdasarkan concern

### 1. Topologi — `anprc_channels`

Peta gerbang fisik platform. Setiap jalur / barrier adalah satu baris channel;
seluruh konfigurasi per-jalur (kamera ANPR mana, S300 mana, road blocker mana)
ada di sini.

| Kolom | Tipe | Catatan |
|---|---|---|
| `id` | SERIAL PK | |
| `channel_no` | VARCHAR(32) UNIQUE | ID channel stabil (mis. `RJ001`); dipakai di path API |
| `anpr_device_sn` | VARCHAR(64) | SN MQTT kamera di jalur ini |
| `s300_base_url` | VARCHAR(255) NOT NULL | Base URL HTTP robot S300 |
| `rb_ip`, `rb_port` | VARCHAR/INT | Endpoint REST road blocker |
| `rb_device_no`, `rb_board_id`, `rb_column_num` | VARCHAR/VARCHAR/INT | Pengalamatan fisik di dalam road blocker |
| `uvis_timeout_sec` | INT NOT NULL DEFAULT 30 | Timeout scan UVIS; FAIL setelah ini |
| `failure_audio_index` | INT DEFAULT 7 | Index TTS yang diputar saat FAIL |
| `name` | VARCHAR(128) | Label yang bisa dibaca manusia |
| `kind` | `anprc_channel_kind` NOT NULL DEFAULT `entry` | Entry atau exit |
| `paired_channel_id` | INT | Pasangan entry/exit untuk routing whitelist |
| `enabled` | SMALLINT 0/1 | Soft-disable tanpa menghapus |

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
| `image_path`, `image_fragment_path` | VARCHAR(512) | URL snapshot |
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

Keduanya sengaja dipisah agar platform tidak prematurly menandai inspeksi
sebagai complete pada heartbeat `op=3` yang sesaat. State hanya maju pada
event HTTP (`/come`, `/leave`) dan callback `reset-complete`.

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
| `blocker_opened` | SMALLINT 0/1 | Apakah kolom diturunkan? |
| `blocker_opened_at`, `blocker_closed_at` | TIMESTAMP | Cron menaikkan kolom ~8 dtk setelah open |
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
URL MJPEG/RTSP live dari kamera S300 (`video-record`, cmd 325). `camera_code`
adalah label channel internal S300 (mis. `A`, `B`).

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
                       orphan_exit
```

Indeks: `idx_visits_plate`, `idx_visits_status`, `idx_visits_entry_at`,
`idx_visits_exit_at`, komposit `idx_visits_active_plate (license_plate, status)` —
dipakai agar `findActiveVisit()` menjadi O(index lookup).

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

### 8. Allowlist VIP — `anprc_vip_plates`

Plat di sini melewati seluruh siklus S300: inspeksi dibuat dengan
`state='vip_skipped'`, `decision='vip_pass'`, blocker langsung terbuka, tanpa
panggilan S300.

| Kolom | Tipe |
|---|---|
| `license_plate` | VARCHAR(32) NOT NULL UNIQUE |
| `description` | VARCHAR(255) |
| `enabled` | SMALLINT 0/1 — soft-disable |

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

| Key | Default | Tujuan |
|---|---|---|
| `platform_name` | "ANPR + S300 Integrated Platform" | Nama tampilan |
| `default_s300_base_url` | `http://192.168.1.50:8080` | Dipakai saat membuat channel baru |
| `mqtt_broker_url` | `ws://localhost:8083/mqtt` | Endpoint MQTT WebSocket frontend |
| `uvis_image_dir`, `xray_image_dir` | `uploads/uvis`, `uploads/xray` | Path penyimpanan |
| `vip_plates` | kosong | Daftar comma-separated legacy (pakai tabel `anprc_vip_plates` saja) |
| `auto_start_s300` | `0` | Worker auto-trigger `/come` pada deteksi saat `1` |
| `auto_start_channel` | `RJ001` | Channel fallback saat SN tidak ter-mapping |
| `blocker_auto_close_sec` | `8` | Detik kolom tetap Lowered setelah PASS |
| `worker_last_seen_at` | (di-set saat runtime) | Heartbeat ditulis oleh setiap cron tick |

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
| S300 (sistem) | `auto_decision`, `open_blocker`, `blocker_close`, `send_backup_audio`, `auto_leave`, `reset_watchdog`, `whitelist_enqueue_add` |

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
                    ┌────────────────────────────────────────┐
                    │              channels                  │
                    │     id, channel_no, kind, paired_id    │
                    └───────┬──────────────────┬─────────────┘
                            │                  │
                            │ channel_no       │ channel_no
                            ▼                  ▼
       ┌──────────────────────────┐    ┌──────────────────┐
       │       inspections        │    │      visits      │
       │ id, channel_no,          │◄──┐│ id, plate,       │
       │ vehicle_id, plate,       │   ││ entry_inspection │
       │ state, decision,         │   ││ status, entry_at │
       │ blocker_*, *_at          │   ││ exit_at          │
       └─┬──────┬──────┬──────┬───┘   │└──────────────────┘
         │      │      │      │       │
         │      │      │      │       │ entry_inspection_id
         │      │      │      │       └─────────────────────────────────
         │      │      │      │
         ▼      ▼      ▼      ▼
  status_logs face_   video_  uvis ──► uvis_coords
              images  streams        xray ──► xray_alarms

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

       ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
       │   vip_plates     │    │     settings     │    │  operation_log   │
       │  plate, enabled  │    │  key, value      │    │ inspection_id    │
       └──────────────────┘    └──────────────────┘    │ action, status   │
                                                       └──────────────────┘
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

## Data seed yang di-insert pada first run

- Satu shadow user `admin` (tidak ada password yang dapat dipakai — SSO satu-
  satunya jalur login; lihat [`DEV_LOGIN.id.md`](./DEV_LOGIN.id.md))
- Baris `anprc_settings` default untuk nama platform, broker MQTT, flag auto-start,
  delay close blocker
- Satu starter `channel` `RJ001` (entry)

Jalankan `psql -f backend/database/schema.sql` terhadap database kosong —
transaksi `BEGIN ... COMMIT` membuat seluruh import atomik, dan setiap
`CREATE` adalah `IF NOT EXISTS` sehingga menjalankan ulang adalah no-op.
