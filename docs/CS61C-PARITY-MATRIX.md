# CS61C Fa24 Venus 插件：需求基线与 Gap Matrix

> 角色：Agent 1/10（需求基线 + gap matrix）。
> 本文只描述"课程真正需要什么"与"当前插件到哪一步"，不修改 `course-fa24` 学生作业。
> 基线快照：worktree `codex/venus-agent1` @ `ccd92fb`。

---

## 1. 证据来源

| 类别 | 文件 |
| --- | --- |
| 交接说明 | `VENUS-PLUGIN-HANDOFF.zh-CN.md` |
| 官方功能定义 | `course-fa24/website/fa24/resources/venus-reference/index.html` |
| Lab 3 题面 | `course-fa24/website/fa24/labs/lab03/index.html` |
| Lab 4 题面 | `course-fa24/website/fa24/labs/lab04/index.html` |
| Lab 3 代码 | `course-fa24/labs/lab03/{ex1_hello,ex3_memcheck,ex4_discrete_fn,ex4_discrete_fn_tester,ex5_factorial,fib,utils}.s` |
| Lab 4 代码 | `course-fa24/labs/lab04/{ex1,ex2,ex3,example_c_to_riscv}.s` |
| Proj2 源码 | `course-fa24/projects/proj2-cs61classify/src/*.s` |
| Proj2 判分器 | `.../framework.py`、`.../unittests.py`、`.../studenttests.py`、`.../test.sh` |
| Proj2 工程配置 | `.../.vscode/{launch,tasks,settings,extensions}.json` |
| 本地 JAR 入口 | `scripts/venus.ps1` |
| 插件源码 | `src/venusRuntime.ts`、`src/venusDebug.ts`、`src/memoryui/memoryUI.ts`、`src/runtime/*`、`package.json` |
| 插件自述 | `CS61C-ACCEPTANCE.md`、`CHANGELOG.md`、`readme.md` |
| 后端核心 | 子模块 `src/runtime/venus`（`venus` fork，branch `js`，pin `70472ec`） |

**判定口径**：`MUST`（课程确实依赖）／`NOT-USED`（课程未使用）／`GAP`（课程需要但插件缺失或不完整）。

---

## 2. 基线 A —— 课程真正使用的 Venus 能力（MUST）

### A1. 汇编与运行（assemble / run）

- 题面：`lab03/index.html:291-294`（Assemble and Simulate from Editor / Re-assemble from Editor）。
- CLI：`lab03/index.html:547`、`:563` 均是 `java -jar tools/venus.jar <file.s>`。
- Proj2 判分器每例都执行一次 assemble+run：`framework.py:33-47`。
- **必须**：从脚本给定的 `.s` 入口装配并运行到结束。

### A2. 多文件 `.import` 与 `.globl`

- `.import` 真实用例：`lab03/ex3_memcheck.s:1`（`.import utils.s`）、`lab03/ex4_discrete_fn_tester.s:1`（`.import ex4_discrete_fn.s`）、`proj2/src/main.s:1-8`（8 条 import）。
- `.globl` 跨文件导出：`lab03/utils.s:1`、`lab04/ex1.s:1`、`proj2/src/*.s:1`、`proj2/src/utils.s:21-30`。
- 语义定义：`venus-reference/index.html:611-616`（`.import` 只暴露 `.globl` 标签，相对路径解析）。
- 后端实现：`venusbackend/linker/ProgramAndLibraries.kt:41-45`（按 import 方所在目录解析相对路径）。
- **必须**：相对路径 `.import` 正确解析；源映射必须能指回被 import 的文件。
- **注意**：CC checker 只检查 `.globl` 函数（`lab04/index.html:539`、`venus-reference:496-498`）。

### A3. 指令 / 伪指令 / 伪操作覆盖

课程实际出现的指令（穷举自 lab03/lab04/proj2-src）：

- 算术逻辑：`add` `addi` `sub` `mul` `slli` `li` `mv` `la`
- 访存：`lw` `sw`
- 控制流：`jal` `jalr` `jr` `j` `beq` `bne` `bge` `ret` `ecall` `ebreak`(题面)
- 伪操作：`.text` `.data` `.globl` `.import` `.word` `.asciiz` `.string` `.align` `#define`
- 书写风格：**空格分隔操作数**（如 `la a0 n`、`lw a0 0(a0)`、`addi t0, a0, 3` 混用），字符字面量（`li a1, '\n'`）。
- 证据：`lab03/ex1_hello.s`、`lab03/ex5_factorial.s`、`lab03/utils.s`、`lab04/ex1.s:4-12`、`lab04/ex2.s:2-3`。

