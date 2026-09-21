# Hoymiles Micro Storage · Home Assistant 集成 (HACS)

把禾迈微储（MS-A2 / HiBattery 4020 X / HiBattery 4020 AC）接入 Home Assistant，
并提供**分时（TOU）充放电计划**的可视化配置界面。

依据《禾迈微储MQTT协议开发指南 V0.5.1》，设备侧保持"裸 MQTT topic"约定，
本集成负责：

- 订阅设备状态 topic 并生成实体（quick / device / system）
- 订阅 TOU 应答与回显 topic（`tou_day_plan/ack`、`tou_week_plan/ack`、`tou_plan/status`）
- 提供 TOU 日计划 / 周计划 / 获取计划 / EMS 模式 / 重启的**服务**
- 提供原生 options 向导，以及**八张捆绑的 Lovelace 卡片**（自动注册前端资源）：
  - `custom:hoymiles-power-flow` —— 家居功率流总览（光伏 / 微储 / 电网 / 负载）
  - `custom:hoymiles-battery` —— 电池堆总览（按实际电池包数量自适应，逐包 SOC/温度）
  - `custom:hoymiles-pack-list` —— 电池包列表（SOC 进度条 / 温度 / 加热状态）
  - `custom:hoymiles-history-chart` —— 历史曲线（日 / 月 / 年 + 日期导航，读长期统计）
  - `custom:hoymiles-gauge` —— 单个数值的仪表盘（带量程换挡，如 Wh → kWh）
  - `custom:hoymiles-control` —— 控制面板（开关机 / EMS / 功率 / 多相 / 重启）
  - `custom:hoymiles-tou-editor` —— 分时计划可视化编辑器
  - `custom:hoymiles-energy-sankey` —— 能量流桑基图（读取 HA 长期统计）

> 八张卡片都以 `ha-card` 为根、自绘 SVG，**不依赖任何 CDN 或第三方卡片**，
> 离线环境同样可用；`language` 统一支持 `zh` / `en`。

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

### 集成会「补丁」固件的 discovery 报文

固件写死的 discovery 报文并不完全符合 Home Assistant 的各域 schema（例如
`switch` 域缺少 `command_topic`、`soc`/`bat_p` 缺 `state_class`），而 discovery
**本质上就是 topic 上的一条 retained 报文**。因此集成会订阅本设备的
`homeassistant/+/<dev_id>/config`，在必要时改写报文并用 `retain=True` 重发，
**无需刷新固件**。实现见 `discovery_override.py`。

| 话题 | 补丁 | 原因 |
|---|---|---|
| `switch/<dev_id>` | 补 `command_topic`；无 `value_template` 时去掉 `state_topic` | 固件 ≤ 1.3.101 没写 `command_topic`，HA 会整条拒绝；而 `state_topic` 指向的 `device/state` 是嵌套 JSON，开关状态永远解不出 `ON`/`OFF`。去掉后变成乐观实体，符合硬件（`ON` 唤醒 / `OFF` 休眠，本就无可读开关状态） |
| `select/<dev_id>/ems_mode` | 补 `state_topic`（集成自维护话题） | 固件没给状态话题，HA 重启后实体变成 `unknown` |
| `sensor/<dev_id>/soc`、`bat_p` | 补 `state_class: measurement` | 否则不产生长期统计（LTS） |
| `number/<dev_id>/phase_output_power` | 补 `command_template` | 固件要求 `{"phase_a":..,"phase_b":..,"phase_c":..}`，而 `number` 实体默认只能发一个数字，实体完全不能用 |
| 以上全部 | 补 `availability_topic` | 设备停止推送后实体转为 `unavailable`，不再展示陈旧值 |
| `text/<dev_id>/tou_day1..8`、`tou_week_plan` | **删除**（空 retained payload） | 旧固件遗留的 TOU 文本实体配置，`"mode": "textarea"` 不是合法值，**每次 HA 启动都报错**。当前固件改用 `sensor/<dev_id>/tou_day_plan/set`，且 HA 从未成功建过这些实体 ⇒ 清理零损失 |

> 补丁是**幂等且带判定条件**的：报文已合规时**不会**重发，因此固件修好后这层
> 自动变成空操作（届时可以删除）。
>
> 被删除的过期配置同理：删掉后 retained 就不再存在，**不会反复发布**；若某个跑旧固件的设备又把它发回来，会被再次删除（自愈）。
>
> ⚠️ 副作用：固件每次重连会重发一次自己的（旧）报文，HA 可能在补丁到达前先对旧
> 报文报一次错；日志里看到 `Invalid config for [switch.mqtt]` 但实体正常，属于正常现象。
> 反之，即使卸载集成，只要固件重连一次就会用自己的报文覆盖回去，**自带自愈**。
> 另外，`availability_topic` 与 `ems_mode` 状态话题都位于 `hoymiles/<dev_id>/…` 命名
> 空间下，与固件话题不冲突。
>
> ⚠️ HA 不会为**已存在**的实体重建订阅：给实体新增 `state_topic` 这类订阅键需要**完整重启**
> HA 才生效（`mqtt.reload` 也不一定行）。若设备恰好在 HA 启动瞬间重连、HA 先读到未修正的
> 报文，个别实体会到下次重启前不跟随状态话题。

