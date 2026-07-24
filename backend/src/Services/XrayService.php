<?php
namespace App\Services;

use App\Core\Database;

/**
 * X-ray receipt sender — protocol §2.2.4 "X-check receipt".
 * POST {vendor}/x-ray/{channelNo} with {SN, VehicleNumber, Result, Note}.
 * Result:true opens the exit barrier; false keeps it closed. The x-ray station
 * is its own vendor channel (setting xray_channel_no, default XRAY01) — the
 * inbound scan push carries no channel, so the receipt always targets it.
 */
class XrayService {
    public static function config(): array {
        $rows = Database::fetchAll(
            "SELECT key_name, value FROM anprc_settings
             WHERE key_name IN ('xray_channel_no','xray_base_url','xray_auto_receipt','default_s300_base_url')"
        );
        $map = [];
        foreach ($rows as $r) $map[$r['key_name']] = $r['value'];
        return [
            'channel_no'   => $map['xray_channel_no'] ?? 'XRAY01',
            'base_url'     => ($map['xray_base_url'] ?? '') !== '' ? $map['xray_base_url'] : ($map['default_s300_base_url'] ?? ''),
            'auto_receipt' => ($map['xray_auto_receipt'] ?? '1') === '1',
        ];
    }

    /** Send the receipt for one anprc_inspection_xray row and record the outcome. */
    public static function sendReceipt(array $xray, bool $result, string $note, ?string $actor): array {
        $cfg = self::config();
        if ($cfg['base_url'] === '') {
            $resp = ['ok' => false, 'status' => 0, 'error' => 'xray_base_url / default_s300_base_url not configured', 'body' => null, 'elapsed_ms' => 0];
        } else {
            $client = new S300Client($cfg['base_url']);
            $resp = $client->post('/x-ray/' . rawurlencode($cfg['channel_no']), [
                'SN'            => $xray['sn'] ?? '',
                'VehicleNumber' => $xray['vehicle_number'] ?? '',
                'Result'        => $result,
                'Note'          => $note,
            ]);
        }

        Database::update('anprc_inspection_xray', [
            'receipt_result'  => $result ? 1 : 0,
            'receipt_status'  => $resp['ok'] ? 'sent' : 'failed',
            'receipt_error'   => $resp['ok'] ? null : mb_substr((string)($resp['error'] ?? 'send failed'), 0, 500),
            'receipt_sent_at' => $resp['ok'] ? date('Y-m-d H:i:s') : null,
        ], 'id = :id', ['id' => $xray['id']]);

        InspectionService::logOperation([
            'actor_username'   => $actor,
            'channel_no'       => $cfg['channel_no'],
            'inspection_id'    => $xray['inspection_id'] ?? null,
            'action'           => 'xray_receipt',
            'request_payload'  => ['SN' => $xray['sn'] ?? '', 'VehicleNumber' => $xray['vehicle_number'] ?? '', 'Result' => $result, 'Note' => $note],
            'response_payload' => is_array($resp['body']) ? $resp['body'] : ['raw' => $resp['body'], 'error' => $resp['error']],
            'status'           => $resp['ok'] ? 'success' : 'failed',
            'error_message'    => $resp['ok'] ? null : $resp['error'],
        ]);

        InspectionService::pushEvent('x-ray-receipt', [
            'xrayId'        => (int)$xray['id'],
            'inspectionId'  => $xray['inspection_id'] ?? null,
            'vehicleNumber' => $xray['vehicle_number'] ?? null,
            'result'        => $result,
            'sent'          => $resp['ok'],
            'error'         => $resp['ok'] ? null : $resp['error'],
        ]);

        return $resp;
    }
}
