# Loops long enough that -ms has to enforce a real bound; exits with code 42
# when it reaches the end.
.text
.globl main
main:
    li t0, 0
    li t1, 5000
loop:
    bge t0, t1, done
    addi t0, t0, 1
    j loop
done:
    li a0, 17
    li a1, 42
    ecall
