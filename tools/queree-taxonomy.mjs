import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { withStagedOutputs } from './queree-generated-files.mjs';

const precedence = [
    'community_contribution',
    'government_education',
    'commercial_corporate',
    'professional_publication',
    'public_interest_organization',
];

export function buildTaxonomy(groups, { nonExclusiveHosts, nonExclusiveHostSuffixes, ownershipCategories, ownershipHostnameKind }) {
    const rows = [];
    const sources = {};
    const exactHosts = new Set(nonExclusiveHosts);

    // Safety and shopping lists are separate from publisher-category precedence.
    for ( const [ category, categorySources ] of Object.entries(groups) ) {
        const seen = new Set();
        sources[category] = categorySources.map(source => {
            for ( const domain of source.domains ) {
                const normalized = domain.toLowerCase().replace(/\.$/, '');
                if ( ownershipCategories.has(category) || category === 'shopping_domain' ) {
                    const kind = ownershipHostnameKind(normalized);
                    if ( kind === undefined && ownershipCategories.has(category) ) {
                        throw new Error(`Invalid ownership domain ${domain} from ${source.name}`);
                    }
                    if ( kind === 'exact' ) { exactHosts.add(normalized); }
                }
                if ( seen.has(normalized) ) { continue; }
                seen.add(normalized);
                rows.push([ category, normalized ]);
            }
            const { domains, items_by_domain, ...metadata } = source;
            void domains;
            void items_by_domain;
            return metadata;
        });
    }
    rows.sort((a, b) => {
        if ( a[0] !== b[0] ) { return a[0] < b[0] ? -1 : 1; }
        return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    });
    const sourceBoundaries = {
        nonexclusive_hosts: Array.from(exactHosts).sort(),
        nonexclusive_host_suffixes: [ ...nonExclusiveHostSuffixes ].sort(),
    };
    const logicalDigest = createHash('sha256');
    logicalDigest.update(JSON.stringify({ schema: 1, precedence, sources, source_boundaries: sourceBoundaries }));
    for ( const row of rows ) {
        logicalDigest.update(`\n${row[0]}\0${row[1]}`);
    }
    const revision = `sha256:${logicalDigest.digest('hex')}`;

    return { rows, revision, precedence, sources, sourceBoundaries };
}

export async function writeTaxonomy(output, { rows, revision, precedence, sources, sourceBoundaries }, sourceCommit) {
    const manifestPath = `${output}.json`;
    mkdirSync(dirname(output), { recursive: true });
    await withStagedOutputs([ output, manifestPath ], ([ databasePath, jsonPath ]) => {
        const database = new DatabaseSync(databasePath);
        try {
            database.exec(`
                PRAGMA journal_mode = OFF;
                PRAGMA synchronous = OFF;
                PRAGMA temp_store = MEMORY;
                CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                ) WITHOUT ROWID;
                CREATE TABLE source_domain (
                    category TEXT NOT NULL,
                    domain TEXT NOT NULL,
                    PRIMARY KEY (domain, category)
                ) WITHOUT ROWID;
            `);
            const insertMetadata = database.prepare(
                'INSERT INTO metadata(key, value) VALUES (?, ?)'
            );
            insertMetadata.run('schema', '1');
            insertMetadata.run('revision', revision);
            insertMetadata.run('source_commit', sourceCommit);
            insertMetadata.run('precedence', JSON.stringify(precedence));
            insertMetadata.run('sources', JSON.stringify(sources));
            insertMetadata.run('source_boundaries', JSON.stringify(sourceBoundaries));
            const insertDomain = database.prepare(
                'INSERT INTO source_domain(category, domain) VALUES (?, ?)'
            );
            database.exec('BEGIN');
            for ( const row of rows ) {
                insertDomain.run(...row);
            }
            database.exec('COMMIT; VACUUM;');
            if ( database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ) {
                throw new Error('Generated taxonomy failed SQLite integrity_check');
            }
        } finally {
            database.close();
        }

        const artifact = readFileSync(databasePath);
        const manifest = {
            schema: 1,
            revision,
            source_commit: sourceCommit,
            sha256: createHash('sha256').update(artifact).digest('hex'),
            byte_length: artifact.length,
            row_count: rows.length,
            precedence,
            sources,
            source_boundaries: sourceBoundaries,
        };
        writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
}
