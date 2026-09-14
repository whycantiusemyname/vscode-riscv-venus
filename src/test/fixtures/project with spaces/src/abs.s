.text
.globl abs
abs:
    lw t0, 0(a0)
    bge t0, zero, done
    sub t0, zero, t0
    sw t0, 0(a0)
done:
    ret
