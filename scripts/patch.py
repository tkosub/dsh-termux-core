#!/usr/bin/env python3
"""Validate every supported source shape before atomically replacing files."""
import argparse
import json
import os
from pathlib import Path
import tempfile


def replace_one(source, old, new, label):
    if source.count(new) == 1 and old not in source:
        return source
    if source.count(old) != 1 or new in source:
        raise ValueError(f'{label}: unrecognized source; no files were changed')
    return source.replace(old, new, 1)


def session_patch(source):
    # Accept both pristine npm files and the earlier rename-based patch.
    old_import = 'import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";'
    new_import = 'import { tryLockExclusive, renameNoReplace } from "@deepseek-ai/node-addon-system/flock";'
    source = replace_one(source, old_import, new_import, 'session import')
    for args, prefix in [('tmp, finalPath', ''), ('staged, currentPath', 'internals.fs.')]:
        new = f'await {prefix}renameNoReplace({args});'
        if new in source:
            if source.count(new) != 1:
                raise ValueError('Duplicate session publication code')
            continue
        old = f'await {prefix}link({args});'
        if old not in source:
            old = f'await {prefix}rename({args});'
        source = replace_one(source, old, new, 'session publication')
    if '\n\trenameNoReplace,' not in source:
        if '\n\trename,' in source:
            source = replace_one(source, '\n\trename,', '\n\trenameNoReplace,', 'session filesystem')
        else:
            source = replace_one(source, '\n\tlink,', '\n\tlink,\n\trenameNoReplace,', 'session filesystem')
    return source


def file_patch(source):
    header = 'import { renameNoReplace } from "@deepseek-ai/node-addon-system/flock";\n'
    if header not in source:
        source = header + source
    original = '\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);'
    new = '''\t\t\t// Android cannot hard-link here; preserve the no-overwrite guarantee.
\t\t\tif (platform === "android" && ["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
\t\t\t\ttry { await renameNoReplace(tempPath, absolutePath); }
\t\t\t\tcatch (publishError) { await throwGuardedCreateFailure(publishError, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget); }
\t\t\t} else await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);'''
    # The former public patch incorrectly claimed ordinary rename was no-replace.
    if 'const platformLinkDenied =' in source:
        start = source.index('\t\t\t// dsh-termux-core (adopted from ErEbusE/dsh-termux, MIT):')
        end = source.index('\n\t\t}', start)
        source = source[:start] + new + source[end:]
    else:
        source = replace_one(source, original, new, 'new-file write')
    return source


def insert_before(source, anchor, block):
    """Insert a whole definition beside an anchor the block itself may quote."""
    if block in source:
        if source.count(block) != 1:
            raise ValueError('Duplicate inserted block')
        return source
    return replace_one(source, anchor, block + anchor, 'insertion anchor')


def attachment_patch(source):
    # Android denies hard links to the app domain, and Termux's app-sandbox
    # ancestors cannot be opened at all, so both the fsync walk and the
    # publication path need a substitute rather than a different syscall.
    header = 'import { renameNoReplace } from "@deepseek-ai/node-addon-system/flock";\n'
    if header not in source:
        source = header + source
    source = replace_one(
        source,
        'import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
        'import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
        'attachment imports')
    source = insert_before(source, '''/**
* Establish this process's proof that one DSH_HOME entry and every ancestor''', '''/**
* Highest ancestor whose entries this process can prove durable. Termux runs
* inside an app sandbox whose system-owned ancestors are traverse-only: they
* cannot be opened, so their entries can never be synced and the walk below
* would fail on them. Stop at the first unopenable ancestor instead. Where the
* whole chain is openable, this still reaches the filesystem root.
*/
async function durableBoundary(path) {
\tlet level = resolve(path);
\tfor (;;) {
\t\tconst parent = dirname(level);
\t\tif (parent === level) return level;
\t\ttry {
\t\t\tconst handle = await open(parent, constants.O_RDONLY);
\t\t\tawait handle.close();
\t\t} catch {
\t\t\treturn level;
\t\t}
\t\tlevel = parent;
\t}
}
''')
    source = replace_one(
        source,
        '\t\tawait ensureDurableDirectory(home, parse(home).root);',
        '\t\tawait ensureDurableDirectory(home, await durableBoundary(home));',
        'attachment durable home')
    source = insert_before(source, '''/**
* Publish another durable hard-link name for an existing immutable object.''', '''/**
* Give one immutable object a second durable name. Android denies hard links
* to the app domain, so a staged name is moved instead (publication consumes
* the staging name either way) and an already-published canonical object is
* copied, keeping its original name intact.
*/
async function publishName(from, to, move) {
\tif (process.platform !== "android") return link(from, to);
\tif (move) return renameNoReplace(from, to);
\treturn copyFile(from, to, constants.COPYFILE_EXCL);
}
''')
    source = replace_one(source, '\t\t\tawait link(source, target);',
                        '\t\t\tawait publishName(source, target, false);', 'attachment alias')
    source = replace_one(source, '\t\t\tawait link(staged.path, target);',
                        '\t\t\tawait publishName(staged.path, target, true);', 'attachment staged')
    # Publication consumes the staging name either way; ignore a name a
    # concurrent publisher already removed instead of failing the save.
    source = replace_one(source, '\t\tawait unlink(staged.path);\n\t\tawait chmod(target, 256);',
                        '\t\tawait removeTemporary(staged.path);\n\t\tawait chmod(target, 256);',
                        'attachment staged cleanup')
    return source


