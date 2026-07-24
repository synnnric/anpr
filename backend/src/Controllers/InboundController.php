<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Core\Logger;
use App\Services\ImageStorage;
use App\Services\InspectionService;
use App\Services\DecisionEngine;
use App\Services\DecisionExecutor;

class InboundController {

    private static function saveRaw(string $endpoint, Request $req, ?array $body): void {
        Database::insert('anprc_inbound_events_raw', [
            'endpoint' => $endpoint,
            'cmd_no' => $body['cmdNo'] ?? null,
            'channel_no' => $body['channelNo'] ?? ($body['channel'] ?? null),
            'source_ip' => $req->ip(),
            'raw_body' => $req->rawBody(),
        ]);
    }

    private static function reply(): void {
        Response::json(['code' => 200, 'message' => 'success', 'data' => new \stdClass()]);
    }

    // 3.1 POST /overseas/s300/work-status (cmdNo 322)
    public function workStatus(Request $req): void {
        $body = $req->json();
        self::saveRaw('work-status', $req, $body);

        $channelNo = $body['channelNo'] ?? null;
        $opState = $body['data']['operatingState'] ?? null;
        if ($channelNo === null || $opState === null) {
            Logger::warn('work-status missing fields: ' . $req->rawBody());
            self::reply();
            return;
        }

        $inspection = InspectionService::findActiveInspection($channelNo);
        $inspectionId = $inspection['id'] ?? null;

        Database::insert('anprc_inspection_status_logs', [
            'inspection_id' => $inspectionId,
            'channel_no' => $channelNo,
            'operating_state' => $opState,
            'cmd_no' => $body['cmdNo'] ?? 322,
            'raw_payload' => json_encode($body),
        ]);

        if ($inspection) {
            // Always mirror the latest S300 operating state.
            $update = ['current_operating_state' => $opState];

            // Only transition the platform-side `state` for terminal S300 conditions.
            // Normal lifecycle states (started/inspecting/resetting/completed) are
            // driven by HTTP calls (/come, /leave) and the reset-complete callback.
            switch ((int)$opState) {
                case 1: // Inspecting
                    if (!$inspection['inspection_started_at']) {
                        $update['inspection_started_at'] = gmdate('Y-m-d H:i:s');
                    }
                    if ($inspection['state'] === 'started') {
                        $update['state'] = 'inspecting';
                    }
                    break;
                case 2: // Resetting (S300 reports it has started resetting)
                    if (!$inspection['inspection_ended_at']) {
                        $update['inspection_ended_at'] = gmdate('Y-m-d H:i:s');
                    }
                    break;
                case 4: // Emergency stop
                    $update['state'] = 'emergency_stop';
                    break;
                case 5: // Equipment failure
                    $update['state'] = 'failed';
                    break;
                // op=0 (Ready), op=3 (Reset complete) and op=6 (Self-test)
                // do NOT change state here — that's the job of /come, /leave
                // and the reset-complete callback.
            }
            Database::update('anprc_inspections', $update, 'id = :id', ['id' => $inspectionId]);
        }

        InspectionService::pushEvent('work-status', [
            'channelNo' => $channelNo,
            'operatingState' => $opState,
            'inspectionId' => $inspectionId,
        ]);

        // If S300 reports equipment failure, decide immediately
        if ((int)$opState === 5 && $inspection) {
            $fresh = Database::fetchOne('SELECT * FROM anprc_inspections WHERE id = ?', [$inspection['id']]);
            $verdict = DecisionEngine::evaluate($fresh);
            if ($verdict) {
                $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
                if ($channel) DecisionExecutor::apply($fresh, $verdict, $channel);
            }
        }
        self::reply();
    }

