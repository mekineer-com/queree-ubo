import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export function replaceOnce(text, from, to) {
    const index = text.indexOf(from);
    if ( index === -1 || text.indexOf(from, index + 1) !== -1 ) {
        throw new Error(`Expected one fixture anchor: ${from}`);
    }
    return text.replace(from, () => to);
}

export async function verifyFixtureSources(root, extension) {
    const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
    const version = (await readFile(resolve(root, 'dist/version'), 'utf8')).trim();
    if ( manifest.version !== version ) { throw new Error('Rebuild the test XPI: version differs'); }
    const expected = JSON.parse(await readFile(resolve(root, 'platform/firefox/manifest.json'), 'utf8'));
    expected.version = version;
    if ( /^\d+\.\d+\.\d+\.\d+$/.test(version) === false ) { delete expected.sidebar_action; }
    if ( isDeepStrictEqual(manifest, expected) === false ) {
        throw new Error('Rebuild the test XPI: stale manifest.json');
    }
    const files = new Map();
    for ( const directory of [ 'js', 'lib', 'css', 'web_accessible_resources', 'img', '_locales' ] ) {
        const base = resolve(root, 'src', directory);
        for ( const entry of await readdir(base, { recursive: true, withFileTypes: true }) ) {
            if ( entry.isFile() === false ) { continue; }
            const path = resolve(entry.parentPath, entry.name);
            const target = `${directory}/${relative(base, path).replaceAll('\\', '/')}`;
            if ( target === 'img/icon_128.png' ) { continue; }
            if ( /^js\/queree\/vendor\/(adult|commercial|corporate|institutional|public-interest)-domains\.js$/.test(target) ) { continue; }
            files.set(target, path);
            if ( target.startsWith('_locales/nb/') ) {
                files.set(target.replace('_locales/nb/', '_locales/no/'), path);
            }
        }
    }
    for ( const directory of [ 'src', 'platform/common', 'platform/firefox' ] ) {
        for ( const name of await readdir(resolve(root, directory)) ) {
            if ( directory === 'src' ? name.endsWith('.html') : /\.(js|json)$/.test(name) && name !== 'manifest.json' ) {
                files.set(name.endsWith('.js') ? `js/${name}` : name, resolve(root, directory, name));
            }
        }
    }
    files.set('assets/queree/domain-index.bin', resolve(root, 'src/assets/queree/domain-index.bin'));
    for ( const directory of [ 'assets', 'dist/build/uAssets/main', 'dist/build/uAssets/prod' ] ) {
        const base = resolve(root, directory);
        for ( const entry of await readdir(base, { recursive: true, withFileTypes: true }) ) {
            if ( entry.isFile() === false ) { continue; }
            const path = resolve(entry.parentPath, entry.name);
            const name = relative(base, path).replaceAll('\\', '/');
            let target;
            if ( directory === 'assets' ) {
                if ( name.startsWith('queree/adult-lists/') ||
                    (name.startsWith('queree/website-lists/') && name !== 'queree/website-lists/LICENSE' &&
                        name.startsWith('queree/website-lists/affiliate-links/') === false) ||
                    name === (/^\d+\.\d+\.\d+$/.test(version) ? 'assets.dev.json' : 'assets.json') ) { continue; }
                target = name;
            } else if ( directory.endsWith('/main') ) {
                if ( /^thirdparties\/(pgl\.yoyo\.org|publicsuffix\.org|urlhaus-filter)\//.test(name) === false ) { continue; }
                target = name;
            } else {
                if ( [ 'thirdparties/easylist.txt', 'thirdparties/easyprivacy.txt' ].includes(name) ) {
                    target = 'thirdparties/easylist/' + name.split('/').at(-1);
                } else if ( name === 'filters/badlists.txt' ||
                    /^filters\/(badware|filters|privacy|quick-fixes|unbreak)\.min\.txt$/.test(name) ) {
                    target = 'ublock/' + name.split('/').at(-1);
                } else { continue; }
            }
            files.set('assets/' + target, path);
        }
    }
    for ( const name of [ 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt' ] ) {
        files.set(name, resolve(root, name));
    }
    const english = JSON.parse(await readFile(resolve(root, 'src/_locales/en/messages.json'), 'utf8'));
    for ( const [ target, path ] of files ) {
        const actual = await readFile(resolve(extension, target));
        let matches;
        if ( /^_locales\/[^/]+\/messages\.json$/.test(target) ) {
            const expected = JSON.parse(await readFile(path, 'utf8'));
            const identityKeys = new Set([
                'extName', 'extShortDesc', 'dashboardName',
                'aboutPrivacyPolicy', 'aboutChangelog', 'aboutCode',
                'supportS1H', 'supportS1P1', 'supportS2H', 'supportS2P1',
                'supportS3H', 'supportS3P1', 'supportS4H', 'supportS4P1', 'supportS6H',
            ]);
            for ( const [ key, entry ] of Object.entries(expected) ) {
                const message = english[key]?.message || '';
                if ( identityKeys.has(key) ) {
                    entry.message = message;
                } else if ( message.includes('my-ubo-q-') ) {
                    entry.message = entry.message.replace(/ublock(?: origin|₀)?/gi, 'ubo-q');
                } else if ( message.includes('uBO+Q') ) {
                    entry.message = entry.message.replace(/uBlock(?: Origin|₀)?|uBO(?!\+Q)/g, 'uBO+Q');
                }
            }
            matches = isDeepStrictEqual(JSON.parse(actual), expected);
        } else {
            matches = actual.equals(await readFile(path));
        }
        if ( matches === false ) {
            throw new Error(`Rebuild the test XPI: stale ${target}`);
        }
    }
    for ( const entry of await readdir(extension, { recursive: true, withFileTypes: true }) ) {
        if ( entry.isFile() === false ) { continue; }
        const target = relative(extension, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/');
        if ( target === 'manifest.json' || target.startsWith('META-INF/') || files.has(target) ) { continue; }
        throw new Error(`Rebuild the test XPI: extra ${target}`);
    }
}
