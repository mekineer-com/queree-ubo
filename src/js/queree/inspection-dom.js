/*******************************************************************************

    Quer.ee inspection DOM scopes
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

(( ) => {
    globalThis.__quereeInspectionRoots = ( ) => {
        const roots = new Set([ document ]);
        for ( const root of roots ) {
            for ( const element of root.querySelectorAll('*') ) {
                const shadow = element.openOrClosedShadowRoot;
                if ( shadow ) { roots.add(shadow); }
                if ( element.localName !== 'iframe' && element.localName !== 'frame' ) {
                    continue;
                }
                // Cross-origin and sandboxed frame documents are not DOM-accessible.
                try {
                    const frame = element.contentDocument;
                    if ( frame ) { roots.add(frame); }
                } catch {
                }
            }
        }
        return Array.from(roots);
    };
})()