### A4. ecall 系统调用面

Proj2 `src/utils.s:5-18` 显式定义课程使用的全部编号：

| # | 名称 | 用途 |
| --- | --- | --- |
| 1 | print_int | 输出整数 |
| 4 | print_str | 输出字符串 |
| 5 | atoi | 字符串转整数 |
| 9 | sbrk | 堆分配 |
| 10 | exit | 退出 |
| 11 | print_char | 输出字符 |
| 13 | openFile（fopen） | 打开文件 |
| 14 | readFile（fread） | 读文件 |
| 15 | writeFile（fwrite） | 写文件 |
| 16 | closeFile（fclose） | 关文件 |
| 17 | exit2 | 带退出码退出 |
| 18 | fflush | 刷新 |
| 19 | feof | EOF 判定 |
| 20 | ferror | 错误判定 |
| 34 | printHex | 十六进制输出 |

另：`lab03/utils.s:6,13` 以 `a0=0x3CC` + `a6=1/4` 实现 malloc/free，Lab3 依赖该路径。
约定：syscall 号放 `a0`（`venus-reference:623-639`，与 Linux 用 `a7` 不同）。

### A5. 执行控制：run / step / stepOver / stepOut / pause

- 题面按钮：Run（`:311`）、Step（`:313`）、**Prev = 回退一条指令**（`:314`）、Reset（`:315`）、Dump（`:317`）。
- `Prev` 即 step back，是 Lab3/Lab4 的显式教学动作。
- 后端能力：`Simulator.kt:355 undo()`、`:514 canUndo()`、`History.kt`（`max_history` 限制回退深度，对应设置项 "Max History"，`venus-reference:413-414`）。

### A6. 断点

- 点击行设置断点（`venus-reference:295`）、`ebreak` 指令强制暂停（`:296-305`，含条件断点写法）。
- **必须**：断点能落在被 `.import` 的源文件行上（Proj2 的最小闭环即 `test_abs_one.s` import `abs.s` 后在 `abs.s` 命中）。

### A7. 寄存器与内存的观察 / 修改

- 观察：寄存器、内存、cache 侧栏（`venus-reference:318`）；Display Settings 十六进制/ASCII/补码十进制/无符号（`:323-324`）。
- **修改寄存器**：`venus-reference:320`「You can manually poke values in registers to affect the execution」。
- 内存导航：Jump to / Address（`:321-322`）。
- 后端写原语存在：`Driver.kt:323-332` `storeByte/storeHalfWord/storeWord/storeLong`。

### A8. CLI 参数（仿真器 flag 与程序参数）

- 课程脚本 `scripts/venus.ps1` 覆盖的 flag：`-cc` `-mc` `-mcv` `-it` `-ahs` `-eoe` `-fa` `-ms <n>` `-wd <dir>`，程序参数以 `--` 分隔。
- Proj2 判分器 flag：`--immutableText`、`--maxsteps -1`、`--callingConvention`、`--coverageFile <path>`、`--def #NAME=...`（`framework.py:21,35,64,473`）。
- 程序参数：`unittests.py:602-612` 传 4 个文件名；`unittests.py:639` 传 `[""]` 触发 code 31。
- 参数传递语义：`venus-reference:439-458`（文件名之后是程序参数；`--` 可强制把形如 flag 的字符串当程序参数）。
- **矛盾待验证**：`:406` 写 `a0=argc, a1=argv`，`:445` 写 `a0=argv, a1=argc`。以真机行为为准，需实测。
- `test.sh`/`unittests.py:702-704` 支持把 `--` 之后的参数透传为 Venus flag（例如 `bash test.sh all -mcv`，见 `framework.py:457`）。

### A9. 文件 I/O

- Proj2 核心：`read_matrix.s`（fopen/fread/fclose，错误码 26/27/28/29）、`write_matrix.s`、`classify.s`（4 个文件参数），输出与 `reference.bin` 逐字节比对（`unittests.py:614`、`:689-698`）。
- 二进制数据：`tests/*/*.bin`，`tests/chain-1/chain.s` 直接跑多轮分类。
- **必须**：程序能读到工作目录下的真实 `.bin`，写出的 `output.bin` 能被 Python 侧读到并比对。
- 后端现状：`FilesHandler.kt` 的 open/read/write/close 全部走 `sim.VFS`；`VirtualFileSystem.kt` 是 localStorage 后端（`LSName = "VFS_DATA"`），仅声明了 `@JsModule("fs") readFileSync`。
- **结论**：默认后端文件 I/O 落在虚拟文件系统而非宿主磁盘 → 这是 Proj2 的关键 gap（见 §4）。

