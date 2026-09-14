# Prints argc and every argv entry, one per line, then exits with code 0.
#
# Venus initializes a0 = argc and a1 = argv (verified against the pinned JAR;
# this is the opposite order from one of the venus-reference paragraphs).
.data
label_argc: .string "argc="
label_argv: .string "argv["
label_eq:   .string "]="
newline:    .string "\n"

.text
.globl main
main:
    addi sp, sp, -16
    sw ra, 0(sp)
    sw s0, 4(sp)
    sw s1, 8(sp)
    sw s2, 12(sp)

    mv s0, a0               # argc
    mv s1, a1               # argv
    li s2, 0                # index

    li a0, 4
    la a1, label_argc
    ecall
    li a0, 1                # print_int
    mv a1, s0
    ecall
    li a0, 4
    la a1, newline
    ecall

loop:
    bge s2, s0, done

    li a0, 4
    la a1, label_argv
    ecall
    li a0, 1
    mv a1, s2
    ecall
    li a0, 4
    la a1, label_eq
    ecall

    slli t0, s2, 2
    add t0, s1, t0
    lw a1, 0(t0)
    li a0, 4                # print_str
    ecall
    li a0, 4
    la a1, newline
    ecall

    addi s2, s2, 1
    j loop

done:
    lw ra, 0(sp)
    lw s0, 4(sp)
    lw s1, 8(sp)
    lw s2, 12(sp)
    addi sp, sp, 16

    li a0, 17               # exit2
    li a1, 0
    ecall
