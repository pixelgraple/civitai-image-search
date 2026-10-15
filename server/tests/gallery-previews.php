<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') exit(1);
$testRoot=sys_get_temp_dir().'/civitai-gallery-'.bin2hex(random_bytes(6));
mkdir($testRoot,0700); mkdir($testRoot.'/media',0700);
file_put_contents($testRoot.'/config.php','<?php return '.var_export(['storage_dir'=>$testRoot.'/media'],true).';');
putenv('CIVITAI_LIBRARY_CONFIG='.$testRoot.'/config.php');
require dirname(__DIR__).'/lib.php';
$checks=0;
function check(bool $value,string $message): void { global $checks; if (!$value) throw new RuntimeException($message); $checks++; }
try {
    foreach ([[480,720],[720,480],[720,720],[100,200],[100,720]] as $n=>[$w,$h]) {
        $path=$testRoot.'/media/'.$n.'.png';
        // Synthetic fixtures keep all tests independent of catalog media.
        $img=imagecreatetruecolor($w,$h); imagealphablending($img,false); imagesavealpha($img,true);
        imagefill($img,0,0,imagecolorallocatealpha($img,10,90,180,35));
        imagepng($img,$path); imagewebp($img,gallery_preview_path($path),80); imagedestroy($img);
        $hash=hash_file('sha256',$path); $largeHash=hash_file('sha256',gallery_preview_path($path));
        check(build_card_preview($path),'small preview created');
        $small=stored_card_preview($path); check($small!=='','stored preview validated');
        $info=getimagesize($small); $scale=min(1,320/$w);
        check($info[0]===max(1,(int)round($w*$scale)) && $info[1]===max(1,(int)round($h*$scale)),'aspect ratio and no upscaling');
        check($info['mime']==='image/webp','WebP format');
        $smallHash=hash_file('sha256',$small); check(build_card_preview($path) && hash_file('sha256',$small)===$smallHash,'idempotent cache');
        check(hash_file('sha256',$path)===$hash && hash_file('sha256',gallery_preview_path($path))===$largeHash,'original and larger preview preserved');
        $decoded=imagecreatefromwebp($small); $rgba=imagecolorsforindex($decoded,imagecolorat($decoded,0,0));
        check($rgba['alpha']>0,'transparency preserved'); imagedestroy($decoded);
        check((fileperms($small)&0777)===0640,'private cache permissions');
    }
    check(!build_card_preview($testRoot.'/media/missing.png'),'missing compact source is deferred');
    $bad=$testRoot.'/media/bad.png'; file_put_contents(gallery_preview_path($bad),'not an image');
    check(!build_card_preview($bad),'corrupt preview rejected');
    $huge=imagecreatetruecolor(721,2); imagewebp($huge,gallery_preview_path($bad)); imagedestroy($huge);
    check(!build_card_preview($bad),'unbounded source rejected before decode');
    check(card_preview_path('/tmp/no-extension')==='','unsupported path rejected');
    check(stored_card_preview($testRoot.'/../outside.png')==='','outside storage rejected');
    check(!glob($testRoot.'/media/*.tmp'),'no temporary files remain');
    echo json_encode(['ok'=>true,'checks'=>$checks])."\n";
} finally {
    foreach (glob($testRoot.'/media/*')?:[] as $file) unlink($file);
    rmdir($testRoot.'/media'); unlink($testRoot.'/config.php'); rmdir($testRoot);
}
