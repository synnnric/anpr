<?php
namespace App\Core;

use PDO;
use PDOException;

class Database {
    private static ?PDO $instance = null;

    public static function getInstance(): PDO {
        if (self::$instance === null) {
            $cfg = $GLOBALS['APP_CONFIG']['database'];
            $dsn = "pgsql:host={$cfg['host']};port={$cfg['port']};dbname={$cfg['name']}";
            try {
                self::$instance = new PDO($dsn, $cfg['user'], $cfg['password'], [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]);
                self::$instance->exec("SET client_encoding TO 'UTF8'");
            } catch (PDOException $e) {
                http_response_code(500);
                echo json_encode(['code' => 500, 'message' => 'Database connection failed: ' . $e->getMessage()]);
                exit;
            }
        }
        return self::$instance;
    }

    public static function query(string $sql, array $params = []): \PDOStatement {
        $stmt = self::getInstance()->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    public static function fetchOne(string $sql, array $params = []): ?array {
        $row = self::query($sql, $params)->fetch();
        return $row ?: null;
    }

    public static function fetchAll(string $sql, array $params = []): array {
        return self::query($sql, $params)->fetchAll();
    }

    public static function insert(string $table, array $data): int {
        $cols = array_keys($data);
        $placeholders = array_map(fn($c) => ":$c", $cols);
        $sql = 'INSERT INTO "' . $table . '" ("' . implode('","', $cols) . '") VALUES (' . implode(',', $placeholders) . ') RETURNING id';
        $stmt = self::query($sql, $data);
        $row = $stmt->fetch();
        return (int) ($row['id'] ?? 0);
    }

    public static function update(string $table, array $data, string $where, array $whereParams = []): int {
        $sets = [];
        foreach ($data as $col => $_) {
            $sets[] = '"' . $col . '" = :' . $col;
        }
        $sql = 'UPDATE "' . $table . '" SET ' . implode(',', $sets) . " WHERE $where";
        return self::query($sql, array_merge($data, $whereParams))->rowCount();
    }
}
