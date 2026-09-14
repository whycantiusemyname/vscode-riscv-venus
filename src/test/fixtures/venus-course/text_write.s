# Stores into the text segment. `-it` must reject this; without `-it` it is
# allowed (the JAR default).
.text
.globl main
main:
    la t0, main
    li t1, 0x00000013
    sw t1, 0(t0)
    li a0, 17
    li a1, 0
    ecall
