"""Regression tests against the exact published npm sources (downloads once)."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('patcher', ROOT / 'scripts/patch.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class Patches(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {}
        fixture = os.environ.get('DSH_TEST_FIXTURE')
        for name in ['dsh-session-persistence-jsonl', 'dsh-fs-local', 'dsh-tool-fs-search',
                     'dsh-attachment-local']:
            if fixture:
                cls.sources[name] = (Path(fixture) / name / 'lib/index.js').read_text(encoding='utf-8')
            else:
                url = f'https://registry.npmjs.org/@deepseek-ai/{name}/-/{name}-0.1.5-rc.2.tgz'
                with urllib.request.urlopen(url, timeout=60) as response:
                    with tarfile.open(fileobj=io.BytesIO(response.read()), mode='r:gz') as archive:
                        cls.sources[name] = archive.extractfile('package/lib/index.js').read().decode()

    def test_pristine_and_repeat(self):
        for name, transform in [('dsh-session-persistence-jsonl', patcher.session_patch),
                                ('dsh-fs-local', patcher.file_patch),
                                ('dsh-tool-fs-search', patcher.search_patch),
                                ('dsh-attachment-local', patcher.attachment_patch)]:
            with self.subTest(package=name):
                result = transform(self.sources[name])
                self.assertNotEqual(result, self.sources[name])
                self.assertEqual(result, transform(result))

    def test_existing_session_patch_is_upgraded(self):
        source = self.sources['dsh-session-persistence-jsonl']
        source = source.replace('await link(tmp, finalPath);', 'await rename(tmp, finalPath);')
        source = source.replace('await internals.fs.link(staged, currentPath);', 'await internals.fs.rename(staged, currentPath);')
        source = source.replace('\n\tlink,', '\n\tlink,\n\trename,')
        result = patcher.session_patch(source)
        self.assertIn('await renameNoReplace(tmp, finalPath);', result)
        self.assertIn('await internals.fs.renameNoReplace(staged, currentPath);', result)
        self.assertIn('\n\trenameNoReplace,', result)
        self.assertEqual(result, patcher.session_patch(result))

    def test_attachment_patch_replaces_both_android_gaps(self):
        result = patcher.attachment_patch(self.sources['dsh-attachment-local'])
        # The fsync walk must stop at an ancestor it can actually open.
        self.assertNotIn('ensureDurableDirectory(home, parse(home).root)', result)
        self.assertIn('ensureDurableDirectory(home, await durableBoundary(home))', result)
        self.assertEqual(result.count('async function durableBoundary(path) {'), 1)
        # Android denies hard links, so neither publication call may remain.
        self.assertNotIn('await link(source, target)', result)
        self.assertNotIn('await link(staged.path, target)', result)
        self.assertIn('await publishName(source, target, false)', result)
        self.assertIn('await publishName(staged.path, target, true)', result)
        self.assertEqual(result.count('async function publishName(from, to, move) {'), 1)
        self.assertIn('copyFile(from, to, constants.COPYFILE_EXCL)', result)
        # Publication consumes the staging name; an absent name is not an error.
        self.assertNotIn('await unlink(staged.path);\n\t\tawait chmod', result)

    def test_attachment_patch_upgrades_its_own_output(self):
        # A re-run must not insert a second copy of either helper.
        once = patcher.attachment_patch(self.sources['dsh-attachment-local'])
        self.assertEqual(patcher.attachment_patch(once), once)

    def test_unrecognized_source_fails(self):
        for transform in [patcher.session_patch, patcher.file_patch, patcher.search_patch,
                          patcher.attachment_patch]:
            with self.subTest(transform=transform.__name__):
                with self.assertRaises(ValueError):
                    transform('export {};\n')

    def test_duplicate_anchor_fails(self):
        source = self.sources['dsh-fs-local']
        with self.assertRaises(ValueError):
            patcher.file_patch(source + source)
        attachment = self.sources['dsh-attachment-local']
        with self.assertRaises(ValueError):
            patcher.attachment_patch(attachment + attachment)

    def test_validates_all_files_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text(json.dumps({'version': '0.1.5-rc.1'}))
            packages = root / 'node_modules/@deepseek-ai'
            for name, source in self.sources.items():
                package = packages / name
                (package / 'lib').mkdir(parents=True)
                (package / 'package.json').write_text(json.dumps({'version': '0.1.5-rc.2'}))
                (package / 'lib/index.js').write_text(source, encoding='utf-8')
            addon = packages / 'node-addon-system'
            addon.mkdir()
            (addon / 'package.json').write_text(json.dumps({'version': '0.1.2'}))
            self.assertEqual(len(patcher.plan(root)), 4)
            (packages / 'dsh-tool-fs-search/lib/index.js').write_text('export {};')
            with self.assertRaises(ValueError):
                patcher.plan(root)
            self.assertEqual((packages / 'dsh-fs-local/lib/index.js').read_text(encoding='utf-8'), self.sources['dsh-fs-local'])
            (addon / 'package.json').write_text(json.dumps({'version': '99.0.0'}))
            with self.assertRaisesRegex(ValueError, 'has not been checked'):
                patcher.plan(root)


if __name__ == '__main__':
    unittest.main()
