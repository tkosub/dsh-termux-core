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

## Browser backend (installed with `--with-web-tools`)

Offline, no browser and no network — asserts the single-session ownership gate:
`owner` is required on every browser-touching tool, a second owner is refused by
name before anything starts, only the owner may close, `browse` takes the gate
and gives it back, and a lock record is honoured only while its holder pid is
alive with a matching kernel start time:

```bash
node browser/test-session-gate.mjs browser/session_server.mjs
```

Real acceptance, needs the proot Chromium — proves the two things the offline
test cannot: that a refused owner starts **no second Chromium**, and that
closing leaves no process behind that could hold the gate:

```bash
node browser/test-session-contention.mjs     # from browser/, with no other session open
python3 browser/nodriver_cf_test.py          # stealth + Cloudflare probe
```

Manual check through a live session (the deployed copies, not the repo):

```bash
# 1. refused, nothing booted
#    mcp__browser__browse {url:"https://example.com"}            -> refused: "no_owner"
# 2. claimed
#    mcp__browser__open  {url:"https://example.com", owner:"a"}  -> ok, session_id
# 3. second owner refused and named
#    mcp__browser__open  {url:"https://example.org", owner:"b"}  -> refused: "held_by", held_by "a"
# 4. released
#    mcp__browser__close {owner:"a"}                             -> closed, gate free
node -e 'const f=process.env.HOME+"/.dsh/run/browser-session.lock";try{console.log("HELD",require("fs").readFileSync(f,"utf8").trim())}catch{console.log("gate free")}'
```

Step 1 and 3 must not start a Chromium: `pgrep -f 'browser-session/user-data'`
counts one process tree at step 3 and none after step 4.

