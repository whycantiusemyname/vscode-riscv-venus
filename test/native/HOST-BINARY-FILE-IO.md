# Native host binary file I/O for Project 2 (ecalls 13-16)

Status: the core change is **prepared as patches under `test/native/patches/` and is not applied to
the pinned submodule**. Nothing in this directory has been compiled or executed on a developer
machine; validation is CI-only. This note is the maintained record of the change, how to apply it,
and what is still missing.

## The gap

The native debugger runs the Venus core compiled from `src/runtime/venus` (upstream
`hm-riscv/venus` pinned at `70472ec0`, which vendors `hm-riscv/venusbackend` at `aa96da2`) on
Node.js, where Project 2 programs use `fopen`/`fread`/`fwrite`/`fclose` (ecalls 13/14/15/16) to
read and write real files such as `input.bin`.

In that core, file contents travel through `String`/`StringBuilder` values: ecall 15 builds a
string from the guest buffer with `sim.loadByte(addr).toShort().toChar()` and ecall 14 stores
chars back with `storeBytewCache(..., c.toInt())`. Bytes outside ASCII (0x00, 0x80-0xff) do not
survive that trip, so a Project 2 matrix is corrupted. The course `venus.jar` does not have this
problem: its `VFSFile.readText`/`setText` are `Files.readAllBytes`/`writeBytes` with
`char = byte and 0xff`, and its `VirtualFileSystem` maps paths onto `java.io.File` relative to
`Driver.workingDir`.

Browser backends are unaffected by either behaviour: they have no host filesystem and keep using
the in-memory VFS.
## The change

`test/native/patches/0001-venusbackend-binary-safe-file-io.patch`, applied in
`src/runtime/venus/src/main/kotlin/venusbackend`:

- adds `simulator/FileHandle.kt`: the `FileHandle` interface (`read`/`write`/`flush`/`close` in
  terms of `ByteArray`) plus `HostFileDescriptor`, which reads with its own read offset and
  appends writes at the end of the file, like the JAR descriptor does;
- adds `simulator/HostFileSystem.kt`, the only place that touches Node's `fs`. The module is
  required lazily through `js(...)`, so browser builds never load it and host mode stays off
  unless the embedding enables it. It resolves absolute paths (POSIX, Windows drive, UNC) and
  resolves everything else against the configured working directory;
- makes `simulator/FileDescriptor.kt` (the VFS descriptor) implement `FileHandle` and move bytes
  instead of strings, keeping one char per byte (`byte and 0xff`) exactly like the JAR;
- switches `simulator/FilesHandler.kt` to `FileHandle` and opens files on the host while host mode
  is enabled, with the JAR's permission mapping (`0 r`, `1 w`, `2 a`, `3 r+`, `4 w+`, `5 a+`;
  anything else is EOF). A failed open returns EOF, like the JAR;
- fixes `riscv/insts/integer/base/i/ecall/ecall.kt`: ecall 15 fills a `ByteArray` with
  `sim.loadByte(addr) and 0xFF` and ecall 14 stores `b.toInt() and 0xFF`.

`test/native/patches/0002-venus-host-file-io-api.patch`, applied in `src/runtime/venus`:

- `venus.Driver` exposes `enableHostFileIO(enabled)`, `setHostFileCwd(path)` and
  `isHostFileIOEnabled()` as `@JsName` functions for the extension host;
- `venus.vfs.VirtualFileSystem.getObjectFromPath` consults the host first **only while host mode
  is enabled** and otherwise runs the upstream code path unchanged (including
  `fs.readFileSync`), so the browser and legacy VFS behaviour is not modified.
## Why this is a patch instead of a submodule update

Both repositories the change touches are upstream (`hm-riscv/venus`, `hm-riscv/venusbackend`), and
this repository cannot push commits to either. Pointing `src/runtime/venus` at a local commit
would leave every fresh clone and CI run with an unpushable submodule ("no such remote ref"), so
the pointer deliberately stays at `70472ec0`. The patches keep the change reviewable and
applicable today; once they land upstream the pinned commit can be bumped and both patches
dropped.

