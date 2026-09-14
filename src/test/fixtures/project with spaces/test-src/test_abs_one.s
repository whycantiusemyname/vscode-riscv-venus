.import ../src/abs.s

.data
value: .word -1

.text
.globl main
main:
    la a0, value
    jal ra, abs
    lw t0, 0(a0)
    li t1, 1
    bne t0, t1, fail
    li a0, 10
    ecall

fail:
    li a0, 17
    ecall
