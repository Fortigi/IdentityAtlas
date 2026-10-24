// Guard: every compose file gives PostgreSQL more shared memory than Docker's
// 64 MB default.
//
// Parallel query and parallel VACUUM pass data between workers through /dev/shm.
// At 64 MB a parallel VACUUM on a 41M-assignment database failed outright with
// "could not resize shared memory segment ... No space left on device", and a
// parallel hash join can hit the same wall. Nothing about a small install shows
// it, so a compose file that loses the setting would pass every other test.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.ci.yml'];

// The body of the top-level `postgres:` service: its indented lines up to the
// next service at the same depth.
function postgresService(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l === '  postgres:');
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function toBytes(value) {
  const m = /^(\d+)(b|k|kb|m|mb|g|gb)?$/i.exec(value);
  if (!m) return NaN;
  const unit = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase()];
  return Number(m[1]) * unit;
}

describe('compose files — PostgreSQL shared memory', () => {
  it.each(COMPOSE_FILES)('%s sets shm_size of at least 1 GB on the postgres service', (file) => {
    const service = postgresService(readFileSync(join(REPO, file), 'utf8'));
    expect(service, `${file} has no top-level postgres service`).not.toBeNull();
    const m = /^ {4}shm_size:\s*(\S+)\s*$/m.exec(service);
    expect(m, `${file}: postgres runs with Docker's 64 MB /dev/shm`).not.toBeNull();
    expect(toBytes(m[1])).toBeGreaterThanOrEqual(1024 ** 3);
  });

  it('reads sizes the way compose writes them', () => {
    expect(toBytes('1gb')).toBe(1024 ** 3);
    expect(toBytes('512m')).toBe(512 * 1024 ** 2);
    expect(toBytes('64M')).toBe(64 * 1024 ** 2);
    expect(toBytes('lots')).toBeNaN();
  });
});
