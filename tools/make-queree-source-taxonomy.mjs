#!/usr/bin/env node

/* globals process */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const output = resolve(process.argv[2] || 'dist/queree-source-taxonomy.sqlite3');
const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', [ '-C', root, ...args ], { encoding: 'utf8' }).trim();
const sourceCommit = git('rev-parse', 'HEAD');
if ( git('status', '--porcelain') ) {
    throw new Error('Refusing to generate taxonomy from a dirty worktree');
}
const { buildTaxonomy, writeTaxonomy } = await import('./queree-taxonomy.mjs');
const { nonExclusiveHostSuffixes, nonExclusiveHosts } = await import('../src/js/queree/nonexclusive-hosts.js');
const { ownershipCategories, ownershipHostnameKind } = await import('./queree-ownership-sources.mjs');
const { taxonomyGroups } = await import('./queree-source-groups.mjs');
const taxonomy = buildTaxonomy(taxonomyGroups, {
    nonExclusiveHosts, nonExclusiveHostSuffixes, ownershipCategories, ownershipHostnameKind,
});
if ( git('rev-parse', 'HEAD') !== sourceCommit || git('status', '--porcelain') ) {
    throw new Error('Checkout changed during taxonomy generation');
}
await writeTaxonomy(output, taxonomy, sourceCommit);
console.log(`Wrote ${taxonomy.rows.length} domains to ${output}`);
