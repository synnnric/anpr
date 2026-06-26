<?php
namespace App\Services;

/**
 * Encodes serial-port command frames for the 方控 (FK / fangkong) display+voice
 * control card. This is the card actually fitted to our cameras (the vendor's
 * own DB types every LED display camera as 方控 = display_motherboard_type 2),
 * confirmed on hardware: an FK LED/voice frame renders while the KF equivalent
 * is silently ignored. Frames ride inside an MQTT `serial_data` message exactly
 * like the KF ones; only the byte layout differs. See [[KfControlCard]] for KF.
 *
 * Ported 1:1 from the vendor CP (SquareDisplay / CRC16Modbus / HexadecimalUtil).
 * Text is GBK (CP936) encoded; ASCII passes through unchanged.
 *
 * Frame layout (text/relay): AA 55 00 64 00 CMD DLhi DLlo <data> CRChi CRClo AF
 *   header=AA55, SLNO=00, DA=64, reserved=00, DL = data length (big-endian 16),
 *   CRC = CRC16/Modbus over "00 64 00 CMD DL <data> 00 00", big-endian, AF terminator.
 * Voice is special: FD DLhi DLlo <data> — NO header, NO CRC, NO terminator.
 */
class FangkControlCard {
    private const CMD_PLAY_VOICE = 0xFD;   // FKScreenDisplayEnums.CMD.PLAY_VOICE
    private const CMD_TEMP_TEXT  = 0x27;   // FKScreenDisplayEnums.CMD.DOWNLOAD_TEMP_TEXT
    private const CMD_SET_RELAY  = 0x12;   // FKScreenDisplayEnums.CMD.SET_RELAY_STATUS
    private const CMD_SET_RELAY2 = 0x13;   // FKScreenDisplayEnums.CMD.SET_RELAY_STATUS_TWO (with on-time)

    /** CRC16/Modbus (poly 0xA001, init 0xFFFF) over the raw bytes. */
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

    /**
     * Standard FK frame: AA55 00 64 00 CMD DL <data> CRC AF.
     * DL is a big-endian 16-bit data length; CRC16/Modbus runs over
     * "00 64 00 CMD DL <data> 00 00" (the vendor appends two zero bytes), big-endian.
     */
    private static function frame(int $cmd, string $data): string {
        $len  = strlen($data);
        $body = chr(0x00) . chr(0x64) . chr(0x00) . chr($cmd)
              . chr(($len >> 8) & 0xFF) . chr($len & 0xFF) . $data;
        $crc  = self::crc16Modbus($body . chr(0x00) . chr(0x00));
        return chr(0xAA) . chr(0x55) . $body
             . chr(($crc >> 8) & 0xFF) . chr($crc & 0xFF) . chr(0xAF);
    }

    private static function gbk(string $text): string {
        $out = mb_convert_encoding($text, 'CP936', 'UTF-8');
        return $out === false ? $text : $out;
    }

    /**
     * Voice frame: CMD 0xFD, data = 01 01 + GBK(text). Unlike every other FK
     * command this is sent bare — just CMD + big-endian length + data, with no
     * AA55 header, no CRC and no AF terminator (vendor SquareDisplay PLAY_VOICE).
     */
    public static function voiceFrame(string $text): string {
        $data = chr(0x01) . chr(0x01) . self::gbk($text);
        $len  = strlen($data);
        return chr(self::CMD_PLAY_VOICE) . chr(($len >> 8) & 0xFF) . chr($len & 0xFF) . $data;
    }

    /**
     * LED temp-text frame: CMD 0x27. Data = lineNo + time + colorText + retain + GBK(text)
     * (from getDownloadTempText, FK branch). Per the vendor: lineNo = index+1,
     * time = 10s, colorText alternates 1 (even line) / 2 (odd line), retain = 0.
     */
    public static function tempTextFrame(string $text, int $index = 0): string {
        $lineNo = ($index + 1) & 0xFF;
        $color  = ($index % 2 === 0) ? 0x01 : 0x02;
        $data = chr($lineNo) . chr(0x0A) . chr($color) . chr(0x00) . self::gbk($text);
        return self::frame(self::CMD_TEMP_TEXT, $data);
    }

    /**
     * Relay / traffic-light frame. With an on-time the vendor uses
     * SET_RELAY_STATUS_TWO (0x13) and the single data byte is the on-time in
     * seconds (getRelayStatus: `ot` overrides `ch`); without it, SET_RELAY_STATUS
     * (0x12) and the data byte is the channel. Used to flash the lane light green.
     */
    public static function relayFrame(int $ch, int $ot = 0): string {
        if ($ot > 0) {
            return self::frame(self::CMD_SET_RELAY2, chr($ot & 0xFF));
        }
        return self::frame(self::CMD_SET_RELAY, chr($ch & 0xFF));
    }

    /**
     * Build the `serial_data` payload body for one or more frames (serial channel 0).
     * Identical wire shape to KfControlCard::serialDataBody — the card only changes
     * the frame bytes, not the envelope.
     *
     * @param string[] $frames raw frame byte-strings
     */
    public static function serialDataBody(array $frames): array {
        return ['serialData' => array_map(fn($f) => [
            'serialChannel' => 0,
            'data' => base64_encode($f),
            'dataLen' => strlen($f),
        ], array_values($frames))];
    }
}
