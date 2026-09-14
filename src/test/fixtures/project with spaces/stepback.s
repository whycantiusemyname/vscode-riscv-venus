.data
value: .word 7

.text
.globl main
main:
    li t0, 1
    la a0, value
    li t1, 3
    jal x1, inc
    li t2, 9
    li a0, 10
    ecall

inc:
    lw t3, 0(a0)
    add t3, t3, t0
    sw t3, 0(a0)
    ret
