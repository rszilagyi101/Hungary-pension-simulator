<?php
/* Pension Simulator – download and parse official tables (port of core/data_sources.py).
   KSH STADAT CSV files (semicolon separated, ISO-8859-2 or UTF-8) and Eurostat JSON-stat. */
declare(strict_types=1);

const PENSIM_CACHE_DIR = __DIR__ . '/../cache';

if (!function_exists('array_is_list')) {          // PHP < 8.1
    function array_is_list(array $a): bool
    {
        return $a === [] || array_keys($a) === range(0, count($a) - 1);
    }
}
const PENSIM_DATA_FILE = PENSIM_CACHE_DIR . '/official.json';

function pensim_config(): array
{
    $cfg = require __DIR__ . '/../config.php';
    $local = __DIR__ . '/../config.local.php';
    if (is_file($local)) {
        $cfg = array_merge($cfg, (array) require $local);
    }
    return $cfg;
}

// ------------------------------------------------------------------ HTTP
function pensim_can_fetch(): bool
{
    return function_exists('curl_init') || filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN);
}

function pensim_http_get(string $url, array $cfg): string
{
    $timeout = (int) ($cfg['http_timeout'] ?? 45);
    $ua = (string) ($cfg['user_agent'] ?? 'pension-simulator');
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5,
            CURLOPT_CONNECTTIMEOUT => 15, CURLOPT_TIMEOUT => $timeout, CURLOPT_USERAGENT => $ua,
            CURLOPT_HTTPHEADER => ['Accept: */*'], CURLOPT_ENCODING => '',
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            throw new RuntimeException("Connection failed: $err");
        }
        if ($code !== 200) {
            throw new RuntimeException("HTTP $code from " . parse_url($url, PHP_URL_HOST));
        }
        return (string) $body;
    }
    if (!pensim_can_fetch()) {
        throw new RuntimeException('This server cannot download files (enable the PHP curl extension or allow_url_fopen).');
    }
    $ctx = stream_context_create(['http' => ['timeout' => $timeout, 'user_agent' => $ua, 'ignore_errors' => true]]);
    $body = @file_get_contents($url, false, $ctx);
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    if ($body === false) {
        throw new RuntimeException('Connection failed');
    }
    if ($status !== 200) {
        throw new RuntimeException("HTTP $status from " . parse_url($url, PHP_URL_HOST));
    }
    return $body;
}

// ------------------------------------------------------------------ KSH helpers
function pensim_lower(string $s): string
{
    if (function_exists('mb_strtolower')) {
        return mb_strtolower($s, 'UTF-8');
    }
    return strtr(strtolower($s), ['Á' => 'á', 'É' => 'é', 'Í' => 'í', 'Ó' => 'ó', 'Ö' => 'ö', 'Ő' => 'ő', 'Ú' => 'ú', 'Ü' => 'ü', 'Ű' => 'ű']);
}

function pensim_to_utf8(string $raw): string
{
    if (strncmp($raw, "\xEF\xBB\xBF", 3) === 0) {
        $raw = substr($raw, 3);
    }
    if (preg_match('//u', $raw)) {
        return $raw;                     // already valid UTF-8
    }
    // Windows-1250 matches ISO-8859-2 for every Hungarian letter and also has the en dash KSH uses
    if (function_exists('iconv')) {
        $out = @iconv('WINDOWS-1250', 'UTF-8//IGNORE', $raw);
        if ($out !== false && $out !== '') {
            return $out;
        }
    }
    if (function_exists('mb_convert_encoding')) {
        return mb_convert_encoding($raw, 'UTF-8', 'ISO-8859-2');
    }
    throw new RuntimeException('Cannot convert the KSH file to UTF-8 (enable mbstring or iconv).');
}

/** '2 413 071' -> 2413071.0, '20,9' -> 20.9, '190 564d' -> 190564.0, '..' -> null */
function pensim_num($cell): ?float
{
    if ($cell === null) {
        return null;
    }
    $s = trim((string) $cell);
    $s = str_replace(["\xC2\xA0", "\xE2\x80\xAF", ' '], '', $s);
    $s = (string) preg_replace('/[a-zA-Z*]+$/', '', $s);
    if (in_array($s, ['', '..', '–', '-', 'x'], true)) {
        return null;
    }
    $s = str_replace(',', '.', $s);
    return is_numeric($s) ? (float) $s : null;
}

function pensim_year($cell): ?int
{
    return preg_match('/^\s*(\d{4})\b/', (string) $cell, $m) ? (int) $m[1] : null;
}

