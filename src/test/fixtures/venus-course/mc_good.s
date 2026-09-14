# Allocates through the course malloc wrapper (Venus 0x3CC with a6=1, the same
# API lab03/utils.s and proj2/src/utils.s expose) and frees the block with a6=4,
# so memcheck has nothing to report: the access is inside a registered block and
# no block is left unfreed. A raw ecall 9 (sbrk) is not registered with memcheck
# and is reported as an invalid access instead.
.data
marker: .string "heap roundtrip ok\n"

.text
.globl main
main:
    li a1, 16               # size
    li a0, 0x3CC            # memcheck-aware malloc
    addi a6, x0, 1
    ecall                   # a0 = block

    li t1, 123
    sw t1, 0(a0)
    lw t0, 0(a0)

    mv a1, a0               # block
    li a0, 0x3CC            # memcheck-aware free
    addi a6, x0, 4
    ecall

    li a0, 4                # print_str
    la a1, marker
    ecall

    li a0, 17               # exit2
    li a1, 0
    ecall
