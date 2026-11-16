import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';

const work = mkdtempSync(join(tmpdir(), 'queree-doaj-'));
const input = join(work, 'journals.csv');
const output = join(work, 'publications.mjs');
const generate = (date = '2026-10-09') => execFileSync(process.execPath, [
    'tools/make-queree-doaj-domains.mjs', input, date, output,
], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
const read = () => JSON.parse(readFileSync(output, 'utf8').split('export default ')[1].trim().slice(0, -1));
try {
    const hosts = [
        'https://www.journal.example/', 'http://journal.example/',
        'https://second.example/', 'https://journal.github.io/',
        'https://shared.example/journal', 'https://shared.example/?journal=one',
        'https://shared.example/#journal', 'https://google.com/',
        'https://github.io/', 'https://youtube.com/',
        'https://127.0.0.1/', 'https://user:pass@journal.example/',
        'https://-bad.example/', 'https://example.com:8443/',
    ];
    const csv = '\ufeffJournal URL,URL in DOAJ,Publisher\n' + hosts.map((url, index) =>
        `${url},https://doaj.org/toc/${index},"Same publisher, many journals"`
    ).join('\n');
    writeFileSync(input, csv);
    const retained = { name: 'ut1_press', domains: [ 'press.example' ], license: 'CC-BY-SA-4.0' };
    writeFileSync(output, `export default ${JSON.stringify([ retained ])};\n`);
    generate();
    const first = readFileSync(output, 'utf8');
    const [ original, source ] = read();
    assert.deepEqual(original, retained);
    assert.deepEqual(source.domains, [ 'journal.example', 'journal.github.io', 'second.example' ]);
    assert.deepEqual(source.items_by_domain['journal.example'], [ 'https://doaj.org/toc/0', 'https://doaj.org/toc/1' ]);
    assert.deepEqual(source.excluded, { invalid: 4, non_root_url: 3, platform: 1, shared_host: 2 });
    assert.equal(source.sha256, createHash('sha256').update(csv).digest('hex'));
    assert.equal(source.snapshot_date, '2026-10-09');
    assert.equal(source.license, 'CC0-1.0');
    generate();
    assert.equal(readFileSync(output, 'utf8'), first, 'Repeated generation must be byte-identical');
    for ( const date of [ 'not-a-date', '2026-02-31' ] ) {
        assert.throws(() => generate(date));
        assert.equal(readFileSync(output, 'utf8'), first);
    }
    for ( const bad of [
        'Website,Record\nhttps://journal.example/,one\n',
        'Journal URL,URL in DOAJ\nhttps://shared.example/journal,one\n',
        'Journal URL,URL in DOAJ\nhttps://journal.example/,one\n"unterminated',
        'Journal URL,URL in DOAJ\nhttps://journal.example/,one\nhttps://second.example/\n',
        'Journal URL,URL in DOAJ\nhttps://journal.example/,one\nhttps://second.example/,two,extra\n',
    ] ) {
        writeFileSync(input, bad);
        assert.throws(() => generate());
        assert.equal(readFileSync(output, 'utf8'), first, 'Failed refresh must preserve prior data');
    }
    rmSync(output);
    writeFileSync(input, csv);
    generate();
    assert.equal(read().length, 1, 'The importer must work without an existing output');
} finally {
    rmSync(work, { recursive: true, force: true });
}
console.log('Passed: DOAJ source retention, reproducibility, host scope, tenant boundaries and failed-refresh preservation');