function pensim_ksh_rows(string $theme, string $code, array $cfg): array
{
    $url = rtrim($cfg['ksh_base'], '/') . "/$theme/hu/$code.csv";
    $text = pensim_to_utf8(pensim_http_get($url, $cfg));
    $rows = [];
    foreach (preg_split('/\r\n|\r|\n/', $text) as $line) {
        if ($line === '') {
            $rows[] = [];
            continue;
        }
        $rows[] = explode(';', $line);
    }
    return $rows;
}

// ------------------------------------------------------------------ KSH tables
/** szo0002 (1990–, thousands) + szo0034 (2000–, exact counts, blocks for men, women, total) */
function pensim_parse_pensioners(array $szo0002, array $szo0034): array
{
    $out = [];
    foreach ($szo0002 as $row) {
        $y = $row ? pensim_year($row[0]) : null;
        if ($y && $y >= 1990) {
            $vals = array_values(array_filter(array_map('pensim_num', array_slice($row, 1)), fn($v) => $v !== null));
            if ($vals) {
                $out[$y]['pensioners_total'] = end($vals) * 1000;
            }
        }
    }
    $suffix = ['férfi' => '_m', 'nő' => '_f', 'összesen' => ''];
    $block = '';
    foreach ($szo0034 as $row) {
        if (!$row) {
            continue;
        }
        $label = pensim_lower(trim($row[0]));
        if (array_key_exists($label, $suffix)) {
            $block = $suffix[$label];
            continue;
        }
        $y = pensim_year($row[0]);
        if ($y && count($row) > 2) {
            $tot = pensim_num($row[1]);
            $old = pensim_num($row[2]);
            if ($tot) {
                $out[$y]['pensioners_total' . $block] = $tot;
            }
            if ($old) {
                $out[$y]['oldage_pensioners' . $block] = $old;
            }
        }
    }
    ksort($out);
    $rows = [];
    foreach ($out as $y => $r) {
        $rows[] = ['year' => $y] + $r;
    }
    return $rows;
}

/** nep0001 (wide: population, life expectancy) + nep0004 (65+ share) */
function pensim_parse_population(array $nep0001, array $nep0004): array
{
    $header = null;
    $section = '';
    $data = [];
    foreach ($nep0001 as $row) {
        $yrs = array_map('pensim_year', array_slice($row, 1));
        if ($header === null && count(array_filter($yrs)) > 10) {
            $header = $yrs;
            continue;
        }
        if ($header === null || !$row) {
            continue;
        }
        $label = pensim_lower(trim($row[0]));
        $rest = array_slice($row, 1);
        if ($label !== '' && count(array_filter(array_map('pensim_num', $rest), fn($v) => $v !== null)) === 0) {
            $section = $label;
            continue;
        }
        if ($label === 'összesen') {
            $key = null;
            if (strpos($section, 'a népesség száma') === 0) {
                $key = 'population';
            } elseif (strpos($section, 'születéskor várható') === 0) {
                $key = 'life_expectancy';
            }
            if ($key) {
                foreach ($header as $i => $y) {
                    $v = pensim_num($rest[$i] ?? null);
                    if ($y && $v !== null && $y >= 1990 && !isset($data[$y][$key])) {
                        $data[$y][$key] = $v;
                    }
                }
            }
        }
    }
    foreach ($nep0004 as $row) {
        $y = $row ? pensim_year($row[0]) : null;
        if ($y && $y >= 1990 && count($row) > 3) {
            $v = pensim_num($row[3]);
            if ($v !== null) {
                $data[$y]['share_65plus'] = $v;
            }
        }
    }
    ksort($data);
    $rows = [];
    foreach ($data as $y => $r) {
        $rows[] = ['year' => $y] + $r;
    }
    return $rows;
}

/** nep0003: single years of age 0..89, 90+ by sex -> ['M' => [year => [91 values]], 'F' => ...] */
function pensim_parse_ages(array $nep0003): array
{
    $header = null;
    $sex = null;
    $acc = ['M' => [], 'F' => []];
    $sexMap = ['férfi' => 'M', 'nő' => 'F', 'összesen' => 'T'];
    foreach ($nep0003 as $row) {
        if (!$row) {
            continue;
        }
        $yrs = array_map('pensim_year', array_slice($row, 1));
        if ($header === null && count(array_filter($yrs)) > 5) {
            $header = $yrs;
            continue;
        }
        if ($header === null) {
            continue;
        }
        $label = pensim_lower(trim($row[0]));
        $rest = array_slice($row, 1);
        if (isset($sexMap[$label]) && count(array_filter(array_map('pensim_num', $rest), fn($v) => $v !== null)) === 0) {
            $sex = $sexMap[$label];
            continue;
        }
        if (($sex === 'M' || $sex === 'F') && preg_match('/^(\d{1,2})/', $label, $m)) {
            $age = min((int) $m[1], 90);
            foreach ($header as $i => $y) {
                $v = pensim_num($rest[$i] ?? null);
                if ($y && $v !== null) {
                    $acc[$sex][$y][$age] = ($acc[$sex][$y][$age] ?? 0) + $v;
                }
            }
        }
    }
    $out = ['M' => [], 'F' => []];
    foreach ($acc as $s => $byYear) {
        ksort($byYear);
        foreach ($byYear as $y => $ages) {
            $arr = array_fill(0, 91, 0.0);
            foreach ($ages as $a => $v) {
                $arr[$a] = $v;
            }
            $out[$s][(string) $y] = $arr;
        }
    }
    if (!$out['M'] || !$out['F']) {
        throw new RuntimeException('no age rows parsed');
    }
    return $out;
}

