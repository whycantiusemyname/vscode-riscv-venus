## Unreleased
* Edit registers and memory through the native debugger: `setVariable` writes
  integer/float/CSR registers and `readMemory`/`writeMemory` read and write the
  byte addressed, little endian simulator memory that `lw`/`sw` use
* Accept Venus literal values (`0x1f`, `0b101`, `'a'`) and ABI register names
  (`t0`) when editing, and report the value read back from the simulator
* Refresh the Memory view after a debugger write; refuse register and memory
  writes while the program runs or into an immutable text segment
* Stop advertising data breakpoints: `dataBreakpointInfo` never offers a
  `dataId`, so no data breakpoint could be armed

## 1.9.1
* Add binary format to memory view
* Add option for selecting number of columns in memory

## 1.9.0
* Better align controls in memory view
* Simplify CSS of memory view using flex layout

## 1.8.1
* Fix and improve settings descriptions
* Reduce number of linter warnings

## 1.8.0
* Allow MemoryUI to be opened using launch.json
* Jump to address also when user confirms his entry by pressing return key

## 1.7.3
* Debugger now also uses breakpoints on labels

## 1.7.1
* Fixes a bug on Windows where the debugger does not stop at breakpoints

## 0.0.1-alpha
* Very early preview, basic debugging and register view
