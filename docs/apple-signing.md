# macOS 签名与公证：从零到出正式包

> 目标：让用户双击 dmg 不再看到「已损坏 / 无法验证开发者」。
>
> 成本：Apple Developer Program **$99/年**（一个账号签你所有 App，不限数量）。
> 时间：注册审核 1–2 天；配好之后每次发版自动公证，约 2–5 分钟。

---

## 0. 你需要准备

| 东西 | 说明 |
|---|---|
| Apple ID | 普通 Apple 账号即可，**必须开启双重认证** |
| 身份证 / 护照 | 个体开发者要实名；姓名要和证件一致 |
| 双币信用卡 | 结账页用（Visa / MasterCard / 银联双币都行，具体以结账页为准） |
| 常用邮箱 | 审核通知 |

> ⚠️ **个人（Individual）最快**，1–2 天过。公司（Organization）要 D-U-N-S 编号，等 1–2 周。
> 个人账号的签名会显示**你的姓名**；公司账号显示公司名。以后想换成公司要重新申请，先想清楚。

---

## 1. 注册 Apple Developer Program

1. 打开 <https://developer.apple.com/programs/enroll/>
2. 点 **Start Your Enrollment** → 用 Apple ID 登录（没开双重认证会要求先开）
3. 选择账号类型：
   - **Individual / Sole Proprietor** ← 推荐，选这个
   - Company / Organization ← 需要 D-U-N-S
4. 填写：
   - First / Last Name（**与证件一致**，拼音或英文）
   - 地址、电话
   - 勾选同意协议
5. 付款 $99（自动续费，可以在账号里关掉）
6. 提交后等邮件，通常 **24–48 小时**。状态可在 <https://developer.apple.com/account> 查看

> 中国区有时会要求补充实名材料（身份证正反面），跟着邮件提示上传即可。
> 如果提示 "Your enrollment requires additional information"，点进账号按提示补。

---

## 2. 拿到 Team ID（10 位）

审核通过后：

1. 打开 <https://developer.apple.com/account>
2. 左侧 **Membership details**
3. 复制 **Team ID**，形如 `A1B2C3D4E5`

把它记下来，后面 CI 要用。

---

## 3. 生成证书（Developer ID Application）

证书 = 一对密钥 + Apple 的签名。**CSR（证书请求）必须用同一把私钥生成**，所以私钥要保管好。

### 3.1 生成私钥和 CSR（在 Windows 上就能做）

在项目根目录执行：

```powershell
pwsh -File scripts/apple-csr.ps1
```

它会在 `.secrets/` 里生成：

```
.secrets/developerID.key     ← 私钥，绝对不要外传/提交
.secrets/developerID.csr     ← 上传给 Apple
```

> `.secrets/` 已经在 .gitignore 里，不会被提交。

### 3.2 上传 CSR、下载证书

1. <https://developer.apple.com/account/resources/certificates/list>
2. 右上 **+** → 选 **Developer ID Application** → Continue
3. 上传 `.secrets/developerID.csr`
4. 下载生成的 `developerID_application.cer`

### 3.3 把 .cer 转成 .p12（CI 要用的格式）

```powershell
pwsh -File scripts/apple-p12.ps1 -Cer .\developerID_application.cer
```

产出：

```
.secrets/developerID.p12         ← 证书+私钥打包
.secrets/developerID.p12.b64     ← base64，用来填 GitHub Secret
```

脚本会问你一个密码，记住它，下一步要用。

---

## 4. 生成 App 专用密码

公证需要一个"App 专用密码"（不是你的 Apple ID 登录密码）：

1. <https://appleid.apple.com> → 登录
2. **Sign-In and Security** → **App-Specific Passwords**
3. **Generate a password** → 名称随便填（如 `textharness-notarize`）
4. 复制生成的密码，形如 `abcd-efgh-ijkl-mnop`

---

## 5. 填 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**，加 5 个：

| Name | 值 |
|---|---|
| `CSC_LINK` | `.secrets/developerID.p12.b64` 的**全部内容**（一行 base64） |
| `CSC_KEY_PASSWORD` | 生成 p12 时你设的密码 |
| `APPLE_ID` | 你的 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 第 4 步生成的那串 |
| `APPLE_TEAM_ID` | 第 2 步的 Team ID |

> Secrets 是加密存储的，CI 日志里不会显示。p12 里的私钥泄露等于别人能用你的名义签名，
> 所以只放 Secrets，别贴到聊天/文档/提交里。

---

## 6. 打开 hardened runtime（公证要求）

证书配好后，把 `electron-builder.yml` 里这一行改成 `true`：

```yaml
mac:
  hardenedRuntime: true     # 公证要求；没证书时保持 false
```

然后正常发版：

```powershell
npm run release -- 0.3.6
```

---

## 7. 怎么确认成功

CI 日志里应该出现：

```
[after-pack] 检测到正式证书，跳过 ad-hoc 签名
[notarize] 提交公证 .../TextHarness.app
[notarize] 公证成功
[notarize] 已 staple 到包上
Verify code signature
  Authority=Developer ID Application: <你的名字> (<TEAMID>)
  Authority=Developer ID Certification Authority
  Authority=Apple Root CA
spctl 评估
  accepted            ← 关键，未公证时这里是 rejected
```

注意 `Verify code signature` 那一步：`spctl` 从 `rejected` 变成 `accepted` 就说明公证生效了。

---

## 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 只能有 2 张 Developer ID 证书 | Apple 的配额。够用：一张手工、一张给 CI；旧的可以 revoke |
| notarize 报 `Invalid Signature` | 包是 ad-hoc 签的。必须先配 `CSC_LINK`（真实证书） |
| notarize 报 `401 Unauthorized` | `APPLE_ID` / 专用密码 / Team ID 有一个填错；专用密码不是登录密码 |
| 公证成功但用户仍被拦 | 没 `staple`，或用户下的是旧包（旧包没公证） |
| `hardenedRuntime: false` 时公证失败 | Apple 要求 hardened runtime，改成 `true` |
| 想撤销泄露的证书 | <https://developer.apple.com/account/resources/certificates/list> → Revoke |

---

## 现在的状态（没有账号时）

- `afterPack` 会做 **ad-hoc 签名** → 用户会看到「无法验证开发者」，右键打开即可
- `afterSign` 检测到没有 `APPLE_ID` 等变量，**自动跳过公证**，不会让 CI 失败
- 官网已经写好「提示已损坏怎么办」三条解法

拿到账号后，只需要：生成证书 → 填 5 个 Secrets → 把 `hardenedRuntime` 改 `true` → 发版。