#### 开关实体的固件支持情况

补 `command_topic` 只是让 HA **不再拒绝**这条报文，能否真正开关机取决于固件：

| 固件 | `…/switch/…/config` | 订阅 `…/switch/…/set` | 表现 |
|---|---|---|---|
| ≤ 1.3.101 | 缺 `command_topic` | ✗ 未订阅 | 补丁后实体出现，但下发无效（设备不响应） |
| 下一个发版及以后 | 完整 | ✓ 已订阅 | 开关机生效（`ON` 唤醒 / `OFF` 休眠） |

---

## 安装

### 方式 A：HACS（推荐）

1. HACS → 集成 → 右上 ⋮ → **自定义存储库**
2. 填入仓库地址 `https://github.com/hoymiles-ha/ha`，类别选择 **Integration**
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

> 设备的 `ems_mode` 是早期固件未提供 `state_topic`，集成会给它补一个**自维护的
> retained 状态话题** `hoymiles/<dev_id>/ems_mode/state`：
>
> - 任何人向 `…/ems_mode/command` 下发后，集成立即回显到该话题 → 界面/卡片即时刷新；
> - 同时跟随 `system/state` 里的 `ems_mode`（设备真实运行模式，5 分钟周期）
>   进行纠正，所以设备侧超时自动回退到 `general` 也能反映出来。
>
> 为什么不直接把 `state_topic` 指向 `system/state`：该话题只有 5 分钟周期，而本卡片
> 是用 select 状态做门控的，那样会让“切到 tou_plan”后最多卡 5 分钟。

---

## 功率流总览卡片

把「家」画出来，并把实时的光伏 / 微储 / 电网 / 负载功率叠加在插图上，和手机 App
首页一致。

```yaml
type: custom:hoymiles-power-flow
dev_id: MSA-280520260806
title: 我的家            # 可选，默认「我的家」
show_title: false        # 可选，false 隐藏标题与设备 SN（只留右侧信号图标）
language: zh             # 可选 en|zh
temperature_entity: sensor.outdoor_temperature   # 可选，标题右侧显示温度
show_rssi: true          # 可选，右上角信号扇形（默认 true）
gradient: true           # 可选，浅色渐变底（默认 true）
max_width: 620           # 可选，插图最大宽度
```

数据全部来自 MQTT 实体（**不依赖 recorder**）：

| 节点 | 实体后缀（`sensor.<dev>_…`） |
|---|---|
| 光伏 | `system_pv_power`（缺失时回退 `pv_power`） |
| 微储 | `system_battery_power`（负=充电）+ `system_soc` |
| 电网 | `system_grid_power`（正=受电） |
| 负载 | `system_load_power` |
| 状态气泡 | `battery_status`（`standby`/`charge`/`discharge`/`lock`） |
| 信号扇形 | `rssi`（dBm） |

- 连线只有该支路功率 ≥ 5 W 时才显示流动小球，球的颜色随支路变化，速度随功率加快。
- 「微储」气泡显示电池真实状态；「电网」气泡显示 `电网输入` / `电网输出`。
- **卡片右上角是 RSSI 信号图标**（与「电池卡片」及 App 的 Wi-Fi 图标同款）：
  四根高度递增的信号条，点亮的条数（0~4）表示信号质量，旁边直接跟 `-21 dBm`
  读数，悬停可看「优秀 / 良好 / 一般 / 较弱」：

  | RSSI | 点亮条数 |
  |---|---|
  | ≥ -55 dBm | 4（优秀） |
  | ≥ -65 dBm | 3（良好） |
  | ≥ -75 dBm | 2（一般） |
  | < -75 dBm | 1（较弱） |

  设备不上报 `rssi` 时自动隐藏，不需要可以把 `show_rssi` 设为 `false`。
- 单独覆盖某个实体用 `entities:` 段，例如 `entities: { pv: sensor.my_pv, rssi: sensor.my_rssi }`。

## 电池卡片

按**实际电池包数量**自适应绘制电池堆：1～4 个电池包各对应一种外形，每个模组
配一个左右交替的气泡显示自己的 SOC 与温度（和 App 的 HiBattery X 页面一致）。

```yaml
type: custom:hoymiles-battery
dev_id: MSA-280520260806
title: HiBattery X        # 可选
language: zh              # 可选 en|zh
show_history: true        # 可选，默认 true（需启用 recorder）
max_width: 560            # 可选，插图最大宽度
alarm_entity: binary_sensor.x   # 可选，为 on 时标题左侧显示铃铛
```

