# Acsus Chat Exporter

SillyTavern 聊天记录导出器。

- 电脑端本地 SillyTavern：安装扩展后，在魔杖扩展菜单点 `聊天记录导出` 即可。
- VPS / 安卓 Termux：推荐用命令行导出，压缩发生在服务器或手机终端里，更适合大体量聊天记录。

默认推荐模式是 `AI 阅读包`：

```text
--mode user-context
```

生成文件名：

```text
sillytavern-user-context-export.zip
```

成功时终端会出现：

```text
SillyTavern chat export complete
written=/某个路径/sillytavern-user-context-export.zip
```

看见 `written=` 才表示真的成功。

## 电脑端：浏览器按钮

把本仓库放到 SillyTavern：

```text
public/scripts/extensions/third-party/Acsus-Chat-Exporter
```

重启或刷新 SillyTavern 后：

1. 打开魔杖扩展菜单。
2. 点击 `聊天记录导出`。
3. 选择导出类型。
4. 等进度弹窗到 100%。

浏览器下载的 ZIP 通常在电脑的下载目录。

## VPS：一条命令导出 AI 阅读包

SSH 进入 VPS 后，复制整段执行：

```bash
ST_DIR="$HOME/SillyTavern"; OUT="$HOME/st-ai-reading-pack"; EXT="$ST_DIR/public/scripts/extensions/third-party/Acsus-Chat-Exporter"; [ ! -d "$ST_DIR/data/default-user" ] && echo "没找到 SillyTavern 数据目录：$ST_DIR/data/default-user。请修改命令开头的 ST_DIR。" && exit 1; mkdir -p "$(dirname "$EXT")" "$OUT"; if [ -d "$EXT/.git" ]; then git -C "$EXT" pull --ff-only; else rm -rf "$EXT"; git clone --depth 1 https://github.com/Achenono/Chat-Exporter.git "$EXT"; fi && node "$EXT/tools/export-sillytavern-chats.mjs" --data-dir "$ST_DIR/data/default-user" --mode user-context --out-dir "$OUT" && echo "完成，ZIP 在：$OUT/sillytavern-user-context-export.zip" && ls -lh "$OUT"/sillytavern-*.zip
```

默认输出位置：

```text
~/st-ai-reading-pack/sillytavern-user-context-export.zip
```

如果你的 SillyTavern 不在 `~/SillyTavern`，改命令最开头：

```bash
ST_DIR="$HOME/SillyTavern"
```

例如：

```bash
ST_DIR="/www/wwwroot/SillyTavern"
```

如果你想把 ZIP 放到别处，改命令开头的：

```bash
OUT="$HOME/st-ai-reading-pack"
```

例如：

```bash
OUT="/www/wwwroot/exports"
```

### 从 VPS 下载到手机

手机 Termux 里可以用：

```bash
pkg install openssh -y; mkdir -p /storage/emulated/0/Download/QQ; scp 用户名@你的VPS地址:~/st-ai-reading-pack/sillytavern-user-context-export.zip /storage/emulated/0/Download/QQ/
```

下载后去手机文件管理器找：

```text
内部存储 / Download / QQ / sillytavern-user-context-export.zip
```

## 安卓 Termux：一条命令导出到 Download/QQ

如果你的 Termux 提示符类似：

```text
root@localhost:~#
```

并且 SillyTavern 在：

```text
/root/SillyTavern
```

复制整段执行：

```bash
OUT="/storage/emulated/0/Download/QQ"; ST_DIR="/root/SillyTavern"; EXT="/root/.acsus-chat-exporter"; [ ! -d "$ST_DIR/data/default-user" ] && echo "没找到酒馆数据：$ST_DIR/data/default-user。请修改命令开头的 ST_DIR。" && exit 1; mkdir -p "$OUT"; rm -f "$OUT"/sillytavern-*.zip "$OUT"/sillytavern-*.zip.partial; rm -rf "$EXT"; git clone --depth 1 https://github.com/Achenono/Chat-Exporter.git "$EXT" && node "$EXT/tools/export-sillytavern-chats.mjs" --data-dir "$ST_DIR/data/default-user" --mode user-context --out-dir "$OUT" && echo "完成，ZIP 在：$OUT/sillytavern-user-context-export.zip" && ls -lh "$OUT"/sillytavern-*.zip
```

