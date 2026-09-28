#!/usr/bin/env python3
"""Tail a crawler job's log via the API, stamping every line with its arrival epoch.
   logtail.py <api> <jobId> <outfile>  — runs until the job leaves queued/running."""
import json, sys, time, urllib.request


def get(api, path):
    with urllib.request.urlopen(f"{api}{path}", timeout=60) as r:
        return json.load(r)


class Tail:
    """Reads the job log from a byte offset and writes complete lines, stamped."""

    def __init__(self, api, jid, f):
        self.api, self.jid, self.f = api, jid, f
        self.off, self.partial = 0, ''

    def write_lines(self, text):
        now = int(time.time())
        lines = (self.partial + text).split('\n')
        self.partial = lines.pop()
        for line in lines:
            self.f.write(f"{now}\t{line}\n")
        self.f.flush()
        self.off += len(text.encode('utf-8'))

    def drain(self):
        """Read until the API says there is nothing more right now."""
        while True:
            d = get(self.api, f"/admin/crawler-jobs/{self.jid}/log?offset={self.off}")
            text = d.get('text') or ''
            if text:
                self.write_lines(text)
            if not d.get('truncated'):
                return

    def finish(self):
        if self.partial:
            self.f.write(f"{int(time.time())}\t{self.partial}\n")


def main(api, jid, out):
    with open(out, 'a') as f:
        tail = Tail(api, jid, f)
        while True:
            status = get(api, f"/admin/crawler-jobs/{jid}").get('status')
            tail.drain()
            if status not in ('queued', 'running'):
                tail.finish()
                return
            time.sleep(5)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