- 电池数量优先取 `pack_count`（`device/state` 的 `pack_num`），缺失时按实际能读到
  SOC 的 `pack1_soc`…`pack4_soc` 推断，上限 4（与固件 `packs` 截断一致）。
- 逐包数据用 `pack<i>_soc` / `pack<i>_temperature`；四周功率用 `pv_power`、
  `grid_on_power`、`grid_off_power`、`battery_power`。
- 标题右侧的信号格数由 `rssi`（dBm）换算。
- 历史数据区（可选）通过 `recorder/statistics_during_period` 读取长期统计，画 SOC
  曲线并汇总该区间的充电 / 放电电量；recorder 未启用时只提示、不影响其余部分。

## 电池包列表卡片

电池堆插图的紧凑替代：一行一个电池包，左侧 SOC 进度条、中间温度、右侧加热标记。
包数量与电池卡片用同一套规则（`pack_count` 优先，缺失时按能读到 SOC 的包推断）。

```yaml
type: custom:hoymiles-pack-list
dev_id: MSA-280520260806
language: zh
title: 电池包
columns: 2                # 可选，按 N 列排布；不填为单列
```

## 历史数据卡片

按**日 / 月 / 年**查看曲线，并可用 `‹` `›` 或日期输入框翻到任意时间段。
正值向上、负值向下堆叠，因此「充电 / 放电」这类双极性传感器会自然地分居 0 线两侧。

```yaml
type: custom:hoymiles-history-chart
dev_id: MSA-280520260806      # 可选（所有 series 都给了 entity 时可省）
title: 历史数据
language: zh
range: day                    # 初始范围 day | month | year
height: 330                   # 可选，SVG 高度
unit: W                       # 可选，纵轴单位（超过 1.5 kW 自动换成 kW）
zero_line: true               # 可选，是否画 0 线（默认 true）
symmetric: true               # 可选，false = 从 min 到 max 自底向上（SOC 用）
min: 0                        # 可选，固定下限
max: 100                      # 可选，固定上限
span: 2500                    # 可选，对称模式下固定半量程
series:                       # 必填，每条曲线一项
  - entity: sensor.x_pv_power
    name: 发电功率
    color: "#22c55e"
  - entity: sensor.x_system_battery_power
    name: 放电[+]/充电[-]
    color: "#4a90d9"
```

- 数据同样来自 `recorder/statistics_during_period`（长期统计，**无需管理员权限**）。
- 纵轴刻度会按实际步长自动决定小数位（例如 1.25 kW 的步长会显示 `1.25` 而不是取整成 `1`）。
- 固定 `span` / `min` / `max` 可让同一组曲线在不同日子保持同一量程，便于横向对比。
- **点击下方图例可以高亮某条曲线**：选中的曲线加粗提亮，其余曲线淡入背景；
  再点同一条、或点图表区域即取消高亮。悬停浮窗里被淡化的曲线会同步降低透明度。

## 仪表盘卡片

一张**统计卡**：左上标题、右上图标、中间大字数值，下方**一条绿弧**按数值占
`min`~`max` 的百分比填充，弧中央同时显示该百分比。HA 自带 `gauge` 卡片的轻量
替代，另针对本设备做了两点补齐：

