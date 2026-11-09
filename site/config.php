<?php
/* Pension Simulator – data service settings. Edit these values after uploading if needed.
   (For local testing you can also create config.local.php returning an array of overrides.) */
return [
    // Minimum minutes between two downloads from KSH/Eurostat. Visitors in between get the cached copy.
    'min_refresh_minutes' => 30,

    // If not empty, "Download latest official data" only works with this key
    // (enter it in the page when asked, or add ?key=... to api.php calls).
    'refresh_key' => '',

    // Seconds to wait for each KSH or Eurostat response.
    'http_timeout' => 45,

    // Sources. Change only if KSH or Eurostat move their files.
    'ksh_base' => 'https://www.ksh.hu/stadat_files',
    'eurostat_base' => 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data',
    'projection_codes' => ['proj_25np', 'proj_23np'],   // EUROPOP2025 first, EUROPOP2023 as fallback
    'variants' => ['BSL', 'LFRT', 'LMRT', 'HMIGR', 'LMIGR', 'NMIGR'],

    'user_agent' => 'Mozilla/5.0 (pension-simulator; +https://www.ksh.hu/stadat)',
];
