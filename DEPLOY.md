# 部署与更新手册

面向**厂商侧发布者**，覆盖四件事：

1. [在 GitHub 仓库发布资源](#1-在-github-仓库发布资源)
2. [在 HACS 里通过 URL 添加集成](#2-在-hacs-里通过-url-添加集成)
3. [在 HA 界面上展示](#3-在-ha-界面上展示)
4. [在 GitHub 更新文件后，用户在 HA 上应用新版本](#4-更新文件后如何在-ha-上应用新版本)

> 终端命令以 PowerShell 为例，路径按需替换。
> 文中仓库地址统一用 `hoymiles-ha/ha`，如换成别的仓库请同步修改
> [三处 URL](#仓库-url-出现在哪三处)。

---

## 0. 发布前自检

仓库根目录应当长这样（`hoymiles-ha/` **里面的内容**就是仓库根，不要再套一层目录）：

```
<repo root>/
├── .github/
│   └── workflows/
│       └── validate.yml              # CI: HACS + hassfest 校验
├── .gitignore
├── LICENSE                           # HACS 必需：OSI 认可的开源协议
├── README.md                         # HACS 必需：仓库根的信息文件（英文，HACS 渲染这一份）
├── README.zh-Hans.md                 # 中文版说明
├── DEPLOY.md                         # 本文件
├── hacs.json                         # HACS 必需：清单
├── docs/
│   ├── CARDS.md                      # 八张卡片参数总表
│   ├── CARDS.zh-Hans.md              #   中文版
│   ├── ARCHITECTURE.md               # MQTT 话题 / discovery 补丁 / 实体模型
│   ├── ARCHITECTURE.zh-Hans.md       #   中文版
│   └── images/                       # README 引用的界面截图
├── scripts/
│   ├── brand-source.png              # 官方 logo 原始稿（设计源，不随集成下发）
│   ├── make_brand_from_official.ps1  # ★ 从官方 logo 生成 icon.png + logo.png
│   ├── make_brand_icon.ps1           # 备用：合成一个品牌图标（无素材时的兜底）
│   ├── make_brand_from_image.ps1     # 备用：从截图/图片抠底生成
│   └── release.ps1                   # 一键发版
└── custom_components/                # HACS 必需：集成目录
    └── hoymiles/
        ├── brand/
        │   ├── icon.png              # HACS 品牌校验必需；本地图标可免去上游 PR
        │   └── logo.png              # 横向锁定版：圆标 + 字标
        ├── manifest.json             # 必需，含 version（HACS 硬性要求）
        ├── www/                      # 八张 Lovelace 卡片
        │   ├── hoymiles-power-flow.js
        │   ├── hoymiles-battery.js
        │   ├── hoymiles-pack-list.js
        │   ├── hoymiles-history-chart.js
        │   ├── hoymiles-gauge.js
        │   ├── hoymiles-control.js
        │   ├── hoymiles-tou-editor.js
        │   └── hoymiles-energy-sankey.js
        └── ... (config_flow / sensor / services ...)
```

### 品牌图（brand/）

`icon.png` 与 `logo.png` **由脚本从官方 logo 生成，不要手工替换**：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make_brand_from_official.ps1
```

- 输入：`scripts/brand-source.png`（官方 logo 原始稿：蓝色实心圆 + 白色 H，下方 "Hoymiles" 字标）
- 输出：`custom_components/hoymiles/brand/icon.png`（256×256，圆形标记）
  与 `logo.png`（横向锁定版，圆标在左 + 字标在右）
- 脚本自带规格自检，不达标会直接报错
- 品牌蓝为 `#0303D8`

> ⚠️ **不要用字标裁剪出方形图标。** 曾经踩过这个坑：把宽字标裁成方形后，
> 字母会超出标记范围，在 HA「选择品牌或集成」弹窗把图标渲染到约 40 px 时
> 糊成一团，看起来像只画了一半。圆形标记必须单独提取。
> 回归由 `ha_monitor/_preview/make-brand-check.cjs` 守住。

一键复核必需项：

```powershell
cd <repo root>
foreach ($f in @("LICENSE","README.md","hacs.json",".gitignore",
                 "custom_components\hoymiles\manifest.json",
                 "custom_components\hoymiles\brand\icon.png")) {
    "{0,-52} {1}" -f $f, (Test-Path $f)
}
```

全部应为 `True`。

### 仓库 URL 出现在哪三处

| 文件 | 字段 |
|---|---|
| `custom_components/hoymiles/manifest.json` | `codeowners`、`documentation`、`issue_tracker` |
| `README.md` / `README.zh-Hans.md` | 安装说明里的仓库地址 |
| `DEPLOY.md`（本文件） | 命令示例 |

`hacs.json` **不含** URL，无需改。

---

## 1. 在 GitHub 仓库发布资源

### 1.1 创建仓库

在 https://github.com/new 新建一个 **public** 仓库，例如 `hoymiles-ha/ha`。

- 建议勾选 **Add a README file = 否**（我们本地已有 README，避免冲突）
- 必须 **public**：HACS 通过 GitHub API 拉取，私有仓库需要额外配 token

### 1.2 初始化本地仓库并推送

```powershell
cd d:\HM\project\MicroStorage\code\arm\g3mainmcu\ha_monitor\hoymiles-ha

git init -b main
git add .
git commit -m "Initial release 0.1.0"

git remote add origin https://github.com/hoymiles-ha/ha.git
git push -u origin main
```

`.gitignore` 已排除 `__pycache__/`、`.storage/`、`*.db`、`hoymiles.zip` 等不该提交的内容。

> 顺手把 GitHub 仓库的 **Description** 和 **Topics** 填上。
> HACS 的 `description` / `topics` 校验会检查它们，留空会导致上架默认商店失败。

### 1.3 打 tag 并创建 Release（**关键，不做用户永远收不到更新**）

HACS 的版本来源是 **GitHub Release**，不是 commit。
只 push 代码、不打 tag 不发 Release，用户侧不会有任何提示。

```powershell
# 方式 A：用发版脚本（推荐，会同步 manifest.json 版本号）
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.1.0 -Push

# 方式 B：手动
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

然后到 **GitHub → Releases → Draft a new release**：

| 项 | 值 |
|---|---|
| Tag | 选 `v0.1.0`（或输入 `v0.1.0` 新建） |
| Release title | `v0.1.0` |
| Describe this release | 写更新说明 —— **会显示在 HACS 的更新界面里** |
| Set as a pre-release | 灰度时勾选（只有开了 beta 的用户可见） |
| Attach binaries | 留空（除非启用了 `zip_release`） |

点 **Publish release**。

### 1.4 确认 CI 校验通过

推送后打开 **Actions** 标签页，`Validate` 工作流会跑：

- **HACS validation**（`hacs/action@main`, category=integration）
- **hassfest validation**（`home-assistant/actions/hassfest@master`）

HACS 一共 9 项检查，常见拦截原因：

| 检查 | 常见失败原因 |
|---|---|
| `license` | 没有 `LICENSE`，或用非 OSI 协议（`NOASSERTION` 会失败） |
| `brands` | 既没有 `custom_components/hoymiles/brand/icon.png`，也不在 `home-assistant/brands` |
| `hacsjson` | `hacs.json` 出现**未知键**（schema 是 `PREVENT_EXTRA`） |
| `integration_manifest` | `manifest.json` 缺 `codeowners`/`documentation`/`issue_tracker`/`version`，或 URL 为空 |
| `description` / `topics` | GitHub 仓库的 Description / Topics 为空 |
| `issues` | 仓库 Issues 被关闭 |

---

## 2. 在 HACS 里通过 URL 添加集成

### 2.1 前置条件

- Home Assistant `2023.8` 或更高（`hacs.json` 里已声明）
- 已安装 **HACS**
- 已安装并配置 HA 的 **MQTT 集成**（本集成 `dependencies: ["mqtt"]`，**复用** HA 的 MQTT 连接，不重复填 broker 账号）
- 固件已连到同一个 broker，并按 `homeassistant/...` 前缀发布 discovery

### 2.2 添加自定义存储库

1. HA 侧边栏 → **HACS**
2. 切到 **集成** 分类
3. 右上角 **⋮** → **自定义存储库**
4. 填写：
   - **存储库**：`https://github.com/hoymiles-ha/ha`
   - **类别**：**Integration**
5. 点 **添加**

### 2.3 下载并重启

1. 在 HACS 集成列表里搜索 **Hoymiles Official**
2. 点进去 → **下载** → 选版本（默认最新 Release）→ **下载**
3. **完整重启 Home Assistant Core**
   （设置 → 系统 → 右上角电源 → 重启 Home Assistant）

> **必须完整重启，不能只 reload。** 新的 Python 模块需要重新 import，只 reload config entry 不会加载新代码。

### 2.4 手动安装（HACS 之外的后备方案）

不装 HACS 也可以，把集成目录拷过去再重启：

```
/config/custom_components/hoymiles/
```

树莓派/HAOS 常用做法：**Samba share** 或 **SSH & Web Terminal** add-on；
Docker/Core：`docker cp` 或直接 `cp -r`。

⚠️ 手动安装的用户**收不到 HACS 更新**，每次升级都要重新拷文件。

---

## 3. 在 HA 界面上展示

### 3.1 添加集成（生成设备与实体）

1. **设置 → 设备与服务 → 添加集成**
2. 搜索 **Hoymiles Official**
3. 集成把发现的设备列进下拉框
   - 也可以直接手输 `dev_id`，形如 `MSA-280520260806`（= `client_prefix-SN`）
4. 选中 → 提交

完成后会生成设备与实体（`sensor.*` / `binary_sensor.*`，entity_id 形如 `sensor.msa_280520260806_<key>`）。

> 固件已通过 MQTT Discovery 注册的实体（`switch` / `ems_mode` / `power_ctrl` / `soc` / `bat_power` / `output_power` / `reboot`）
> 集成**刻意不重复创建**，避免同一数据出现两个实体。

#### 下拉框里的设备是怎么来的

**不是网络扫描，而是订阅 MQTT 的 retained discovery 消息。**
实现见 `mqtt_util.async_discover_dev_ids()`：

| 环节 | 行为 |
|---|---|
| 订阅的 topic | `homeassistant/switch/+/config`（`const.T_DISCOVERY`） |
| 取值方式 | topic 按 `/` 切分，取**第 3 段**作为 `dev_id` |
| 收集窗口 | **只订阅 3 秒**，之后取消订阅 |
| 去重排序 | `sorted(set(...))` |
| 过滤 | 已配置过的设备会从下拉框中排除 |

因此"能否被扫到"只取决于三件事：

1. 设备**曾经连上**这个 broker 并发布过 discovery 消息（qos 1 / **retain=true**）
2. broker **保留了** retained 消息
3. HA 的 MQTT 集成连的是**同一个** broker

由此有两个推论：

- **设备掉线也会出现在下拉框里** —— 只要 broker 还留着 retained 消息。这正是用 retained 而非"在线扫描"的好处。
- **broker 重启且未开启持久化时，掉线的设备会消失**，直到它重连补发一次。
  Mosquitto 建议开 `persistence true`（HAOS 的 Mosquitto add-on 默认已开）。

> **下拉框只显示 1 项不代表只发现 1 台**：下拉是折叠的，点开才看到全部。
>
> 想确认完整清单，用 MQTT 工具订阅 `homeassistant/switch/+/config`
> 看有多少条 retained 消息即可。

### 3.2 可用服务

| 服务 | 说明 |
|---|---|
| `hoymiles.set_tou_day_plan` | 下发某天日计划 |
| `hoymiles.set_tou_week_plan` | 下发星期与日计划映射 |
| `hoymiles.get_tou_plan` | 查询某天计划 |
| `hoymiles.set_ems_mode` | 切换 EMS 模式 |
| `hoymiles.reboot` | 重启设备 |

**目标设备二选一：**

- **`device_id`** —— 在 UI 里从设备下拉中选择（推荐，自动补全）
- **`dev_id`** —— 直接填设备标识字符串，如 `MSA-280520260806`

> ⚠️ **不要用 `target.device`。** HA 的 hassfest 明确禁止在服务的 `target`
> 下使用 device 过滤器（`script/hassfest/services.py` 的
> `raise_on_target_device_filter`：*"Services do not support device filters on
> target, use a device selector instead"*）。`target` 下只允许 `entity`。
> 设备必须通过 `device_id` 字段（device selector）指定。

```yaml
# 方式一：用设备下拉（推荐）
service: hoymiles.reboot
data:
  device_id: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d

# 方式二：用设备标识
service: hoymiles.reboot
data:
  dev_id: MSA-280520260806
```

### 3.3 两张内置卡片（**无需手动添加资源**）

集成启动时会自动把 `www/` 下的 JS 注册为前端模块
（`__init__._async_register_frontend` → `add_extra_js_url`），
所以**不用**去 Lovelace 资源里手工添加。

#### 卡片 A：TOU 计划编辑器

```yaml
type: custom:hoymiles-tou-editor
dev_id: MSA-280520260806
language: zh
```

只有在 EMS 模式为 `tou_plan` 时才渲染编辑界面（`require_tou_mode: false` 可关闭该门控）。

#### 卡片 B：能量流桑基图

```yaml
type: custom:hoymiles-energy-sankey
dev_id: MSA-280520260806
title: 能量流
language: zh
range: today          # today | 7d | 30d | month
```

可选参数：

| 参数 | 说明 |
|---|---|
| `balancer_label` | 「损耗/其他」或「未计量」节点的自定义名称 |
| `statistics` | 覆盖默认的 statistic_id，值为字符串或数组 |
| `show_toolbar` | `false` 隐藏时间段切换栏 |

`statistics` 覆盖示例（实体被改名或想改用 `*_total` 累计口径时很有用）：

```yaml
type: custom:hoymiles-energy-sankey
dev_id: MSA-280520260806
range: 30d
statistics:
  pv: sensor.msa_280520260806_system_pv_energy_today
  grid_in: [sensor.a_system_grid_in, sensor.b_system_grid_in]
  grid_out: sensor.msa_280520260806_grid_on_energy_out_total
```

**数据来源**：卡片调用 HA 的 `recorder/statistics_during_period` WebSocket
命令读取**长期统计**（`types: ["change"]`，单位由服务端换算成 kWh）。
它**不接触** recorder 数据库文件，也**不需要管理员权限**。

**关于「损耗/其他」节点**：桑基图要求流量守恒，而设备各端口是**独立计量**的
（转换损耗、采样相位、未计量负载都会造成差额）。卡片不做归一化缩放，
而是把差额显式画成一个节点，保证图面守恒且数值真实。

### 3.4 添加到仪表盘

1. 打开目标仪表盘 → **编辑** → **+ 添加卡片**
2. 选 **手动**（Manual），粘贴上面的 YAML
3. 保存

**验证卡片已注册**：浏览器控制台执行

```js
customElements.get('hoymiles-tou-editor')          // -> 构造函数
customElements.get('hoymiles-energy-sankey')       // -> 构造函数
```

### 3.5 （可选）让官方能源仪表盘也出图

HA 自带的能源仪表盘有一个 Sankey 风格的「能量分布」卡片，节点固定为
**光伏 / 电网 / 电池 / 家庭** 四类。配上实体即可：

| 位置 | 建议实体 |
|---|---|
| 太阳能 | `sensor.<dev>_system_pv_energy_today` |
| 电网受电 | `sensor.<dev>_grid_on_energy_in_total` |
| 电网送电 | `sensor.<dev>_grid_on_energy_out_total` |
| 电池充电 | `sensor.<dev>_battery_charge_energy_today` |
| 电池放电 | `sensor.<dev>_battery_discharge_energy_today` |

> **优先用 `*_total` 累计口径**（`grid_on_*` / `inv_*` 的 `etin`/`etout`）。
> `*_today` 型是日清零的，HA 在**长时间停机后**会把"跨天下降"识别为设备重置，
> 中间天数的增量会丢失。累计型没有这个问题。
>
> 设备特有的 **EPS / 插座 / 离网** 端口官方模型装不下，那部分只能用卡片 B 展示。

---

## 4. 更新文件后，如何在 HA 上应用新版本

### 4.1 厂商侧：发一个新版本

```powershell
cd <repo root>

# 1) 改代码，正常提交
git add -A
git commit -m "Fix: ..."

# 2) 发版（自动 bump manifest.json 版本 + 打 tag + 推送）
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.2.0 -Push
```

然后必须去 **GitHub → Releases → Draft a new release**，
选 tag `v0.2.0`，写更新说明，**Publish release**。

> **版本号规范**
>
> | 项 | 要求 |
> |---|---|
> | tag 名 | `v0.2.0`（`v` 前缀可以，但必须是可解析版本号；`release-2024` 这种 HACS 无法比较） |
> | `manifest.json` 的 `version` | `0.2.0`，**与 tag 一致**（脚本会同步） |
> | 灰度 | 发 **pre-release**，只有开启 beta 的用户能看到 |
> | 回滚 | 用户在 HACS 里 **重新下载** 并选旧版本即可降级 |

### 4.2 用户侧：会看到什么

HACS 的检查周期是**硬编码**的（`hacs/integration` 的 `base.py` → `startup_tasks`）：

| 周期 | 任务 |
|---|---|
| **48 小时** | `async_update_downloaded_custom_repositories` ← **检查已装集成的新版本** |
| 48 小时 | `async_load_hacs_from_github`（HACS 自身数据） |
| 6 小时 | 商店列表 / critical 仓库检查 |
| 10 分钟 | 处理任务队列 |
| 5 分钟 | GitHub API 限流恢复检查 |

此外 **每次 HA 启动完成时会立即检查一次**。

有新版本时会出现**三处提示**：

1. HACS 侧边栏图标出现红点徽章
2. **设置 → 系统 → 更新** 里出现 update 实体（`update.hoymiles_micro_storage_update`），可直接点安装
3. 一条持久通知（persistent notification）

> **HACS 的设置里没有"检查间隔"这个选项。**
> 「设置 → 设备与服务 → HACS → 配置」只有 4 项：
> `sidepanel_title` / `sidepanel_icon` / `country` / `appdaemon`。

### 4.3 用户侧的更新步骤（2 次点击）

1. HACS → 集成 → 找到 **Hoymiles Official** → **更新**
2. 提示重启时点 **重启 Home Assistant**（**必须完整重启**，不是 reload entry）

### 4.4 想立刻检查（不等 48 小时）的三种办法

| 办法 | 说明 |
|---|---|
| **重启 HA** | 启动时会自动检查一次，最省事 |
| **HACS 面板手动重载** | HACS 面板右上角的重载操作 |
| **调 update 实体** | `homeassistant.update_entity` 作用于 `update.hoymiles_micro_storage_update` |

第三种可以写成自动化，让用户尽快感知到发版：

```yaml
alias: 定时刷新禾迈集成更新状态
mode: single
triggers:
  - trigger: time_pattern
    hours: "/4"
actions:
  - action: homeassistant.update_entity
    target:
      entity_id: update.hoymiles_micro_storage_update
```

> ⚠️ **别把频率调太高。** HACS 每 5 分钟检查 GitHub 限流，
> 要求保留约 1000 次配额，配额不足会**自动禁用 HACS**。
> 这也是 HACS 默认设 48 小时的原因。

### 4.5 更新后前端卡片有缓存

卡片 JS 变了但界面没更新时，按顺序试：

1. **硬刷新浏览器**：`Ctrl` + `F5`（macOS 是 `Cmd` + `Shift` + `R`）
2. 若还不行，**重启 HA 后再硬刷新**（集成注入的 JS 在页面加载时解析）
3. 若实体列表变了（新增/重命名实体），需要重启 HA 让平台重新建实体

### 4.6 手动安装的用户怎么更新

把新的 `custom_components/hoymiles/` 覆盖过去，然后**完整重启 HA**。
没有 HACS 就没有版本提示，需要自己关注仓库。

### 4.7 固件与集成的耦合（**重要**）

本集成是 `iot_class: local_push`，直接解析固件发布的 MQTT payload。所以：

1. **发布顺序必须是"集成先行"**
   固件一旦改了 topic 名或 payload 字段，旧集成立刻解析失败。正确做法：
   先发一版**同时兼容新旧字段**的集成，等用户装完，再发固件。
   或让集成按 `attributes` topic 里的 `sw_version` 做能力探测，缺字段降级为 `unknown`。
2. **解析未知/缺失字段不要抛异常**
   否则 setup 失败会让整个集成 `Setup failed`，用户连旧功能都没了。
3. **别轻易改实体的 `key` / `unique_id`**
   `statistic_id` 跟着实体走，一改名历史统计就变成孤儿，桑基图/能源仪表盘的历史会断。
4. **HA 版本兼容**
   `hacs.json` 里 `homeassistant: "2023.8.0"` 是最低门槛；
   同时避免使用更新的 API（当前代码已刻意避开 `ConfigFlowResult` 等新符号）。

---

## 5. 排障

### 5.1 HACS 里搜不到 / 安装报错

| 现象 | 原因 |
|---|---|
| 提示 "Repository structure for vX.Y.Z is not compliant" | 仓库根没有 `custom_components/`，或 `hacs.json` 不在根 |
| 提示无可用版本 | 没打 tag / 没发 Release |
| `hacs.json` 校验失败 | 出现了未知键（schema 是 `PREVENT_EXTRA`） |
| 集成校验失败 | `manifest.json` 缺 `codeowners`/`documentation`/`issue_tracker`/`version`，或 URL 为空 |
| CI `brands` 失败 | 缺 `custom_components/hoymiles/brand/icon.png` 且不在 `home-assistant/brands` |

本地重新生成图标：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make_brand_icon.ps1
```

### 5.2 集成装了但不出现

1. **是否完整重启过 HA Core？** 只 reload entry 不够
2. 检查 `/config/custom_components/hoymiles/manifest.json` 是否存在
3. 直接在「添加集成」里搜 `Hoymiles Official`
   （`manifest/list` WS 命令**看不到未加载的自定义集成**，别用它判断）

### 5.3 添加集成时下拉框是空的

下拉框来自 retained 的 `homeassistant/switch/+/config`（原理见 [3.1](#下拉框里的设备是怎么来的)）。

按顺序排查：

1. **设备是否连的是同一个 broker？** 最常见的原因。用 MQTT 工具订阅
   `homeassistant/switch/+/config`，看有没有 retained 消息。
2. **broker 是否保留了 retained 消息？** broker 重启且未开持久化时会丢。
   Mosquitto 确认 `persistence true`，然后让设备重连一次补发。
3. **3 秒窗口够不够？** 订阅窗口是固定的 3 秒；网络慢或 retained 消息多时
   可能来不及收全，重试一次。
4. 实在不行就**手动输入 `dev_id`**（`client_prefix-SN`），不依赖发现。

> 下拉框**折叠**时只显示 1 项 —— 点开才能看到全部设备，别误判成"只发现一台"。

### 5.4 添加集成时显示 `Translation error: UNCLOSED_TAG`

**已修复的旧版本问题。** 早期版本的翻译文本里含有用反引号包裹的尖括号：
`` `<client_prefix>-<SN>` ``。HA 前端把描述按 HTML 解析，
`<client_prefix>` 被当成未闭合标签，于是报 `UNCLOSED_TAG`
（hassfest 的对应报错是 *"the string should not contain HTML"*）。

**处理：更新到含该修复的版本。**

- HACS 安装：HACS → 集成 → 更新 → **完整重启 HA Core**
- 手动安装：覆盖 `custom_components/hoymiles/` → **完整重启 HA Core**
- 临时绕过：直接把 HA 上 `custom_components/hoymiles/translations/zh-Hans.json`
  里的 `client_prefix-SN` 相关文本改成不含尖括号的写法，然后重启

> 注意：**只重启不换文件是没用的**，必须让新文件先落地。
> 重启后浏览器再 `Ctrl` + `F5` 清一下前端缓存。

### 5.5 桑基图空白 / 报错

| 提示 | 原因与处理 |
|---|---|
| `recorder 集成不可用…` | 未启用 recorder（属于 `default_config`，检查是否被移除） |
| `未找到实体：…` | 实体被改名；用卡片 `statistics` 参数显式指定 statistic_id |
| `暂无统计数据：…` | 实体刚创建，还没生成长期统计；等一个统计周期或检查是否被 recorder `exclude` |
| `所选时间段内没有能量记录` | 该时间段设备未发电/未工作，属正常 |

排查统计是否存在：**开发者工具 → 统计**（Developer Tools → Statistics）。

### 5.6 HACS 列表里的图标是灰色占位框

**不是本仓库的问题，是 HACS 的已知缺陷，无需改我们的文件。**

现象：**HACS 仓库列表**里我们的条目显示灰色占位图，但
**HA 自己的「设备与服务 / 添加集成」**页面图标完全正常。

原因（已核对 HACS 2.0.5 源码与前端 bundle）：

1. HACS 前端只按 CDN 拼 URL：
   `https://brands.home-assistant.io/_/<domain>/icon.png`。
   整个 HACS 前端 bundle 里 **搜不到 `api/brands`**，即它**不读** HA 2026.3+
   的本地品牌图接口。
2. CDN 上的图来自 `home-assistant/brands` 仓库，而该仓库**已不再接收新第三方
   集成的图标**（其 PR 模板原文：*Pull requests for adding new custom
   components will no longer be accepted*），所以永远不会有 `hoymiles` 的条目。
3. 于是 CDN 返回 HA 的通用灰底占位图（约 3039 字节）。

结论：**本地 `brand/` 目录只对 HA 自己有效，对 HACS 列表无效。**

处理：什么都不用做，等 HACS 修复。相关的 open issue：

- [hacs/integration#5171](https://github.com/hacs/integration/issues/5171) — HACS dashboard doesn't show local brand icons (HA 2026.3+)
- [hacs/integration#5223](https://github.com/hacs/integration/issues/5223)
- [hacs/integration#5402](https://github.com/hacs/integration/issues/5402)

想推动的话**去对应 issue 点 👍 / 补一句复现信息**即可。

> ⚠️ **不要**去 `home-assistant/brands` 提 PR 加 `custom_integrations/hoymiles/`：
> 官方已明确不再接收，且该项目 `AI_POLICY.md` 禁止用自主 agent 提 PR/issue。

### 5.7 换了品牌图但界面还是旧的

HA 2026.3 起品牌图走本地代理并**落盘缓存**，改了文件不清缓存就一直吐旧图。

按顺序处理：

1. **清 HA 侧缓存**：删除 `/homeassistant/.cache/brands/integrations/hoymiles/`
   （容器内 HA 配置目录是 `/homeassistant`，不是 `/config`）。
2. **浏览器硬刷新**：`Ctrl` + `Shift` + `R`。
3. 浏览器缓存 7 天、Cloudflare 24h（只影响 CDN 那一路）。

核对 HA 实际吐的是哪个版本（最可靠）：

```js
// 在 HA 页面控制台里执行；token 可从任意品牌图 <img> 的 src 里抄
const r = await fetch("/api/brands/integration/hoymiles/icon.png?token=<token>");
console.log((await r.arrayBuffer()).byteLength);   // 与本地文件大小对比
```

### 5.8 HACS 里的名字/版本不对，或重启后条目消失

**名字与版本以「最新 Release」为准。** HACS 读的是 Release 里的 `hacs.json`
与 `manifest.json`，**不是 main 分支**。

所以改了 `hacs.json` 的 `name` 后发现 HACS 还显示旧名，**必须发一个新 Release**。
反过来也要注意：如果 `manifest.json` 的 version 比最新 Release 高，
用户在 HACS 点「下载」会**降级**到那个 Release。

**重启后自定义仓库从列表消失**：HACS 只把**已安装**仓库的完整数据写进
`.storage/hacs.data`（含 `category` 字段）。启动时
`utils/data.py` 的 `register_unknown_repositories` 会跳过没有 `category` 的条目，
所以「只添加、没下载」的仓库重启后不会被重新注册。

处理：在 HACS 里**点一次「下载」**，让它正式记录为已安装，此后重启就不会丢。

> 该函数的关键判断：
> `if entry == "0" or repo_data.get("category", category) is None or ...: continue`


---

## 6. 发版清单（Copy & Paste）

```text
[ ] 代码已提交、工作区干净
[ ] manifest.json 的 version 已 bump（release.ps1 自动处理）
[ ] git tag vX.Y.Z 已创建并推送
[ ] GitHub Release 已创建（tag 选对、release notes 已写）
[ ] Actions 里 HACS + hassfest 全绿
[ ] （可选）灰度：勾选 Set as a pre-release
[ ] 通知用户：重启 HA 或等最多 48 小时
[ ] 用户被提醒：更新后需要「完整重启 HA Core」+ 浏览器硬刷新
```
