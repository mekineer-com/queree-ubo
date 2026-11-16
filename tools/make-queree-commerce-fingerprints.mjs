import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const pins = Object.fromEntries((await readFile(new URL(
    './queree-release-sources.lock', import.meta.url
), 'utf8')).trim().split('\n').map(line => line.split('=')));
import { withStagedOutputs } from './queree-generated-files.mjs';

export async function generateCommerceFingerprints(convertWappalyzerTech, webappanalyzer, output) {
    // This freezes the completion order of the original concurrent import. Order can
    // affect detection, so a cleanup must be reviewed as a behavior change.
    const shardOrder = [
        '_', 'd', 'e', 'b', 'a', 'c', 'i', 'g', 'j', 'k', 'h', 'f', 'n', 'q',
        'o', 'm', 'l', 'p', 'u', 'v', 'w', 'r', 't', 's', 'x', 'y', 'z',
    ];
    const fingerprints = new Map();

    for ( const shard of shardOrder ) {
        const raw = await readFile(
            resolve(webappanalyzer, `src/technologies/${shard}.json`),
            'utf8'
        );
        for ( const [ name, technology ] of Object.entries(JSON.parse(raw)) ) {
            // Upstream scripts are source text, not URLs. Reuse the importer's
            // pattern conversion without adding them to scriptSrc.
            const fingerprint = convertWappalyzerTech(name, {
                ...technology, scripts: undefined, xhr: undefined,
            });
            const scripts = convertWappalyzerTech(name, {
                scriptSrc: technology.scripts,
            }).scriptSrc;
            if ( scripts !== undefined ) { fingerprint.scriptContent = scripts; }
            // The importer reduces object rules to selectors and loses conditions.
            delete fingerprint.dom;
            fingerprints.set(fingerprint.name, fingerprint);
        }
    }

    const selected = [ ...fingerprints.values() ].filter(fingerprint =>
        fingerprint.categories.includes('ecommerce')
    );
    const selectedNames = new Set(selected.map(fingerprint => fingerprint.name));
    for ( let index = 0; index < selected.length; index++ ) {
        for ( const required of selected[index].requires || [] ) {
            const dependency = fingerprints.get(required);
            if ( dependency === undefined || selectedNames.has(required) ) { continue; }
            selectedNames.add(required);
            selected.push(dependency);
        }
    }

    // Hash the emitted payload, preserving detection-significant rule/array order.
    const payload = JSON.stringify(selected);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const header = `/* Generated from OpenTechalyzer ${pins.OPENTECHALYZER_COMMIT.slice(0, 7)} and WebAppAnalyzer ${pins.WEBAPPANALYZER_COMMIT.slice(0, 7)}.
 * Lossy imported DOM conversions are omitted; see opentechalyzer/README.md. */

export const commerceFingerprintsSHA256 = '${sha256}';
export const commerceEngineSource = 'opentechalyzer:${pins.OPENTECHALYZER_COMMIT}';
export const commerceFingerprintsSource = 'webappanalyzer:${pins.WEBAPPANALYZER_COMMIT}';

export default `;
    // Probe inputs are derived only from the hashed payload, in the same order.
    const signals = {
        js: [ ...new Set(selected.flatMap(fingerprint => Object.keys(fingerprint.js || {}))) ],
    };
    await withStagedOutputs([
        output, resolve(dirname(output), 'commerce-signals.js'),
    ], async ([ fingerprintsPath, signalsPath ]) => {
        await writeFile(fingerprintsPath, `${header}${payload};\n`);
        await writeFile(signalsPath,
            '/* Generated from commerce-fingerprints.js. Do not edit by hand. */\n\n' +
            `globalThis.__quereeCommerceSignals = ${JSON.stringify(signals)};\n`);
    });
}

if ( process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ) {
    const [ opentechalyzerArgument, webappanalyzerArgument, outputArgument ] =
        process.argv.slice(2);
    if ( outputArgument === undefined ) {
        throw new Error(
            'Usage: node tools/make-queree-commerce-fingerprints.mjs ' +
            'OPENTECHALYZER_ROOT WEBAPPANALYZER_ROOT OUTPUT'
        );
    }

    const opentechalyzer = resolve(opentechalyzerArgument);
    const webappanalyzer = resolve(webappanalyzerArgument);
    const output = resolve(outputArgument);
    for ( const [ directory, pin ] of [
        [ opentechalyzer, 'OPENTECHALYZER_COMMIT' ], [ webappanalyzer, 'WEBAPPANALYZER_COMMIT' ],
    ] ) {
        execFileSync('sh', [ fileURLToPath(new URL('./check-queree-source.sh', import.meta.url)), directory, pin ]);
    }
    const { convertWappalyzerTech } = await import(pathToFileURL(
        resolve(opentechalyzer, 'src/fingerprints/external.ts')
    ));
    await generateCommerceFingerprints(convertWappalyzerTech, webappanalyzer, output);
}
