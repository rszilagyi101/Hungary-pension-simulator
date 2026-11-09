<?php
/* Pension Simulator – download the official data once and save it as a static file for hosts without PHP
   (GitHub Pages). Run from the command line:   php lib/build_static.php [output file]
   Default output: data/official.json next to index.html. The page reads that file when api.php is missing.
   Sources that fail keep the values already in the output file, so a temporary outage never empties it.
   Exit code 0 = file written (even with some failed sources), 1 = nothing usable. */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/official.php';

$out = $argv[1] ?? __DIR__ . '/../data/official.json';
$cfg = pensim_config();
if (!is_dir(PENSIM_CACHE_DIR)) {
    mkdir(PENSIM_CACHE_DIR, 0775, true);
}
// start from the previous file so failed sources keep their old values
if (is_file($out)) {
    $prev = json_decode((string) file_get_contents($out), true);
    if (is_array($prev) && !empty($prev['data'])) {
        pensim_save(['data' => $prev['data'], 'meta' => $prev['meta'] ?? null]);
    }
}

$res = pensim_refresh('BSL', $cfg);
$data = $res['data'];
$sources = $res['report']['sources'];
foreach ($cfg['variants'] as $v) {
    if ($v === 'BSL') {
        continue;
    }
    try {
        $sources[] = ['name' => "Eurostat population projection ($v)", 'ok' => true, 'detail' => pensim_fetch_projection($data, $v, $cfg)];
    } catch (Throwable $e) {
        $sources[] = ['name' => "Eurostat population projection ($v)", 'ok' => false, 'detail' => $e->getMessage()];
    }
}

foreach ($sources as $s) {
    fwrite(STDOUT, ($s['ok'] ? '  ok    ' : '  FAIL  ') . $s['name'] . ' – ' . $s['detail'] . PHP_EOL);
}
if (empty($data['ksh_pensioners'])) {
    fwrite(STDERR, "No pensioner data available – output not written." . PHP_EOL);
    exit(1);
}
$meta = ['time' => $res['report']['time'], 'sources' => $sources, 'variant' => 'all', 'static' => true];
if (!is_dir(dirname($out))) {
    mkdir(dirname($out), 0775, true);
}
file_put_contents($out, json_encode(['available' => true, 'meta' => $meta, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION));
fwrite(STDOUT, 'wrote ' . $out . ' (' . round(filesize($out) / 1024) . ' KB)' . PHP_EOL);
