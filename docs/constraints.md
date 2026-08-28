# Hard constraints

These are the conditions the project exists to satisfy. They are not defaults
and not preferences: a change that breaks one is wrong even when it works, even
when every test passes, and even when it makes something better on the machine
it was written on.

They come from the brief this project started with, and for most of its life
they lived only in the choices they produced — a Windows asset that happened to
say `cpu` in its filename, an install that happened to write only under
`AMALGAM_HOME`. Nothing named them, so nothing defended them, and they were
broken in good faith by someone adding platform support who had no way to know
they existed. `tests/constraints-eval.mjs` now checks what can be checked
mechanically. This file carries the rest, and the reasoning.

## 1. No GPU

**The target is a virtual machine with no GPU** — a Windows guest on ESXi, a VDI
session. Not "prefers CPU" and not "falls back to CPU": there is no device to
fall back from.

Choosing a CPU-only build is not sufficient, because for one platform none is
published. llama.cpp's macOS arm64 release always contains Metal, and that
binary answers:

```
$ llama-server --list-devices
Available devices:
  MTL0: Apple M2 (18186 MiB, 18185 MiB free)
```

llama.cpp offloads to whatever it finds unless told not to. So the guarantee is
made **at launch, not at packaging**: every `llama-server` this project starts
is passed `CPU_ONLY` from `lib/services.mjs` — `--device none -ngl 0` — on every
platform, including Windows, where it also protects against a future mirrored
build quietly gaining a backend. Any new call site that spawns llama-server
must pass it.

Prefer a `-cpu` upstream asset where one exists. Never mirror a `cuda`,
`vulkan`, `rocm`, `sycl`, `opencl` or `openvino` build.

## 2. Nothing is installed, and nothing needs admin

No `sudo`, no elevation prompt, no service registration, no package manager, no
writes to `/usr/local`, `Program Files` or the registry. Everything is portable
or built here.

This is why memory is SQLite through Node's built-in module: the portable
PostgreSQL it replaced wanted a 307 MB download, an `initdb`/`pg_ctl` lifecycle
and a TCP port. It is why the local model is a file plus a binary the user's own
account starts, rather than a daemon.

**The one exception, and it is deliberate: Node itself.** The memory store needs
Node 22.5+ *built with SQLite's FTS5*, and amalgam cannot supply it — every
entry point is a Node script, so Node has to exist before anything here can run.
It is documented as a prerequisite, `lib/preflight.mjs` checks for the
capability rather than the version number, and the instructions point at the
official portable archives, which need no installer and no administrator. The
user installs it; amalgam only ever *tells* them.

## 3. Portable, including where user space is not writable

Assume the user may not be able to write to their home directory, and that the
whole installation may move — a new drive letter in a VDI session, a remounted
share, a USB stick. Everything stored lives under `AMALGAM_HOME`, read from the
environment on every path that needs it:

```
process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam")
```

`~/.amalgam` is the default, never an assumption. Nothing may resolve a storage
path another way, and nothing may hard-code `os.homedir()` for anything it
writes.

Relocatability also governs what gets written *into* configuration. `wire` and
`shim` record the bare word `node` whenever `node` on PATH already resolves to
the running binary, and an absolute path only when it does not — because an
absolute path is frozen to a location, and a portable install moves.

## 4. Nothing is fetched from a host this project does not publish

From the brief: no cloud services and no model services for anything except the
call to the frontier model. Every payload comes from this repository's own
release — a fallback chain ending at huggingface, ggml-org or a CDN means the
answer to "where did this binary come from" is "whichever host answered",
decided on a machine nobody was watching, at the moment something had already
gone wrong.

Mirroring upstream into the release is a **publishing** step, run deliberately
on a maintainer's machine. It is the only moment anything here reads an upstream
host, and it never happens during an install.

**Shown is not fetched.** Upstream addresses are still printed — by
`manualHelp` when the release cannot be reached, and by `vendor-graph` when its
asset is missing. On a machine that cannot reach GitHub, the difference between
being told where a file lives and being left stuck is the whole difference, and
a person reading an address can see the host, weigh it, and check what they got.
What must not happen is this project contacting one on their behalf, quietly,
at the moment something has already gone wrong.

So the addresses live on fields named for what they are — `manualUrl`,
`manualMirrors`, `VIS_UPSTREAM` — and `tests/constraints-eval.mjs` asserts three
things: that `download()` reaches the release and nothing else, that no
third-party address appears anywhere but those fields, and that none of them is
ever passed to a fetcher.

## 5. Degrade, never fail

Optional components are optional in behaviour, not just in the installer.
Without the embedding model, search matches names instead of meaning. Without
the local model, digest and routing are absent and everything else is unchanged.

A missing capability must cost precision, never correctness, and never an error.
`amalgam status` reports which are in play, because a silently degraded machine
is worse than a loud one.

This does not extend to prerequisites. A store that cannot create its index is
not a degraded store, it is a store that cannot open — so the FTS5 check stops
rather than working around it.

## 6. The point is context, not features

Layered memory (TencentDB) and the code graph (Graphify) exist to reduce what
the frontier model has to be told; caveman compression exists to reduce what it
costs to say. A change that adds capability while increasing the tokens a
session spends is working against the reason any of this exists.
