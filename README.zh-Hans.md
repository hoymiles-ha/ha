# Hoymiles Official · Home Assistant 集成

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2023.8%2B-41BDF5.svg)](https://www.home-assistant.io)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

把**禾迈微储**接入 Home Assistant，并提供**分时（TOU）充放电计划**的可视化配置界面，
以及**八张贴合禾迈 App 版式的 Lovelace 卡片**。

[English](README.md) · **简体中文**

| 想了解什么 | 去哪儿 |
|---|---|
| 安装与上手 | 本页 |
| 每张卡片的完整参数 | **[docs/CARDS.md](docs/CARDS.md)** |
| MQTT 话题、固件 discovery 补丁、实体清单 | **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** |
| 发版 / 仓库维护 | **[DEPLOY.md](DEPLOY.md)** |

---

## 特点

- **纯 MQTT，不上云。** 集成复用 Home Assistant 自带的 MQTT 集成
  （`dependencies: ["mqtt"]`）——不需要第二个 Broker、不需要账号、不经过云端，
  数据全程在局域网内。
- **直接读设备真实话题。** 实体来自 `quick/state`（1 秒）、`device/state`（5 分钟）、
  `system/state`（5 分钟），依据《禾迈微储 MQTT 协议开发指南 V0.5.1》。
- **修掉固件写错的报文，且不用刷固件。** 部分固件发布的 MQTT discovery 报文会被
  Home Assistant 整条拒绝；集成会实时改写并以 retained 重发。补丁是**幂等**的，
  固件修好后自动变成空操作。
- **TOU 计划编辑器。** 配置 `day1`…`day8`、为每个星期指定日计划、下发、再切到
  `tou_plan` —— 原生 options 向导和可视化卡片两条路都可以。
- **八张捆绑卡片**，集成启动时自动注册为前端模块，**无需手动添加资源**。
  全部自绘 SVG，**不依赖 CDN、不依赖第三方卡片**，离线可用。
- **跟随界面语言。** 八张卡片都使用**当前登录用户**的语言（`hass.language`），
  所以同一个仪表盘对英文用户和中文用户都能正确显示，无需为每人复制一份。
  **你自己写**的文字也能跟随 —— 把 `title` / `name` / `label` 写成映射
  （`{en: History, zh: 历史数据}`）而不是字符串即可，详见
  [docs/CARDS.zh-Hans.md](docs/CARDS.zh-Hans.md#让自己写的文字也跟随语言)。
  只有需要把某张卡片钉死语言时才写 `language: en` / `language: zh`。
- **诚实的可用性判定。** 设备停止推送 2 分钟内实体转为 `unavailable`，
  而不是一直展示陈旧值。

## 兼容性

| 项目 | 要求 |
|---|---|
| **Home Assistant** | 2023.8 或更高（已在 `hacs.json` 声明） |
| **必需集成** | Home Assistant 的 **MQTT** 集成，指向与设备相同的 Broker |
| **设备** | MS-A2 · HiBattery 4020 X · HiBattery 1920 AC |
| **固件** | 需在 `homeassistant/` 前缀下发布 MQTT discovery |
| **Recorder** | 可选 —— 仅历史曲线卡片与桑基图卡片需要 |

> 不同型号上报的数据不同。卡片做了优雅降级：设备从未上报的字段不会渲染出来。

---

## 安装

### 方式 A：HACS（推荐）

1. **HACS → 集成 → 右上角 ⋮ → 自定义存储库**
2. 仓库地址填 `https://github.com/hoymiles-ha/ha`，类别选 **Integration**
3. 搜索 **Hoymiles Official** → **下载**
4. **完整重启 Home Assistant Core**（不是「重载配置项」）

> 为什么必须完整重启：新下载的 Python 模块需要重新 import，
> 只 reload config entry 不会加载新代码。

### 方式 B：手动安装

把 `custom_components/hoymiles/` 整个目录拷贝到 Home Assistant 配置目录：

```
/config/custom_components/hoymiles/
```

然后**完整重启** Home Assistant。

拷贝到树莓派 / HAOS 的常见做法：

- **HAOS / Supervised** —— 装 Samba share 或 SSH add-on，访问
  `\\<host>\config\custom_components\`
- **HA Core / Docker** —— `cp -r hoymiles /config/custom_components/` 或 `docker cp`

### 前置条件

- Home Assistant **2023.8+**
- 已安装并配置 **MQTT 集成**
- 设备已连接**同一个** Broker，并在 `homeassistant/...` 前缀下发布 discovery

---

## 添加设备

**设置 → 设备与服务 → 添加集成 → 搜索 `Hoymiles Official`。**

集成会自动扫描 retained 的 `homeassistant/switch/+/config` 主题，把发现的设备列在下拉框
里，通常直接选一个就行；也可以手动输入 `dev_id`（例如 `MSA-280520260806`）。

`dev_id` = `<mqtt_param.client_prefix>-<SN>`，未配置前缀时仅 SN。

---

## 快速上手

设备添加完之后就能用实体和八张卡片了。一个最小仪表盘示例：

```yaml
type: vertical-stack
cards:
  - type: custom:hoymiles-power-flow
    dev_id: MSA-280520260806

  - type: custom:hoymiles-battery
    dev_id: MSA-280520260806

  - type: grid
    columns: 3
    square: false
    cards:
      - type: custom:hoymiles-gauge
        entity: sensor.msa_280520260806_system_pv_energy_today
        name: 今日发电量
        unit: kWh
        scale: 0.001
        icon: ☀️
        max: 10
      - type: custom:hoymiles-gauge
        entity: sensor.msa_280520260806_battery_discharge_energy_today
        name: 今日放电量
        unit: kWh
        scale: 0.001
        icon: 🔋
      - type: custom:hoymiles-gauge
        entity: sensor.msa_280520260806_battery_charge_energy_today
        name: 今日充电量
        unit: kWh
        scale: 0.001
        icon: ⚡
```

> 上面两张卡都没有写 `language`，因此都跟随**查看者自己的**界面语言。仪表盘卡片是例外 ——
> 它的文字来自你填的 `name`，想显示哪种语言就填哪种。详见
> [docs/CARDS.zh-Hans.md](docs/CARDS.zh-Hans.md#语言是怎么选的)。

配置 TOU 计划，两条路效果一致：

- **原生向导** —— 设备卡片 → **配置** → *编辑日计划* / *编辑周计划* /
  *获取当前计划* / *设置 EMS 模式* / *重启设备*
- **卡片** —— `type: custom:hoymiles-tou-editor`。卡片只有在 EMS 模式为 `tou_plan`
  时才渲染编辑界面，`require_tou_mode: false` 可以关掉该门控。

---

## 八张卡片

| 卡片 | 作用 |
|---|---|
| `custom:hoymiles-power-flow` | 家居插图，叠加实时光伏 / 微储 / 电网 / 负载功率与流动动画 |
| `custom:hoymiles-battery` | 按**实际电池包数量**（1~4）自适应的电池堆，逐包 SOC 与温度 |
| `custom:hoymiles-pack-list` | 紧凑电池包列表 —— SOC 进度条、温度、加热标记 |
| `custom:hoymiles-history-chart` | 日 / 月 / 年曲线 + 日期导航，读取长期统计 |
| `custom:hoymiles-gauge` | 单值仪表盘，支持量程换挡（如 Wh → kWh） |
| `custom:hoymiles-control` | 开关机 / EMS 模式 / 功率 / 多相输出 / 取计划 / 重启 |
| `custom:hoymiles-tou-editor` | 分时计划可视化编辑器 |
| `custom:hoymiles-energy-sankey` | 能量流桑基图，读取长期统计 |

每张卡片都以 `ha-card` 为根、自绘 SVG，不依赖 CDN。

**→ 每张卡片的完整参数说明：[docs/CARDS.md](docs/CARDS.md)**

> 卡片在集成启动时自动注入为前端模块。界面没变化时请硬刷新浏览器（`Ctrl` + `F5`）。

---

## 服务

| 服务 | 说明 |
|---|---|
| `hoymiles.set_tou_day_plan` | 下发 `day1`…`day8` 中某一天的日计划 |
| `hoymiles.set_tou_week_plan` | 下发「星期 → 日计划」映射 |
| `hoymiles.get_tou_plan` | 查询设备当前计划 |
| `hoymiles.set_ems_mode` | 切换 EMS 模式（`general` / `mqtt_ctrl` / `tou_plan`） |
| `hoymiles.set_phase_output_power` | 一次性设置 A/B/C 三相输出功率限值 |
| `hoymiles.reboot` | 重启设备 |

目标设备二选一：

- `device_id` —— 在 UI 里从设备下拉中选择（推荐，自动补全）
- `dev_id` —— 直接填设备标识字符串，如 `MSA-280520260806`

```yaml
service: hoymiles.set_tou_day_plan
data:
  dev_id: MSA-280520260806
  day_idx: 1
  day_plan:
    - {mode: 1, ts: 0, te: 5, sh: 55, sl: 10, pc: 1000, pd: 1000}
    - {mode: 4, ts: 5, te: 96, sh: 55, sl: 10, pc: 1000, pd: 1000}
```

> ⚠️ 服务**不支持** `target.device` 这种写法 —— HA 明确禁止在服务的 `target` 下使用
> device 过滤器。设备只能通过上面的 `device_id` 字段（device selector）指定。

---

## 实体

| 平台 | 来源 | 示例 |
|---|---|---|
| `sensor` | `quick/state`（1 秒，所有角色） | `PV Power`、`Grid On Power`、`Battery Status`、`System SOC` |
| `sensor` | `device/state`（5 分钟，所有角色） | `Grid On Voltage`、`Inverter Power`、`PV1 Power`、`Pack 1 SOC`、`Battery Temperature` |
| `sensor` | `system/state`（5 分钟，仅主机 / 单机） | `System PV Energy Today`、`Battery Charge Energy Today`、`EMS Mode (Device)` |
| `sensor` | TOU 话题 | `TOU Plan Status`、`TOU Day Plan Ack`、`TOU Week Plan Ack` |
| `binary_sensor` | `quick/state`、`device/state` | `Heating`、`System Heating`、`Pack N Heating` |
| `number` | 集成本地维护 | `Phase A/B/C Output Power` |

完整的话题映射、固件 discovery 补丁说明与可用性判定逻辑见
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

---

## 更新

集成通过 HACS 管理更新，厂商发版后：

- HACS 最长 **48 小时**检查一次新版本，**HA 每次启动也会立即检查**
- 有新版本时，HACS 侧边栏出现红点、**设置 → 系统 → 更新** 出现 `update` 实体，并弹一条通知
- 点 **更新** → 提示后 **重启 Home Assistant Core** 即生效

> HACS 的检查间隔是**硬编码**的，HACS 配置里没有这个选项。
> 想立刻检查：重启 HA，或在 HACS 面板手动重载，或对 update 实体调
> `homeassistant.update_entity`（可写成自动化，但别太频繁，否则会触发 GitHub 限流）。

手动安装方式**不会**自动升级，需要重新拷贝文件并完整重启。

---

## 排错

| 现象 | 处理 |
|---|---|
| 添加集成时列表为空 | 确认 MQTT 集成已配置、Broker 地址一致；设备需已连接并发过 retained discovery |
| 实体一直 `unknown` | 确认 `dev_id` 大小写与 topic 完全一致；`system/state` 仅在主机 / 单机发布 |
| 卡片找不到 | 集成启动后会自动注入前端模块；若浏览器缓存旧版请强制刷新 |
| 下发 TOU 报 `10` | 表示设备当前不是 `tou_plan` 模式，先调用 `hoymiles.set_ems_mode` |
| 日志报 `Invalid config for [switch.mqtt]` | 固件重连时先发了自己的旧报文，集成会在毫秒内补上；实体正常则无需理会 |
| 日志报 `mode: textarea` 或 `does not generate unique IDs` | 前者是本集成会自动清理的旧固件遗留（升级后应消失）；后者是旧固件把多个 config 的 `unique_id` 写成同一个值，**只影响未被本集成管理的设备**，需升级固件消除 |
| 开关状态显示 `unknown` | 已按设计改为乐观实体，只能反映本集成下发的状态（设备无开关状态回读） |
| 实体全部 `unavailable` | 检查设备是否在推送；`quick/state` 停超 2 分钟即判定离线 |
| 新增 `state_topic` 后实体不跟随 | HA 不会为已存在实体重建订阅，需**完整重启** HA Core |
| 云平台下载的集成不生效 | 树莓派旧版 HA 注意最低版本要求，或改用「手动拷贝 + 重启」方式 |

更多排错（含 HACS 图标限制、发版相关的坑）见 **[DEPLOY.md](DEPLOY.md)**。

---

## 目录结构

```
hoymiles-ha/
├── hacs.json                     HACS 元数据
├── README.md                     英文说明
├── README.zh-Hans.md             本文件
├── DEPLOY.md                     发版 / 维护手册
├── docs/
│   ├── CARDS.md                  卡片参数总表
│   └── ARCHITECTURE.md           MQTT 话题、discovery 补丁、实体模型
├── scripts/                      品牌图生成脚本
└── custom_components/hoymiles/
    ├── __init__.py               入口 / 前端资源注册
    ├── manifest.json
    ├── const.py                  topic 模板、常量、应答状态码
    ├── mqtt_util.py              MQTT 收发与设备自动发现
    ├── coordinator.py            MQTT 推送型 DataUpdateCoordinator + 可用性判定
    ├── discovery_override.py     固件 discovery 报文补丁
    ├── sensor.py                 状态传感器 + TOU 回显 / 应答传感器
    ├── binary_sensor.py          加热状态
    ├── number.py                 三相输出功率
    ├── config_flow.py            设备发现与接入
    ├── options_flow.py           TOU 配置向导
    ├── services.py               hoymiles.* 服务
    ├── services.yaml
    ├── strings.json
    ├── translations/             en / zh-Hans
    ├── brand/                    icon.png + logo.png
    └── www/                      八张 Lovelace 卡片（JS）
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
