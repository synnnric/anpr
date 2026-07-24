<?php
namespace App\Services;

class ImageStorage {
    public static function saveBase64(string $subdir, string $base64Data, string $ext = 'jpg'): ?string {
        $cfg = $GLOBALS['APP_CONFIG']['upload'];
        $dir = $cfg['base_path'] . '/' . $subdir;
        if (!is_dir($dir)) @mkdir($dir, 0777, true);

        $clean = preg_replace('#^data:image/[^;]+;base64,#', '', $base64Data);
        $bin = base64_decode($clean, true);
        if ($bin === false) return null;

        $filename = date('Ymd') . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
        $fullPath = $dir . '/' . $filename;
        if (file_put_contents($fullPath, $bin) === false) return null;

        return $subdir . '/' . $filename;
    }

    public static function publicUrl(?string $relativePath): ?string {
        if (!$relativePath) return null;
        $base = $GLOBALS['APP_CONFIG']['upload']['public_url'];
        return $base . '/' . $relativePath;
    }
}
