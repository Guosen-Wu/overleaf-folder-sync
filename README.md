# Overleaf Folder Sync

[English README](./EN_README.md)

`Overleaf Folder Sync` 是一个面向本地文件夹工作流的 Overleaf 同步命令行工具。它提供 `olfs` 命令，可以把一个本地目录绑定到 Overleaf 项目，并支持拉取、推送、状态检查、冲突处理和编译结果获取。

这个项目适合希望继续使用本地编辑器、Git、终端和自动化脚本，同时又需要与 Overleaf 项目协作的科研写作场景。

## 特性

- 将本地文件夹绑定到指定 Overleaf 项目。
- 使用用户提供的 `overleaf_session2` Cookie 访问 Overleaf，不实现网页登录流程。
- 支持 `pull`、`push` 和 `sync`，并在同步前检查本地与远端变更。
- 支持基于 baseline 的冲突检测，同一文件两端都变更时会提示选择处理方式。
- 支持 `.gitignore` 和 `.olignore` 作为项目提交过滤规则，避免上传、拉取或删除本地临时文件、编辑器文件和 LaTeX 构建产物。
- 支持从 Overleaf 获取编译日志、PDF 和其他输出文件。
- 绑定项目时会生成平台相关的快捷脚本，方便双击执行常用命令。

## 安装

使用 `pnpm` 全局安装：

```bash
pnpm add -g overleaf-folder-sync
```

也可以不安装，直接临时运行：

```bash
pnpm dlx overleaf-folder-sync --help
```

安装完成后，系统中会出现全局 `olfs` 命令：

```bash
olfs --help
```

如果你使用 `npm`：

```bash
npm install -g overleaf-folder-sync
npx overleaf-folder-sync --help
```

从源码开发时可以直接运行：

```bash
pnpm dev -- --help
```

## 快速开始

1. 设置 Overleaf Cookie：

```bash
olfs auth set-cookie
```

2. 检查当前身份：

```bash
olfs auth whoami
```

3. 列出可访问的 Overleaf 项目：

```bash
olfs list
```

4. 绑定本地文件夹到 Overleaf 项目：

```bash
olfs bind --project-id <project-id> --path .
```

5. 从 Overleaf 拉取项目内容：

```bash
olfs pull
```

6. 将本地修改推送回 Overleaf：

```bash
olfs push
```

## 常用命令

```bash
olfs status
olfs status --local
olfs pull
olfs pull --force
olfs push
olfs push --force
olfs sync
olfs compile
```

`status --local` 只比较本地文件和上一次保存的 baseline，速度更快。普通 `status` 会连接 Overleaf 并下载远端项目压缩包，用于判断远端是否也发生了变化。`pull`、`push` 和 `sync` 会在真正修改文件前额外执行一次完整 `status`；如果下一步就是这些命令，通常不需要先手动跑一遍普通 `status`，除非你只是想提前预览变更或冲突。

## 项目状态文件

绑定后的本地目录会出现 `.olfs/`，用于保存该目录与 Overleaf 项目的同步状态：

```text
.olfs/config.json
.olfs/baseline.json
.olfs/bin/*
```

认证信息不会保存在项目目录中，而是保存在用户配置目录：

```text
~/.config/overleaf-folder-sync/auth.json
```

该认证文件会使用 `0600` 权限保存。

## 同步行为

`pull`、`push` 和 `sync` 会先执行完整状态检查，因此它们会连接 Overleaf 并下载远端项目压缩包后再决定如何处理。如果你刚刚只是为了预览执行过 `olfs status`，再运行这些命令时还会重新检查一次，以避免基于过期状态修改本地或远端文件。如果同一个文件在本地和远端都发生了变化，工具会提示选择：

- 保留本地版本
- 保留远端版本
- 跳过该文件

`pull --force` 会以远端内容镜像本地目录。`push --force` 会以本地内容镜像远端项目。这两个命令都会在运行时再次确认。

首次执行 `pull` 时，如果本地还没有 `.olfs/baseline.json`，工具会从远端初始化本地目录。如果本地已有文件且可能被覆盖，工具会先询问；可以使用 `pull --yes` 跳过交互确认。

## 提交过滤

`olfs` 会读取项目根目录下的 `.gitignore` 和 `.olignore`。这些规则会用于本地扫描、状态计算、普通 `pull`、`push` 和 `sync`：

- 被忽略的本地文件不会上传到 Overleaf。
- 被忽略的远端文件不会因为本地缺失而被 `push` 或 `sync` 当作删除提交。
- 普通 `pull` 和 `sync` 不会把被忽略的远端文件写入本地。

如果需要只对 Overleaf 同步生效、但不影响 Git，可以把规则写进 `.olignore`。

## 编译输出

`olfs compile` 可以获取 Overleaf 编译日志并解析错误和警告，也可以保存编译产物：

```bash
olfs compile --pdf-out output.pdf
olfs compile --log-out output.log
olfs compile --output-dir .output
```

也可以更新项目编译设置：

```bash
olfs compile --compiler xelatex
olfs compile --set-root main.tex
```

## 平台快捷脚本

`olfs bind` 会在 `.olfs/bin/` 下生成当前平台可用的快捷脚本：

- macOS: `.command`
- Linux: `.sh`
- Windows: `.cmd`

这些脚本覆盖状态检查、编译、拉取、强制拉取、推送、强制推送和同步等常用操作。

## 开发

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

开发模式运行：

```bash
pnpm dev -- <command>
```

示例：

```bash
pnpm dev -- list
pnpm dev -- status
```

## Codex Skill

本仓库包含一个 Codex skill，用于教 agent 如何安全地使用已安装的 `olfs` 命令。

如果本项目已经发布到 GitHub，可以让 Codex 使用 `skill-installer` 从仓库路径安装：

```bash
install skill from <owner>/<repo> path skills/overleaf-folder-sync
```

安装后重启 Codex。之后当你让 Codex 执行 Overleaf 同步、拉取、推送、编译或冲突处理任务时，它会读取该 skill，并按其中的安全流程操作 `olfs`。

## 安全说明

本工具需要用户手动提供 `overleaf_session2` Cookie。它不会实现 Overleaf 网页登录，也不会请求用户的 Overleaf 密码。

请只在可信机器上使用本工具，并妥善保护本地认证文件。不要把 `auth.json`、`.olfs/` 或任何包含 Cookie 的文件提交到 Git 仓库。

## 免责声明

本项目不是 Overleaf 官方项目，也未获得 Overleaf 官方关联、背书或授权。Overleaf 是其各自权利人的商标。

本工具依赖 Overleaf 当前可观察到的接口行为。由于相关接口可能变化，未来版本可能需要调整以保持兼容。

## 许可证

本项目基于 [Apache License 2.0](./LICENSE) 发布。
