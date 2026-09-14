# CS61C acceptance contract

The GitHub Actions workflow in `.github/workflows/ci.yml` is the source of
truth for build and extension-host acceptance. It uses JDK 8 only inside the CI
runner because the pinned Venus core still builds with Gradle 4.9 and Kotlin
1.3, then uses Node.js 20 to build and package the extension.

`npm test` runs the real extension-host suite. `src/test/runTest.ts` opens each
scenario's workspace folder in VS Code with a private `--user-data-dir` and an
empty `--extensions-dir`, so an already running VS Code or an installed copy of
this extension cannot influence the result. Scenario data reaches
`src/test/suite/extension.test.ts` through `CS61C_ACCEPTANCE_*` variables.

1. open a Project 2-shaped program under a directory containing spaces;
2. assemble `test-src/test_abs_one.s` with `.import ../src/abs.s`;
3. stop on entry and step once;
4. continue to a verified source breakpoint in the imported `src/abs.s`;
5. confirm the stack frame points to the imported source and expected line;
6. expose integer registers and modify `t0` through DAP `setVariable`;
7. start an infinite program and pause it without terminating the session;
8. confirm a paused program stops advancing and that `continue` resumes it
   without a synthetic stop event;
9. confirm the launch `args` reach the program as `argv` (`a0` = argc,
   `a1` = argv) and that the launch `cwd` (default: the directory containing
   the program) is the working directory the runtime reports;
10. package the exact accepted commit as a VSIX artifact.

The adapter exposes `venus/runtimeInfo` for these checks: it returns the entry
file, the program arguments and the effective working directory the runtime was
initialised with. The `cwd` launch attribute is forwarded to the runtime, where
the host-disk bridge is expected to consume it; relative program paths are
resolved against it.

The course JAR remains authoritative for calling-convention checking,
memcheck, file-I/O error behavior, and exit-code tests. This extension does not
claim to replace `venus.jar -cc`, `venus.jar -mc`, or the Project 2 test suite.
Step Back and editable memory are not advertised: the bundled backend exposes
partial undo primitives and a read-only memory view, but neither currently has
the end-to-end state guarantees needed for a truthful claim.

## Differential acceptance against the pinned course JAR

`scripts/ci/venus-course-parity.js` (fixtures under
`src/test/fixtures/venus-course/`) exercises the extension course bridge - the
code behind the four `riscv-venus.course.*` commands - against the pinned
`course-fa24/projects/proj2-cs61classify/tools/venus.jar`. Every case runs
`java -jar` twice, once directly with the documented argv and once through
`buildVenusJarArgv` + `runVenusCourseProcess`, then compares the planned argv,
the exit code, the combined output, and the host files that were written:

- run, `-cc`, `-mc`, `-mcv`, `-ms -1` / `-ms 1000` / `-ms 5`, `-it` on and off;
- argv entries containing spaces and flag-shaped arguments;
- program paths and working directories containing spaces, including `-wd`, and
  a relative `workingDirectory` resolved against the project root;
- `ecall 17` exit codes (0, 42, and negative via `ecall 5` atoi), an assembler
  error, and a missing program file;
- Project 2 host file I/O (`ecall` 13/14/15/16/18/19/20) writing a relative file
  into the process working directory.

Run it with `npm run compile && npm run test:course-parity`; set
`VENUS_COURSE_JAR` when the JAR is not in the CS61C directory layout. Without a
JAR the harness exits 0 with a SKIPPED line, so CI sets `VENUS_COURSE_REQUIRE=1`
whenever the JAR is present to keep the check from passing silently.

## Native host binary file I/O (Project 2)

Project 2 programs read and write real files through ecalls 13/14/15/16. The bundled Venus core
still moves file contents through `String`/`StringBuilder` values, which does not preserve bytes
0x00 and 0x80-0xff. The binary-safe host file bridge is prepared as patches under
`test/native/patches/` and is **not** applied to the pinned submodule, because the two
repositories it changes (`hm-riscv/venus` at `70472ec0`, `hm-riscv/venusbackend` at `aa96da2`) are
upstream and this repository cannot push to them; pointing the submodule at a local commit would
break every fresh clone. `test/native/HOST-BINARY-FILE-IO.md` is the full note; the expected CI
contract is: check out submodules recursively, run
`pwsh test/native/apply-host-file-io-patches.ps1`, rebuild with `npm run compileAll`, and run
`VENUS_REQUIRE_HOST_FILE_IO=1 node test/native/host-file-io.test.js`. Until that happens, the
native debugger keeps its previous (non binary-safe) file I/O behaviour.

## Extension-host scenarios

Scenarios:

1. `project-root` - opens the in-repo Project 2 shape
   (`src/test/fixtures/project with spaces`) as the workspace root.
2. `spaced-copy` - copies that tree into a temporary directory whose full path
   contains spaces and opens the copy; the suite asserts that the stopped source
   is the copy and not the original.
3. `course-project2` - opt-in via `CS61C_PROJ2_ROOT`, which points at a checkout
   of `course-fa24/projects/proj2-cs61classify`. That directory is opened
   read-only; assignment sources are never copied over or modified.

Every scenario validates the same native debugger path:

1. the workspace root is the folder that was opened;
2. `test-src/test_abs_one.s` is edited as RISC-V and contains `.import ../src/abs.s`;
3. a source breakpoint at the first instruction of `abs` in the imported
   `src/abs.s` is forwarded to the adapter and verified;
4. stop on entry reports the driver, then `next` and `continue` reach a
   `stopped(breakpoint)` event whose top frame is the imported source file at
   the requested line, and stepping continues inside that file;
5. the Integer register scope is exposed and `t0` can be read and written
   through DAP `setVariable`;
6. an endless program answers `pause` with `stopped(pause)` and no `terminated`
   event, keeps the session active, and remains steppable.

Set `VSCODE_EXECUTABLE_PATH` to reuse an installed VS Code instead of
downloading one, and `CS61C_PROJ2_ROOT` to add the real course project
scenario.


The debugger side is already wired up:
`src/venusRuntime.ts` enables host file mode for the directory of the program being launched while
assembling and disables it when the runtime stops, both behind `typeof` guards, so an unpatched
core is unaffected. `node test/native/host-file-io-wiring.test.js` is the static check for that
wiring.
