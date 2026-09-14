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
