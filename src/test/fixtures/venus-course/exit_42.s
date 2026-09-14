# Exits through ecall 17 with a non-zero code; the JAR forwards it to the JVM.
.text
.globl main
main:
    li a0, 17
    li a1, 42
    ecall
