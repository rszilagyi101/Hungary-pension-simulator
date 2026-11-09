<?php
// Mock KSH + Eurostat server for tests: php -S 127.0.0.1:8099 tests/mock_router.php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$dir = __DIR__ . '/mock';
if (preg_match('#/stadat_files/(szo|nep)/hu/(\w+)\.csv$#', $path, $m) && is_file("$dir/{$m[2]}.csv")) {
    header('Content-Type: text/csv; charset=windows-1250'); readfile("$dir/{$m[2]}.csv"); return true;
}
if (preg_match('#/data/(demo_pjan|proj_25np|proj_23np)$#', $path, $m)) {
    parse_str((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY), $q);
    // proj_25np "not published yet" -> 404, so the fallback to proj_23np is exercised
    if ($m[1] === 'proj_25np') { http_response_code(404); echo '{"error":"not found"}'; return true; }
    $f = $m[1] === 'demo_pjan' ? 'demo_pjan.json' : 'proj_' . ($q['projection'] ?? 'BSL') . '.json';
    if (!is_file("$dir/$f")) { http_response_code(404); echo '{}'; return true; }
    header('Content-Type: application/json'); readfile("$dir/$f"); return true;
}
http_response_code(404); echo 'not found';