def search_patch(source):
    old = '\t\tconst dependency = (await import("@vscode/ripgrep")).rgPath;'
    new = '''\t\tif (process.platform === "android") {
\t\t\tif (!process.env.PREFIX) throw new Error("Termux PREFIX is missing");
\t\t\tconst binary = join(process.env.PREFIX, "bin", "rg");
\t\t\tif (!existsSync(binary)) throw new Error("Install ripgrep with: pkg install ripgrep");
\t\t\treturn binary;
\t\t}
\t\tconst dependency = (await import("@vscode/ripgrep")).rgPath;'''
    # The old line is intentionally the non-Android branch of the new code.
    if source.count(new) == 1:
        return source
    if source.count(old) != 1:
        raise ValueError('Search resolver: unrecognized source')
    return source.replace(old, new, 1)


def subprocess_inspector_patch(source):
    # Node reports 'android' on Android, so the inspector dispatch never
    # reaches the Linux branch and every PTY open throws at spawn time.
    # Android is Linux for this purpose: /proc is readable for the processes
    # DSH spawns, and the arm64 syscall table is already present.
    old = '\tif (platform === "linux") return new LinuxProcessInspector(arch, internals);'
    new = '\tif (platform === "linux" || platform === "android") return new LinuxProcessInspector(arch, internals);'
    if source.count(new) == 1:
        return source
    if source.count(old) != 1:
        raise ValueError('subprocess inspector: unrecognized source; no files were changed')
    return source.replace(old, new, 1)


def subprocess_containment_patch(source):
    # Classify Android as Linux so containment selection reaches the Linux
    # probes. Termux fails them for the honest reason -- no user-systemd scope
    # and no private bootstrap -- instead of the false "platform android has
    # no native managed range", and keeps the same fallback containment.
    old = '\t\tif (platform === "linux") {'
    new = '\t\tif (platform === "linux" || platform === "android") {'
    if source.count(new) == 1:
        return source
    if source.count(old) != 1:
        raise ValueError('subprocess containment: unrecognized source; no files were changed')
    return source.replace(old, new, 1)


def plan(root):
    packages = root / 'node_modules' / '@deepseek-ai'
    versions = [(root, '0.2.1-alpha.1'),
                (packages / 'node-addon-system', '0.1.2')]
    # (package, file pattern under the package, transform). The subprocess
    # inspector lives in a bundled chunk whose name carries a build hash, so
    # it is matched by pattern rather than by name.
    transforms = [('dsh-session-persistence-jsonl', 'lib/index.js', session_patch),
                  ('dsh-fs-local', 'lib/index.js', file_patch),
                  ('dsh-tool-fs-search', 'lib/index.js', search_patch),
                  ('dsh-attachment-local', 'lib/index.js', attachment_patch),
                  ('dsh-subprocess-local', 'lib/runner-launch-*.js', subprocess_inspector_patch),
                  ('dsh-subprocess-local', 'lib/index.js', subprocess_containment_patch)]
    versions += [(packages / name, '0.2.1-alpha.1') for name in dict.fromkeys(name for name, _, _ in transforms)]
    for directory, expected in versions:
        actual = json.loads((directory / 'package.json').read_text())['version']
        if actual != expected:
            raise ValueError(f'{directory.name}: expected {expected}, found {actual}; this version has not been checked')
    changes = []
    for name, pattern, transform in transforms:
        matched = sorted((packages / name).glob(pattern))
        if len(matched) != 1:
            raise ValueError(f'{name}: {pattern} matched {len(matched)} files; this version has not been checked')
        path = matched[0]
        original = path.read_text(encoding='utf-8')
        changes.append((path, original, transform(original)))
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    changes = plan(args.root)
    if args.check:
        print('All package versions and patch locations are recognized.')
        return
    for path, before, after in changes:
        if before == after:
            print(f'Already patched: {path.parent.parent.name}')
            continue
        fd, temporary = tempfile.mkstemp(prefix='.termux-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
                stream.write(after)
            os.chmod(temporary, path.stat().st_mode & 0o777)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f'Patched: {path.parent.parent.name}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(f'ERROR: {error}')