// ------------------------------------------------------------------ Eurostat
function pensim_age_code(string $code): ?int
{
    if ($code === 'Y_LT1') {
        return 0;
    }
    if ($code === 'Y_OPEN' || $code === 'Y_GE100') {
        return 100;
    }
    return preg_match('/^Y(\d+)$/', $code, $m) ? (int) $m[1] : null;
}

/** JSON-stat 2.0 -> ['M' => [year => [101 values, ages 0..99 and 100+]], 'F' => ...] */
function pensim_jsonstat_ages(array $js, int $minYear, int $maxYear): array
{
    $ids = $js['id'];
    $sizes = $js['size'];
    $cats = [];
    foreach ($ids as $d) {
        $idx = $js['dimension'][$d]['category']['index'];
        $cats[] = array_is_list($idx) ? $idx : array_flip($idx);
    }
    $values = $js['value'] ?? [];
    $acc = ['M' => [], 'F' => []];
    $openAge = [];                              // Y_OPEN, or Y_GE100 when Y_OPEN is missing: never both
    foreach ($values as $flat => $val) {
        if ($val === null) {
            continue;
        }
        $rem = (int) $flat;
        $rec = [];
        for ($k = count($ids) - 1; $k >= 0; $k--) {
            $rec[$ids[$k]] = $cats[$k][$rem % $sizes[$k]];
            $rem = intdiv($rem, $sizes[$k]);
        }
        $sex = $rec['sex'] ?? null;
        if ($sex !== 'M' && $sex !== 'F') {
            continue;
        }
        $code = (string) ($rec['age'] ?? '');
        $age = pensim_age_code($code);
        $year = (int) substr((string) ($rec['time'] ?? ''), 0, 4);
        if ($age === null || $year < $minYear || $year > $maxYear) {
            continue;
        }
        if ($age === 100) {
            if ($code === 'Y_OPEN' || !isset($openAge[$sex][$year]['open'])) {
                $openAge[$sex][$year] = ['open' => $code === 'Y_OPEN', 'v' => (float) $val];
            }
            continue;
        }
        $acc[$sex][$year][$age] = ($acc[$sex][$year][$age] ?? 0) + (float) $val;
    }
    foreach ($openAge as $s => $byYear) {
        foreach ($byYear as $y => $o) {
            $acc[$s][$y][100] = $o['v'];
        }
    }
    $out = ['M' => [], 'F' => []];
    foreach ($acc as $s => $byYear) {
        ksort($byYear);
        foreach ($byYear as $y => $ages) {
            $arr = array_fill(0, 101, 0.0);
            foreach ($ages as $a => $v) {
                $arr[$a] = $v;
            }
            $out[$s][(string) $y] = $arr;
        }
    }
    if (!$out['M'] || !$out['F']) {
        throw new RuntimeException('no values for Hungary by sex and age');
    }
    return $out;
}

function pensim_eurostat(string $code, array $params, array $cfg, int $minYear, int $maxYear): array
{
    $q = 'format=JSON&lang=EN';
    foreach ($params as $k => $v) {
        foreach ((array) $v as $one) {
            $q .= '&' . rawurlencode($k) . '=' . rawurlencode((string) $one);
        }
    }
    $body = pensim_http_get(rtrim($cfg['eurostat_base'], '/') . '/' . rawurlencode($code) . '?' . $q, $cfg);
    $js = json_decode($body, true);
    if (!is_array($js) || !isset($js['id'], $js['size'], $js['dimension'])) {
        throw new RuntimeException('unexpected response from Eurostat');
    }
    return pensim_jsonstat_ages($js, $minYear, $maxYear);
}

