<?php
namespace App\Services;

use App\Core\Database;
use App\Core\Logger;

/**
 * Global logging to the partner receiver (gateCarEntry). The backend ENQUEUES
 * a queue row per push; the worker drains it and POSTs. Two phases per entry:
 *   initial  — right after the entry decision (xray: null)
 *   followup — once the x-ray scan has a verdict (same event_id)
 * event_id = anprc-{channel}-{YYYYMMDD}-{inspectionId}, stable across both.
 * All methods are best-effort: failures are logged, never thrown to the flow.
 */
class GlobalLog {
    public static function enabled(): bool {
        return in_array(self::setting('global_log_enabled', '0'), ['1', 'true', 'True'], true);
    }

    /** Enqueue the INITIAL push for an entry inspection (idempotent). */
    public static function enqueueEntry(int $inspectionId): void {
        try {
            if (!self::enabled()) return;
            $insp = Database::fetchOne('SELECT * FROM anprc_inspections WHERE id = ?', [$inspectionId]);
            if (!$insp) return;
            $payload = self::basePayload($insp);
            self::insert($payload['event_id'], 'initial', $payload);
        } catch (\Throwable $e) {
            Logger::error('GlobalLog::enqueueEntry(' . $inspectionId . ') failed: ' . $e->getMessage());
        }
    }

    /** Enqueue the FOLLOW-UP push once an x-ray scan has a verdict. */
    public static function enqueueXray(array $xray): void {
        try {
            if (!self::enabled()) return;
            $inspId = $xray['inspection_id'] ?? null;
            if (!$inspId) return;   // standalone scan (no linked inspection) — nothing to attach to
            $insp = Database::fetchOne('SELECT * FROM anprc_inspections WHERE id = ?', [$inspId]);
            if (!$insp) return;
            $payload = self::basePayload($insp);
            $payload['xray'] = [
                'sn'            => $xray['sn'] ?? null,
                'is_anomaly'    => (int)($xray['is_anomaly'] ?? 0) === 1,
                'result'        => array_key_exists('receipt_result', $xray) && $xray['receipt_result'] !== null
                                    ? ((int)$xray['receipt_result'] === 1) : null,
                'note'          => $xray['review_note'] ?? null,
                'reviewed_by'   => $xray['reviewed_by'] ?? null,
                'scanned_image' => self::absUrl($xray['scanned_image_path'] ?? null),
                'decided_at'    => self::toJkt($xray['reviewed_at'] ?? $xray['receipt_sent_at'] ?? null),
            ];
            self::insert($payload['event_id'], 'followup', $payload);
        } catch (\Throwable $e) {
            Logger::error('GlobalLog::enqueueXray failed: ' . $e->getMessage());
        }
    }

    // ---- internals -------------------------------------------------------

    public static function eventId(array $insp): string {
        $ts = $insp['come_called_at'] ?? $insp['created_at'] ?? gmdate('Y-m-d H:i:s');
        $date = date('Ymd', strtotime((string)$ts));
        return sprintf('anprc-%s-%s-%06d', $insp['channel_no'] ?? 'NA', $date, (int)$insp['id']);
    }

    private static function basePayload(array $insp): array {
        $plate = $insp['license_plate'];
        $veh = Database::fetchOne(
            'SELECT full_image_path FROM anprc_vehicles WHERE license_plate = ? ORDER BY id DESC LIMIT 1', [$plate]);
        $uvis = Database::fetchOne(
            'SELECT image_path FROM anprc_inspection_uvis WHERE inspection_id = ? ORDER BY id DESC LIMIT 1', [$insp['id']]);
        $faces = Database::fetchAll(
            'SELECT image_url FROM anprc_inspection_face_images WHERE inspection_id = ? ORDER BY id ASC', [$insp['id']]);
        $visit = Database::fetchOne(
            'SELECT id FROM anprc_visits WHERE license_plate = ? ORDER BY id DESC LIMIT 1', [$plate]);

        return [
            'event_id'      => self::eventId($insp),
            'event_type'    => 'entry_inspection',
            'visit_id'      => $visit ? (int)$visit['id'] : null,
            'channel_no'    => $insp['channel_no'],
            'license_plate' => $plate,
            'detected_at'   => self::toJkt($insp['come_called_at'] ?? $insp['created_at'] ?? null),
            'decision'      => $insp['decision'],
            'vehicle_photo' => self::absUrl($veh['full_image_path'] ?? null),
            'uvis_image'    => self::absUrl($uvis['image_path'] ?? null),
            // Face images are stored as full vendor URLs already — passed through.
            'face_images'   => array_values(array_filter(array_map(
                                    static fn($f) => $f['image_url'] ?? null, $faces))),
            'xray'          => null,
        ];
    }

    private static function insert(string $eventId, string $phase, array $payload): void {
        Database::query(
            'INSERT INTO anprc_global_log_queue (event_id, phase, payload)
             VALUES (?, ?, ?::jsonb)
             ON CONFLICT (event_id, phase) DO NOTHING',
            [$eventId, $phase, json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]
        );
    }

    /** Absolute URL for a stored upload path (prepends public_base_url). */
    private static function absUrl(?string $relPath): ?string {
        if (!$relPath) return null;
        $pub = ImageStorage::publicUrl($relPath);          // /anpr_backend/uploads/...
        $base = rtrim(self::setting('public_base_url', ''), '/');
        return $base !== '' ? $base . $pub : $pub;
    }

    /** UTC db timestamp -> 'Y-m-d H:i:s' in Asia/Jakarta (GMT+7). */
    private static function toJkt(?string $utc): ?string {
        if (!$utc) return null;
        try {
            $dt = new \DateTime((string)$utc, new \DateTimeZone('UTC'));
            $dt->setTimezone(new \DateTimeZone('Asia/Jakarta'));
            return $dt->format('Y-m-d H:i:s');
        } catch (\Throwable $e) {
            return (string)$utc;
        }
    }

    private static function setting(string $key, string $def = ''): string {
        $r = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
        return $r['value'] ?? $def;
    }
}
