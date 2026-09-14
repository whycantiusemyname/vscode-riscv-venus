# Allocates on the heap with ecall 9 before using it, so memcheck is silent.
.text
.globl main
main:
    li a0, 9                # sbrk
    li a1, 16
    ecall
    li t1, 123
    sw t1, 0(a0)
    lw t0, 0(a0)
    li a0, 17
    li a1, 0
    ecall
