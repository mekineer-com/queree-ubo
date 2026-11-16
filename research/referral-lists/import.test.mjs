/* globals process */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '../..');
const generator = resolve(root, 'research/referral-lists/import.mjs');
const work = mkdtempSync(resolve(tmpdir(), 'queree-referral-source-'));

try {
    const input = resolve(work, 'valid.txt');
    const shorteners = resolve(work, 'shorteners.txt');
    const output = resolve(work, 'domains.js');
    writeFileSync(input, [
        '! Version: fixture-1',
        '! Last modified: fixture-time',
        '||sjv.io^',
        '||Sub.Example^',
        '||t.co^',
        '||v.short.gy^',
        '||sjv.io^',
        '',
    ].join('\n'));
    writeFileSync(shorteners, '# Comment\nt.co\nshort.gy\nBit.Ly\n');
    execFileSync(process.execPath, [ generator, input, shorteners, output ]);
    const generated = JSON.parse(
        readFileSync(output, 'utf8').match(/export default (.+);\n$/s)[1]
    );
    assert.deepEqual(generated[0].domains, [ 'sjv.io', 'sub.example' ]);
    assert.equal(generated[0].upstream_version, 'fixture-1');
    assert.deepEqual(
        generated[0].excluded_sources[0].excluded_domains,
        [ 't.co', 'v.short.gy' ]
    );

    const invalid = resolve(work, 'invalid.txt');
    writeFileSync(invalid, '||sjv.io^\n/path^\n');
    assert.throws(
        ( ) => execFileSync(process.execPath, [
            generator,
            invalid,
            shorteners,
            output,
        ], {
            stdio: 'pipe',
        }),
        /Command failed/
    );
    writeFileSync(shorteners, 'not a hostname\n');
    assert.throws(
        ( ) => execFileSync(process.execPath, [
            generator,
            input,
            shorteners,
            output,
        ], { stdio: 'pipe' }),
        /Command failed/
    );
    console.log('Passed: referral and shortener sources accept only exact hostnames');
} finally {
    rmSync(work, { recursive: true, force: true });
}
