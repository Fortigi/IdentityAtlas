// How IdentityIQ writes things down: its ids, its timestamps, its XML.
// Pure functions of (seed, kind, index) so any row can be re-derived without
// having kept it.

import { fmix32, hashLabel } from '../../scale-dataset/lib/random.mjs';

// The 4-hex "high time" field of an id, fixed per kind. Distinct per kind, so
// two kinds can never produce the same id.
const KIND_CODES = Object.freeze({
  application: 0x01a1, identity: 0x01a2, custom: 0x01a3, entitlement: 0x01a4,
  bundle: 0x01a5, profile: 0x01a6, relation: 0x01a7, grant: 0x01a8,
});

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const hex4 = (n) => (n & 0xffff).toString(16).padStart(4, '0');

// Per-(seed, kind) constants, computed once.
export function idSpace(seed, kind) {
  const code = KIND_CODES[kind];
  if (code === undefined) throw new Error(`Unknown id kind '${kind}'`);
  const key = fmix32((seed >>> 0) ^ hashLabel(`iiq-id:${kind}`));
  // Two application servers, as a clustered deployment has: ids share long
  // prefixes (server address + JVM start), which is what real ids look like.
  const servers = [0, 1].map(s => {
    const ip = (0x0a000000 | (fmix32((seed >>> 0) ^ hashLabel(`iiq-ip:${s}`)) & 0x00ffffff)) >>> 0;
    const jvm = fmix32((seed >>> 0) ^ hashLabel(`iiq-jvm:${s}`));
    return hex8(ip) + hex8(jvm);
  });
  return { code: hex4(code), key, servers };
}

// A 32-character lowercase hex id in Hibernate's UUIDHexGenerator layout:
// address(8) jvm(8) hi-time(4) lo-time(8) counter(4). The lo-time field is a
// bijection of the index, so ids are unique within a kind for any index < 2^32;
// the counter is the index's low 16 bits, incrementing as Hibernate's does.
export function iiqId(space, index) {
  const lo = fmix32((index ^ space.key) >>> 0);
  return space.servers[lo & 1] + space.code + hex8(lo) + hex4(index);
}

const DAY_MS = 86400000;

// created / modified in epoch milliseconds, like IdentityIQ's numeric(19,0)
// columns: created somewhere in the last `historyDays`, modified between it and
// asOf.
export function timestamps(seed, kind, index, asOf, historyDays) {
  const h = fmix32((index ^ hashLabel(`iiq-ts:${kind}`) ^ seed) >>> 0);
  const created = asOf - Math.floor((h / 4294967296) * historyDays * DAY_MS);
  const modified = created + Math.floor((fmix32(h) / 4294967296) * (asOf - created));
  return { created, modified };
}

export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// An IdentityIQ attribute map as the product serialises it into a column:
// <Attributes><Map><entry key=".." value=".."/>…, indented over several lines.
// Entries whose value is null are left out.
export function attributesXml(entries) {
  const lines = ['<Attributes>', '  <Map>'];
  for (const [k, v] of entries) {
    if (v === null || v === undefined) continue;
    lines.push(`    <entry key="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`);
  }
  lines.push('  </Map>', '</Attributes>');
  return lines.join('\n');
}

// The catalogue record: a map keyed by application name whose values are maps.
export function catalogXml(apps) {
  const lines = ['<Attributes>', '  <Map>'];
  for (const { name, fields } of apps) {
    lines.push(`    <entry key="${xmlEscape(name)}">`, '      <value>', '        <Map>');
    for (const [k, v] of fields) {
      if (v === null || v === undefined) continue;
      lines.push(`          <entry key="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`);
    }
    lines.push('        </Map>', '      </value>', '    </entry>');
  }
  lines.push('  </Map>', '</Attributes>');
  return lines.join('\n');
}
