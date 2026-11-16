import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildTaxonomy } from './queree-taxonomy.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import process from 'node:process';
import { tmpdir } from 'node:os';

export function checkGenerated(root) {
    const work = mkdtempSync(join(tmpdir(), 'queree-generated-check-'));
    const run = (tool, args) => execFileSync(process.execPath,
        [ '--max-old-space-size=512', `tools/${tool}`, ...args ], { cwd: root, stdio: 'inherit' });
    const compare = (actual, expected) => {
        if ( readFileSync(actual).equals(readFileSync(join(root, expected))) === false ) {
            throw new Error(`Stale generated file: ${expected}; regenerate and commit it`);
        }
    };
    try {
        run('make-queree-website-domains.mjs', []);
        run('make-queree-website-lists.mjs', [
            'assets/queree/website-lists/provenance.json', join(work, 'website-lists.js'),
        ]);
        compare(join(work, 'website-lists.js'), 'src/js/queree/vendor/website-lists.js');
        run('make-queree-domain-index.mjs', [ join(work, 'domain-index.bin'), join(work, 'domain-index-data.js') ]);
        compare(join(work, 'domain-index.bin'), 'src/assets/queree/domain-index.bin');
        compare(join(work, 'domain-index-data.js'), 'src/js/queree/vendor/domain-index-data.js');
        const dependencies = existsSync(join(root, 'third_party_sources'))
            ? 'third_party_sources' : 'dist/build/queree-release-sources';
        run('make-queree-commerce-fingerprints.mjs', [
            `${dependencies}/opentechalyzer`, `${dependencies}/webappanalyzer`, join(work, 'commerce-fingerprints.js'),
        ]);
        for ( const name of [ 'commerce-fingerprints.js', 'commerce-signals.js' ] ) {
            compare(join(work, name), `src/js/queree/vendor/${name}`);
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

// Compare classification inputs, not unrelated extension commits. The manifest
// can name an older commit only when its classification inputs still match.
export async function checkServerTaxonomy(root, manifestPath, databasePath) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if ( /^[a-f0-9]{40}$/.test(manifest.source_commit || '') === false ) {
        throw new Error('Server taxonomy manifest lacks a valid source_commit');
    }
    const paths = [
        'tools/make-queree-source-taxonomy.mjs', 'tools/queree-source-groups.mjs',
        'tools/queree-taxonomy.mjs', 'tools/queree-ownership-sources.mjs',
        'tools/queree-adult-sources.mjs', 'tools/queree-release-sources.lock',
        'tools/vendor/wikidata-broad-domains.js',
        'src/lib/publicsuffixlist/publicsuffixlist.js', 'src/js/queree/nonexclusive-hosts.js',
        'src/js/queree/community-domains.js', 'src/js/queree/restricted-namespaces.js',
        'assets/queree/adult-lists',
        'tools/vendor/reviewed-domains/reviewed.tsv',
        ...[ 'adult', 'commercial', 'corporate', 'institutional', 'public-interest' ]
            .map(name => `src/js/queree/vendor/${name}-domains.js`),
        'src/js/queree/vendor/website-lists.js',
    ];
    const changed = execFileSync('git', [ 'diff', '--name-only', manifest.source_commit, '--', ...paths ],
        { cwd: root, encoding: 'utf8' }).trim();
    if ( changed ) { throw new Error(`Server taxonomy needs a matching export:\n${changed}`); }
    const artifact = readFileSync(databasePath);
    if ( manifest.sha256 !== createHash('sha256').update(artifact).digest('hex') ||
        manifest.byte_length !== artifact.length ) {
        throw new Error('Server taxonomy database hash/length differs from manifest');
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM metadata').all()
            .map(({ key, value }) => [ key, value ]));
        for ( const key of [ 'schema', 'revision', 'source_commit', 'precedence', 'sources', 'source_boundaries' ] ) {
            const value = [ 'schema', 'precedence', 'sources', 'source_boundaries' ].includes(key)
                ? JSON.parse(metadata[key]) : metadata[key];
            if ( isDeepStrictEqual(value, manifest[key]) === false ) {
                throw new Error(`Server taxonomy metadata differs: ${key}`);
            }
        }
        if ( manifest.schema !== 1 ) { throw new Error('Unsupported server taxonomy schema'); }
        const digest = createHash('sha256').update(JSON.stringify({
            schema: 1, precedence: manifest.precedence, sources: manifest.sources,
            source_boundaries: manifest.source_boundaries,
        }));
        let count = 0;
        for ( const { category, domain } of database.prepare(
            'SELECT category, domain FROM source_domain ORDER BY category, domain'
        ).iterate() ) {
            digest.update(`\n${category}\0${domain}`);
            count++;
        }
        if ( count !== manifest.row_count || manifest.revision !== `sha256:${digest.digest('hex')}` ) {
            throw new Error('Server taxonomy rows differ from manifest');
        }
    } finally {
        database.close();
    }
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { taxonomyGroups } = await load('tools/queree-source-groups.mjs');
    const boundaries = await load('src/js/queree/nonexclusive-hosts.js');
    const ownership = await load('tools/queree-ownership-sources.mjs');
    const expected = buildTaxonomy(taxonomyGroups, { ...boundaries, ...ownership });
    if ( manifest.revision !== expected.revision ) {
        throw new Error('Server taxonomy needs a matching export: logical revision differs');
    }
}

if ( process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ) {
    const root = resolve(import.meta.dirname, '..');
    if ( process.argv[2] === '--server-taxonomy' ) {
        if ( !process.argv[3] || !process.argv[4] ) { throw new Error('Supply the matching server taxonomy JSON manifest and SQLite database'); }
        await checkServerTaxonomy(root, process.argv[3], process.argv[4]);
    } else {
        checkGenerated(root);
    }
}
