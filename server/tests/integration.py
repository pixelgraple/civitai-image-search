#!/usr/bin/env python3
"""Isolated API/worker integration test. Run on a test host with PHP, curl, SQLite, and internet access."""
import fcntl, hashlib, json, os, sqlite3, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC=os.path.join(ROOT,'public')
BASE='http://127.0.0.1:18257'
TOKEN='test-writer-key'
TEST_CONFIG='/data/civitai/test/config.php'
TEST_DATABASE='/data/civitai/test/catalog.sqlite'
checks=0

def check(value,message):
    global checks
    if not value: raise AssertionError(message)
    checks+=1

def request(url,method='GET',body=None,token=None):
    data=None if body is None else json.dumps(body).encode()
    headers={'Accept':'application/json'}
    if data is not None: headers['Content-Type']='application/json'
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(url,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=25) as response:
            raw=response.read()
            return response.status,response.headers,raw
    except urllib.error.HTTPError as error:
        return error.code,error.headers,error.read()

def run():
    env=os.environ.copy()
    env['CIVITAI_LIBRARY_CONFIG']=TEST_CONFIG
    # This test database is isolated from production; reset it so the test is repeatable.
    db=sqlite3.connect(TEST_DATABASE)
    db.execute('DELETE FROM images_fts'); db.execute('DELETE FROM images'); db.commit(); db.close()
    log=open('/tmp/civitai-library-php-test.log','wb')
    server=None
    try:
        server=subprocess.Popen(['php','-S','127.0.0.1:18257','-t',PUBLIC],cwd=PUBLIC,env=env,stdout=log,stderr=subprocess.STDOUT)
        status=None
        for _ in range(60):
            try:
                status,_,raw=request(BASE+'/api.php?action=health')
                if status==200: break
            except Exception: time.sleep(.25)
        check(status==200,'health endpoint is available')
        health=json.loads(raw);check(health['ok'] is True,'health response is valid JSON')
        status,_,_=request(BASE+'/api.php?action=images','POST',{'items':[]})
        check(status==401,'write endpoint rejects missing contributor key')
        status,_,_=request(BASE+'/api.php?action=check','POST',{'imageIds':['42']})
        check(status==401,'storage/hash endpoint rejects missing contributor key')
        for invalid in ([],['0'],['../42'],['1']*101,[1.5],{'id':'42'}):
            status,_,_=request(BASE+'/api.php?action=check','POST',{'imageIds':invalid},TOKEN)
            check(status==400,'storage/hash endpoint rejects invalid ID batch: '+repr(invalid)[:60])
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':['999000099','999000099']},TOKEN)
        absent=json.loads(raw)
        check(status==200 and absent['checked']==1 and absent['missing']==1 and absent['items'][0]['needsDownload'] and absent['items'][0]['downloadStatus']=='unknown','unknown IDs deduplicate and need download')
        conn=sqlite3.connect(TEST_DATABASE)
        check(conn.execute('SELECT COUNT(*) FROM images').fetchone()[0]==0,'preflight unknown IDs do not create catalog rows')
        conn.close()

        # Fetch a current, non-NSFW public image because fixed historical IDs may be removed.
        civitai_url='https://civitai.com/api/v1/images?limit=10&sort=Newest'
        req=urllib.request.Request(civitai_url,headers={'User-Agent':'CivitaiPromptLibraryTest/1.0','Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as response: source=json.load(response)
        candidates=source.get('items') or source.get('images') or []
        candidates=[candidate for candidate in candidates if not candidate.get('nsfw') and candidate.get('type','image')=='image']
        check(bool(candidates),'Civitai public image lookup returned a record')
        image=candidates[0]; source_url=image.get('url','')
        check(source_url.startswith('https://image.civitai.com/') or source_url.startswith('https://imagecache.civitai.com/'),'Civitai supplied an allowed image host')

        promptless=[{'id':'999000080','downloadUrl':source_url},
            {'id':'999000081','downloadUrl':source_url,'prompt':' \n\t\u00a0','tags':['selfie']},
            {'id':'999000082','downloadUrl':source_url,'negativePrompt':'selfie'},
            {'id':'999000083','downloadUrl':source_url,'prompt':{'text':'selfie'},'tags':['selfie']}]
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':promptless},TOKEN)
        skipped=json.loads(raw)
        check(status==200 and skipped['accepted']==0 and skipped['skipped']==4 and skipped['imageCopiesQueued']==0,'unknown images without a real positive prompt are skipped and never queued')
        conn=sqlite3.connect(TEST_DATABASE)
        check(conn.execute('SELECT COUNT(*) FROM images').fetchone()[0]==0,'tags-only, negative-only and blank/malformed prompt records are not cataloged')
        conn.close()

        record={'id':str(image['id']),'downloadUrl':source_url,'prompt':'catalogprobeunique, candid selfie, photorealistic portrait, realistic skin texture, DSLR','negativePrompt':'anime, drawing','tags':['catalogprobeunique','selfie','portrait'],'modelName':'Realistic Vision XL','loras':[]}
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[record]},TOKEN)
        data=json.loads(raw);check(status==200 and data.get('accepted')==1,'authenticated metadata is accepted and image copy queued')
        status,_,raw=request(BASE+'/api.php?action=search&q=catalogprobeunique')
        data=json.loads(raw);check(data['total']==1,'tag/prompt search finds the queued image')
        check(data['categoryCounts']['realistic']==1,'photoreal prompt/model classifies realistic')
        check(data['items'][0]['downloadStatus']=='pending','queued result is visible before image copy')

        # Busy storage returns a retryable response within MV3's request window,
        # and neither API nor worker changes the record's attempts while waiting.
        held=open('/data/civitai/test/media/.image-locks/'+record['id']+'.lock','a+')
        try:
            fcntl.flock(held,fcntl.LOCK_EX)
            started=time.monotonic()
            status,headers,_=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
            check(status==503 and headers.get('Retry-After')=='2' and time.monotonic()-started<8,'busy preflight returns retryable 503 within bounded lock wait')
            status,_,_=request(BASE+'/api.php?action=images','POST',{'items':[record]},TOKEN)
            check(status==503,'busy upload retries instead of waiting for a network download lock')
            skipped_worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'1'],env=env,capture_output=True,text=True,timeout=10)
            conn=sqlite3.connect(TEST_DATABASE)
            attempts=conn.execute('SELECT download_attempts FROM images WHERE image_id=?',(record['id'],)).fetchone()[0];conn.close()
            check(skipped_worker.returncode==0 and 'busy' in skipped_worker.stdout and attempts==0,'busy worker leaves queued record and attempt counter unchanged')
        finally:
            fcntl.flock(held,fcntl.LOCK_UN); held.close()

        worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'1'],env=env,capture_output=True,text=True,timeout=60)
        check(worker.returncode==0,'image worker exits successfully: '+worker.stderr[-300:])
        status,_,raw=request(BASE+'/api.php?action=search&q=catalogprobeunique')
        data=json.loads(raw);item=data['items'][0]
        check(item['downloadStatus']=='ready','worker stores the downloaded image')
        media=urllib.parse.urljoin(BASE+'/',item['downloadUrl'])
        status,headers,content=request(media)
        check(status==200 and headers.get_content_type() in ('image/jpeg','image/png','image/webp'),'public media endpoint serves the validated image')
        check(len(content)>100,'served image has non-empty bytes')
        thumb=urllib.parse.urljoin(BASE+'/',item['previewUrl'])
        tstatus,theaders,tcontent=request(thumb)
        check(tstatus==200 and theaders.get_content_type().startswith('image/'),'thumbnail route serves image bytes')
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
        existing=json.loads(raw)
        check(status==200 and existing['existing']==1 and not existing['items'][0]['needsDownload'],'verified stored image skips another network download')
        check(existing['items'][0]['sha256']==hashlib.sha256(content).hexdigest(),'reported SHA256 matches actual served original bytes')
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[record,record]},TOKEN)
        check(status==200 and json.loads(raw)['imageCopiesQueued']==0,'same ready image rescanned twice queues zero downloads')

        anime={'id':'135960468','downloadUrl':source_url,'prompt':'animetestunique anime style manga selfie, cel shading','tags':['animetestunique','anime'],'modelName':'Anime checkpoint','loras':['Anime portrait LoRA']}
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[anime]},TOKEN)
        check(status==200 and json.loads(raw)['accepted']==1,'second prompt is accepted')
        status,_,raw=request(BASE+'/api.php?action=search&q=animetestunique')
        data=json.loads(raw);check(data['total']==1 and data['categoryCounts']['anime']==1,'anime prompt/model/LoRA signals classify anime and count correctly')
        worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'5'],env=env,capture_output=True,text=True,timeout=60)
        conn=sqlite3.connect(TEST_DATABASE); conn.row_factory=sqlite3.Row
        original=dict(conn.execute('SELECT * FROM images WHERE image_id=?',(record['id'],)).fetchone())
        duplicate=dict(conn.execute('SELECT * FROM images WHERE image_id=?',(anime['id'],)).fetchone())
        check(worker.returncode==0 and duplicate['download_status']=='ready','second image ID downloads successfully')
        check(duplicate['sha256']==original['sha256'] and duplicate['file_path']==original['file_path'],'equal content hashes reuse one original file and thumbnail across image IDs')
        conn.close()

        # A missing thumbnail is repaired from verified originals, even when the
        # source URL is deliberately unavailable. No new network attempt occurs.
        original_path=original['file_path']; thumb_path=os.path.splitext(original_path)[0]+'-thumb'+os.path.splitext(original_path)[1]
        os.unlink(thumb_path)
        conn=sqlite3.connect(TEST_DATABASE)
        conn.execute('UPDATE images SET source_url=? WHERE image_id=?',('https://image.civitai.com/this-must-not-be-downloaded.jpg',record['id']))
        conn.commit(); conn.close()
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
        checked=json.loads(raw)['items'][0]
        check(checked['exists'] and not checked['needsDownload'] and checked['downloadStatus']=='pending','missing thumbnail queues local repair while skipping original download')
        worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'5'],env=env,capture_output=True,text=True,timeout=60)
        conn=sqlite3.connect(TEST_DATABASE); conn.row_factory=sqlite3.Row
        repaired=dict(conn.execute('SELECT * FROM images WHERE image_id=?',(record['id'],)).fetchone())
        check(worker.returncode==0 and repaired['download_status']=='ready' and os.path.isfile(thumb_path),'worker repairs thumbnail without network access')
        check(repaired['download_attempts']==original['download_attempts'] and 'no network download' in worker.stdout,'thumbnail repair preserves network attempt counter')
        conn.execute('UPDATE images SET source_url=? WHERE image_id=?',(source_url,record['id'])); conn.commit(); conn.close()

        # Missing originals and equal-length byte changes both invalidate ready
        # storage. Repeated checks retain the pending attempt count.
        with open(original_path,'rb') as stored_file: good_bytes=stored_file.read()
        with open(original_path,'wb') as stored_file: stored_file.write(good_bytes[:-1]+bytes([good_bytes[-1]^1]))
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
        damaged=json.loads(raw)['items'][0]
        check(damaged['needsDownload'] and not damaged['exists'] and damaged['downloadStatus']=='pending','same-length corrupted original fails saved SHA256 verification and is requeued')
        conn=sqlite3.connect(TEST_DATABASE); conn.execute('UPDATE images SET download_attempts=2 WHERE image_id=?',(record['id'],)); conn.commit(); conn.close()
        status,_,_=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
        status,_,_=request(BASE+'/api.php?action=images','POST',{'items':[record]},TOKEN)
        conn=sqlite3.connect(TEST_DATABASE)
        check(conn.execute('SELECT download_attempts FROM images WHERE image_id=?',(record['id'],)).fetchone()[0]==2,'repeated check and metadata scan do not reset pending attempts')
        conn.close()
        with open(original_path,'wb') as stored_file: stored_file.write(good_bytes)
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
        check(json.loads(raw)['items'][0]['exists'] and json.loads(raw)['items'][0]['downloadStatus']=='ready','restored verified bytes recover pending state without downloading')
        os.unlink(original_path)
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[record]},TOKEN)
        check(json.loads(raw)['imageCopiesQueued']==1,'metadata upload independently detects and queues missing ready original')
        worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'5'],env=env,capture_output=True,text=True,timeout=60)
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id']]},TOKEN)
        check(worker.returncode==0 and json.loads(raw)['items'][0]['exists'],'worker re-downloads absent original and verifies new saved digest')

        # Deliberately block the thumbnail destination for a new original. Its
        # verified path/hash must survive the failed thumbnail and prevent a fetch
        # on retry even after the source has become unavailable.
        interrupted=dict(record,id='999000097',prompt='thumbnailrecoveryspecial positive prompt')
        ext=os.path.splitext(original_path)[1]
        probe_dir='/data/civitai/test/media/images/'+interrupted['id'][-2:]+'/'+interrupted['id'][-4:-2]
        os.makedirs(probe_dir,exist_ok=True)
        blocked_thumb=probe_dir+'/'+interrupted['id']+'-thumb'+ext
        if os.path.isfile(blocked_thumb): os.unlink(blocked_thumb)
        os.makedirs(blocked_thumb,exist_ok=True)
        conn=sqlite3.connect(TEST_DATABASE)
        conn.execute("UPDATE images SET download_status='failed' WHERE image_id IN (?,?)",(record['id'],anime['id']));conn.commit();conn.close()
        status,_,_=request(BASE+'/api.php?action=images','POST',{'items':[interrupted]},TOKEN)
        worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'1'],env=env,capture_output=True,text=True,timeout=60)
        conn=sqlite3.connect(TEST_DATABASE);conn.row_factory=sqlite3.Row
        persisted=dict(conn.execute('SELECT * FROM images WHERE image_id=?',(interrupted['id'],)).fetchone())
        check(persisted['download_status']=='pending' and persisted['sha256']==hashlib.sha256(good_bytes).hexdigest() and os.path.isfile(persisted['file_path']),'thumbnail failure preserves verified original metadata and bytes for local recovery')
        conn.execute('UPDATE images SET source_url=? WHERE image_id=?',('https://image.civitai.com/this-must-not-be-downloaded.jpg',interrupted['id']));conn.commit();conn.close()
        os.rmdir(blocked_thumb)
        worker=subprocess.run(['php',os.path.join(ROOT,'worker.php'),'1'],env=env,capture_output=True,text=True,timeout=60)
        conn=sqlite3.connect(TEST_DATABASE);conn.row_factory=sqlite3.Row
        recovered=dict(conn.execute('SELECT * FROM images WHERE image_id=?',(interrupted['id'],)).fetchone())
        check(recovered['download_status']=='ready' and recovered['download_attempts']==persisted['download_attempts'] and 'no network download' in worker.stdout,'thumbnail retry reuses persisted original without a second source fetch')
        conn.execute('DELETE FROM images_fts WHERE image_id=?',(interrupted['id'],));conn.execute('DELETE FROM images WHERE image_id=?',(interrupted['id'],));conn.commit();conn.close()
        status,_,_=request(BASE+'/api.php?action=check','POST',{'imageIds':[record['id'],anime['id']]},TOKEN)

        # Failed transfers remain failed during ordinary browsing; rescans cannot
        # force an unlimited retry loop. A successful local byte recovery is safe.
        failed=dict(record,id='999000098')
        status,_,_=request(BASE+'/api.php?action=images','POST',{'items':[failed,failed]},TOKEN)
        conn=sqlite3.connect(TEST_DATABASE)
        conn.execute("UPDATE images SET download_status='failed',download_attempts=3 WHERE image_id=?",(failed['id'],));conn.commit();conn.close()
        status,_,raw=request(BASE+'/api.php?action=check','POST',{'imageIds':[failed['id']]},TOKEN)
        check(json.loads(raw)['items'][0]['downloadStatus']=='failed' and json.loads(raw)['items'][0]['needsDownload'],'failed missing copies report failure without silent retry reset')
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[failed]},TOKEN)
        conn=sqlite3.connect(TEST_DATABASE)
        failure=conn.execute('SELECT download_status,download_attempts FROM images WHERE image_id=?',(failed['id'],)).fetchone()
        check(failure==('failed',3) and json.loads(raw)['imageCopiesQueued']==0,'metadata rescans preserve failed transfer attempts')
        conn.execute('DELETE FROM images_fts WHERE image_id=?',(failed['id'],));conn.execute('DELETE FROM images WHERE image_id=?',(failed['id'],));conn.commit()
        conn.close()

        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[dict(record,id='999000001',downloadUrl='https://evil.example/private.png')]},TOKEN)
        data=json.loads(raw);check(status==200 and data['accepted']==0 and data['skipped']==1,'unsafe image host is skipped')

        updated=dict(record,tags=['selfie','updated-tag','Café Étude','Portrait "Study"'],loras=['realismcatalogloraprobe Photo Portrait LoRA'],reactions={'likeCount':5,'heartCount':0},width=832,height=1216)
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[updated]},TOKEN)
        check(status==200 and json.loads(raw)['accepted']==1,'repeat scan updates catalog metadata idempotently')
        status,_,raw=request(BASE+'/api.php?action=search&q=updated-tag')
        data=json.loads(raw);check(data['total']==1 and data['items'][0]['downloadStatus']=='ready','metadata update preserves stored image')

        # Feed rescans often omit generation metadata. Empty fallbacks must not
        # delete previously captured prompts, tags, resources, or FTS entries.
        blank_rescan=dict(record,prompt='',negativePrompt='',tags=[],modelName='',loras=[])
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[blank_rescan]},TOKEN)
        check(status==200 and json.loads(raw).get('accepted')==1,'rescan with empty metadata is accepted')
        status,_,raw=request(BASE+'/api.php?'+urllib.parse.urlencode({'action':'search','q':'catalogprobeunique'}))
        data=json.loads(raw)
        check(status==200 and data['total']==1,'empty rescan preserves prompt FTS search')
        preserved=data['items'][0]
        check(all(preserved[field]==updated[field] for field in ('prompt','negativePrompt','tags','modelName','loras')),'empty rescan preserves all previously populated generation metadata')
        check(preserved['downloadStatus']=='ready','empty rescan preserves the stored image')
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[dict(blank_rescan,prompt=' \u00a0\t')]},TOKEN)
        check(status==200 and json.loads(raw)['accepted']==1 and json.loads(raw)['imageCopiesQueued']==0,'Unicode blank rescan retains an existing positive prompt and valid file')
        check(preserved['reactions']==updated['reactions'] and preserved['width']==832 and preserved['height']==1216,'empty rescan preserves captured reaction counts and dimensions')
        partial=dict(blank_rescan,reactions={'heartCount':2,'cryCount':-1},width=0,height=0)
        status,_,raw=request(BASE+'/api.php?action=images','POST',{'items':[partial]},TOKEN)
        check(status==200 and json.loads(raw).get('accepted')==1,'partial stats rescan accepted')
        status,_,raw=request(BASE+'/api.php?'+urllib.parse.urlencode({'action':'search','q':'catalogprobeunique'}))
        refreshed=json.loads(raw)['items'][0]
        check(refreshed['reactions']=={'likeCount':5,'heartCount':2} and refreshed['width']==832 and refreshed['height']==1216,'known reaction keys merge, invalid values rejected, and dimensions retained')
        status,_,raw=request(BASE+'/api.php?'+urllib.parse.urlencode({'action':'search','q':'realismcatalogloraprobe'}))
        data=json.loads(raw)
        check(status==200 and data['total']==1 and data['items'][0]['id']==record['id'],'empty rescan preserves resource FTS search')

        # Exact-tag filtering must compare decoded tag values; JSON escaping
        # and non-ASCII case variants should never make a known tag disappear.
        for tag in ('CAFÉ ÉTUDE','portrait "study"'):
            status,_,raw=request(BASE+'/api.php?'+urllib.parse.urlencode({'action':'search','tag':tag}))
            data=json.loads(raw)
            check(status==200 and data['total']==1 and data['items'][0]['id']==record['id'],'exact tag filter matches Unicode/quoted case variant: '+tag)
        for partial_tag in ('café','portrait'):
            status,_,raw=request(BASE+'/api.php?'+urllib.parse.urlencode({'action':'search','tag':partial_tag}))
            data=json.loads(raw)
            check(status==200 and data['total']==0,'exact tag filter rejects substring: '+partial_tag)

        print(f'PASS {checks} server integration checks; downloaded and served {len(content)} image bytes')
    finally:
        if server is not None:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        log.close()

if __name__=='__main__':
    try: run()
    except Exception as error:
        print(f'FAIL after {checks} checks: {error}',file=sys.stderr)
        raise
