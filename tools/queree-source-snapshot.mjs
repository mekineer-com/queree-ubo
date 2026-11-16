import { copyFileSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function readVerified(file, manifestURL) {
    const bytes = readFileSync(new URL(file.file, manifestURL));
    if ( bytes.length !== file.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256 ) {
        throw new Error(`Source hash/size mismatch: ${file.file}`);
    }
    if ( file.git_blob_sha !== undefined ) {
        const blob = createHash('sha1')
            .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if ( blob !== file.git_blob_sha ) {
            throw new Error(`Source Git blob mismatch: ${file.file}`);
        }
    }
    return bytes;
}

export function openSourceSnapshot(path) {
    const directory = mkdtempSync(join(tmpdir(), 'queree-source-'));
    try {
        const snapshot = join(directory, 'input');
        copyFileSync(path, snapshot);
        // Keep only the descriptor so later input overwrites cannot change it.
        return openSync(snapshot, 'r');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
