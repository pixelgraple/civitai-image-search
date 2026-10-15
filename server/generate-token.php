<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$token=bin2hex(random_bytes(32));
fwrite(STDOUT,"Contributor token (copy once into the extension settings):\n{$token}\n\nConfig hash (place in config.local.php):\n".password_hash($token,PASSWORD_DEFAULT)."\n");
