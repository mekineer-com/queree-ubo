import { basename, dirname, join } from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

// Roll back publication errors. Readers still verify pair hashes: multiple
// renames cannot be a filesystem transaction or survive SIGKILL atomically.
export async function withStagedOutputs(outputs, generate) {
    // Keep read-modify-write callbacks and pair publication under one OS lock.
    // The pipe closes even on SIGKILL, releasing flock without stale lock state.
    const lock = spawn('flock', [ '-x', join(tmpdir(), `queree-generators-${process.getuid()}.lock`),
        'sh', '-c', 'echo locked; cat' ], { stdio: [ 'pipe', 'pipe', 'inherit' ] });
    const exited = once(lock, 'close');
    const ready = once(lock.stdout, 'data');
    await Promise.race([ ready, exited.then(() => { throw new Error('Generator lock failed'); }) ]);
    const staged = [];
    const published = [];
    try {
        for ( const output of outputs ) {
            const directory = fs.mkdtempSync(join(dirname(output), '.queree-generate-'));
            staged.push({ directory, path: join(directory, basename(output)), output });
        }
        await generate(staged.map(file => file.path));
        for ( const file of staged ) {
            if ( fs.statSync(file.path).isFile() === false ) {
                throw new Error(`Generator did not produce a file: ${file.output}`);
            }
            if ( fs.existsSync(file.output) ) {
                file.backup = join(file.directory, 'previous');
                fs.copyFileSync(file.output, file.backup);
            }
        }
        for ( const file of staged ) {
            fs.renameSync(file.path, file.output);
            published.push(file);
        }
    } catch (error) {
        for ( const file of published.reverse() ) {
            if ( file.backup ) {
                fs.renameSync(file.backup, file.output);
            } else {
                fs.rmSync(file.output);
            }
        }
        throw error;
    } finally {
        for ( const file of staged ) {
            fs.rmSync(file.directory, { recursive: true, force: true });
        }
        lock.stdin.end();
        await exited;
    }
}
