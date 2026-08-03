# 提交你的 `.swoblens` 包

首阶段采用 GitHub PR 收录，不提供在线市场，也不接受执行代码。

1. 从 [`examples/`](./examples/) 选择与你的类型相同的官方包，并按[格式规范](./format.md)创建 manifest 与声明文件。
2. 生成确定性的 `.swoblens` ZIP；不要加入目录项、系统元数据、隐藏文件或未在 manifest 声明的内容。
3. 在 Swob 的“设置 → Lens → 从文件安装”中完成预览、安装、禁用、启用与卸载全链路。
4. 运行 `npm run swoblens:check` 和 `.swoblens` 相关 Vitest；确认恶意包矩阵仍全部 fail-closed。
5. 提交 PR，附包文件、SHA-256、作者与许可证、截图，以及你实际运行的测试命令。

维护者会检查 schema、资源上限、digest、许可与展示质量。任何 JS、网络资源、任意 CSS、Provider Adapter、文件系统权限或绕过未知字段规则的包都会直接拒绝。需要这些能力的提案应进入独立治理流程，不能伪装成声明式包。
