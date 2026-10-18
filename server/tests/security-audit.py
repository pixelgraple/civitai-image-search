#!/usr/bin/env python3
"""Bounded tests on a disposable catalog and loopback PHP, never production data."""
import base64, concurrent.futures, http.client, json, os, pathlib, socket, sqlite3, subprocess, sys, tempfile, time, urllib.parse

APP=pathlib.Path(sys.argv[1]).resolve()
PHP='/www/server/php/84/bin/php'
REPORT=pathlib.Path(sys.argv[2])
results=[]
def check(category,name,ok,details=None):
    results.append({'category':category,'name':name,'passed':bool(ok),'details':details})
def php(code,env):
    p=subprocess.run([PHP],input=('<?php '+code).encode(),env=env,capture_output=True,timeout=30)
    if p.returncode: raise RuntimeError(p.stderr.decode()[-1500:])
    return p.stdout.decode()

with tempfile.TemporaryDirectory(prefix='civitai-security-') as directory:
    tmp=pathlib.Path(directory)
    (tmp/'database').mkdir(); (tmp/'media').mkdir()
    database=tmp/'database/catalog.sqlite'
    settings={'database_path':str(database),'storage_dir':str(tmp/'media'),'public_origin':'https://search-civitai.xyz',
              'public_ingest_enabled':True,'public_ingest_requests_per_minute':1200,'download_concurrency':32}
    (tmp/'settings.json').write_text(json.dumps(settings))
    config=tmp/'config.php'
    config.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);")
    env={**os.environ,'CIVITAI_LIBRARY_CONFIG':str(config)}
    bootstrap=f"require '{APP}/lib.php'; require '{APP}/search-guard.php'; "
    session=php(bootstrap+"db(); $_SERVER['REMOTE_ADDR']='127.0.0.1'; gate_open_session(true); $_SESSION['verifiedAt']=time(); $_SESSION['verifiedUntil']=time()+3600; echo session_id(); gate_release_session();",env).strip()
    cookie='__Host-civitai_access='+session
    guarddb=tmp/'database/access-gate.sqlite'
    with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
    log=(tmp/'server.log').open('wb')
    server=subprocess.Popen([PHP,'-d','display_errors=0','-d','log_errors=1','-S',f'127.0.0.1:{port}','-t',str(APP/'public')],env=env,stdout=log,stderr=log)
    def request(path='/api.php',params=None,method='GET',body=None,headers=None,verified=True,raw=None):
        if params: path+='?'+urllib.parse.urlencode(params,doseq=True)
        hdr={'Accept':'application/json', **({'Cookie':cookie} if verified else {}), **(headers or {})}
        payload=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if body is not None and 'Content-Type' not in hdr: hdr['Content-Type']='application/json'
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
        try:
            conn.request(method,path,body=payload,headers=hdr); r=conn.getresponse(); text=r.read().decode('utf-8','replace')
            try: data=json.loads(text)
            except ValueError: data=None
            return r.status,dict(r.getheaders()),data,text
        finally: conn.close()
    def reset_search():
        if guarddb.exists():
            with sqlite3.connect(guarddb) as conn:
                if conn.execute("SELECT 1 FROM sqlite_master WHERE name='search_clients'").fetchone(): conn.execute('DELETE FROM search_clients')
    def search(**params):
        reset_search(); return request(params={'action':'search',**params})
    def submit(items,headers=None): return request(params={'action':'images'},method='POST',body={'items':items},headers=headers)
    fixture={'id':'1001','downloadUrl':'https://image.civitai.com/security-fixture.jpg','prompt':'a mountain landscape fixture sentinel',
             'modelName':'Photo Model','creatorName':'original-creator','tags':['landscape'],'capturedPageUrl':'https://civitai.red/images/1001'}
    try:
        for _ in range(60):
            try:
                if request(params={'action':'health'})[0]==200: break
            except OSError: pass
            time.sleep(.1)
        check('baseline','healthy isolated fixture',submit([fixture])[0]==200)
        check('baseline','verified safe search',search(q='sentinel')[2]['total']==1)
        # A thumbnail fixture for path, method, MIME and rate accounting tests.
        png=tmp/'media/fixture.png'; png.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hJkAAAAASUVORK5CYII='))
        with sqlite3.connect(database) as conn: conn.execute("UPDATE images SET download_status='ready',file_path=?,mime_type='image/png' WHERE image_id='1001'",(str(png),))
        # SQL/FTS operators remain data, never broaden a query or execute SQL.
        sqls=["' OR 1=1--",'" OR "1"="1',"'; DROP TABLE images;--", "' UNION SELECT name FROM sqlite_master--",'1;SELECT sqlite_version()',
              'NULL OR TRUE',"')/**/OR/**/1=1--",'${7*7}','{{7*7}}','%27%20OR%201=1','"* OR prompt:*','NEAR(foo bar, 1)',
              'tags : (*)','{prompt tags} : *','NOT landscape','foo OR landscape','foo AND NOT bar','" OR tags:landscape OR "',
              '1 AND randomblob(1000000000)','0 UNION SELECT load_extension(\'/tmp/pwn\')','0;ATTACH DATABASE \'/tmp/pwn\' AS x','%','_','\\',
              '"','""','foo\x00bar','a'*1201,'a '*21,'漢字" OR 1=1','[x]','(((x)))','<script>alert(1)</script>','../../etc/passwd']
        for field in ['q','model','lora','creator','tag']:
            for n,payload in enumerate(sqls):
                r=search(**{field:payload})
                expected=(400 if ('\x00' in payload or len(payload)>({'tag':4000,'lora':200,'creator':200}.get(field,300)) or (field=='q' and len(payload.split())>20)) else 200)
                check('SQLi/FTS',f'{field}-{n}',r[0] in [200,400] and (r[0]!=200 or r[2]['total']==0),{'status':r[0]})
        for field in ['q','model','lora','creator','tag','qMode','tagMode','tagMatch','qScope','category','sort','page','limit','pg13','source','creatorMatch']:
            for n,payload in enumerate(['x','',"' OR 1=1--"]):
                r=search(**{field+'[]':payload})
                check('parameter types',f'{field}-array-{n}',r[0]==400,{'status':r[0]})
        for field,values in {'page':['-1','1e3','1.1','9999999','%00'],'limit':['-1','1e3','1.1','9999'],'sort':['random()','sleep(3)','newest;--'],'source':['com.evil','unknown;--'],'pg13':['false','yes','2'],'category':['<svg>','ALL'],'qMode':['OR','neither']}.items():
            for n,v in enumerate(values): check('enum/bounds',f'{field}-{n}',search(**{field:v})[0]==400)
        # XSS payloads saved as inert metadata; the DOM renderer is checked separately.
        xss=['<script>globalThis.auditXss=1</script>','<img src=x onerror=alert(1)>','\"><svg/onload=alert(1)>',"'><iframe srcdoc='<script>alert(1)</script>'>",
             'javascript:alert(1)','data:text/html,<script>alert(1)</script>','<math href="javascript:alert(1)">x</math>',
             '</textarea><script>alert(1)</script>','&lt;img onerror=alert(1)&gt;','<a href="//evil.invalid">x</a>',
             '" autofocus onfocus=alert(1) x="','<style>body{display:none}</style>','</script><script src=//evil.invalid/x.js>',
             '<svg><foreignObject onload=alert(1)>x</foreignObject></svg>','<object data="data:text/html,x"></object>',
             '<details open ontoggle=alert(1)>x</details>','{{constructor.constructor("alert(1)")()}}','<form action=//evil.invalid>']
        for n,payload in enumerate(xss):
            item={**fixture,'id':str(2000+n),'prompt':payload,'modelName':payload,'creatorName':payload,'tags':[payload],'loras':[payload]}
            r=submit([item]); check('stored XSS data',f'payload-{n}',r[0]==200 and r[2]['accepted']==1)
            with sqlite3.connect(database) as conn: stored=conn.execute('SELECT prompt FROM images WHERE image_id=?',(item['id'],)).fetchone()
            check('stored XSS data',f'preserved-as-text-{n}',stored and stored[0]==payload)
        # URL allowlist, protocol, credentials, IPv6, encoded addresses and path handling.
        bad_urls=['file:///etc/passwd','http://image.civitai.com/x','ftp://image.civitai.com/x','gopher://127.0.0.1:6379/_PING','https://127.0.0.1/x',
                  'https://[::1]/x','https://169.254.169.254/latest/meta-data/','https://2130706433/x','https://0177.0.0.1/x','https://0x7f000001/x',
                  'https://image.civitai.com.evil.invalid/x','https://image.civitai.com@evil.invalid/x','https://evil.invalid@image.civitai.com/x',
                  'https://image.civitai.com:443/x','https://image.civitai.com:22/x','https://image.civitai.com./x','https://image.civitai.com\\@127.0.0.1/x',
                  'https://image.civitai.com\r\nX-Test: x','//image.civitai.com/x','data:image/svg+xml,<svg/>','javascript:alert(1)',
                  'https://image%2ecivitai%2ecom/x','https://image.civitai.com%00.evil.invalid/x','https://image.civitai.com /x','https://image.civitai.com\tx',
                  'https://localhost/x','https://10.0.0.1/x','https://192.168.1.1/x','https://100.64.0.1/x','https://[fc00::1]/x']
        for n,url in enumerate(bad_urls):
            r=submit([{**fixture,'id':str(3000+n),'downloadUrl':url}])
            check('SSRF URL',f'url-{n}',r[0]==400 or (r[0]==200 and r[2]['accepted']==0),{'status':r[0]})
        # Batch shape and scalar types: no 500, warning leakage, or partial mutation.
        malformed=[[],None,False,1,{'name':'x'}]
        for field in ['prompt','negativePrompt','modelName','creatorName','downloadUrl','capturedPageUrl']:
            for n,value in enumerate(malformed):
                if value is None: continue
                r=submit([{**fixture,field:value}]); check('ingestion validation',f'{field}-{n}',r[0]==400,{'status':r[0]})
        for field in ['tags','loras']:
            for n,value in enumerate([False,'text',{'not':'a list'},[[1]],[{'name':[]}],[1],['x'*201],['x']*201]):
                r=submit([{**fixture,field:value}]); check('ingestion validation',f'{field}-{n}',r[0]==400,{'status':r[0]})
        for n,raw in enumerate([b'null',b'[]',b'false',b'42',b'"hi"',b'{bad',b'{"items":'+b'['*40+b']'*40+b'}',b' '*1048577]):
            r=request(params={'action':'images'},method='POST',raw=raw,headers={'Content-Type':'application/json'})
            check('JSON/bounds',f'body-{n}',r[0] in [400,413],{'status':r[0]})
        for origin in ['https://evil.invalid','https://search-civitai.xyz.evil.invalid','http://search-civitai.xyz','null','chrome-extension://evil']:
            r=submit([fixture],headers={'Origin':origin}); check('CORS/CSRF',origin,r[0]==403 and 'Access-Control-Allow-Origin' not in r[1])
        for ct in ['text/plain','application/x-www-form-urlencoded','multipart/form-data; boundary=audit','application/xml']:
            r=submit([fixture],headers={'Content-Type':ct}); check('CORS/CSRF',ct,r[0]==415)
        for origin in ['chrome-extension://'+'a'*32,'https://civitai.red','https://civitai.com']:
            r=submit([fixture],headers={'Origin':origin}); check('extension compatibility',origin,r[0]==200 and r[1].get('Access-Control-Allow-Origin')==origin)
        for action in ['search','health','images','check','source-reactions','download-settings','download-status','reactions']:
            for method in ['PUT','DELETE','TRACE','PATCH']:
                r=request(params={'action':action},method=method); check('HTTP methods',f'{action}-{method}',r[0]==405)
        for bad in ['../../etc/passwd','..%2f..%2fetc/passwd','1 OR 1=1','1\r\nX-Header:x','-1','0'*21,'<svg/onload=alert(1)>']:
            for key in ['id','variant','w']:
                r=request('/media.php',params={'id':'1001','variant':'thumb',key:bad}); check('media traversal/types',f'{key}-{bad}',r[0]==404)
        for key in ['id','variant','w']:
            r=request('/media.php',params={'id':'1001',key+'[]':'x'}); check('media traversal/types',f'{key}-array',r[0]==404)
        for method in ['POST','PUT','DELETE']:
            check('media methods',method,request('/media.php',params={'id':'1001'},method=method)[0]==405)
        for path,params in [('/api.php',{'action':'search'}),('/api.php',{'action':'reactions','id':'1001'}),('/media.php',{'id':'1001'})]:
            reset_search()
            for bogus in ['', '__Host-civitai_access='+'a'*32,'__Host-civitai_access=../../etc/passwd']:
                r=request(path,params=params,verified=False,headers={'Cookie':bogus})
                check('access control',path+str(params)+bogus[:20],r[0]==403 and r[2].get('code')=='captcha_required')
        # Cross-site read/CSRF checks, single-use challenges and private/no-store headers.
        r=request('/access.php',params={'action':'challenge'},verified=False)
        check('CAPTCHA','challenge issued',r[0]==200 and all(k in r[2] for k in ['challengeId','csrfToken','imageUrl']))
        challenge=r[2]; cap_cookie=r[1]['Set-Cookie'].split(';')[0]
        check('CAPTCHA','cookie flags',all(flag in r[1]['Set-Cookie'].lower() for flag in ['secure','httponly','samesite=lax']))
        for origin in ['https://evil.invalid','null','']:
            r=request('/access.php',params={'action':'verify'},method='POST',body={**challenge,'answer':'AAAAAA'},verified=False,headers={'Cookie':cap_cookie,'Origin':origin})
            check('CAPTCHA',f'origin-{origin}',r[0]==403)
        validbody={'challengeId':challenge['challengeId'],'csrfToken':challenge['csrfToken'],'answer':'AAAAAA'}
        r=request('/access.php',params={'action':'verify'},method='POST',body=validbody,verified=False,headers={'Cookie':cap_cookie,'Origin':'https://search-civitai.xyz'})
        check('CAPTCHA','incorrect consumes challenge',r[0]==400)
        r=request('/access.php',params={'action':'verify'},method='POST',body=validbody,verified=False,headers={'Cookie':cap_cookie,'Origin':'https://search-civitai.xyz'})
        check('CAPTCHA','challenge replay rejected',r[0]==400 and r[2].get('newChallenge')==True)
        # Existing metadata cannot be replaced by an anonymous rescan.
        changed={**fixture,'prompt':'overwrite injection','creatorName':'attacker','modelName':'evil model','downloadUrl':'https://image.civitai.com/other.jpg'}
        r=submit([changed])
        with sqlite3.connect(database) as conn: row=conn.execute("SELECT prompt,creator_name,model_name,source_url FROM images WHERE image_id='1001'").fetchone()
        check('metadata integrity','anonymous overwrite retained originals',r[0]==200 and row==(fixture['prompt'],fixture['creatorName'],fixture['modelName'],fixture['downloadUrl']))
        r=submit([{**fixture,'width':100000,'height':100000,'tags':['poisoned'],'loras':['poisoned']}])
        with sqlite3.connect(database) as conn:
            skip=conn.execute("SELECT COUNT(*) FROM image_collection_skips WHERE image_id='1001'").fetchone()[0]
            tags=json.loads(conn.execute("SELECT tags_json FROM images WHERE image_id='1001'").fetchone()[0])
        check('metadata integrity','oversized rescan cannot hide existing image',r[0]==200 and skip==0 and tags==fixture['tags'])
        r=submit([{**fixture,'id':'5002','width':100000,'height':100000}])
        with sqlite3.connect(database) as conn: skip=conn.execute("SELECT COUNT(*) FROM image_collection_skips WHERE image_id='5002'").fetchone()[0]
        check('metadata integrity','fake dimensions cannot preemptively blacklist an ID',r[0]==200 and r[2]['accepted']==0 and skip==0)
        for action,body in [
            ('check',{'imageIds':['1001','99999999999999'],'allowPartial':True}),
            ('download-settings',{'collectionToken':'a'*64,'concurrency':8}),
            ('source-reactions',{'items':[{'id':'1001','creatorName':'hijack','reactions':{'likeCount':123,'heartCount':22,'laughCount':2,'cryCount':1}}]})]:
            r=request(params={'action':action},method='POST',body=body)
            check('extension workflow',action,r[0]==200,{'status':r[0],'body':r[2]})
        with sqlite3.connect(database) as conn: row=conn.execute("SELECT creator_name,reactions_json FROM images WHERE image_id='1001'").fetchone()
        check('extension workflow','reaction updates retain creator',row[0]==fixture['creatorName'] and json.loads(row[1]).get('likeCount')==123)
        for action,key in [('check','imageIds'),('download-status','collectionTokens'),('source-reactions','items')]:
            for n,value in enumerate([None,False,1,'x',{},[],['x']*101]):
                r=request(params={'action':action},method='POST',body={key:value})
                check('batch validation',f'{action}-{n}',r[0]==400,{'status':r[0]})
        r=request(params={'action':'reactions','id':'1001'})
        check('reactions','verified visitor receives token',r[0]==200 and bool(r[2].get('csrfToken')))
        reactionCookie=r[1]['Set-Cookie'].split(';')[0]
        csrf=r[2]['csrfToken']; reactionHeaders={'Cookie':cookie+'; '+reactionCookie,'Origin':'https://search-civitai.xyz'}
        vote={'id':'1001','type':'upvote','active':True,'csrfToken':csrf}
        for n in range(2):
            r=request(params={'action':'reactions'},method='POST',body=vote,headers=reactionHeaders)
            check('reactions',f'idempotent upvote-{n}',r[0]==200 and r[2]['counts']['upvote']==1)
        for n,change in enumerate([{'csrfToken':'x'}, {'csrfToken':[]}, {'csrfToken':None}]):
            r=request(params={'action':'reactions'},method='POST',body={**vote,**change},headers=reactionHeaders)
            check('reactions',f'CSRF token-{n}',r[0]==403)
        for n,change in enumerate([{'id':[]},{'id':"1 OR 1=1"},{'type':'<script>'},{'active':'true'},{'active':[]} ]):
            r=request(params={'action':'reactions'},method='POST',body={**vote,**change},headers=reactionHeaders)
            check('reactions',f'invalid vote-{n}',r[0]==400)
        for n,change in enumerate([{'Origin':'https://evil.invalid'},{'Origin':''},{'Sec-Fetch-Site':'cross-site'}]):
            r=request(params={'action':'reactions'},method='POST',body=vote,headers={**reactionHeaders,**change})
            check('reactions',f'origin-{n}',r[0]==403)
        r=request(params={'action':'reactions'},method='POST',body={**vote,'active':False},headers=reactionHeaders)
        check('reactions','remove own vote',r[0]==200 and r[2]['counts']['upvote']==0)
        r=submit([{**fixture,'id':'5001','prompt':'explicit nude fixture','capturedPageUrl':'https://civitai.com/images/5001'}])
        check('PG13 provenance','claimed .com cannot bypass safe filter',search(q='explicit',source='com')[2]['total']==0)
        check('PG13 provenance','explicit opt-out still works',search(q='explicit',source='com',pg13='0')[2]['total']==1)
        with sqlite3.connect(database) as conn: conn.execute("UPDATE images SET prompt='nude fixture changed externally' WHERE image_id='1001'")
        with sqlite3.connect(database) as conn: row=conn.execute("SELECT 1 FROM image_pg13_safety_v2 WHERE image_id='1001'").fetchone()
        check('PG13 provenance','metadata mutation invalidates stale safe flag',row is None)
        # The search guard counts only API searches, shared across tabs/cookie resets.
        with sqlite3.connect(database) as conn: conn.execute("UPDATE images SET download_status='ready',file_path=?,mime_type='image/png' WHERE image_id='1001'",(str(png),))
        reset_search()
        for n in range(12): check('rate limit',f'allowed burst {n+1}',request(params={'action':'search','q':'nevermatch'})[0]==200)
        for n in range(80):
            r=request('/media.php',params={'id':'1001'})
            check('image exemption',f'image {n+1}',r[0]==200,{'status':r[0]})
        with sqlite3.connect(guarddb) as conn: hits=json.loads(conn.execute('SELECT hits FROM search_clients').fetchone()[0])
        check('image exemption','80 images consumed zero searches',len(hits)==12)
        r=request(params={'action':'search','q':'nevermatch'})
        check('rate limit','13th search blocks 600 seconds',r[0]==429 and 599<=r[2]['retryAfter']<=601 and r[1].get('Retry-After') is not None)
        until=r[2]['blockedUntil']
        for n,h in enumerate([{}, {'X-Forwarded-For':'1.1.1.1'}, {'CF-Connecting-IP':'8.8.8.8'}, {'X-Real-IP':'8.8.4.4'}, {'Cookie':'bogus=x'}, {'User-Agent':'different-client'}]):
            r=request(params={'action':'search'},verified=False,headers=h)
            check('rate limit',f'cookie/header bypass {n}',r[0]==429 and r[2]['blockedUntil']==until)
        r=request('/access.php',params={'action':'search-block','next':'https://evil.invalid/<script>'})
        check('block page','custom page 429/no reflection',r[0]==429 and 'Take a short search break' in r[3] and 'evil.invalid' not in r[3])
        check('block page','no-store and CSP', 'no-store' in r[1].get('Cache-Control','') and "frame-ancestors 'none'" in r[1].get('Content-Security-Policy',''))
        with sqlite3.connect(guarddb) as conn: conn.execute('UPDATE search_clients SET blocked_until=?,expires_at=?',(int(time.time())-1,int(time.time())-1))
        check('rate limit','expiry allows new search',request(params={'action':'search','q':'nevermatch'})[0]==200)
        # Pure-state tests cover sliding windows and precise expiry without a 10-minute sleep.
        statecode=bootstrap+"""
        $out=[]; $row=[];
        for($i=0;$i<60;$i++) $row=search_guard_state($row,1000+$i*0.99,true);
        $out['minute_allowed']=$row['blocked_until']===0;
        $row=search_guard_state($row,1059.5,true); $out['minute_blocked']=$row['blocked_until']===1660;
        $out['not_extended']=search_guard_state($row,1200,true)['blocked_until']===1660;
        $out['expiry']=search_guard_state($row,1660,true)['blocked_until']===0;
        $row=[]; for($i=0;$i<12;$i++) $row=search_guard_state($row,1000,true);
        $out['boundary']=search_guard_state($row,1010,true)['blocked_until']===0;
        echo json_encode($out);
        """
        for name,value in json.loads(php(statecode,env)).items(): check('rate clock',name,value)
        reset_search()
        command=[PHP,'-r',f"require '{APP}/lib.php'; require '{APP}/search-guard.php'; $_SERVER['REMOTE_ADDR']='192.0.2.77'; echo search_guard_check(true); "]
        def quota_process(_):
            p=subprocess.run(command,env=env,capture_output=True,timeout=15)
            return p.returncode,p.stdout.decode().strip()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: decisions=list(pool.map(quota_process,range(20)))
        check('rate concurrency','atomic across processes',sum(code==0 and text=='0' for code,text in decisions)==12 and all(code==0 for code,text in decisions),decisions)
        # DNS validation uses synthetic addresses, never contacts private networks.
        ipcases=['127.0.0.1','10.1.2.3','192.168.1.1','172.16.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','255.255.255.255','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']
        netcode=bootstrap+f"require '{APP}/image-network.php'; $out=[]; $ips=json_decode(base64_decode('{base64.b64encode(json.dumps(ipcases).encode()).decode()}'),true); foreach($ips as $ip){{ try{{image_public_addresses([['ip'=>$ip]]);$out[$ip]=false;}}catch(Throwable $e){{$out[$ip]=true;}}}} echo json_encode($out);"
        for name,value in json.loads(php(netcode,env)).items(): check('DNS SSRF',name,value)
        netcode=bootstrap+f"require '{APP}/image-network.php'; echo json_encode(image_public_addresses([['ip'=>'1.1.1.1'],['ipv6'=>'2606:4700:4700::1111']]));"
        check('DNS SSRF','global addresses accepted',len(json.loads(php(netcode,env)))==2)
        with sqlite3.connect(database) as conn: check('catalog integrity','database remains valid',conn.execute('PRAGMA quick_check').fetchone()[0]=='ok')
    finally:
        server.terminate(); server.wait(timeout=10); log.close()
        logtext=(tmp/'server.log').read_text()
        errors=[line for line in logtext.splitlines() if any(s in line for s in ['PHP Warning','PHP Fatal','Uncaught','Civitai library API error'])]
        check('error handling','no PHP warnings or internal errors',not errors,errors[:10])
        REPORT.write_text(json.dumps({'total':len(results),'passed':sum(r['passed'] for r in results),'failed':[r for r in results if not r['passed']],'checks':results},indent=2))
        print(json.dumps({'total':len(results),'passed':sum(r['passed'] for r in results),'failed':[r for r in results if not r['passed']]},indent=2))
        if any(not r['passed'] for r in results): sys.exit(1)
