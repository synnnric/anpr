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

        $inspection = InspectionService::findActiveInspection($channelNo);
        $inspectionId = $inspection['id'] ?? null;

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

    // 3.3 POST /overseas/s300/video-record (cmdNo 325)
    public function videoRecord(Request $req): void {
        $body = $req->json();
        self::saveRaw('video-record', $req, $body);

        $channelNo = $body['channelNo'] ?? null;
        $streams = $body['data'] ?? [];
        if ($channelNo === null || !is_array($streams)) {
            self::reply();
            return;
        }

        $inspection = InspectionService::findActiveInspection($channelNo);
        $inspectionId = $inspection['id'] ?? null;

        $saved = [];
        foreach ($streams as $s) {
            if (empty($s['code']) || empty($s['url'])) continue;
            $id = Database::insert('anprc_inspection_video_streams', [
                'inspection_id' => $inspectionId,
                'channel_no' => $channelNo,
                'camera_code' => $s['code'],
                'stream_url' => $s['url'],
            ]);
            $saved[] = ['id' => $id, 'code' => $s['code'], 'url' => $s['url']];
        }

        InspectionService::pushEvent('video-record', [
            'channelNo' => $channelNo,
            'inspectionId' => $inspectionId,
            'streams' => $saved,
        ]);
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

        $channelNo = $body['channel'] ?? null;
        $params = $body['params'] ?? [];
        if ($channelNo === null || empty($params)) {
            self::reply();
            return;
        }

        $inspection = InspectionService::findActiveInspection($channelNo);
        $inspectionId = $inspection['id'] ?? null;

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
