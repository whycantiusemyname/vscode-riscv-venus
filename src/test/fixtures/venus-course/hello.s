# Prints one line and exits through ecall 10 (plain exit).
.data
message: .string "hello from venus\n"

.text
.globl main
main:
    li a0, 4                # print_str
    la a1, message
    ecall

    li a0, 10               # exit
    ecall
