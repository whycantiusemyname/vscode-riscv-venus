# Venus cannot assemble this: ".not_a_directive" is not a known directive.
.not_a_directive 1

.text
.globl main
main:
    li a0, 10
    ecall
