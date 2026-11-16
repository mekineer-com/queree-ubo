/*******************************************************************************

    Quer.ee bounded document capture
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

(( ) => {
    if ( document.contentType !== 'text/html' && document.contentType !== 'application/xhtml+xml' ) { return; }
    const titleLimit = 512;
    const bodyLimitBytes = 128 * 1024;
    const normalizeLine = text => text.replace(/\0/g, '').replace(/[\t\f\v ]+/g, ' ').trim();
    const title = Array.from(normalizeLine(document.title || ''))
        .slice(0, titleLimit).join('');
    const rawBody = String(document.body?.innerText || '')
        .replace(/\r\n?/g, '\n');
    const normalizedBody = rawBody
        .split('\n')
        .map(normalizeLine)
        .filter(Boolean)
        .join('\n');
    // encodeInto stops before a character that cannot fit, including surrogate pairs.
    const { read } = new TextEncoder().encodeInto(
        normalizedBody, new Uint8Array(bodyLimitBytes)
    );
    const metaRobots = Array.from(document.querySelectorAll(
        'meta[name="robots" i]'
    ), element => String(element.content || '').trim()).filter(Boolean);
    return {
        schema: 1,
        url: location.href,
        title,
        body: normalizedBody.slice(0, read),
        extraction_version: 'rendered-text-v2',
        truncated: read < normalizedBody.length,
        indexing_directives: {
            complete: metaRobots.length <= 8 &&
                metaRobots.every(value => value.length <= 512),
            meta_robots: metaRobots.slice(0, 8).map(value => value.slice(0, 512)),
            x_robots_tag: [],
        },
    };
})()