### A10. stdout / stderr / 退出码

- stdout 必须逐字匹配：`unittests.py:681` 断言 `"Two classifications:\n2\n...\n\nExited with error code 0"`。
- stderr 必须为空（仅允许 `Found 0 warnings!`）：`framework.py:550-553`。
- 退出码必须匹配：`framework.py:570-576`；用例 `unittests.py:626`（code 26，malloc 失败注入）、`:639`（code 31，参数不足）。
- **必须**：退出码要能被调试器/终端观察到，且与 JAR 一致。

### A11. 课程工具链：`-cc` / `-mc` / `-mcv` / coverage / `--def` / trace

- `-cc`：Lab4 全篇依赖（`lab04/index.html:541-543`）；语义与三类违规信息见 `venus-reference:483-576`。
- `-mc` / `-mcv`：Lab3 memcheck（`lab03/index.html` 的 "Venus: Memcheck" 小节；`venus-reference:594-602`）。
- coverage：Proj2 `test.sh coverage` → `studenttests.py`，依赖 `--coverageFile`（`framework.py:64`）。
- `--def`：判分器注入 `FOPEN_RETURN_HOOK` / `FREAD_RETURN_HOOK` / `MALLOC_RETURN_HOOK`（`framework.py:473`、`proj2/src/utils.s` 中对应 hook 注释）。
- `--trace` / `--tracepattern`：定义于 `venus-reference:577-592`，课程未在 lab/proj 中直接调用。

### A12. 测试脚本与工程集成

- `test.sh` 子命令：`all` `coverage` `test_abs` `test_relu` `test_argmax` `test_dot` `test_matmul` `test_read_matrix` `test_write_matrix` `test_classify` `test_chain` `download_tools`。
- `unittests.py` 会生成 `test-src/test_*.s` 驱动（`framework.py` 的 `save_assembly`），并 `check_hashes()` 校验工具完整性（`unittests.py:706`）。
- VS Code 侧：`proj2/.vscode/tasks.json` 以 Git Bash 跑 `test.sh`；`.vscode/launch.json` 用 `type: "venus"` 调试 `test-src/*.s`，字段 `program / stopOnEntry / stopAtBreakpoints / openViews`，并含 `preLaunchTask` 生成驱动。
- `proj2/.vscode/settings.json` 使用插件设置：`riscv-venus.variableFormat`、`riscv-venus.onlyShowUsedRegs`、`riscv-venus.mutableText`。
- 运行目录约定：判分器 `cwd=test_asm_dir`（`framework.py:47`，即 `test-src/`）；`TestChain` 从工程根跑（`unittests.py:672`）。**工作目录必须是可配置的。**

---

## 3. 基线 B —— 课程**未使用**的 Venus 能力（NOT-USED）

以下在 Venus 中存在，但 Fa24 Lab3/Lab4/Proj2 未依赖；插件不支持它们**不构成** parity 缺口。

| 能力 | 证据 |
| --- | --- |
| Chocopy 标签页 | `venus-reference:330-333`「You can ignore this tab」 |
| LED Matrix / Robot / Seven Segment 外设 ecall（0x100-0x101、0x110、0x120-0x122） | 仅插件自带 `examples/`，课程 lab/proj 无引用 |
| 浮点寄存器 / CSR / 特权态、Trap | 仅 `examples/privileged`、`examples/basicTrap` |
| Terminal 交互式输入 ecall 0x130 / 0x131 | 课程输入全部走文件，无 stdin 依赖 |
| `mount` / `vdb` / `run` / `edit` 等网页终端命令 | `venus-reference:338-398`；课程用本地 JAR + VS Code 替代 |
| 网页版 cache 视图、Dark Mode、Text Start 设置 | 非判分相关 |
| `--trace` / `--tracepattern` | 未在 lab/proj 脚本中调用 |
| Tracer 面板 | `venus-reference:432-434` |
| `-it` / `-ahs` / `-eoe` / `-fa` | 仅在 `scripts/venus.ps1` 暴露为可选开关，课程作业未强制 |

