# Hoymiles Micro Storage · Home Assistant 集成 (HACS)

把禾迈微储（MS-A2 / HiBattery 4020 X / HiBattery 4020 AC）接入 Home Assistant，
并提供**分时（TOU）充放电计划**的可视化配置界面。

依据《禾迈微储MQTT协议开发指南 V0.5.1》，设备侧保持"裸 MQTT topic"约定，
本集成负责：

- 订阅设备状态 topic 并生成实体（quick / device / system）
- 订阅 TOU 应答与回显 topic（`tou_day_plan/ack`、`tou_week_plan/ack`、`tou_plan/status`）
- 提供 TOU 日计划 / 周计划 / 获取计划 / EMS 模式 / 重启的**服务**
- 提供原生 options 向导，以及**两张捆绑的 Lovelace 卡片**（自动注册前端资源）：
  - `custom:hoymiles-tou-editor` —— 分时计划可视化编辑器
  - `custom:hoymiles-energy-sankey` —— 能量流桑基图（读取 HA 长期统计）

> 注：集成**复用** Home Assistant 的 MQTT 集成（`dependencies: ["mqtt"]`），
> 不需要重复填写 Broker 账号密码。
>
> 发布 / 安装 / 升级的完整操作流程见 **[DEPLOY.md](DEPLOY.md)**。

---

## 与固件 discovery 的分工

固件通过 MQTT Discovery 已注册以下实体，集成**不会重复创建**：

| 实体 | topic |
|---|---|
| 设备开关 | `homeassistant/switch/<dev_id>/config` |
| EMS 模式 | `homeassistant/select/<dev_id>/ems_mode/config` |
| 功率控制 | `homeassistant/number/<dev_id>/power_ctrl/config` |
| SOC / 电池功率 | `homeassistant/sensor/<dev_id>/soc|bat_p/config` |
| 输出功率 / 多相输出功率 | `homeassistant/number/<dev_id>/output_power|phase_output_power/config` |
| 重启 | `homeassistant/button/<dev_id>/reboot/config` |

因此集成**不创建** `soc` 与 `bat_power` 实体，避免同一数据出现两个实体。

`<dev_id>` = `<mqtt_param.client_prefix>-<SN>`（未配置前缀时仅 SN）。

---

## 安装

### 方式 A：HACS（推荐）

1. HACS → 集成 → 右上 ⋮ → **自定义存储库**
2. 填入仓库地址 `https://github.com/ls199303/ha`，类别选择 **Integration**
3. 搜索 `Hoymiles Micro Storage` → **下载**
4. **完整重启 Home Assistant Core**（不是 reload config entry）

> 为什么必须完整重启：新下载的 Python 模块需要重新 import，
> 只 reload config entry 不会加载新代码。

### 方式 B：手动安装

把 `custom_components/hoymiles/` 整个目录拷贝到 HA 配置目录：

```
/config/custom_components/hoymiles/
```

然后**完整重启** Home Assistant（不是重载）。

