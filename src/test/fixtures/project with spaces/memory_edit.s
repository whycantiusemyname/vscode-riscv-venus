.data
slot: .word 0

.text
.globl main
main:
    la t0, slot
    li t3, 7
    addi t4, t3, 0
    lw t1, 0(t0)
    add t2, t1, zero
done:
    j done
