# Exercises the Project 2 host file syscalls end to end:
#   13 fopen, 15 fwrite, 18 fflush, 16 fclose, then
#   13 fopen, 14 fread, 19 feof, 20 ferror, 16 fclose.
# The file name contains spaces and is relative, so the host file lands in the
# working directory the JAR was started in.
.data
file_name:  .string "parity io file with spaces.txt"
payload:    .string "project2 file io payload\n"
label_read: .string "read bytes="
label_feof: .string " feof="
label_err:  .string " ferror="
label_ctnt: .string " content=["
label_end:  .string "]\n"
buffer:     .word 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
tail:       .word 0 0

.text
.globl main
main:
    addi sp, sp, -16
    sw ra, 0(sp)
    sw s0, 4(sp)
    sw s1, 8(sp)
    sw s2, 12(sp)

    # fd = fopen(file_name, 1)   # 1 = write
    li a0, 13
    la a1, file_name
    li a2, 1
    ecall
    mv s0, a0

    # fwrite(fd, payload, nitems = 25, size = 1)
    li a0, 15
    mv a1, s0
    la a2, payload
    li a3, 25
    li a4, 1
    ecall

    # fflush(fd)
    li a0, 18
    mv a1, s0
    ecall

    # fclose(fd)
    li a0, 16
    mv a1, s0
    ecall

    # fd = fopen(file_name, 0)   # 0 = read
    li a0, 13
    la a1, file_name
    li a2, 0
    ecall
    mv s1, a0

    # n = fread(fd, buffer, 64)
    li a0, 14
    mv a1, s1
    la a2, buffer
    li a3, 64
    ecall
    mv s2, a0

    # One extra read to drive the stream to EOF, then feof/ferror.
    li a0, 14
    mv a1, s1
    la a2, tail
    li a3, 1
    ecall

    li a0, 4
    la a1, label_read
    ecall
    li a0, 1
    mv a1, s2
    ecall
    li a0, 4
    la a1, label_feof
    ecall
    li a0, 19               # feof
    mv a1, s1
    ecall
    mv t0, a0
    li a0, 1
    mv a1, t0
    ecall
    li a0, 4
    la a1, label_err
    ecall
    li a0, 20               # ferror
    mv a1, s1
    ecall
    mv t0, a0
    li a0, 1
    mv a1, t0
    ecall
    li a0, 4
    la a1, label_ctnt
    ecall
    li a0, 4
    la a1, buffer
    ecall
    li a0, 4
    la a1, label_end
    ecall

    li a0, 16
    mv a1, s1
    ecall

    lw ra, 0(sp)
    lw s0, 4(sp)
    lw s1, 8(sp)
    lw s2, 12(sp)
    addi sp, sp, 16

    li a0, 17
    li a1, 0
    ecall