    // 3.2 POST /overseas/s300/face-image (cmdNo 323)
    public function faceImage(Request $req): void {
        $body = $req->json();
        self::saveRaw('face-image', $req, $body);

        $channelNo = $body['channelNo'] ?? null;
        $imgs = $body['data']['img'] ?? [];
        if ($channelNo === null || !is_array($imgs)) {
            self::reply();
            return;
        }

        // Face images stream in for ~90s after the verdict — link even after the
        // inspection has completed (grace window), or they'd show up unattached.
        $inspection = InspectionService::findInspectionForArtifact($channelNo);
        $inspectionId = $inspection['id'] ?? null;

        // /leave timing keyed to the face-image stream — FULL mode only. The
        // vendor streams face images during the scan (before /leave) and the
        // recorded video only AFTER /leave — and once /leave fires the face stream
        // stops. We can't tell driver from passenger (the payload has no
        // seat/camera label), so to avoid cutting off before the driver we RESET
        // the /leave countdown on EVERY face image: /leave then fires
        // face_leave_delay_s after the LAST face, capturing the whole burst
        // (driver included, wherever it lands). Capped from the verdict so an
        // endless/faulty face stream can't defer /leave forever (the manual Leave
        // button always overrides). SKIP/TIMED modes ignore face images entirely.
        $chMode = (string)(Database::fetchOne(
            "SELECT s300_inspection_mode FROM anprc_channels WHERE channel_no = ?",
            [$channelNo]
        )['s300_inspection_mode'] ?? 'full');
        if ($chMode === 'full'
            && $inspection && $inspectionId
            && empty($inspection['leave_called_at'])
            && !empty($inspection['blocker_open_due_at'])) {
            $faceDelay = (int)(Database::fetchOne(
                "SELECT value FROM anprc_settings WHERE key_name = 'face_leave_delay_s'"
            )['value'] ?? 20);
            $ref = $inspection['decision_at'] ?: ($inspection['come_called_at'] ?? null);
            $capTs = ($ref ? strtotime($ref . ' UTC') : time()) + 180;   // hard ceiling
            $newTs = min(time() + max(0, $faceDelay), $capTs);
            Database::query(
                "UPDATE anprc_inspections SET blocker_open_due_at = ?
                 WHERE id = ? AND leave_called_at IS NULL",
                [gmdate('Y-m-d H:i:s', $newTs), $inspectionId]
            );
        }

        $saved = [];
        foreach ($imgs as $url) {
            $id = Database::insert('anprc_inspection_face_images', [
                'inspection_id' => $inspectionId,
                'channel_no' => $channelNo,
                'image_url' => $url,
            ]);
            $saved[] = ['id' => $id, 'url' => $url];
        }

        InspectionService::pushEvent('face-image', [
            'channelNo' => $channelNo,
            'inspectionId' => $inspectionId,
            'images' => $saved,
        ]);
        self::reply();
    }

    // 3.7 POST /overseas/s300/video-record — post-inspection recording files.
    public function videoRecord(Request $req): void {
        $this->ingestStreams('video-record', 'record', $req);
    }

    // 3.3 POST /overseas/s300/video-real-time (cmdNo 325) — live robotic-arm
    // stream addresses, pushed after /come. Shown live in the inspection detail.
    public function videoRealTime(Request $req): void {
        $this->ingestStreams('video-real-time', 'realtime', $req);
    }

    // Shared: both 3.3 (realtime) and 3.7 (record) carry {channelNo, data:[{code,url}]}.
    private function ingestStreams(string $endpoint, string $kind, Request $req): void {
        $body = $req->json();
        self::saveRaw($endpoint, $req, $body);

        $channelNo = $body['channelNo'] ?? null;
        $streams = $body['data'] ?? [];
        if ($channelNo === null || !is_array($streams)) {
            self::reply();
            return;
        }

        // Recorded video arrives ~100s after the verdict (post-/leave) — well
        // after completion — so link within the grace window too.
        $inspection = InspectionService::findInspectionForArtifact($channelNo);
        $inspectionId = $inspection['id'] ?? null;

        $saved = [];
        foreach ($streams as $s) {
            if (empty($s['code']) || empty($s['url'])) continue;
            $id = Database::insert('anprc_inspection_video_streams', [
                'inspection_id' => $inspectionId,
                'channel_no' => $channelNo,
                'camera_code' => $s['code'],
                'stream_url' => $s['url'],
                'stream_kind' => $kind,
            ]);
            $saved[] = ['id' => $id, 'code' => $s['code'], 'url' => $s['url']];
        }

        InspectionService::pushEvent($endpoint, [
            'channelNo' => $channelNo,
            'inspectionId' => $inspectionId,
            'kind' => $kind,
            'streams' => $saved,
        ]);
        self::reply();
    }

