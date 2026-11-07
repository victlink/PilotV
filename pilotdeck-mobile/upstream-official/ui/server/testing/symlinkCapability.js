import { mkdirSync, rmSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Can this machine create symlinks without elevation?
 *
 * Windows only allows unprivileged symlink creation with Developer Mode enabled
 * (HKLM\...\AppModelUnlock\AllowDevelopmentWithoutDevLicense). Otherwise every
 * symlinkSync() throws EPERM, which made the security suites that prove
 * "writes must not escape through a symlink" fail on a normal Windows runner.
 *
 * Probing beats skipIf(process.platform === 'win32'): on a Windows box that DOES
 * have Developer Mode, the escape assertion still runs, so the guarantee stays
 * covered instead of being quietly disabled per platform.
 */
function probeSymlinksUsable() {
    let dir;
    try {
        dir = mkdtempSync(join(tmpdir(), 'pilotdeck-symlink-probe-'));
        const target = join(dir, 'target');
        mkdirSync(target);
        symlinkSync(target, join(dir, 'link'));
        return { usable: true, reason: '' };
    } catch (error) {
        return { usable: false, reason: error?.code || error?.message || 'unknown' };
    } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
}

const probe = probeSymlinksUsable();

export const SYMLINKS_USABLE = probe.usable;
export const SYMLINK_PROBE_REASON = probe.reason;
export const SYMLINK_SKIP_REASON =
    `symlink creation is not permitted here (${probe.reason}); enable Windows Developer Mode or run elevated`;