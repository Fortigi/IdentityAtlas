// Resolve which release channel this deployment is on, so the update check
// compares against the right "newest version".
//
// Preferred signal: the IMAGE_TAG env var (the same value docker-compose uses to
// pick the image — `edge` / `beta` / `latest`, or a pinned `5.2.1.0`). The compose
// file passes it into the container. When it's absent (older compose, Azure, a
// local run), fall back to inferring the channel from the running version string.

import { resolveModuleVersion } from '../version.js';

const CHANNELS = new Set(['edge', 'beta', 'latest']);
const PINNED_RE = /^\d+\.\d+\.\d+\.\d+$/; // a fully-pinned image tag, e.g. 5.2.1.0

export function resolveChannel(env = process.env, read) {
  const tag = (env.IMAGE_TAG || '').trim().toLowerCase();
  if (CHANNELS.has(tag)) return tag;
  if (tag && PINNED_RE.test(tag)) return 'pinned'; // pinned deployments don't auto-jump
  return inferChannelFromVersion(resolveModuleVersion(env, read));
}

// Best-effort channel from the MODULE_VERSION baked into the image:
//   5.3.0-beta.2        → beta
//   5.310.20260629.1221 → edge   (3rd segment is an 8-digit yyyyMMdd date)
//   5.2.1.0             → latest (a normal release)
export function inferChannelFromVersion(version) {
  if (typeof version !== 'string' || !version) return 'latest';
  if (version.includes('-beta.')) return 'beta';
  const seg = version.split('.');
  if (seg.length === 4 && /^\d{8}$/.test(seg[2])) return 'edge';
  return 'latest';
}

export function getCurrentVersion(env = process.env, read) {
  return resolveModuleVersion(env, read);
}
