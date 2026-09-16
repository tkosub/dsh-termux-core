# Development checks

Run the source-patch regression tests with Python 3. They download the
three exact public npm packages and check repeated application, upgrades
from the previous conversation-storage fix, and rejection of unknown code.

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

On Termux, after installation:

```bash
node scripts/verify.mjs "$(npm root -g)/@deepseek-ai/dsh"
node tests/web-start.mjs "$(npm root -g)/@deepseek-ai/dsh"
```

The functional checks use temporary files and clean them up. They assert
cross-process locking, refusal to overwrite existing files, image decoding,
terminal execution, and the installed search resolver. The web test starts
a separate server on a random loopback port with empty settings, checks its
authenticated page, and stops only that test process. It does not use API
keys or send a model request.

The release check should also install DSH into a temporary npm prefix with
an empty npm cache and Termux's supplied headers, apply the patches twice,
and run both checks above against that installation. This detects accidental
dependence on an earlier patched package or an existing node-gyp cache.

These checks do not substitute for installation on a fresh Android phone.
Final acceptance includes a real prompt, creating and editing files,
searching, saving and reopening a conversation, and an existing-conversation
migration when testing an upgrade. Android background-process behavior and
optional browser setup are separate checks.