## Applying, building and running

```powershell
git submodule update --init --recursive      # the nested venusbackend submodule must exist
pwsh test/native/apply-host-file-io-patches.ps1 -Check   # verify the patches still apply
pwsh test/native/apply-host-file-io-patches.ps1          # apply them
npm run compileAll                           # rebuilds src/runtime/venus/build/kotlin-js-min/main
node test/native/host-file-io.test.js        # acceptance test for ecalls 13/14/15/16
node test/native/host-file-io-wiring.test.js # static check of the debugger opt in, no build
```

The test skips (exit 0) when there is no compiled core, or when the compiled core has no
`enableHostFileIO` API, so it is safe to run before the patches are applied. Set
`VENUS_REQUIRE_HOST_FILE_IO=1` to turn those skips into failures, which is what a CI job that
applies the patches and rebuilds the core should do.

The extension host wires this up for every native debug session: `src/venusRuntime.ts` calls
`setHostFileCwd(dirname(program))` and then `enableHostFileIO(true)` while a launch is assembled,
and `enableHostFileIO(false)` when the runtime stops, so the opt in lasts exactly as long as the
debug session. Both calls are guarded with `typeof ... === 'function'`, which leaves an
unpatched core exactly as it was. Nothing is enabled by default, so a browser or a Node session
that never assembles a debug launch keeps the previous behaviour, and a core that does implement
the API can still be driven by hand.

## What the test covers

`node test/native/host-file-io.test.js` loads the compiled core on Node, points host mode at a
temporary directory whose path contains spaces, and runs assembly programs through the simulator:

- every byte value 0x00..0xff survives a read/write round trip through `in.bin`/`out.bin`;
- relative paths resolve against the configured working directory, and an absolute path (with
  spaces) works as well;
- the permission, EOF and error returns match the JAR for missing files, invalid permissions,
  read-only writes, reads past end of file, double close and `feof`/`ferror`/`fflush`;
- append (`2`) keeps existing bytes and `w`/`1` truncates;
- with host mode disabled no host file is touched, i.e. the VFS backend still serves the ecalls.

The debugger side is covered by `node test/native/host-file-io-wiring.test.js`: a static check that
reads `src/venusRuntime.ts` and asserts that `assemble()` enables host file mode with the program
directory before assembling, that both core entry points are looked up defensively, and that
`stop()` resets the backend. It needs no build and no VS Code test host.

## Remaining risks and known limits

- **Unvalidated compile.** The Kotlin edits were reviewed by hand and both patches apply cleanly
  (`git apply --check`) to clean checkouts of `70472ec0` and `aa96da2`, but the core has not been
  compiled or executed. The first real compile happens in CI, so small Kotlin 1.3/Gradle 4.9
  fixes (for instance around `dynamic`/`js(...)` usage) may still be needed before the test can
  pass.
- **The opt in only helps once patch 0002 has been applied and the core rebuilt.** The debugger
  already calls `setHostFileCwd`/`enableHostFileIO` behind `typeof` guards, but a core without the
  API ignores them and keeps the old string-based path.
- **Descriptor semantics follow the JAR, not C stdio.** Writes append at the end of the file and
  reads advance a separate offset; the core has no `fseek`/`ftell`, so interleaving reads and
  writes on one `r+` descriptor behaves like the JAR rather than like a freshly opened C `FILE*`.
- **`feof`/`ferror` return 0**, as in the JAR, so programs must detect end of file from the EOF
  return of ecall 14.
- **Host lookups only happen while host mode is enabled**, and `VirtualFileSystem` falls back to
  its previous `fs.readFileSync` path when the host lookup finds nothing, so `make` semantics for
  VFS entries stay exactly as upstream.
- **The VFS backend still stores one char per byte in a `StringBuilder`.** That is the JAR's own
  representation and is binary-safe for the ecalls, but it gives the browser backend no real file
  I/O, which is out of scope here.