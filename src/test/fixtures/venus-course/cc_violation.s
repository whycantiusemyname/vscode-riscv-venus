# Modifies the callee-saved s1 inside an exported function without saving it.
# `-cc` must report "[CC Violation]" and exit non-zero.
.text
.globl main, f
main:
    jal ra, f
    li a0, 17
    li a1, 0
    ecall
f:
    li s1, 7
    jr ra