// ------------------------------------------------------------------ cache
function pensim_load(): ?array
{
    if (!is_file(PENSIM_DATA_FILE)) {
        return null;
    }
    $d = json_decode((string) file_get_contents(PENSIM_DATA_FILE), true);
    return is_array($d) ? $d : null;
}

function pensim_save(array $doc): void
{
    if (!is_dir(PENSIM_CACHE_DIR) || !is_writable(PENSIM_CACHE_DIR)) {
        throw new RuntimeException('The cache folder is not writable. Set its permissions to 755 or 775 on the server.');
    }
    $tmp = PENSIM_DATA_FILE . '.tmp' . getmypid();
    file_put_contents($tmp, json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION));
    rename($tmp, PENSIM_DATA_FILE);
}

/** Eurostat EUROPOP projection for one variant, newest dataset first. Stores it in $data; returns a description. */
function pensim_fetch_projection(array &$data, string $variant, array $cfg): string
{
    $last = null;
    foreach ($cfg['projection_codes'] as $code) {
        foreach ([['unit' => 'PER'], []] as $extra) {
            try {
                $ages = pensim_eurostat($code, ['geo' => 'HU', 'sex' => ['M', 'F'], 'projection' => $variant] + $extra, $cfg, 2015, 2100);
                $data['eurostat_proj'][$variant] = ['code' => $code] + $ages;
                $ys = array_keys($ages['M']);
                return "$code variant $variant by sex, " . reset($ys) . '–' . end($ys);
            } catch (Throwable $e) {
                $last = $e;
            }
        }
    }
    throw new RuntimeException('No Eurostat projection available (' . ($last ? $last->getMessage() : 'unknown') . ')');
}

/** Download every source; a failed source keeps its previously cached data. */
function pensim_refresh(string $variant, array $cfg): array
{
    @set_time_limit(300);
    $doc = pensim_load() ?? ['data' => [], 'meta' => null];
    $data = $doc['data'] ?? [];
    $report = ['time' => date('c'), 'variant' => $variant, 'sources' => []];
    $run = function (string $name, callable $fn) use (&$report) {
        try {
            $report['sources'][] = ['name' => $name, 'ok' => true, 'detail' => $fn()];
        } catch (Throwable $e) {
            $report['sources'][] = ['name' => $name, 'ok' => false, 'detail' => $e->getMessage()];
        }
    };
    $run('KSH pensioners (szo0002, szo0034)', function () use (&$data, $cfg) {
        $rows = pensim_parse_pensioners(pensim_ksh_rows('szo', 'szo0002', $cfg), pensim_ksh_rows('szo', 'szo0034', $cfg));
        if (!$rows) {
            throw new RuntimeException('no rows parsed');
        }
        $data['ksh_pensioners'] = $rows;
        return count($rows) . ' years (' . $rows[0]['year'] . '–' . end($rows)['year'] . ') from szo0002 + szo0034';
    });
    $run('KSH population (nep0001, nep0004)', function () use (&$data, $cfg) {
        $rows = pensim_parse_population(pensim_ksh_rows('nep', 'nep0001', $cfg), pensim_ksh_rows('nep', 'nep0004', $cfg));
        if (!$rows) {
            throw new RuntimeException('no rows parsed');
        }
        $data['ksh_population'] = $rows;
        return count($rows) . ' years from nep0001 + nep0004';
    });
    $run('KSH population by age and sex (nep0003)', function () use (&$data, $cfg) {
        $ages = pensim_parse_ages(pensim_ksh_rows('nep', 'nep0003', $cfg));
        $data['ksh_ages'] = $ages;
        $ys = array_keys($ages['M']);
        return 'single-year ages by sex for ' . count($ys) . ' years (' . reset($ys) . '–' . end($ys) . ')';
    });
    $run('Eurostat population by age (demo_pjan)', function () use (&$data, $cfg) {
        $ages = pensim_eurostat('demo_pjan', ['geo' => 'HU', 'sex' => ['M', 'F'], 'unit' => 'NR'], $cfg, 1990, 2100);
        $data['eurostat_hist'] = $ages;
        $ys = array_keys($ages['M']);
        return 'demo_pjan single-year ages by sex, ' . reset($ys) . '–' . end($ys);
    });
    $run("Eurostat population projection ($variant)", function () use (&$data, $cfg, $variant) {
        return pensim_fetch_projection($data, $variant, $cfg);
    });
    $meta = $doc['meta'] ?? [];
    $meta['time'] = $report['time'];
    $meta['sources'] = $report['sources'];
    $meta['variant'] = $variant;
    $meta['refreshed'][$variant] = time();
    pensim_save(['data' => $data, 'meta' => $meta]);
    return ['data' => $data, 'meta' => $meta, 'report' => $report];
}
