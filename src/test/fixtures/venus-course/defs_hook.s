# --def acceptance fixture: the assembler replaces the #PRINT_HOOK token on its
# own line with whatever the caller defines, e.g.
# `--def "#PRINT_HOOK=li a1 7"`. Without --def that line is an ordinary Venus
# comment and the program still assembles, so the printed value tells the two
# runs apart. Project 2 uses the same mechanism for its fail-injection hooks
# (`#MALLOC_RETURN_HOOK=li a0 0`, see framework.py).
.text
.globl main
main:
    li a1, 3                # printed when no define is injected
    #PRINT_HOOK
    li a0, 1                # print_int
    ecall

    li a0, 10               # exit
    ecall
