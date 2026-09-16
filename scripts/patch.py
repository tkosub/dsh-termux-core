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


def search_patch(source):
    old = '\t\treturn (await import("@vscode/ripgrep")).rgPath;'
    new = '''\t\tif (process.platform === "android") {
\t\t\tif (!process.env.PREFIX) throw new Error("Termux PREFIX is missing");
\t\t\tconst binary = join(process.env.PREFIX, "bin", "rg");
\t\t\tif (!existsSync(binary)) throw new Error("Install ripgrep with: pkg install ripgrep");
\t\t\treturn binary;
\t\t}
\t\treturn (await import("@vscode/ripgrep")).rgPath;'''
    # The old line is intentionally the non-Android branch of the new code.
    if source.count(new) == 1:
        return source
    if source.count(old) != 1:
        raise ValueError('Search resolver: unrecognized source')
    return source.replace(old, new, 1)


def plan(root):
    packages = root / 'node_modules' / '@deepseek-ai'
    versions = [(root, '0.1.5-rc.1'),
                (packages / 'node-addon-system', '0.1.2')]
    transforms = [('dsh-session-persistence-jsonl', session_patch),
                  ('dsh-fs-local', file_patch), ('dsh-tool-fs-search', search_patch)]
    versions += [(packages / name, '0.1.5-rc.2') for name, _ in transforms]
    for directory, expected in versions:
        actual = json.loads((directory / 'package.json').read_text())['version']
        if actual != expected:
            raise ValueError(f'{directory.name}: expected {expected}, found {actual}; this version has not been checked')
    changes = []
    for name, transform in transforms:
        path = packages / name / 'lib' / 'index.js'
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