- **可以换单位**（`scale`），直接把 Wh 传感器显示成 kWh，不需要额外的 template 传感器；
- **可以不给 `max`**，此时弧线随数值增长（适合「今日充电量」这类没有固定上限的量）。

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_battery_charge_energy_today
name: 今日充电量
unit: kWh                 # 可选，显示单位
scale: 0.001              # 可选，显示前的换算系数（Wh → kWh）
max: 10                   # 可选（显示单位）；不填表示自适应
min: 0                    # 可选，默认 0
decimals: 2               # 可选，默认 2
icon: ⚡                   # 可选，标题右侧的图标
label: 自发自用率          # 可选，百分比下方的说明文字
color: "#22c55e"          # 可选，弧线颜色（默认绿色）
```

- 百分比 = `(值 - min) / (max - min) × 100`，四舍五入到整数；值超出量程时钳到 0~100%。
- 实体还没上报数据时仍画出空弧，数值与百分比显示 `—`，卡片不会变成一片空白。
- 把 `max` 设为 100 并直接接 SOC 传感器，就是一张电池电量表。

## 控制面板卡片

把《禾迈微储 MQTT 协议开发指南 V0.5.1》里**所有可下发的控制**做成按钮 / 输入框。
指令**直接发布到协议 topic**（qos 1、retain false），因此即使某个 discovery 实体缺失
或选项列表比协议窄，卡片也仍可用；当前值则从对应实体回读。

```yaml
type: custom:hoymiles-control
dev_id: MSA-280520260806
language: zh
title: 设备控制
show_power_ctrl: true     # 可选，默认 true（隐藏「功率控制」行）
show_phase: true          # 可选，默认 true（隐藏「多相输出功率」行）
```

| 行 | 协议 topic | 说明 |
|---|---|---|
| 设备开关 | `switch/<dev_id>/set` | `ON` / `OFF` |
| EMS 模式 | `select/<dev_id>/ems_mode/command` | `general` / `mqtt_ctrl` / `tou_plan`，不支持的选项自动置灰 |
| 功率控制 | `number/<dev_id>/power_ctrl/set` | 仅 `mqtt_ctrl` 模式有效，需至少每分钟下发一次 |
| 输出功率 | `number/<dev_id>/output_power/set` | 满载输出上限（W） |
| 多相输出功率 | `number/<dev_id>/phase_output_power/set` | 按 `{"phase_a":..,"phase_b":..,"phase_c":..}` 下发 |
| 获取 TOU 计划 | `sensor/<dev_id>/tou_plan/get` | 应答发布在 `tou_plan/status` |
| 重启设备 | `button/<dev_id>/reboot/trigger` | 二次确认后发 `RESTART` |

> 卡片的范围提示（如 `-1000 ~ 1000 W`）优先读实体的 `min` / `max` 属性，
> 读不到时用协议默认值。

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
| `hoymiles.set_phase_output_power` | 一次性设置 A/B/C 三相输出功率限值 |
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
| `number` | 集成本地（`phase_output_power/set`） | `Phase A/B/C Output Power` |

> `system/state` 与 `quick/state` 的 `sys_*` 字段仅主机/单机发布；从机上这些实体为 `unknown`。
> `pv_num` / `pvs` 字段在 PID=0x2806 的机型上不发布，`PV1..PV4 Power` 为 `unknown`。

### 设备离线时的可用性

所有实体都带可用性判定：`quick/state` 超过 2 分钟（或 `device/state`、
`system/state` 超过 11 分钟）没收到推送，集成就会把 `hoymiles/<dev_id>/availability`
置为 `offline`，**固件 discovery 的实体与集成自己的实体会一起转为 `unavailable`**，
避免继续展示陈旧值。恢复推送后自动变回 `online`。

### 多相输出功率

三相限值设备**不会回读**，因此 `Phase A/B/C Output Power` 展示的是"最后一次下发值"
（跨 HA 重启会通过实体状态恢复）。任一相从未设置过时会回退到协议下限 100 W，
并打一条 warning；想避免这种情况请用 `hoymiles.set_phase_output_power` 一次设齐三相。

固件自带的 `phase_output_power` 实体被补上 `command_template` 后也能用，语义是
**一个值同时应用到三相**（固件只接受完整的三相 JSON）。

---

## 排错

| 现象 | 处理 |
|---|---|
| 添加集成时列表为空 | 确认 MQTT 集成已配置、Broker 地址一致；设备需已连接并发过 retained discovery |
| 实体一直 `unknown` | 确认 `dev_id` 大小写与 topic 完全一致；`system/state` 仅在主机/单机发布 |
| 卡片找不到 | 集成启动后会自动注入前端模块；若浏览器缓存旧版请强制刷新 |
| 下发 TOU 报 `10` | 表示设备当前不是 `tou_plan` 模式，先调用 `hoymiles.set_ems_mode` |
| 日志报 `Invalid config for [switch.mqtt]` | 固件重连时先发了自己的旧报文，集成会在毫秒内补上；实体正常则无需理会 |
| 日志报 `mode: textarea` 或 `does not generate unique IDs` | 前者是本集成会自动清理的旧固件遗留（升级后应消失）；后者是旧固件把多个 config 的 `unique_id` 写成同一个值，**只影响未被本集成管理的设备**，需升级固件消除 |
| 开关状态显示 `unknown` | 已按设计改为乐观实体，只能反映本集成下发的状态（设备无开关状态回读） |
| 实体全部 `unavailable` | 检查设备是否在推送；`quick/state` 停超 2 分钟即判定离线 |
| 新增 `state_topic` 后实体不跟随 | HA 不会为已存在实体重建订阅，需**完整重启** HA Core |
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
    ├── coordinator.py       MQTT 推送型 DataUpdateCoordinator + 可用性判定
    ├── discovery_override.py 固件 discovery 报文补丁
    ├── sensor.py            状态传感器 + TOU 回显/应答传感器
    ├── binary_sensor.py     加热状态
    ├── number.py            三相输出功率
    ├── config_flow.py       设备发现与接入
    ├── options_flow.py      TOU 配置向导
    ├── services.py          hoymiles.* 服务
    ├── services.yaml
    ├── strings.json
    ├── translations/        en / zh-Hans
    └── www/hoymiles-tou-editor.js
```