> 说明：`-it`、`-eoe`、`-ahs`、`-fa`、`-ms` 由用户脚本 `scripts/venus.ps1` 提供，属于"用户自建便利入口"，非课程强制项；但 `--immutableText` 与 `--maxsteps` 是判分器默认值（`framework.py:21`），必须支持。

---

## 4. Gap Matrix

图例：✅ 已实现｜🟡 部分/有隐患｜❌ 缺失

| # | 能力 | 课程证据 | 插件现状 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | assemble + run | `framework.py:33-47`；`lab03/index.html:547` | `venusRuntime.ts:120-147` 读盘 → `driver.externalAssemble` | ✅ |
| 2 | `.import` 相对路径 + 跨文件源映射 | `proj2/src/main.s:1-8`；`lab03/ex3_memcheck.s:1` | `venusRuntime.ts:176-205` 建 `pcToAssemblyLine`/`sourceLineToPc`；`ProgramAndLibraries.kt:41-45` 走 VFS 解析 | 🟡 需实测（子模块未构建，无法运行验证） |
| 3 | 断点（含被 import 文件） | `venus-reference:295`；`.vscode/launch.json` | `venusRuntime.ts:628-728`；`venusDebug.ts:284-305` | 🟡 单文件已验证，跨文件待复测 |
| 4 | step / stepOver / stepOut / run / pause | `venus-reference:311-316` | `venusRuntime.ts:398-453`；`venusDebug.ts:480-520` | ✅ |
| 5 | **step back（Prev）** | `venus-reference:314`；Lab3/4 教学动作 | `venusRuntime.ts:398-406` 调 `driver.undo()` + `_stackHistory`；DAP `supportsStepBack=true`（`venusDebug.ts:198`）、`stepBackRequest`（`:528-531`） | 🟡 已接线，受 `maxHistory` 限制，端到端未验收；且与 `CS61C-ACCEPTANCE.md` 自述「Step Back 不advertised」**文档漂移** |
| 6 | 寄存器查看 | `venus-reference:318` | `venusRuntime.ts:237-293`（int/float/CSR） | ✅ |
| 7 | 寄存器修改 | `venus-reference:320` | DAP `supportsSetVariable=true`；`venusRuntime.setRegister/setFRegister/setCsrRegisterByName`；`venusHelpers.parseRegisterName` 接受 `x05 (t0)   `/`x5`/`t0`，`parseVenusValue` 对齐后端 `userStringToInt`（`0x`/`0b`/字符字面量/当前显示进制）；响应回读模拟器真实值 | ✅ 写入立即回读且被后续指令消费（`src/test/suite/editing.test.ts`） |
| 8 | **内存查看** | `venus-reference:318,321-322` | DAP `supportsReadMemoryRequest=true` → `VenusRuntime.readMemoryBytes` → `driver.loadByte`；`memoryui/memoryUI.ts` 仍走同一字节源 | ✅ 字节寻址/小端，返回真实 `lw` 所见字节 |
| 9 | **内存修改** | `venus-reference:320`（poke） | DAP `supportsWriteMemoryRequest=true` → `VenusRuntime.writeMemoryBytes` → `driver.storeByte` 并 `MemoryUI.update()` 刷新；运行中拒绝写入，`mutableText=false` 时拒绝改写 text（对齐 `storeWordwCache` 的 StoreError） | ✅ 字节粒度，写入影响后续 `lw`（`editing.test.ts` 断言） |
| 10 | 程序 CLI 参数 | `unittests.py:602-612`；`venus-reference:439-458` | `frontendAPI.setArgs` → `Driver.kt:547-550`；`launch.json` 的 `args` | 🟡 argv/argc 顺序存在文档矛盾（`:406` vs `:445`），需实测 |
| 11 | stdout 一致 | `unittests.py:681` | `ex: "Exited with error code N"`（`Driver.kt:526-531`）→ 终端捕获 | 🟡 未与 JAR 逐字比对 |
| 12 | stderr 干净（仅 `Found 0 warnings!`） | `framework.py:550-553` | 无对应处理/嗅探 | ❌ |
| 13 | **退出码** | `framework.py:570-576`；`unittests.py:626,639` | `exitcodecheck()` 被调用（`venusRuntime.ts:508,515,522`）但未通过 DAP 上报 | ❌ |
| 14 | **文件 I/O（真实磁盘）** | `read_matrix.s`/`write_matrix.s`；`tests/*/*.bin` | `FilesHandler.kt` → `sim.VFS`（localStorage 后端，`VirtualFileSystem.kt`） | ❌ **Proj2 头号 gap**：读写不落宿主磁盘 |
| 15 | **`-cc` / `--callingConvention`** | `lab04/index.html:541-543`；`venus-reference:483-576` | `src/` 无任何实现，仅 `fake.index.html.ts:52` 一个死按钮 | ❌ Lab4 全部依赖 |
| 16 | **`-mc` / `-mcv` memcheck** | `lab03` memcheck 小节；`venus-reference:594-602` | `src/` 无任何实现 | ❌ |
| 17 | **`--coverageFile`** | `framework.py:64`；`part-a/index.html:691`（`bash test.sh coverage`） | `riscv-venus.course.coverageFile` → `venusCourseArgs.ts` 在 `-ms` 之后、`-wd` 之前发 `--coverageFile <path>`（相对路径按运行目录解析，`venusCourseCommands.ts`）；`courseVenus.test.ts` 断言 argv；`scripts/ci/venus-course-parity.js` 的 `checkCoverageFile` 对比直跑与桥接写出的 coverage map | ✅ |
| 18 | **`--def` 钩子注入** | `framework.py:473`；`proj2/src/utils.s:152,172,276` hook 注释 | `riscv-venus.course.defines` → 每个条目发一对 `--def <key=value>`，原文透传；`src/test/fixtures/venus-course/defs_hook.s` 在差分测试中证明替换生效（有 define 打印 7，无 define 打印 3） | ✅ |
| 19 | `--immutableText` | `framework.py:21` | `simSettings.mutableText`（`venusRuntime.ts:153-155`），默认 `true` 与课程默认相反 | 🟡 语义存在但默认值冲突 |
| 20 | `--maxsteps` / `-ms` | `framework.py:21` | `simSettings.maxSteps`（`venusRuntime.ts:162-164`；`venusDebug.ts:884`） | ✅ |
| 21 | `-wd` 工作目录 | `scripts/venus.ps1`；`framework.py:47` | 无；靠 `program` 路径推断 | ❌ 影响 `test-src/` 相对路径 |
| 22 | 测试脚本集成 | `test.sh`；`proj2/.vscode/tasks.json` | 由外部 task 调用 Git Bash，插件无参与 | ✅ 无需插件支持 |
| 23 | 构建可复现 | — | 子模块 `src/runtime/venus` 未初始化、无 `node_modules`、无 `dist/` | ❌ **阻断项** |

