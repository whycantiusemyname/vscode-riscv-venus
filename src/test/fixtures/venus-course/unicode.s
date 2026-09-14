# Prints non-ASCII bytes so the bridge's output decoding is compared with a
# direct `java -jar` run byte for byte.
.data
message: .string "unicode: héllo 世界 ☃\n"

.text
.globl main
main:
    li a0, 4
    la a1, message
    ecall
    li a0, 17
    li a1, 0
    ecall
