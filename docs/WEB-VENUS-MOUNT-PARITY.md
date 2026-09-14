# Web Venus mount workflow ↔ native extension parity

The Fa24 project pages tell students to point the web Venus simulator at a local
directory by starting a mount server and mounting it in the browser. This note
maps those steps onto the native VS Code extension, so that the extension is not
described as needing the literal web-server command.

## What the course docs ask for

| Fa24 evidence | Instruction | What it actually does |
| --- | --- | --- |
| `course-fa24/website/fa24/projects/proj2/index.html:235` | `java -jar tools/venus.jar . -dm` | starts the Venus **mount server** for the current directory on a local port (default 6161) |
| `.../proj2/index.html:239` | open `https://venus.cs61c.org`, run `mount local vmfs`, paste the key | binds that local directory into the browser simulator's file system at `/vmfs` |
| `.../proj2/index.html:242` | Files tab / `ls vmfs` | browses and edits the local files in the browser |
| `.../projects/proj2/part-a/index.html:319,413,484,579` and `part-b/index.html:378,628,825,1227,1237` | `cd /vmfs/test-src`, `ls`, `vdb test_abs_one.s` | runs the web debugger on the course tests |
| `.../labs/lab03/index.html:230-237` and `.../resources/venus-reference/index.html:237-256,384-395` | the same flow plus `--port`, the encryption key and `umount` | transport details of the mount server |

## Classification and native equivalents

| Web step | Kind | Native replacement |
| --- | --- | --- |
| `... -dm`, `--port`, encryption key, `mount` / `umount` | transport/setup | nothing to replace: the extension runs the Venus core in-process, so there is no HTTP mount server, port or session key |
| the mount root ("expose this directory") | transport/setup | the launch `cwd` attribute (default: the directory of the launched program), forwarded to the core through `setHostFileCwd` + `enableHostFileIO` in `src/venusRuntime.ts` |
| `vmfs/...` / Files tab: open and edit | setup UX | the VS Code explorer and editor; `Venus: Open Assembly` opens the disassembly view |
| program file I/O (`ecall` 13/14/15/16 reading `input.bin`, ...) | real capability | the host file I/O bridge, binary safe, resolving relative paths against the configured `cwd` (`test/native/HOST-BINARY-FILE-IO.md`) |
| `cd /vmfs/test-src` + `vdb test_abs_one.s` | real capability | a native debug session: open `test-src/test_abs_one.s`, start the debugger, then use breakpoints, Step, Step Over, Step Out, Pause, Continue and Prev (`CS61C-ACCEPTANCE.md` items 1-11) |

## What the extension deliberately does not claim

- It never starts a mount server and never needs `java -jar tools/venus.jar . -dm`,
  `--port` or the browser key exchange.
- It does not implement the `/vmfs` prefix, `mount` or `umount`. `/vmfs` is a
  browser-mount name, not a Venus path: the course JAR maps paths onto the host
  file system relative to its working directory, which is exactly what the native
  bridge does with the launch `cwd`. A teaching program that hard-codes `/vmfs/...`
  has to use a path relative to the launch `cwd` instead.
- The `riscv-venus.course.*` JAR bridge is unaffected: the web workflow is not part
  of its argv or its acceptance cases.

## CI coverage for the equivalence

- `scripts/ci/venus-course-parity.js`: the host file I/O cases (ecalls
  13/14/15/16/18/19/20) write and read real files relative to the per-case working
  directory.
- `src/test/suite/extension.test.ts`: `venus/runtimeInfo` reports host file I/O
  enabled for the effective launch `cwd` (falling back to the program directory).
- `src/test/suite/editing.test.ts` and `stepback.test.ts`: editing and Prev run
  entirely in-process; no mount server is involved.
