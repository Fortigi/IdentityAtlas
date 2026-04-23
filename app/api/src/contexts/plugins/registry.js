// Static plugin registry. Each entry is a module that default-exports a
// ContextPlugin (see types.js).
//
// Adding a plugin: drop a new file in this directory, import it here, and
// add it to the array. seedAlgorithms.js will sync the registry into the
// ContextAlgorithms table at container startup so the UI picker is aware
// of new plugins without manual DB writes.

import managerHierarchy    from './manager-hierarchy.js';
import adOuFromDn          from './ad-ou-from-dn.js';
import { plugin as resourceCluster } from './resource-cluster/index.js';

/** @type {import('./types.js').ContextPlugin[]} */
export const REGISTERED_PLUGINS = [
  managerHierarchy,
  adOuFromDn,
  resourceCluster,
];

export function getPlugin(name) {
  return REGISTERED_PLUGINS.find(p => p.name === name) || null;
}
