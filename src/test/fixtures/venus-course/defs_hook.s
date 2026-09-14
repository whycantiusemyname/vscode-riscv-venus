# --def acceptance fixture: the assembler replaces the #PRINT_HOOK / #PRINT_HOOK2
# tokens on their own lines with whatever the caller defines, e.g.
# `--def "#PRINT_HOOK=li a1 7;#PRINT_HOOK2=li a1 9"`. Without --def those lines
# are ordinary Venus comments and the program still assembles, so the printed
# values tell the runs apart. Project 2 uses the same mechanism for its
# fail-injection hooks (`#MALLOC_RETURN_HOOK=li a0 0`, see framework.py).
.text
.globl main
main:
    li a1, 3                # printed when no define is injected
    #PRINT_HOOK
    li a0, 1                # print_int
    ecall

    li a1, 5                # printed when the second hook is not injected
    #PRINT_HOOK2
    li a0, 1                # print_int
    ecall

    li a0, 10               # exit
    ecall
