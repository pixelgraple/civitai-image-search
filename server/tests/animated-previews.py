#!/usr/bin/env python3
"""Synthetic first-frame and worker integration checks; no catalog or network."""
from pathlib import Path
from PIL import Image
import hashlib, json, os, subprocess, tempfile

root = Path(__file__).resolve().parent.parent
php = os.environ.get('PHP_BINARY', 'php')
checks = 0
def check(value, message):
    global checks
    assert value, message
    checks += 1

with tempfile.TemporaryDirectory(prefix='civitai-animated-previews-') as folder:
    temp = Path(folder)
    source = temp/'animated.webp'
    frames = [Image.new('RGBA', (960, 1440), color) for color in ['red', 'blue']]
    frames[0].save(source, save_all=True, append_images=frames[1:], duration=100, loop=0, lossless=True)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    for format in ['webp', 'jpeg', 'png']:
        target = temp/('preview.'+format)
        subprocess.run(['/usr/bin/python3',str(root/'thumbnail_frame.py'),str(source),str(target),format],check=True,capture_output=True,timeout=15)
        with Image.open(target) as result:
            check(result.size==(480,720),'bounded dimensions and aspect ratio')
            check(getattr(result,'n_frames',1)==1,'still preview')
            red,green,blue = result.convert('RGB').getpixel((0,0))
            check(red>200 and blue<30,'first frame selected')
    config = temp/'config.php'
    config.write_text('<?php return '+"['storage_dir'=>"+repr(str(temp))+'];')
    # Load production functions without entering the download queue. Directory
    # constants still point at the candidate's own helpers and dependencies.
    worker = (root/'worker.php').read_text().split('$cfg=config(); $lockPath=')[0]
    worker = worker.replace('__DIR__',repr(str(root)))
    probe = temp/'worker-functions.php'
    probe.write_text(worker+"\nensure_thumbnail($argv[1],'image/webp'); echo json_encode(['large'=>getimagesize(stored_gallery_preview($argv[1])),'small'=>getimagesize(stored_card_preview($argv[1]))]);")
    result = subprocess.run([php,'-d','memory_limit=128M',str(probe),str(source)],env={**os.environ,'CIVITAI_LIBRARY_CONFIG':str(config)},capture_output=True,text=True,timeout=20,check=True)
    data = json.loads(result.stdout)
    check([data['large']['0'],data['large']['1']]==[480,720],'worker creates large preview')
    check([data['small']['0'],data['small']['1']]==[320,480],'worker creates small preview')
    check(hashlib.sha256(source.read_bytes()).hexdigest()==before,'original bytes preserved')
    oversized = temp/'too-wide.webp'
    Image.new('RGB',(4097,4),'red').save(oversized)
    reject = subprocess.run(['/usr/bin/python3',str(root/'thumbnail_frame.py'),str(oversized),str(temp/'rejected.webp'),'webp'],capture_output=True,timeout=15)
    check(reject.returncode!=0 and not (temp/'rejected.webp').exists(),'collection limits enforced')
print(json.dumps({'ok':True,'checks':checks}))
