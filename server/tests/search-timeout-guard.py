#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import json
spec=importlib.util.spec_from_file_location('guard',Path(__file__).resolve().parents[1]/'ops/search-timeout.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
checks=0
def check(value):
    global checks
    assert value;checks+=1
for args in [['grep','-RIn','term','/data'],['grep','--recursive','term','.'],['grep','--dereference-recursive','x','.']]:
    check(guard.search_arguments('/usr/bin/grep',args))
for args in [['grep','term'],['grep','--','-R'],['grep','-n','term']]:check(not guard.search_arguments('/usr/bin/grep',args))
check(guard.search_arguments('/usr/bin/rg',['rg','term','.']))
check(not guard.search_arguments('/usr/bin/php',['grep','-R','.']))
rows={10:{'pid':10,'parent':9,'name':'grep'},9:{'pid':9,'parent':8,'name':'bash'},8:{'pid':8,'parent':1,'name':'sshd'}}
guard.process=lambda pid:rows.get(pid)
check(guard.from_ssh(rows[10]))
rows[8]['name']='systemd';check(not guard.from_ssh(rows[10]))
rows[8]['parent']=10;check(not guard.from_ssh(rows[10]))
print(json.dumps({'ok':True,'checks':checks,'productionTouched':False}))
