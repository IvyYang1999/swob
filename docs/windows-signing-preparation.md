# Dark Constant LLC 的 Windows 签名准备清单

## 决策摘要

Windows Beta 第一版可以未签名发布，但必须明示 SmartScreen 与未知发行者边界。正式改善信任链的路径是由 Dark Constant LLC 的授权代表申请 Microsoft **Artifact Signing（原 Trusted Signing）** Public Trust，通过组织身份校验后建立证书 profile，再把签名变成 Release 的失败即停门禁。

负责人现在只需做外部申请和账号授权；不要将证件、密码、client secret 或任何 token 提交到仓库、Issue 或聊天。

## 1. 申请前的硬条件

- 一个付费 Azure 订阅及其 Microsoft Entra tenant；免费、试用和赞助订阅不受支持。
- Azure 账单上的法定组织名、地址必须与申请身份完全一致。对本项目应为 `Dark Constant LLC`，不使用 `Swob` 作为法定主体。
- Dark Constant LLC 必须是 Microsoft Public Trust 当前支持地区内可验证的法人。申请人需具备 Azure 的 `Identity Verifier` 角色。
- 组织需有可公开访问的官网和与该域名一致的企业邮箱。主/备联系邮箱必须不同，且验证链接有效期只有 7 天。

Microsoft 当前列出的 Public Trust 组织支持地区包括美国、加拿大、欧盟、英国、澳大利亚、新西兰、日本、韩国、新加坡、瑞士、挪威和以色列。申请前仍应在[Microsoft 快速入门](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) 复核最新范围。

## 2. 负责人需准备的材料

| 类别 | 要求 | 自检 |
|---|---|---|
| 法定名称 | `Dark Constant LLC`，必须与注册文件、Azure 账单、网站一致 | □ |
| 注册信息 | 州/国家、完整营业地址、企业识别号 | □ |
| 注册证明 | 政府注册证明、组织章程或同类官方文件，显示完整名称和地址 | □ |
| 文件时效 | 辅助文档原则上为近 12 个月签发；若有到期日，提交时剩余至少 2 个月 | □ |
| 官网 | 公开网址，可以把组织名与业务联系起来 | □ |
| 域名证明 | 域名注册记录或发票，显示法人/联系人和域名 | □ |
| 主邮箱 | 同域企业邮箱，申请期间每天查收 | □ |
| 备用邮箱 | 与主邮箱不同、同域的企业邮箱 | □ |
| 授权代表 | 姓名必须与政府证件完全一致，且有权代表 LLC | □ |

Microsoft 通常给出 1–20 个工作日的审核区间，复杂情况会更长。文档上传次数受限，不要用不一致或过期材料“试一试”。详见[Microsoft FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)。

## 3. Azure 中的操作顺序

1. 负责人确认 Azure 订阅的 billing profile 已是 Dark Constant LLC 的法定名称和地址。
2. 在 Azure Portal 创建 Artifact Signing account，选择与团队合适的支持区域。
3. 由拥有 `Identity Verifier` 角色的人在 Portal 提交 Public Trust 组织身份。身份申请不通过 CLI/API 代办。
4. 在 7 天内完成邮箱验证，并及时补交审核材料。
5. 身份通过后创建 Public Trust certificate profile；记录 endpoint、account name、certificate profile name 和证书 Subject/CN。
6. 给 CI 专用身份只授予 `Artifact Signing Certificate Profile Signer`（旧文档可能称 Trusted Signing Certificate Profile Signer）所需范围，不赋予身份审核或账户管理权。参考[Microsoft 签名集成文档](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)。

## 4. 仓库接入方案（身份通过后执行）

签名对象不只是最外层安装包；Electron 应用的内层 executable 和最外层 NSIS installer 都应被签名。因此首选方案是在 electron-builder 的 Windows 打包期间接入 `win.azureSignOptions`，不是发布前只给最终 `.exe` 补一个签名。详见 [electron-builder Windows 签名](https://www.electron.build/docs/features/code-signing/code-signing-win/)。

接入时必须满足：

- 先在一个隔离分支里验证 electron-builder/Artifact Signing 当前版本能否直接使用 GitHub OIDC；不在没有实测时宣称“无密钥”已可用。
- OIDC 可用时，只给 Release workflow `id-token: write` 和最小 Signer 角色，同时把 GitHub organization/repository/ref 限定在 federated credential 中。Microsoft 官方 [`azure/artifact-signing-action`](https://github.com/azure/artifact-signing-action) 推荐 OIDC，可用于对照验证，但不得因此漏签内层 executable。
- 如果当前 electron-builder 链路仍只支持 client secret，由负责人确认是否接受该风险；secret 只存放在 GitHub Environments/Secrets，启用环境审批、最短轮换周期和最小 RBAC，不写入仓库、日志或文档。
- 稳定发布打开 `forceCodeSigning: true`：任意内层/外层签名失败都不得上传未签名资产。Beta 期间不要提前打开，否则在身份尚未就绪时会阻断全部发布。
- 时间戳使用 SHA-256 和 RFC 3161。`publisherName` 必须与实际证书 CN 精确一致；不提前猜测。

## 5. 签名验收与回滚

签名接入后，Release 必须新增以下失败即停检查：

```powershell
$installer = Get-AuthenticodeSignature .\dist\swob-<version>-windows-beta-x64.exe
if ($installer.Status -ne 'Valid') { throw "Installer signature is $($installer.Status)" }
if ($installer.SignerCertificate.Subject -notmatch 'Dark Constant LLC') { throw 'Unexpected signer' }
```

还要对安装后的 `Swob.exe` 执行同样检查，核对时间戳、Subject/CN、证书链和 SHA-256，并在全新 Windows 11 上重做 SmartScreen 验收。签名失败的回滚是停止发布，不是暗中回退到未签名稳定版。

## 负责人交接卡

- □ 确认付费 Azure 订阅与 Dark Constant LLC 账单信息
- □ 准备上表组织、域名、邮箱和授权代表材料
- □ 指定拥有 `Identity Verifier` 的申请人
- □ 完成 Public Trust identity 与 certificate profile
- □ 只把 endpoint、account name、profile name、证书 CN 这四项**非秘密元数据**交给工程负责人
- □ 审批 OIDC 或受控 client-secret 方案，再启动签名接入 PR
