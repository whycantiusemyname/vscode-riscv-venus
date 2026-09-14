# Parses argv[1] with ecall 5 (the Project 2 `atoi` wrapper) and exits with it.
# Covers both the argv convention and the Project 2 exit-code path.
.text
.globl main
main:
    lw t0, 4(a1)            # argv[1]
    li a0, 5                # atoi
    mv a1, t0
    ecall
    mv t1, a0
    li a0, 17
    mv a1, t1
    ecall