拷贝到树莓派/HAOS 的常见做法：
- HAOS / Supervised：装 Samba share 或 SSH add-on，访问 `\\<host>\config\custom_components\`
- HA Core / Docker：`cp -r hoymiles /config/custom_components/` 或 `docker cp`

### 前置条件

- Home Assistant `2023.8` 或更高（`hacs.json` 已声明最低版本）
- 已安装并配置 Home Assistant 的 **MQTT 集成**
- 固件已连接同一个 Broker，并使用 `homeassistant/...` 前缀发布 discovery

---

## 添加设备

设置 → 设备与服务 → **添加集成** → 搜索 `Hoymiles Micro Storage`。

集成会自动扫描 retained 的 `homeassistant/switch/+/config` 主题，把发现的
设备列在下拉框中；也可以手动输入 `dev_id`（例如 `MSA-280520260806`）。

---

## 配置 TOU 计划

有两条路径，效果一致：

### 1) 原生 options 向导
设备卡片 → **配置**：

| 菜单 | 说明 |
|---|---|
| 编辑日计划 | 选择 `day1..day8` 与段数，逐段填写 mode / ts / te / sh / sl / pc / pd |
| 编辑周计划 | 为周一~周日各选一个日计划（或 `none`） |
| 获取当前计划 | 按星期查询设备当前计划，结果进状态实体 + 通知 |
| 设置 EMS 模式 | `general` / `mqtt_ctrl` / `tou_plan` |
| 重启设备 | 发送 `RESTART` |

### 2) 捆绑的 Lovelace 卡片
集成启动时会自动把 `hoymiles-tou-editor.js` 注册为前端模块，**无需手动添加资源**。

添加卡片：

```yaml
type: custom:hoymiles-tou-editor
dev_id: MSA-280520260806
language: zh
```

卡片只有在 EMS 模式为 `tou_plan` 时才渲染编辑界面（`require_tou_mode: false` 可关闭该门控）。
卡片会依次下发 `day1..day8` 日计划 → 周计划 → 切到 `tou_plan` → 回读当天计划。

> 设备的 `ems_mode` 是**乐观实体**（Discovery 未提供 `state_topic`），
> 因此卡片读到的模式是"最后一次设置值"。集成另提供 `EMS Mode (Device)` 传感器，
> 来自 `system/state` 的 `ems_mode` 字段，可反映设备实际运行模式。

---

## 能量流桑基图

集成捆绑了一张能量流桑基图卡片，同样**无需手动添加前端资源**。

```yaml
type: custom:hoymiles-energy-sankey
dev_id: MSA-280520260806
title: 能量流
language: zh
range: today          # today | 7d | 30d | month
```

| 参数 | 说明 |
|---|---|
| `dev_id` | **必填**，设备标识（`<client_prefix>-<SN>`） |
| `title` | 卡片标题 |
| `language` | `zh` / `en` |
| `range` | 时间范围：`today`（默认）/ `7d` / `30d` / `month` |
| `balancer_label` | 「损耗/其他」或「未计量」节点的自定义名称 |
| `statistics` | 覆盖默认 statistic_id（字符串或数组） |
| `show_toolbar` | `false` 隐藏时间段切换栏 |

### 数据来源

卡片调用 HA 官方的 WebSocket 统计接口读取**长期统计**：

```
recorder/statistics_during_period
  statistic_ids: [...]   # 本设备的能量传感器
  period: "day"
  units: {energy: "kWh"} # 由服务端换算单位
  types: ["change"]      # HA 已算好的区间增量
```

因此：

- **不接触** recorder 数据库文件（不读 SQLite、不受 schema 迁移影响）
- **不需要管理员权限**（`statistics_during_period` 没有 `require_admin`）
- 只依赖 recorder 集成（属于 `default_config`）
- 渲染是自绘 SVG，**不依赖 CDN**，离线也能用

### 关于「损耗/其他」节点

桑基图要求流量守恒，而设备各端口是**独立计量**的（转换损耗、采样相位、
未计量负载都会造成差额）。卡片**不做归一化缩放**，而是把差额显式画成一个
节点（正差额记为「损耗/其他」，负差额记为「未计量」），
保证图面守恒且各条数值真实。

### 与官方能源仪表盘的关系

HA 自带能源仪表盘有 Sankey 风格的「能量分布」卡片，但节点固定为
**光伏 / 电网 / 电池 / 家庭** 四类。配置方法：

| 位置 | 建议实体 |
|---|---|
| 太阳能 | `sensor.<dev>_system_pv_energy_today` |
| 电网受电 | `sensor.<dev>_grid_on_energy_in_total` |
| 电网送电 | `sensor.<dev>_grid_on_energy_out_total` |
| 电池充电 | `sensor.<dev>_battery_charge_energy_today` |
| 电池放电 | `sensor.<dev>_battery_discharge_energy_today` |

> **优先用 `*_total` 累计口径**（`grid_on_*` / `inv_*` 的 `etin` / `etout`）。
> `*_today` 型每天清零，HA 在**长时间停机后**会把"跨天下降"识别为设备重置，
> 中间天数的增量会丢失；累计型没有这个问题。

设备特有的 **EPS / 插座 / 离网** 端口官方模型装不下，那部分用本卡片展示。

---

## 更新

集成通过 HACS 管理更新，厂商发版后：

- HACS 最长 **48 小时**检查一次新版本，**HA 每次启动也会立即检查**
- 有新版本时，HACS 侧边栏出现红点、**设置 → 系统 → 更新** 出现 `update` 实体、并弹一条通知
- 用户点 **更新** → 提示后 **重启 Home Assistant Core** 即生效

> HACS 的检查间隔是**硬编码**的，HACS 配置里没有这个选项。
> 想立刻检查：重启 HA，或在 HACS 面板手动重载，或对 update 实体调
> `homeassistant.update_entity`（可写成自动化，但别太频繁，否则会触发 GitHub 限流）。

前端卡片改动后若界面没变化，请**硬刷新浏览器**（`Ctrl` + `F5`）。

更新后同目录的手动安装方式不会自动升级，需要重新拷贝文件并完整重启。

---

## 服务

| 服务 | 说明 |
|---|---|
| `hoymiles.set_tou_day_plan` | 下发某一天日计划 |
| `hoymiles.set_tou_week_plan` | 下发星期与日计划映射 |
| `hoymiles.get_tou_plan` | 查询某一天计划 |
| `hoymiles.set_ems_mode` | 切换 EMS 模式 |
| `hoymiles.reboot` | 重启设备 |

目标设备二选一：

- **`device_id`** —— 在 UI 里从设备下拉中选择（推荐，自动补全）
- **`dev_id`** —— 直接填设备标识字符串，如 `MSA-280520260806`

> ⚠️ 服务**不支持** `target.device` 这种写法 —— HA 明确禁止在服务的 `target`
> 下使用 device 过滤器，设备只能通过上面的 `device_id` 字段（device selector）指定。

示例：

```yaml
service: hoymiles.set_tou_day_plan
data:
  dev_id: MSA-280520260806
  day_idx: 1
  day_plan:
    - {mode: 1, ts: 0, te: 5, sh: 55, sl: 10, pc: 1000, pd: 1000}
    - {mode: 4, ts: 5, te: 96, sh: 55, sl: 10, pc: 1000, pd: 1000}