    // 3.6 POST /overseas/s300/x-ray — X-ray scan images + anomaly result. Linked
    // to the active inspection by license plate (the push carries no channelNo).
    public function xray(Request $req): void {
        $body = $req->json();
        self::saveRaw('x-ray', $req, $body);

        // Vendor retry guard: SN is the scan's unique id — a re-push of an
        // already-recorded SN (e.g. our slow auto-receipt made the vendor time
        // out and retry) must not create a duplicate record + second receipt.
        $snId = trim((string)($body['SN'] ?? ''));
        if ($snId !== '') {
            $dup = Database::fetchOne('SELECT id FROM anprc_inspection_xray WHERE sn = ?', [$snId]);
            if ($dup) { self::reply(); return; }
        }

        $plate = $body['VehicleNumber'] ?? null;
        $inspection = null;
        if ($plate) {
            // Only link to a RECENT inspection (xray_clearance_window_s, default
            // 60 min) — an older match means the car came voluntarily and the
            // scan stays standalone.
            $winRow = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = 'xray_clearance_window_s'");
            $win = max(60, (int)($winRow['value'] ?? 3600));
            $inspection = Database::fetchOne(
                "SELECT * FROM anprc_inspections WHERE license_plate = ?
                   AND created_at >= NOW() - make_interval(secs => ?)
                 ORDER BY id DESC LIMIT 1", [$plate, $win]
            );
        }

        // ScanedImage is the vendor's actual key (typo preserved in their spec);
        // accept ScannedImage too.
        $scanImg = $body['ScanedImage'] ?? ($body['ScannedImage'] ?? null);
        $scanPath = !empty($scanImg) ? ImageStorage::saveBase64('xray', $scanImg, 'jpg') : null;
        $platePath = !empty($body['PlateImage']) ? ImageStorage::saveBase64('xray', $body['PlateImage'], 'jpg') : null;

        $xrayId = Database::insert('anprc_inspection_xray', [
            'inspection_id' => $inspection['id'] ?? null,
            'channel_no' => $inspection['channel_no'] ?? null,
            'sn' => $body['SN'] ?? null,
            'vehicle_number' => $plate,
            'scan_started_at' => $body['DateScanStarted'] ?? null,
            'scan_ended_at' => $body['DateScanEnded'] ?? null,
            'is_anomaly' => !empty($body['IsAnomaly']) ? 1 : 0,
            'anomaly_comments' => $body['AnomalyComments'] ?? null,
            'scanner_operator' => $body['ScannerOperator'] ?? null,
            'scanned_image_path' => $scanPath,
            'plate_image_path' => $platePath,
            'alarm_info' => isset($body['AlarmInfo']) ? json_encode($body['AlarmInfo'], JSON_UNESCAPED_UNICODE) : null,
        ]);

        InspectionService::pushEvent('x-ray', [
            'inspectionId' => $inspection['id'] ?? null,
            'xrayId' => $xrayId,
            'vehicleNumber' => $plate,
            'isAnomaly' => !empty($body['IsAnomaly']),
            'scanUrl' => ImageStorage::publicUrl($scanPath),
        ]);

        // Receipt flow (§2.2.4): a clean scan is auto-receipted with Result:true
        // (exit barrier opens) when xray_auto_receipt is on; an anomaly stays
        // 'pending' — no receipt is sent, the barrier stays closed until an
        // operator passes/denies it on the X-Ray tab.
        $isAnomaly = !empty($body['IsAnomaly']);
        if (!$isAnomaly && \App\Services\XrayService::config()['auto_receipt']) {
            Database::update('anprc_inspection_xray',
                ['review_status' => 'auto'], 'id = :id', ['id' => $xrayId]);
            $row = Database::fetchOne('SELECT * FROM anprc_inspection_xray WHERE id = ?', [$xrayId]);
            \App\Services\XrayService::sendReceipt($row, true, 'auto: no anomaly', null);
        }
        self::reply();
    }

