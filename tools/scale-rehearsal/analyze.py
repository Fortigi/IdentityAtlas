#!/usr/bin/env python3
"""Per-phase table from a run dir: job-timed.log (arrival-stamped) + samples.tsv.
   analyze.py <run-dir> <dataset-dir>"""
import json, re, sys, datetime

PHASES = [  # (name, start marker, rows key)
    ('systems', 'Step 1: Systems', 'Systems.csv'),
    ('contexts', 'Step 2: Contexts', 'Contexts.csv'),
    ('context members', 'ContextMembers.csv:', 'ContextMembers.csv'),
    ('resources', 'Step 3: Resources', 'Resources.csv'),
    ('relationships', 'Step 4: Resource relationships', None),
    ('users', 'Step 5: Users', 'Users.csv'),
    ('assignments', 'Step 6: Assignments', 'Assignments.csv'),
    ('identities/members/certs', 'Step 7: Identities', None),
    ('classify + refresh views', 'Auto-classifying BusinessRole', None),
    ('post-sync hooks', '=== CSV Sync Complete', None),
    ('end', 'Job result', None),
]
UNITS_MIB = {'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024, 'B': 1 / 1048576}


def stamp(ep, text):
    """Prefer the crawler's own [HH:MM:SS] stamp (1 s) over arrival time (5 s poll)."""
    m = re.search(r'\[(\d\d):(\d\d):(\d\d)\]', text)
    if not m:
        return ep
    a = datetime.datetime.fromtimestamp(ep, datetime.timezone.utc)
    t = a.replace(hour=int(m[1]), minute=int(m[2]), second=int(m[3]))
    if t.timestamp() > ep + 60:
        t -= datetime.timedelta(days=1)
    return int(t.timestamp())


def mib(s):
    m = re.match(r'([\d.]+)(\w+)', s or '')
    return float(m[1]) * UNITS_MIB.get(m[2], 1) if m else 0


def read_log(run):
    out = []
    for raw in open(f"{run}/job-timed.log"):
        ep, _, text = raw.rstrip('\n').partition('\t')
        out.append((int(ep), text))
    return out


def phase_starts(lines):
    starts = []
    for name, marker, key in PHASES:
        hit = next((stamp(ep, t) for ep, t in lines if marker in t), None)
        if hit is not None:
            starts.append((name, hit, key))
    return starts


def job_end(run):
    timeline = [l.split() for l in open(f"{run}/timeline.txt")]
    return int(next(t[0] for t in timeline if t[1] == 'job-end'))


def parse_sample(line):
    c = line.rstrip('\n').split('\t')
    try:
        return (int(c[0]), int(c[1]), int(c[6] or 0), int(c[7] or 0), c[3], c[4], c[5])
    except (ValueError, IndexError):
        return None


def read_samples(run):
    with open(f"{run}/samples.tsv") as f:
        next(f)
        return [s for s in (parse_sample(l) for l in f) if s]


def window(samples, s, e):
    return [x for x in samples if s <= x[0] <= e + 5] or [min(samples, key=lambda x: abs(x[0] - s))]


def phase_row(name, s, e, key, rows, samples):
    win = window(samples, s, e)
    wall = max(e - s, 0)
    n = rows.get(key) if key else None
    rps = f"{n / wall:9.0f}" if n and wall else f"{'':>9}"
    return (f"{name:28} {wall:8d} {n if n else '':>12} {rps} {max(x[1] for x in win):8d} "
            f"{max(mib(x[5]) for x in win):7.0f} {max(mib(x[6]) for x in win):7.0f} "
            f"{max(x[2] for x in win) / 1e9:7.2f} {max(x[3] for x in win) / 1e9:8.2f}")


def main(run, data):
    man = json.load(open(f"{data}/manifest.json"))
    rows = {f['file']: f['rows'] for f in man['files']}
    starts = phase_starts(read_log(run))
    end = job_end(run)
    samples = read_samples(run)
    print(f"{'phase':28} {'wall s':>8} {'rows':>12} {'rows/s':>9} {'pwsh MB':>8} {'web MB':>7} {'pg MB':>7} {'db GB':>7} {'disk GB':>8}")
    for i, (name, s, key) in enumerate(starts):
        if name == 'end':
            break
        e = starts[i + 1][1] if i + 1 < len(starts) else end
        print(phase_row(name, s, e, key, rows, samples))
    total = end - starts[0][1]
    print(f"{'TOTAL (job)':28} {total:8d}   peak pwsh {max(x[1] for x in samples)} MB, "
          f"peak db {max(x[2] for x in samples) / 1e9:.2f} GB, disk used "
          f"{min(x[3] for x in samples) / 1e9:.1f}→{max(x[3] for x in samples) / 1e9:.1f} GB")


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
