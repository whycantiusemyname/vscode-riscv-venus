# CS61C acceptance contract

The GitHub Actions workflow in `.github/workflows/ci.yml` is the source of
truth for build and extension-host acceptance. It uses JDK 8 only inside the CI
runner because the pinned Venus core still builds with Gradle 4.9 and Kotlin
1.3, then uses Node.js 20 to build and package the extension.

The extension-host suite validates the following native debugger path:

1. open a Project 2-shaped program under a directory containing spaces;
2. assemble `test-src/test_abs_one.s` with `.import ../src/abs.s`;
3. stop on entry and step once;
4. continue to a verified source breakpoint in the imported `src/abs.s`;
5. confirm the stack frame points to the imported source and expected line;
6. expose integer registers and modify `t0` through DAP `setVariable`;
7. start an infinite program and pause it without terminating the session;
8. package the exact accepted commit as a VSIX artifact.

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
