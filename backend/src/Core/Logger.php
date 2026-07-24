<?php
namespace App\Core;

class Logger {
    public static function log(string $level, string $message): void {
        $dir = $GLOBALS['APP_CONFIG']['logs']['path'];
        if (!is_dir($dir)) @mkdir($dir, 0777, true);
        $line = sprintf("[%s] [%s] %s\n", date('Y-m-d H:i:s'), strtoupper($level), $message);
        @file_put_contents($dir . '/app-' . date('Y-m-d') . '.log', $line, FILE_APPEND);
    }
    public static function info(string $m): void  { self::log('info', $m); }
    public static function warn(string $m): void  { self::log('warn', $m); }
    public static function error(string $m): void { self::log('error', $m); }
}
