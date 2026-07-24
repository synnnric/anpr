# Global Logging API — Integration Contract (Draft)

The ANPR inspection platform will **push a log record** to the partner system
for every vehicle event. The partner side builds the receiving endpoint; this
document defines what we send.

## Request

| Property | Value |
|---|---|
| Method | `POST` |
| Path (partner-defined) | e.g. `POST http://<partner-host>/api/anpr-log` |
| Content-Type | `application/json; charset=utf-8` |
| Auth (suggested) | `X-Api-Key: <shared key>` header |

## Body example — initial push (x-ray not filled yet)

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

## Follow-up push — SAME `event_id`, x-ray now filled

Sent again once the x-ray result exists. The receiver must **upsert by
`event_id`**: update the existing record, do not create a second one.

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

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | yes | Unique per event — **upsert key**: a push with an already-known `event_id` REPLACES/updates that record (used for retries AND for the x-ray follow-up). |
| `event_type` | string | yes | `entry_inspection` (more types may follow: `exit`, …). |
| `visit_id` | integer \| null | no | Our visit record id (one per stay; re-entries reuse it). |
| `channel_no` | string | yes | Lane / channel code (e.g. `RJ001`). |
| `license_plate` | string | yes | Plate as recognized by the ANPR camera. |
| `detected_at` | string | yes | `YYYY-MM-DD HH:MM:SS`, GMT+7 (Asia/Jakarta). |
| `decision` | string | no | `pass` / `fail` / `suspect` / `vip_pass`. |
| `vehicle_photo` | string \| null | no | **Image reference**, full vehicle snapshot from the ANPR camera. |
| `uvis_image` | string \| null | no | **Image reference** (see note below), undercarriage scan. |
| `face_images` | string[] | no | **Image references**, driver/passenger face captures (0–n). |
| `xray` | object \| null | no | `null` until the vehicle is x-rayed; filled on the follow-up push. |

### `xray` object

| Field | Type | Description |
|---|---|---|
| `sn` | string | X-ray scan unique id (vendor SN). |
| `is_anomaly` | boolean | Machine's automatic anomaly judgment. |
| `result` | boolean \| null | Final verdict: `true` = passed (barrier opened), `false` = denied, `null` = still awaiting operator review. |
| `note` | string \| null | Review note (`"auto: no anomaly"` for automatic passes). |
| `reviewed_by` | string \| null | Operator username; `null` when automatic. |
| `scanned_image` | string \| null | **Image reference**, the x-ray scan. |
| `decided_at` | string \| null | When the verdict was made, GMT+7. |

### Image references — IMPORTANT

Image fields are **reference strings (URI/path), never base64**.

- **Phase 1 (now):** HTTP URLs served by our backend
  (`http://10.10.33.144/anpr_backend/uploads/...`) — fetchable directly.
- **Phase 2 (planned, MinIO):** devices will upload straight to MinIO and we
  will send the **MinIO object directory/key** instead, e.g.
  `minio://anpr-media/RJ001/2026-07-20/000123/uvis/scan.jpg`
  (bucket + object key; access credentials shared separately).

**Treat these fields as opaque strings** — do not parse or validate their
scheme, so the Phase 1 → Phase 2 switch needs no change on the receiving side.

## Expected response

HTTP **200** with any body = accepted. Anything else (or a timeout) = failure;
we will retry with the **same `event_id`** — hence the upsert requirement.
The x-ray follow-up push also reuses the `event_id`, so upsert covers both.

```json
{ "code": 200, "message": "ok" }
```

## cURL test example

```bash
curl -X POST http://<partner-host>/api/anpr-log \
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

## Open points (to agree with the partner)

1. Final endpoint URL + auth mechanism (API key vs token).
2. Retry policy details (we propose: 3 retries, exponential backoff, then flagged in our CP).
3. MinIO credentials/bucket naming for Phase 2.
