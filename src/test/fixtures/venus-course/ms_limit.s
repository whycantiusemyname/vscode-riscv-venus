# Never terminates on its own; `-ms` is what stops it.
.text
.globl main
main:
    li t0, 0
loop:
    addi t0, t0, 1
    j loop
