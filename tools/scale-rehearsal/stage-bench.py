#!/usr/bin/env python3
"""A/B of the assignment write path, one client, two protocols — STREAMING, so it
   runs at 41M rows in constant memory (one 10k buffer per system).
   stage-bench.py <Assignments.csv> <protocol: batches|stage> <label>
 batches: today's streamed full sync — 10k-row delta batches per system, then
          POST /ingest/reconcile per system (rows not touched since the start go).
 stage:   one stage per system, 10k-row appends, one grouped finalize (deleteMissing).
Systems are looked up once by name (min id) — they are the same rows on every run."""
import csv, json, subprocess, sys, time, urllib.request

API = 'http://localhost:3005/api'
KEY = subprocess.check_output(['docker', 'exec', 'scale-test-web-1', 'cat', '/data/uploads/.builtin-worker-key']).decode().strip()
SCOPE = {'assignmentType': 'Direct'}
PREFIX = 'CSV-resource-assignments'
BATCH = 10000

def call(method, path, body=None, timeout=7200):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        t = r.read()
        return json.loads(t) if t else None

def systems():
    out = subprocess.check_output(['docker', 'exec', 'scale-test-postgres-1', 'psql', '-U', 'identity_atlas', '-d',
        'identity_atlas', '-AtF', '\t', '-c', 'select "displayName", min(id) from "Systems" group by 1']).decode()
    return {l.split('\t')[0]: int(l.split('\t')[1]) for l in out.strip().split('\n') if l}

def stream(path, send):
    """Read the file once; call send(systemName, batch) whenever a system's buffer fills."""
    buf, n = {}, 0
    with open(path, encoding='utf-8-sig') as f:
        for r in csv.DictReader(f, delimiter='\t'):
            b = buf.setdefault(r['SystemName'], [])
            b.append({'resourceExternalId': r['ResourceExternalId'], 'principalExternalId': r['UserExternalId'], 'assignmentType': 'Direct'})
            n += 1
            if len(b) >= BATCH:
                send(r['SystemName'], b)
                buf[r['SystemName']] = []
    for name, b in buf.items():
        if b: send(name, b)
    return n, list(buf.keys())

def run_batches(path, sysmap):
    before = call('GET', '/crawlers/whoami').get('serverTime')
    def send(name, b):
        call('POST', '/ingest/resource-assignments', {'systemId': sysmap[name], 'syncMode': 'delta', 'scope': SCOPE,
             'idGeneration': 'deterministic', 'idPrefix': PREFIX, 'records': b})
    n, names = stream(path, send)
    t = time.time(); removed = 0
    for name in names:
        r = call('POST', '/ingest/reconcile', {'entity': 'resource-assignments', 'systemId': sysmap[name], 'scope': SCOPE, 'before': before})
        removed += (r or {}).get('deleted', 0)
    return n, {'removed': removed, 'reconcileSeconds': round(time.time() - t, 1)}

def run_stage(path, sysmap):
    stages = {}
    def send(name, b):
        if name not in stages:
            stages[name] = call('POST', '/ingest/stages', {'entity': 'resource-assignments', 'systemId': sysmap[name], 'scope': SCOPE,
                                'idGeneration': 'deterministic', 'idPrefix': PREFIX})['stageId']
        call('POST', f'/ingest/stages/{stages[name]}/rows', {'records': b})
    n, _ = stream(path, send)
    t = time.time()
    res = call('POST', '/ingest/stages/finalize', {'stageIds': list(stages.values()), 'deleteMissing': True})['results']
    paths, tot = {}, {'inserted': 0, 'updated': 0, 'deleted': 0}
    for r in res:
        paths[r['path']] = paths.get(r['path'], 0) + 1
        for k in tot: tot[k] += r[k]
    return n, {'paths': paths, **tot, 'finalizeSeconds': round(time.time() - t, 1)}

if __name__ == '__main__':
    path, proto, label = sys.argv[1:4]
    sysmap = systems()
    t0 = time.time()
    n, res = run_batches(path, sysmap) if proto == 'batches' else run_stage(path, sysmap)
    print(json.dumps({'label': label, 'protocol': proto, 'rows': n, 'seconds': round(time.time() - t0, 1), **res}), flush=True)
