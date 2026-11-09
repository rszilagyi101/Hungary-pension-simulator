<?php
/* Pension Simulator – data service for the web page.
     GET  api.php?action=ping      what this server can do
     GET  api.php?action=data      official data cached on the server (shared by all visitors)
     POST api.php?action=refresh   download the latest KSH and Eurostat tables (variant=BSL|LFRT|...)
   The simulation itself runs in the visitor's browser; this file never runs models or stores visitor data. */
declare(strict_types=1);

require __DIR__ . '/lib/official.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

function pensim_respond(array $body, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function pensim_public(?array $doc): array
{
    if (!$doc || empty($doc['data'])) {
        return ['available' => false, 'meta' => $doc['meta'] ?? null, 'data' => null];
    }
    return ['available' => true, 'meta' => $doc['meta'] ?? null, 'data' => $doc['data']];
}

$cfg = pensim_config();
$action = $_GET['action'] ?? 'ping';
if (extension_loaded('zlib') && !ini_get('zlib.output_compression') && $action === 'data') {
    ob_start('ob_gzhandler');
}

try {
    switch ($action) {
        case 'ping':
            header('Cache-Control: no-store');
            pensim_respond([
                'ok' => true,
                'php' => PHP_VERSION,
                'can_download' => pensim_can_fetch(),
                'cache_writable' => is_dir(PENSIM_CACHE_DIR) && is_writable(PENSIM_CACHE_DIR),
                'refresh_needs_key' => ($cfg['refresh_key'] ?? '') !== '',
                'variants' => $cfg['variants'],
            ]);

        case 'data':
            $mtime = is_file(PENSIM_DATA_FILE) ? (int) filemtime(PENSIM_DATA_FILE) : 0;
            $etag = '"pensim-' . $mtime . '"';
            header('Cache-Control: no-cache');
            header('ETag: ' . $etag);
            if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
                http_response_code(304);
                exit;
            }
            pensim_respond(pensim_public(pensim_load()));

        case 'refresh':
            header('Cache-Control: no-store');
            if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
                pensim_respond(['error' => 'Use POST to download new data.'], 405);
            }
            $in = json_decode((string) file_get_contents('php://input'), true) ?: $_POST;
            $variant = (string) ($in['variant'] ?? 'BSL');
            if (!in_array($variant, $cfg['variants'], true)) {
                pensim_respond(['error' => 'Unknown projection variant.'], 400);
            }
            $key = (string) ($cfg['refresh_key'] ?? '');
            if ($key !== '' && !hash_equals($key, (string) ($in['key'] ?? $_GET['key'] ?? ''))) {
                pensim_respond(['error' => 'Downloading new data needs the site key set in config.php.', 'needs_key' => true], 403);
            }
            $doc = pensim_load();
            $last = (int) ($doc['meta']['refreshed'][$variant] ?? 0);
            $wait = (int) ($cfg['min_refresh_minutes'] ?? 30) * 60;
            if ($doc && $last && time() - $last < $wait) {
                $mins = (int) ceil(($wait - (time() - $last)) / 60);
                $out = pensim_public($doc);
                $out['report'] = $doc['meta'] + ['throttled' => true,
                    'note' => "The data was downloaded less than {$cfg['min_refresh_minutes']} minutes ago, so the stored copy is used. Try again in $mins minutes."];
                pensim_respond($out);
            }
            if (!is_dir(PENSIM_CACHE_DIR) || !is_writable(PENSIM_CACHE_DIR)) {
                pensim_respond(['error' => 'The cache folder on the server is not writable. Set its permissions to 755 or 775.'], 500);
            }
            $lock = fopen(PENSIM_CACHE_DIR . '/refresh.lock', 'c');
            if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
                pensim_respond(['error' => 'Another download is running. Try again in a minute.', 'busy' => true], 409);
            }
            $res = pensim_refresh($variant, $cfg);
            flock($lock, LOCK_UN);
            fclose($lock);
            $out = pensim_public(['data' => $res['data'], 'meta' => $res['meta']]);
            $out['report'] = $res['report'];
            pensim_respond($out);

        default:
            pensim_respond(['error' => 'Unknown action.'], 404);
    }
} catch (Throwable $e) {
    pensim_respond(['error' => 'Server error: ' . $e->getMessage()], 500);
}
