# rdsh

rdsh 是 DeepSeek Harness (`dsh`) 的快速 Rust 启动器。它只优化本地热路径；对原始 `dsh` 的委派保持原始参数和输出不变。

## 开始使用

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
cargo build --release
./target/release/rdsh --version
```

完整安装、设置、恢复和扩展仪表板说明请参阅 [README.md](README.md)。日语说明请参阅 [README.ja.md](README.ja.md)。

## 产品语言

rdsh 自己的 CLI 诊断、原生本地页面和项目仪表板提供英语、简体中文和日语。单次调用使用 `--language`；持久化设置写入 `$DSH_HOME/rdsh.json` 的 `general.language`。可用值为 `auto`、`en`、`zh-CN`、`ja`，其中 `auto` 使用第一个非空语言环境变量；未设置或不支持时采用英语。

```sh
rdsh --language zh-CN settings show
rdsh settings set general.language zh-CN
```

优先顺序为 `--language`、非空 `RDSH_LANG`、非 `auto` 的 `general.language`、`LC_ALL`、`LC_MESSAGES`、`LANG`，最后是英语。委派给 `dsh` 的参数、模型输出、API JSON 字段、文件内容、名称和协议标识符保持原文。

`worker-scope validate` 和 `worker-scope policy` 的帮助与 CLI 诊断也支持三种语言。这些纯计算命令及其帮助不依赖无关的损坏设置；普通命令和根帮助仍报告设置错误。规范 JSON、策略代码和输入路径保持不变。

设置文件和浏览器设置页面的详细字段见 [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md)；项目仪表板的独立启动方式见 [dashboard/README.md](dashboard/README.md)。

## 受保护启动的兼容版本

仅访问显式共享文件的隔离功能要求 Linux x86_64、bubblewrap、prlimit 和用户命名空间。已审计的 DSH 与工具运行时必须使用相同版本：`0.2.0-rc.2`、`0.2.1-alpha.1` 或 `0.2.1-alpha.3`。未知、混合、被修改或解析到其他依赖副本的运行时会被拒绝。macOS 和 Windows 拒绝受保护的委派。[仪表板的固定更新](docs/STAGED-UPDATES.md)保留单独的兼容版本列表。