    // 3.4 POST /overseas/s300/reset-complete (cmdNo 326)
    public function resetComplete(Request $req): void {
        $body = $req->json();
        self::saveRaw('reset-complete', $req, $body);

        $channelNo = $body['channelNo'] ?? null;
        if ($channelNo === null) {
            self::reply();
            return;
        }

        // Find the inspection that's been /leave'd but not yet reset-completed.
        // Using "most recent" would mis-target a fresh /come that happened to
        // sneak in between this callback and the previous vehicle's lifecycle.
        $inspection = Database::fetchOne(
            "SELECT * FROM anprc_inspections
             WHERE channel_no = ?
               AND leave_called_at IS NOT NULL
               AND reset_completed_at IS NULL
             ORDER BY id DESC LIMIT 1",
            [$channelNo]
        );
        if ($inspection) {
            Database::update('anprc_inspections', [
                'state' => 'completed',
                'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            ], 'id = :id', ['id' => $inspection['id']]);
        }

        InspectionService::pushEvent('reset-complete', [
            'channelNo' => $channelNo,
            'inspectionId' => $inspection['id'] ?? null,
        ]);
        self::reply();
    }

    // 3.5 POST /overseas/s300/uvis
    public function uvis(Request $req): void {
        $body = $req->json();
        self::saveRaw('uvis', $req, $body);

        $channelNo = trim((string)($body['channelNo'] ?? $body['channel'] ?? ''));
        $params = $body['params'] ?? [];
        if (empty($params)) {
            self::reply();
            return;
        }

        // The real vendor (wuhandock) UVIS push carries an EMPTY channel and no
        // plate — only its own inspectionId. Resolve our inspection: by channel
        // when given, else fall back to the most recent still-active inspection
        // (one vehicle is inspected at a time, so this is the one being scanned).
        $inspection = $channelNo !== ''
            ? InspectionService::findActiveInspection($channelNo)
            : null;
        if (!$inspection) {
            $inspection = Database::fetchOne(
                "SELECT * FROM anprc_inspections
                 WHERE state IN ('pending','started','inspecting')
                 ORDER BY id DESC LIMIT 1"
            );
        }
        $inspectionId = $inspection['id'] ?? null;
        // Store + decide against the RESOLVED lane, not the empty channel string.
        $channelNo = $inspection['channel_no'] ?? ($channelNo !== '' ? $channelNo : null);

        $imagePath = null;
        if (!empty($params['imageData'])) {
            $imagePath = ImageStorage::saveBase64('uvis', $params['imageData'], 'jpg');
        }

        $uvisId = Database::insert('anprc_inspection_uvis', [
            'inspection_id' => $inspectionId,
            'channel_no' => $channelNo,
            's300_inspection_id' => $params['inspectionId'] ?? null,
            'image_type' => $params['imageType'] ?? 0,
            'image_path' => $imagePath,
            'object_count' => $params['objectCount'] ?? 0,
        ]);

        $coords = $params['coords'] ?? [];
        if (is_array($coords)) {
            foreach ($coords as $c) {
                Database::insert('anprc_inspection_uvis_coords', [
                    'uvis_id' => $uvisId,
                    'confidence' => $c['conf'] ?? null,
                    'x1' => $c['x1'] ?? 0,
                    'y1' => $c['y1'] ?? 0,
                    'x2' => $c['x2'] ?? 0,
                    'y2' => $c['y2'] ?? 0,
                ]);
            }
        }

        InspectionService::pushEvent('uvis', [
            'channelNo' => $channelNo,
            'inspectionId' => $inspectionId,
            'uvisId' => $uvisId,
            'imageUrl' => ImageStorage::publicUrl($imagePath),
            'imageType' => $params['imageType'] ?? 0,
            'objectCount' => $params['objectCount'] ?? 0,
            'coords' => $coords,
        ]);

        // === Auto-decision trigger ===
        if ($inspection) {
            $fresh = Database::fetchOne('SELECT * FROM anprc_inspections WHERE id = ?', [$inspection['id']]);
            $verdict = DecisionEngine::evaluate($fresh);
            if ($verdict) {
                $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
                if ($channel) DecisionExecutor::apply($fresh, $verdict, $channel);
            }
        }
        self::reply();
    }

}