> **更新（agent10 使用面扫描，2026）**：第 15-18 行原判缺失，现由课程 JAR 桥接命令
> （`riscv-venus.course.run` / `.callingConvention` / `.memcheck` / `.memcheckVerbose`）
> 以及 `riscv-venus.course.coverageFile` / `.defines` 设置提供，并在
> `scripts/ci/venus-course-parity.js` 中以「直跑 JAR vs 桥接」差分验收；第 5/8/9/13/14/21
> 行由本次集成分支的其他提交补齐（见 `CS61C-ACCEPTANCE.md`）。本表其余判定仍为基线时点结论。

---

## 5. 验收命令

### 5.1 JAR 基线（权威参照，只读）

```bash
# 环境
java -version

JAR=course-fa24/projects/proj2-cs61classify/tools/venus.jar

# A1 最小运行
java -jar "$JAR" course-fa24/labs/lab03/ex1_hello.s

# A2 多文件 .import
cd course-fa24/labs/lab03 && java -jar ../../../"$JAR" -cc ex4_discrete_fn_tester.s

# A11 -cc（Lab4）
cd course-fa24/labs/lab04 && java -jar ../../../"$JAR" -cc ex1.s

# A11 -mc / -mcv（Lab3）
cd course-fa24/labs/lab03 && java -jar ../../../"$JAR" -mc ex3_memcheck.s

# A8/A9/A10 Proj2 全量判分（含文件 I/O、coverage、退出码）
cd course-fa24/projects/proj2-cs61classify && bash test.sh all
cd course-fa24/projects/proj2-cs61classify && bash test.sh coverage
cd course-fa24/projects/proj2-cs61classify && bash test.sh all -mcv
```

### 5.2 插件 parity 验收（每条对应 §4 行号）

```bash
# 前置：子模块 + 依赖 + Venus 核心构建（当前缺失）
git submodule update --init --recursive      # src/runtime/venus @ 70472ec (branch js)
npm install
npx grunt buildvenus                         # 产出 src/runtime/venus/build/kotlin-js-min/main/venus.js
npm run compile                              # 或 npm run webpack

# 扩展宿主验收（沿用 CS61C-ACCEPTANCE.md 路径）
npm run compile && node ./out/test/runTest.js
```

