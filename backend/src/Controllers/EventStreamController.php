<?php
namespace App\Controllers;

use App\Core\Request;

class EventStreamController {
    // GET /api/events/stream  Server-Sent Events
    public function stream(Request $req): void {
        @set_time_limit(0);
        ignore_user_abort(false);
        while (ob_get_level() > 0) @ob_end_clean();

        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache, no-store');
        header('X-Accel-Buffering: no');
        header('Connection: keep-alive');

        $file = $GLOBALS['APP_CONFIG']['logs']['path'] . '/events.stream';
        if (!file_exists($file)) @file_put_contents($file, '');

        $fp = @fopen($file, 'r');
        if (!$fp) {
            echo "event: error\ndata: cannot open stream\n\n";
            @flush();
            return;
        }
        fseek($fp, 0, SEEK_END);

        echo ": connected at " . date('c') . "\n\n";
        @flush();

        $lastPing = time();
        $start = time();
        $maxLifetime = 300; // 5 min then client reconnects

        while (!connection_aborted() && (time() - $start) < $maxLifetime) {
            $line = fgets($fp);
            if ($line === false) {
                if (time() - $lastPing >= 15) {
                    echo ": ping " . time() . "\n\n";
                    @flush();
                    $lastPing = time();
                }
                usleep(500000);
                clearstatcache(false, $file);
                continue;
            }
            $line = trim($line);
            if ($line === '') continue;
            $event = json_decode($line, true);
            if (!is_array($event)) continue;
            $type = $event['type'] ?? 'message';
            echo "event: " . $type . "\n";
            echo "data: " . json_encode($event['payload'] ?? []) . "\n\n";
            @flush();
        }
        fclose($fp);
    }
}
