# Same shape as cc_violation.s but saves and restores s1: `-cc` reports no
# warnings and exits 0.
.text
.globl main, f
main:
    jal ra, f
    li a0, 17
    li a1, 0
    ecall
f:
    addi sp, sp, -4
    sw s1, 0(sp)
    li s1, 7
    lw s1, 0(sp)
    addi sp, sp, 4
    jr ra