VS Code 内（`proj2/.vscode/launch.json`）：

| 验收点 | 动作 |
| --- | --- |
| 行 1/2 | `Venus: debug test_abs_one` → 装配成功 |
| 行 3 | 在 `src/abs.s` 下断点 → 命中且栈帧指向 `abs.s` |
| 行 4 | Step / Step Over / Continue / Pause 各一次 |
| 行 5 | Debug Console 或 Prev 按钮回退一条 |
| 行 6/7 | Variables 面板读改 `t0`；Memory 视图读地址 |
| 行 9 | Memory 写入一个 word/字节并回读，且程序随后的 `lw` 读到该值（`editing.test.ts`） |
| 行 13 | 记录退出码（当前预期失败：未通过 DAP 上报） |
| 行 14 | `bash test.sh test_read_matrix`（当前预期失败：VFS 不落盘） |
| 行 15/16/17/18 | `bash test.sh test_abs` 带 `-cc`、`-mc`、coverage（当前预期失败） |

---

## 6. 阻断与风险

1. **无法构建/运行**：`git submodule status` 显示 `-70472ec`（未初始化），`node_modules`、`dist/` 均不存在。所有"插件现状"只能靠源码静态判定，**尚无端到端实测证据**。
2. **后端与课程 JAR 版本不同源**：子模块是 `whycantiusemyname/venus` 的 `js` 分支（Kotlin 1.3.72 / Gradle 4.9 / version 0.1.0），课程用 `tools/venus.jar`（11,574,730 bytes）。memcheck、coverage、`--def`、CC checker 是否存在于该 JS 分支**未验证**。
3. **文件 I/O 架构性 gap**：后端经 `FilesHandler.kt` → `VirtualFileSystem`（localStorage）。要满足 Proj2 必须为 VFS 增加宿主磁盘桥接（或改用 JAR 子进程）。
4. **文档漂移**：`CS61C-ACCEPTANCE.md` 声明 Step Back 与可编辑内存"不 advertised"，但 `ccd92fb` 已将 `supportsStepBack=true` 接线。需二者对齐后再下结论。
5. **参数语义矛盾**：`venus-reference` 内部 `a0/a1 = argc/argv` 与 `argv/argc` 两处冲突，实现前必须实测 JAR。
6. **`-wd` 缺失**：判分器 `cwd=test-src/`，插件无工作目录设置，会导致相对文件路径解析差异。

---

## 7. 结论（给下游 agent）

**必须支持（P0）**：A1 assemble/run、A2 `.import`+`.globl`+源映射、A6 断点、A5 step/run/pause/step back、A7 寄存器读改、A8 程序参数、A9 **真实磁盘文件 I/O**、A10 **退出码**、A11 **`-cc` / `-mc` / `-mcv` / `--coverageFile` / `--def`**、A3 指令集与 `.globl` 语法。

**课程未使用，无需支持**：Chocopy、LED/Robot/SevenSeg 外设、浮点/CSR/特权、交互式 stdin、cache 视图、Dark Mode、`--trace`。

> **网页 Venus 工作流（`-dm` + `mount local vmfs` + 网页 `vdb`）**：Fa24 题面（`proj2/index.html:235-242`、
> `labs/lab03/index.html:230-237`、`resources/venus-reference/index.html:237-256,384-395`）确实用它挂载本地目录并在
> 浏览器里调试，但那属于"传输/托管"层，不是需要复刻的功能：原生插件在进程内运行模拟器，以 launch `cwd` 为根直接读写
> 工作区（宿主文件 I/O 桥），文件浏览/编辑由 VS Code 承担，`vdb` 由原生 DAP 调试（断点/步进/Pause/Prev）代替。
> 因此验收不应要求 `java -jar tools/venus.jar . -dm`；`/vmfs/...` 只是网页端挂载名，程序应使用相对 launch `cwd`
> 的路径。逐条映射与非声明见 `docs/WEB-VENUS-MOUNT-PARITY.md`。

**当前最大缺口排序**：① 构建链缺失（阻断一切验证）→ ② 文件 I/O 不落宿主磁盘 → ③ `-cc`/`-mc`/coverage/`--def` 全缺 → ④ 退出码未上报 → ⑤ 内存不可写、`-wd` 缺失 → ⑥ step back 与文档漂移。