```

在 UI 里也可以这样选设备：

```yaml
service: hoymiles.reboot
data:
  device_id: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d   # 从设备下拉里选
```

---

## 实体

| 平台 | 来源 | 示例 |
|---|---|---|
| `sensor` | `quick/state`（1s，所有角色） | `PV Power`、`Grid On Power`、`Battery Status`、`System SOC` |
| `sensor` | `device/state`（5min，所有角色） | `Grid On Voltage`、`Inverter Power`、`PV1 Power`、`Pack 1 SOC`、`Battery Temperature` |
| `sensor` | `system/state`（5min，仅主机/单机） | `System PV Energy Today`、`Battery Charge Energy Today`、`EMS Mode (Device)` |
| `sensor` | TOU topic | `TOU Plan Status`、`TOU Day Plan Ack`、`TOU Week Plan Ack` |
| `binary_sensor` | `quick/state`、`device/state` | `Heating`、`System Heating`、`Pack N Heating` |

> `system/state` 与 `quick/state` 的 `sys_*` 字段仅主机/单机发布；从机上这些实体为 `unknown`。
> `pv_num` / `pvs` 字段在 PID=0x2806 的机型上不发布，`PV1..PV4 Power` 为 `unknown`。

---

## 排错

| 现象 | 处理 |
|---|---|
| 添加集成时列表为空 | 确认 MQTT 集成已配置、Broker 地址一致；设备需已连接并发过 retained discovery |
| 实体一直 `unknown` | 确认 `dev_id` 大小写与 topic 完全一致；`system/state` 仅在主机/单机发布 |
| 卡片找不到 | 集成启动后会自动注入前端模块；若浏览器缓存旧版请强制刷新 |
| 下发 TOU 报 `10` | 表示设备当前不是 `tou_plan` 模式，先调用 `hoymiles.set_ems_mode` |
| 云平台下载的集成不生效 | 树莓派旧版 HA 注意最低版本要求，或改用"手动拷贝 + 重启"方式 |

---

## 目录结构

```
hoymiles-ha/
├── hacs.json
├── README.md
└── custom_components/hoymiles/
    ├── __init__.py          入口 / 前端资源注册
    ├── manifest.json
    ├── const.py             topic 模板、常量、应答状态码
    ├── mqtt_util.py         MQTT 收发与设备自动发现
    ├── coordinator.py       MQTT 推送型 DataUpdateCoordinator
    ├── sensor.py            状态传感器 + TOU 回显/应答传感器
    ├── binary_sensor.py     加热状态
    ├── config_flow.py       设备发现与接入
    ├── options_flow.py      TOU 配置向导
    ├── services.py          hoymiles.* 服务
    ├── services.yaml
    ├── strings.json
    ├── translations/        en / zh-Hans
    └── www/hoymiles-tou-editor.js
```