默认输出位置：

```text
/storage/emulated/0/Download/QQ/sillytavern-user-context-export.zip
```

手机文件管理器里对应：

```text
内部存储 / Download / QQ / sillytavern-user-context-export.zip
```

如果你的 SillyTavern 不在 `/root/SillyTavern`，改命令开头：

```bash
ST_DIR="/root/SillyTavern"
```

例如：

```bash
ST_DIR="/storage/1311-D4AB"
```

如果你想把 ZIP 放到别的文件夹，改命令开头：

```bash
OUT="/storage/emulated/0/Download/QQ"
```

例如放到外置存储根目录：

```bash
OUT="/storage/1311-D4AB"
```

### 普通 Termux 用户

如果你不是 `root@localhost`，而是普通 Termux，并且 SillyTavern 在 `~/SillyTavern`，用这一段：

```bash
termux-setup-storage >/dev/null 2>&1 || true; OUT="$HOME/storage/downloads/st-ai-reading-pack"; ST_DIR="$HOME/SillyTavern"; EXT="$HOME/.acsus-chat-exporter"; [ ! -d "$ST_DIR/data/default-user" ] && echo "没找到酒馆数据：$ST_DIR/data/default-user。请修改命令开头的 ST_DIR。" && exit 1; mkdir -p "$OUT"; rm -f "$OUT"/sillytavern-*.zip "$OUT"/sillytavern-*.zip.partial; rm -rf "$EXT"; git clone --depth 1 https://github.com/Achenono/Chat-Exporter.git "$EXT" && node "$EXT/tools/export-sillytavern-chats.mjs" --data-dir "$ST_DIR/data/default-user" --mode user-context --out-dir "$OUT" && echo "完成，ZIP 在：$OUT/sillytavern-user-context-export.zip" && ls -lh "$OUT"/sillytavern-*.zip
```

默认输出位置：

```text
Download / st-ai-reading-pack / sillytavern-user-context-export.zip
```

## 可以改的导出模式

把命令里的：

```bash
--mode user-context
```

改成下面之一：

```text
user-context   AI 阅读包：User 输入 + 前后上下文 + 索引统计，推荐
user-only      纯 User 输入：最小包
full           完整归档：全部聊天 Markdown + User 输入 + 索引统计，体积最大
index-stats    只有索引统计
```

对应 ZIP 文件名：

```text
user-context -> sillytavern-user-context-export.zip
user-only    -> sillytavern-user-inputs-only.zip
full         -> sillytavern-chat-export.zip
index-stats  -> sillytavern-chat-index-stats.zip
```

## 进度怎么看

命令行会显示两段进度：

```text
scan 25/1602
scan 50/1602
...
zip 1/1458 user-inputs/ALL_USER_INPUTS.md
zip 2/1458 user-inputs/USER_INPUT_INDEX.csv
...
```

`scan` 是扫描聊天文件。

`zip` 是写入压缩包。

如果卡在一个很大的文件上，只要没有出现 `FATAL ERROR`、`out of memory`、`Aborted`，一般可以继续等。

## 常见问题

### 终端显示 out of memory

请确认你拉到的是新版脚本。重新运行上面的命令即可，命令里有：

```bash
rm -rf "$EXT"; git clone --depth 1 https://github.com/Achenono/Chat-Exporter.git "$EXT"
```

它会强制下载最新低内存流式脚本。

### 文件管理器看不到 ZIP

先在 Termux 确认：

```bash
ls -lh /storage/emulated/0/Download/QQ/sillytavern-user-context-export.zip
```

如果终端能看到，说明文件存在。文件管理器里刷新目录，或把 `OUT` 改到更容易找的位置。

### 指定输出文件夹改哪里

只改命令最开头的 `OUT`：

```bash
OUT="/storage/emulated/0/Download/QQ"
```

### 指定 SillyTavern 根目录改哪里

只改命令最开头的 `ST_DIR`：

```bash
ST_DIR="/root/SillyTavern"
```
