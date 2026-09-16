/** Lazy POSIX flock entry; importing it does not load a native addon.
 *
 * Termux/Android variant: `process.platform === 'android'` on Termux, but
 * Bionic exposes a fully functional flock(2). The upstream package ships
 * platform packages only for linux and darwin; on android it would throw
 * ERR_FLOCK_UNSUPPORTED_PLATFORM. This patched copy relaxes the guard to
 * admit android and loads the prebuilt addon from a location the host
 * controls.
 *
 *   - primary: prebuilt system.node at the DSH_FLOCK_PREBUILD_DIR directory
 *     (default ~/.dsh/flock/), set by the installer so each host places the
 *     binary where its own policy says; the loader reads the environment at
 *     first use and never hard-codes a host path.
 * Missing native support is an error; session locks must never be simulated.
 *
 * Drop-in replacement for @deepseek-ai/node-addon-system/lib/flock.js.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getSystemErrorName } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

/** Directory holding the prebuilt `system.node` for android-arm64.
 * Override with DSH_FLOCK_PREBUILD_DIR (a directory path). */
function prebuildDir() {
    const env = process.env.DSH_FLOCK_PREBUILD_DIR;
    if (env) return env;
    return join(homedir(), '.dsh', 'flock');
}

let binding;
function loadBinding() {
    if (binding)
        return binding;
    const { platform, arch } = process;
    const POSIX_PLATFORMS = ['linux', 'darwin', 'android'];
    if (!POSIX_PLATFORMS.includes(platform)) {
        throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
            syscall: 'flock',
        });
    }
    if (platform === 'android') {
        const custom = join(prebuildDir(), 'system.node');
        if (existsSync(custom)) {
            binding = require(custom);
            return binding;
        }
        throw Object.assign(new Error(`Android file support is missing: ${custom}. Run provision.sh again.`), {
            code: 'DSH_FLOCK_NO_PREBUILD',
        });
    }
    let filename = 'system.node';
    if (platform === 'linux') {
        // Node's report types omit the libc field supplied by Linux reports.
        const report = process.report.getReport();
        filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename);
    }
    const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`);
    binding = require(join(dirname(manifest), 'bin', filename));
    return binding;
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd) {
    const errno = await new Promise((resolve) => {
        loadBinding().tryLock(fd, resolve);
    });
    if (errno === 0)
        return;
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(`${code}: flock failed`), {
        code,
        errno,
        syscall: 'flock',
    });
}

/** Atomically publish a file, refusing to overwrite an existing destination. */
export async function renameNoReplace(source, destination) {
    if (typeof source !== 'string' || typeof destination !== 'string' ||
        source.includes('\0') || destination.includes('\0')) {
        throw new TypeError('File paths must be strings without NUL characters');
    }
    const native = loadBinding();
    if (typeof native.publishNoReplace !== 'function') {
        throw new Error('Android file support is outdated. Run provision.sh again.');
    }
    const errno = native.publishNoReplace(source, destination);
    if (errno) {
        const code = getSystemErrorName(-errno);
        throw Object.assign(new Error(`${code}: cannot create ${destination}`), {
            code, errno, syscall: 'renameat2', path: source, dest: destination,
        });
    }
}
