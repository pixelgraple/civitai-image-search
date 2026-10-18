<?php
declare(strict_types=1);

/** Pin cURL to the public DNS answers we validated, on every redirect hop. */
function image_public_addresses(array $records): array {
    $out=[];
    foreach ($records as $record) {
        $ip=$record['ip']??$record['ipv6']??null;
        if ($ip===null) continue; // CNAME records themselves are not connection targets.
        if (!is_string($ip) || filter_var($ip,FILTER_VALIDATE_IP,FILTER_FLAG_GLOBAL_RANGE)===false ||
            str_starts_with(strtolower($ip),'::ffff:') ||
            (str_contains($ip,':') ? str_starts_with(strtolower($ip),'ff') : (int)explode('.',$ip)[0]>=224))
            throw new RuntimeException('Image host resolved to a non-public address.');
        $out[$ip]=str_contains($ip,':')?'['.$ip.']':$ip;
    }
    if (!$out) throw new RuntimeException('Image host has no public DNS address.');
    return array_values($out);
}

function image_pinned_resolution(string $url): array {
    static $cache=[];
    if (!safe_image_url($url)) throw new RuntimeException('Source URL rejected.');
    $host=strtolower((string)parse_url($url,PHP_URL_HOST));
    if (!isset($cache[$host]) || $cache[$host]['until']<=time()) {
        $records=dns_get_record($host,DNS_A|DNS_AAAA);
        if (!is_array($records)) throw new RuntimeException('Image host DNS is unavailable.');
        $cache[$host]=['addresses'=>image_public_addresses($records),'until'=>time()+60];
    }
    return [$host.':443:'.implode(',',$cache[$host]['addresses'])];
}
