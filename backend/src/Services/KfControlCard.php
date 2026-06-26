<?php
namespace App\Services;

/**
 * Encodes serial-port command frames for the 科发 (KF / kefa) display+voice
 * control card built into the ANPR camera — the default card type. These frames
 * are carried inside an MQTT `serial_data` message (payload.body.serialData[].data
 * is the base64 of the frame bytes) and drive the LED plate display and the voice
 * announcement. The vendor CP sends them alongside the gate-open on every
 * recognition; our gate-open path previously omitted them.
 *
 * Ported 1:1 from the vendor CP (ScreenDisplay / CRC16Modbus / HexadecimalUtil).
 * Frame layout: 00 64 PN CMD DL <data> CRClo CRChi
 *   DA=0x00, VR=0x64, PN=0xFFFF (single packet), CRC = CRC16/Modbus little-endian.
 * Text is GBK (CP936) encoded; ASCII passes through unchanged.
 */
class KfControlCard {
    private const CMD_PLAY_VOICE = 0x30;   // KFScreenDisplayEnums.CMD.PLAY_VOICE
    private const CMD_TEMP_TEXT  = 0x62;   // KFScreenDisplayEnums.CMD.DOWNLOAD_TEMP_TEXT
    private const CMD_SET_RELAY  = 0x0F;   // KFScreenDisplayEnums.CMD.SET_RELAY_STATUS

    /** CRC16/Modbus (poly 0xA001, init 0xFFFF) over the raw frame bytes. */
    private static function crc16Modbus(string $bytes): int {
        $crc = 0xFFFF;
        $len = strlen($bytes);
        for ($i = 0; $i < $len; $i++) {
            $crc ^= ord($bytes[$i]) & 0xFF;
            for ($b = 0; $b < 8; $b++) {
                $crc = ($crc & 1) ? (($crc >> 1) ^ 0xA001) & 0xFFFF : ($crc >> 1) & 0xFFFF;
            }
        }
        return $crc & 0xFFFF;
    }

    /** Wrap a command's data block in the KF frame + trailing little-endian CRC. */
    private static function frame(int $cmd, string $data): string {
        $body = chr(0x00) . chr(0x64) . chr(0xFF) . chr(0xFF)
              . chr($cmd) . chr(strlen($data) & 0xFF) . $data;
        $crc = self::crc16Modbus($body);
        return $body . chr($crc & 0xFF) . chr(($crc >> 8) & 0xFF);
    }

    private static function gbk(string $text): string {
        $out = mb_convert_encoding($text, 'CP936', 'UTF-8');
        return $out === false ? $text : $out;
    }

    /** Voice frame: CMD 0x30, data = 0x02 (clear queue + play) + GBK(text). */
    public static function voiceFrame(string $text): string {
        return self::frame(self::CMD_PLAY_VOICE, chr(0x02) . self::gbk($text));
    }

    /**
     * LED temp-text frame: CMD 0x62. Field layout (from getTempText, KF branch):
     *   twid, etm=01(R->L), ets=02, gst=02, dt=00, 00 01, findex=03(songti16),
     *   drs=05, tc[4] (green on even line / red on odd), 00 00 00 00, textLen, 00, GBK(text)
     */
    public static function tempTextFrame(string $text, int $twid = 0): string {
        $t = self::gbk($text);
        $tc = ($twid % 2 === 0)
            ? chr(0x00) . chr(0xFF) . chr(0x00) . chr(0x00)   // green
            : chr(0xFF) . chr(0x00) . chr(0x00) . chr(0x00);  // red
        $data = chr($twid & 0xFF)
              . chr(0x01) . chr(0x02) . chr(0x02) . chr(0x00)
              . chr(0x00) . chr(0x01)
              . chr(0x03) . chr(0x05)
              . $tc
              . chr(0x00) . chr(0x00) . chr(0x00) . chr(0x00)
              . chr(strlen($t) & 0xFF) . chr(0x00)
              . $t;
        return self::frame(self::CMD_TEMP_TEXT, $data);
    }

    /**
     * Relay / traffic-light frame: CMD 0x0F, data = ch + 01 00 00 00 + ot
     * (from getSetRelayStatus). Switches relay channel `ch` on for `ot` seconds —
     * used to turn the lane signal light green on gate-open.
     */
    public static function relayFrame(int $ch, int $ot): string {
        $data = chr($ch & 0xFF) . chr(0x01) . chr(0x00) . chr(0x00) . chr(0x00) . chr($ot & 0xFF);
        return self::frame(self::CMD_SET_RELAY, $data);
    }

    /**
     * Build the `serial_data` payload body for one or more frames. Each frame
     * becomes a serialData entry on serial channel 0 (matches VzicloudBean).
     *
     * @param string[] $frames  raw frame byte-strings
     */
    public static function serialDataBody(array $frames): array {
        return ['serialData' => array_map(fn($f) => [
            'serialChannel' => 0,
            'data' => base64_encode($f),
            'dataLen' => strlen($f),
        ], array_values($frames))];
    }
}
