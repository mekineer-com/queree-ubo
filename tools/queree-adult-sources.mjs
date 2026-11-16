import adultSources from '../src/js/queree/vendor/adult-domains.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function loadAdultSources() {
    return adultSources.map(source => {
        const input = readFileSync(new URL(`../${source.input_asset}`, import.meta.url));
        if (
            input.length !== source.bytes ||
            createHash('sha256').update(input).digest('hex') !== source.sha256
        ) {
            throw new Error(`Adult source hash/size mismatch: ${source.name}`);
        }
        const domains = new Set();
        for ( const [ index, rawLine ] of input.toString('utf8').split(/\r?\n/).entries() ) {
            const domain = rawLine.trim();
            if ( domain === '' || domain.startsWith('#') ) { continue; }
            if (
                /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(domain) === false ||
                domain.length > 253 || domain.split('.').some(label => label.length > 63) ||
                new URL(`https://${domain}/`).hostname !== domain
            ) {
                throw new Error(`Invalid adult hostname on line ${index + 1}: ${domain}`);
            }
            domains.add(domain);
        }
        if ( domains.size !== source.domain_count ) {
            throw new Error(`Adult source domain count mismatch: ${source.name}`);
        }
        return { ...source, domains: Array.from(domains).sort() };
    });
}
