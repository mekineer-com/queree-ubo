/*******************************************************************************

    Quer.ee inspection readiness
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

(( ) => {
    const roots = globalThis.__quereeInspectionRoots();

    const visible = element => element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
    });
    const hasContent = root => {
        const doc = root.ownerDocument || root;
        const body = root.host || doc.body;
        if ( !body ) { return false; }
        for ( let frame = doc.defaultView.frameElement; frame;
            frame = frame.ownerDocument.defaultView.frameElement ) {
            if ( visible(frame) === false ) { return false; }
        }
        const container = root.host ? root : body;
        const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        while ( walker.nextNode() ) {
            const node = walker.currentNode;
            const parent = node.parentElement || root.host;
            if (
                node.textContent.trim() !== '' &&
                parent.closest('script, style, noscript, template') === null &&
                visible(parent)
            ) {
                return true;
            }
        }
        // A canvas box alone cannot establish that any content has been drawn.
        return Array.from(container.querySelectorAll('img, svg, video')).some(element => {
            if ( visible(element) === false ) { return false; }
            if ( element.localName === 'img' ) {
                return element.complete && element.naturalWidth > 0;
            }
            if ( element.localName === 'video' ) {
                return element.readyState >= 2 && element.videoWidth > 0;
            }
            return Array.from(element.querySelectorAll(
                'path,rect,circle,ellipse,line,polyline,polygon,text,use,image,foreignObject'
            )).some(visible);
        });
    };
    return {
        url: location.href,
        complete: document.readyState !== 'loading',
        content: roots.some(hasContent),
    };
})()
