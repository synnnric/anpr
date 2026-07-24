<?php
spl_autoload_register(function (string $class) {
    if (strncmp($class, 'App\\', 4) !== 0) return;
    $relative = substr($class, 4);
    $file = __DIR__ . '/../' . str_replace('\\', '/', $relative) . '.php';
    if (file_exists($file)) require_once $file;
});
