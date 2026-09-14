# Reads unallocated stack memory. `-mc`/`-mcv` must report it; Venus keeps
# running and still exits with the program's own code (0).
.data
after: .string "continued-after-memcheck\n"

.text
.globl main
main:
    li t0, 0x7fffff00
    lw t1, 0(t0)
    li a0, 4
    la a1, after
    ecall
    li a0, 17
    li a1, 0
    ecall
