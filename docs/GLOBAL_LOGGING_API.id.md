# API Global Logging — Kontrak Integrasi (Draf)

Platform inspeksi ANPR akan **mengirim (push) catatan log** ke sistem mitra
untuk setiap peristiwa kendaraan. Sisi mitra membangun endpoint penerimanya;
dokumen ini mendefinisikan apa yang kami kirim.

## Request

| Properti | Nilai |
|---|---|
| Method | `POST` |
| Path (ditentukan mitra) | mis. `POST http://<host-mitra>/api/anpr-log` |
| Content-Type | `application/json; charset=utf-8` |
| Auth (saran) | header `X-Api-Key: <kunci bersama>` |

## Contoh body — push awal (x-ray belum terisi)

```json
{
  "event_id": "anprc-RJ001-20260720-000123",
  "event_type": "entry_inspection",
  "visit_id": 456,
  "channel_no": "RJ001",
  "license_plate": "B1234ABC",
  "detected_at": "2026-07-20 14:32:11",
  "decision": "pass",
  "vehicle_photo": "http://10.10.33.144/anpr_backend/uploads/vehicles/2026/07/20/veh_000123.jpg",
  "uvis_image": "http://10.10.33.144/anpr_backend/uploads/uvis/2026/07/20/uvis_000123.jpg",
  "face_images": [
    "http://10.10.33.144/anpr_backend/uploads/faces/2026/07/20/face_000123_1.jpg",
    "http://10.10.33.144/anpr_backend/uploads/faces/2026/07/20/face_000123_2.jpg"
  ],
  "xray": null
}
```

## Push susulan — `event_id` SAMA, x-ray sudah terisi

Dikirim lagi setelah hasil x-ray ada. Penerima wajib **upsert berdasarkan
`event_id`**: perbarui record yang ada, jangan membuat record kedua.

```json
{
  "event_id": "anprc-RJ001-20260720-000123",
  "event_type": "entry_inspection",
  "visit_id": 456,
  "channel_no": "RJ001",
  "license_plate": "B1234ABC",
  "detected_at": "2026-07-20 14:32:11",
  "decision": "pass",
  "vehicle_photo": "http://10.10.33.144/anpr_backend/uploads/vehicles/2026/07/20/veh_000123.jpg",
  "uvis_image": "http://10.10.33.144/anpr_backend/uploads/uvis/2026/07/20/uvis_000123.jpg",
  "face_images": [
    "http://10.10.33.144/anpr_backend/uploads/faces/2026/07/20/face_000123_1.jpg"
  ],
  "xray": {
    "sn": "SYS00100120260720000001",
    "is_anomaly": false,
    "result": true,
    "note": "auto: no anomaly",
    "reviewed_by": null,
    "scanned_image": "http://10.10.33.144/anpr_backend/uploads/xray/2026/07/20/xray_000123.jpg",
    "decided_at": "2026-07-20 14:40:02"
  }
}
```

### Kolom

| Kolom | Tipe | Wajib | Keterangan |
|---|---|---|---|
| `event_id` | string | ya | Unik per peristiwa — **kunci upsert**: push dengan `event_id` yang sudah dikenal MENGGANTI/memperbarui record tsb (dipakai untuk retry DAN push susulan x-ray). |
| `event_type` | string | ya | `entry_inspection` (tipe lain menyusul: `exit`, …). |
| `visit_id` | integer \| null | tidak | Id record kunjungan kami (satu per kunjungan; masuk-ulang memakai id yang sama). |
| `channel_no` | string | ya | Kode jalur/channel (mis. `RJ001`). |
| `license_plate` | string | ya | Plat hasil pengenalan kamera ANPR. |
| `detected_at` | string | ya | `YYYY-MM-DD HH:MM:SS`, GMT+7 (Asia/Jakarta). |
| `decision` | string | tidak | `pass` / `fail` / `suspect` / `vip_pass`. |
| `vehicle_photo` | string \| null | tidak | **Referensi gambar**, foto utuh kendaraan dari kamera ANPR. |
| `uvis_image` | string \| null | tidak | **Referensi gambar** (lihat catatan), scan kolong kendaraan. |
| `face_images` | string[] | tidak | **Referensi gambar**, tangkapan wajah pengemudi/penumpang (0–n). |
| `xray` | object \| null | tidak | `null` sampai kendaraan di-x-ray; terisi pada push susulan. |

### Objek `xray`

| Kolom | Tipe | Keterangan |
|---|---|---|
| `sn` | string | Id unik scan x-ray (SN vendor). |
| `is_anomaly` | boolean | Penilaian anomali otomatis dari mesin. |
| `result` | boolean \| null | Vonis akhir: `true` = lolos (palang terbuka), `false` = ditolak, `null` = masih menunggu review operator. |
| `note` | string \| null | Catatan review (`"auto: no anomaly"` untuk lolos otomatis). |
| `reviewed_by` | string \| null | Username operator; `null` jika otomatis. |
| `scanned_image` | string \| null | **Referensi gambar**, hasil scan x-ray. |
| `decided_at` | string \| null | Waktu vonis dibuat, GMT+7. |

### Referensi gambar — PENTING

Kolom gambar berupa **string referensi (URI/path), bukan base64**.

- **Fase 1 (sekarang):** URL HTTP yang dilayani backend kami
  (`http://10.10.33.144/anpr_backend/uploads/...`) — bisa diunduh langsung.
- **Fase 2 (rencana, MinIO):** perangkat akan mengunggah langsung ke MinIO dan
  kami mengirim **direktori/key objek MinIO**, mis.
  `minio://anpr-media/RJ001/2026-07-20/000123/uvis/scan.jpg`
  (bucket + object key; kredensial akses dibagikan terpisah).

**Perlakukan kolom ini sebagai string opaque** — jangan parse/validasi
skemanya, sehingga peralihan Fase 1 → Fase 2 tidak butuh perubahan di sisi
penerima.

## Respons yang diharapkan

HTTP **200** dengan body apa pun = diterima. Selain itu (atau timeout) =
gagal; kami akan retry dengan **`event_id` yang sama** — karena itu wajib
upsert. Push susulan x-ray juga memakai `event_id` yang sama, jadi upsert
mencakup keduanya.

```json
{ "code": 200, "message": "ok" }
```

## Contoh uji cURL

```bash
curl -X POST http://<host-mitra>/api/anpr-log \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: CHANGE_ME" \
  -d '{
    "event_id": "anprc-RJ001-20260720-000123",
    "event_type": "entry_inspection",
    "channel_no": "RJ001",
    "license_plate": "B1234ABC",
    "detected_at": "2026-07-20 14:32:11",
    "decision": "pass",
    "uvis_image": "http://10.10.33.144/anpr_backend/uploads/uvis/2026/07/20/uvis_000123.jpg",
    "face_images": ["http://10.10.33.144/anpr_backend/uploads/faces/2026/07/20/face_000123_1.jpg"]
  }'
```

## Poin terbuka (disepakati dengan mitra)

1. URL endpoint final + mekanisme auth (API key vs token).
2. Detail kebijakan retry (usulan kami: 3x retry, backoff eksponensial, lalu ditandai di CP).
3. Kredensial/penamaan bucket MinIO untuk Fase 2.
