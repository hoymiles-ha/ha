# 卡片参数总表

`hoymiles` 集成捆绑的八张 Lovelace 卡片的完整参数说明。

[English](CARDS.md) · **简体中文**

---

## 卡片如何加载

集成启动时会把八张卡片全部注册为前端模块，因此**无需手动添加资源**，也不依赖任何
CDN。用 **添加卡片 → 手动** 粘贴 YAML，或直接写进仪表盘 YAML 文件即可。

集成安装完并重启 Home Assistant 之后，卡片类型为 `custom:hoymiles-*`。

> 改过卡片文件？请硬刷新浏览器（`Ctrl` + `F5`）。

## 通用参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `dev_id` | string | 设备标识 `<client_prefix>-<SN>`（如 `MSA-280520260806`）。除仪表盘卡片（按实体取值）外均为**必填** |
| `language` | `zh` \| `en` | **不填则跟随 Home Assistant**：使用当前登录用户的语言（任何 `zh-*` 都算中文）。只有在需要把某张卡片钉死为某种语言时才填。 |
| `title` | string | 卡片标题，各卡片默认值不同（见下文） |
| `show_title` | bool | 设为 `false` 隐藏标题（部分卡片同时隐藏设备 SN） |

`dev_id` 的作用：卡片据此推导出所需实体 id（`sensor.<dev_id 转下划线>_<后缀>`）。
如果你的实体命名不符合这个规律，用各卡片的 `entities:` 映射单独覆盖。

### 语言是怎么选的

1. 卡片配置里显式写了 `language: en` / `language: zh` → **以它为准**。只有需要把
   某张卡片钉死语言时才写。
2. 否则跟随**当前 Home Assistant 用户**的语言（在 **个人资料 → 语言** 里设置）。
   任何以 `zh` 开头的语言代码（`zh-Hans`、`zh-Hant`、`zh-Hans-CN`）都算中文，
   其余都算英文。
3. 它是在每次渲染时解析的，所以切换个人语言**所有卡片实时跟着变**，不用刷新页面、
   也不用改配置。

> 所以同一个仪表盘对英文用户和中文用户会各自显示成正确的语言：语言是**看的人的属性**，
> 不是卡片的属性。

> `hoymiles-gauge` 是例外 —— 它内部没有任何文案，上面的字全部来自你配置的
> `name` / `label` / `icon`，永远不需要翻译。

### 让自己写的文字也跟随语言

上面的规则只管卡片**内部**的文案。你在 YAML 里写的文字（卡片标题、曲线名、
gauge 的 name、`balancer_label`）是你自己的，卡片无法翻译 —— 但可以在你提供的
多个语言之间选择：把**字符串换成映射**即可。

```yaml
type: custom:hoymiles-history-chart
# 原来： title: History
title:
  en: History
  zh: 历史数据
series:
  - entity: sensor.x_pv_power
    name:
      en: PV power
      zh: 发电功率
```

卡片按解析出的语言（`zh` / `en`）取值。映射里**没有**当前语言时，先回退 `en`，
再回退到任意一个已有的条目，所以残缺的映射也不会变空。普通字符串行为完全不变，
因此**现有仪表盘全都不受影响**。

支持语言映射的参数：

| 卡片 | 支持映射的参数 |
|---|---|
| 所有卡片 | `title` |
| `hoymiles-history-chart` | `title`、`series[].name` |
| `hoymiles-gauge` | `name`、`label` |
| `hoymiles-energy-sankey` | `title`、`balancer_label` |

> 可视化卡片编辑器只能存普通字符串，所以映射在那里显示为**空字段**，标签会写
> `accepts an en/zh map`。这些参数请在 YAML 编辑器（⋮ → *在 YAML 中编辑*）里改。

> Home Assistant 自带的卡片（`markdown`）以及视图 / 页签标题属于 HA 本身、不属于本集成，
> 它们的文字无法跟随语言。请把这些写成语言无关的内容，或者为它们统一选一种语言。

---

## 1. `custom:hoymiles-power-flow`

把「家」画出来，并把实时的光伏 / 微储 / 电网 / 负载功率叠加在插图上，和手机 App
首页一致。珠子沿连线流动，速度与该支路功率相关。

```yaml
type: custom:hoymiles-power-flow
dev_id: MSA-280520260806
title: 我的家
language: zh
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dev_id` | string | — | **必填** |
| `title` | string | 本地化的「我的家」 | 标题文字 |
| `show_title` | bool | `true` | `false` 隐藏标题与设备 SN，只留右侧信号图标 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `temperature_entity` | entity id | — | 标题右侧显示的温度实体 |
| `show_rssi` | bool | `true` | 右上角 Wi-Fi 信号扇形 |
| `show_extras` | bool | `true` | 左上角「光伏2 / 智能插座」小气泡 |
| `gradient` | bool | `true` | 是否画浅色渐变底 |
| `max_width` | number (px) | `620` | 插图最大宽度，超宽时保持居中 |
| `flow_speed` | number | `1` | 流动珠子速度倍数，`0.5` 更慢、`2` 更快 |
| `has_meter` | `auto` \| `true` \| `false` | `auto` | 是否装了电网电表。`auto` 把非零的 `sys_grid_p` 视为有电表；判定逻辑见 `meter_zero_samples` |
| `meter_zero_samples` | number | `10` | `auto` 模式下，需要连续多少个 0 读数才判定为「没有电表」。读数每秒一次，故默认约 10 秒 |
| `entities` | map | — | 实体覆盖，键为后缀（见下） |

### 数据来源

全部来自普通实体状态，**不依赖 recorder**。

| 节点 | 实体后缀（`sensor.<dev>_…`） |
|---|---|
| 光伏 | `system_pv_power`（缺失时回退 `pv_power`） |
| 微储 | `system_battery_power`（负 = 充电）+ `system_soc` |
| 电网 | `system_grid_power`（正 = 受电） |
| 负载 | `system_load_power` |
| 光伏2 气泡 | `system_pv2_power` |
| 智能插座气泡 | `system_smart_plug_power` |
| 状态气泡 | `battery_status`（`standby` / `charge` / `discharge` / `lock`） |
| 信号扇形 | `rssi`（dBm） |

### 行为说明

- 连线只有该支路功率 **≥ 5 W** 时才显示流动小球，球的颜色随支路变化，速度随功率加快。
- 珠子走完时间**按路径长度算**，所以短线与长线速度一致；1059 W 时 325px 的光伏连线
  约 3.8 秒跑完。觉得还快/还慢就用 `flow_speed` 整体调。
- 「微储」气泡显示电池真实状态；「电网」气泡显示 `电网输入` / `电网输出`。
- **右上角是 RSSI 信号图标**（与「电池卡片」及 App 的 Wi-Fi 图标同款）：
  四根高度递增的信号条，点亮的条数（0~4）表示信号质量，旁边直接跟 `-21 dBm`
  读数，悬停可看说明：

  | RSSI | 点亮条数 |
  |---|---|
  | ≥ −55 dBm | 4（优秀） |
  | ≥ −65 dBm | 3（良好） |
  | ≥ −75 dBm | 2（一般） |
  | < −75 dBm | 1（较弱） |

  设备不上报 `rssi` 时自动隐藏，不需要可以把 `show_rssi` 设为 `false`。
- **左上角两个小气泡（光伏2 / 智能插座）** 用来补齐插图上没有节点的两条支路。
  设备侧的负载是这么算出来的：

  ```
  负载 = 电网 + 插座 + 光伏2 − 智能插座
  ```

  也就是说「光伏2」和「智能插座」参与了 `负载` 的计算，但插图上只有「光伏」一个
  节点，只看四个大数字是对不上账的，所以把这两路单独做成小气泡显示。
  从机不上报这两个字段时（读到 `null`）气泡自动隐藏；**读数正好为 0 时也不显示**
  （该支路没有功率流动，不必占地方），两件事同时发生时插图上就不会出现气泡。
  只上报一个时，剩下的那个会顶到最上面，不会留空位。整组关掉用 `show_extras: false`。
- 单独覆盖某个实体用 `entities:` 段：

  ```yaml
  entities:
    system_pv_power: sensor.my_pv_power
    system_battery_power: sensor.my_battery_power
    system_grid_power: sensor.my_grid_power
    grid_on_power: sensor.my_grid_on_power
    system_load_power: sensor.my_load_power
    soc: sensor.my_soc
    battery_status: sensor.my_battery_status
    rssi: sensor.my_rssi
    system_pv2_power: sensor.my_system_pv2_power
    system_smart_plug_power: sensor.my_system_smart_plug_power
  ```

### 有电表 / 无电表两种版式

没有装电表时，设备侧数据无法区分「电网」和「家里」，所以卡片有两种画法：

- **装了电表**（`sys_grid_p` 非零）—— 四个节点；电网节点显示电表读数并带
  `电网输入` / `电网输出` 药丸标签，家里负载在右上角有独立标注。
- **没有电表** —— 去掉负载标注及其连线，右下角节点变成「电网&负载」，
  显示设备侧并网口功率（`grid_on_p`）。

两个读数**符号约定相反**（`sys_grid_p` 受电为正，`grid_on_p` 受电为负，因为固件把
「功率流入设备」定义为负）。卡片在绘制前统一成「是否在受电」。没有功率流动的节点
不会挂任何药丸标签，而不是显示「待机」。

---

## 2. `custom:hoymiles-battery`

按**实际电池包数量**自适应绘制电池堆：1～4 个电池包各对应一种外形，每个模组
配一个左右交替的气泡显示自己的 SOC 与温度（和 App 的 HiBattery X 页面一致）。

```yaml
type: custom:hoymiles-battery
dev_id: MSA-280520260806
title: HiBattery 4020 X
language: zh
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dev_id` | string | — | **必填** |
| `title` | string | 自动读设备型号 | 覆盖设备注册表里的型号 |
| `show_title` | bool | `true` | `false` 隐藏标题 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `show_history` | bool | `true` | 可选历史数据区（需启用 recorder） |
| `max_width` | number (px) | `560` | 插图最大宽度 |
| `alarm_entity` | entity id | — | 该实体为 `on` 时标题左侧显示铃铛 |
| `entities` | map | — | 实体覆盖（见下表） |

| `entities` 键 | 含义 |
|---|---|
| `pack_count` | 电池包数量 |
| `pv` | 光伏功率 |
| `grid_on` | 并网口功率 |
| `grid_off` | 离网口功率 |
| `battery` | 电池功率 |
| `battery_status` | 电池状态 |
| `soc` | 系统 SOC |
| `pack<N>_soc` | 逐包 SOC |
| `pack<N>_temperature` | 逐包温度 |

### 行为说明

- **标题默认取设备注册表里的型号**（本机实测为 `HiBattery 4020 X`，来源于固件 MQTT
  discovery 的 `device.model`），所以换机型不用改卡片配置；显式写 `title` 则覆盖它。
- 电池数量优先取 `pack_count`（`device/state` 的 `pack_num`），缺失时按实际能读到
  SOC 的 `pack1_soc`…`pack4_soc` 推断，上限 4（与固件 `packs` 截断一致）。
- 逐包数据用 `pack<i>_soc` / `pack<i>_temperature`；四周功率用 `pv_power`、
  `grid_on_power`、`grid_off_power`、`battery_power`。
- 标题右侧的信号格数由 `rssi`（dBm）换算。
- 历史数据区（可选）通过 `recorder/statistics_during_period` 读取长期统计，画 SOC
  曲线并汇总该区间的充电 / 放电电量；recorder 未启用时只提示、不影响其余部分。

---

## 3. `custom:hoymiles-pack-list`

电池堆插图的紧凑替代：一行一个电池包，左侧 SOC 进度条、右侧 SOC 百分比与加热标记。
包数量与电池卡片用同一套规则。

```yaml
type: custom:hoymiles-pack-list
dev_id: MSA-280520260806
language: zh
title: 电池电量
columns: 2
show_temperature: false
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dev_id` | string | — | **必填** |
| `title` | string | 本地化的「电池电量」 | 标题文字 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `columns` | number | `1` | 按 N 列排布；不填为单列 |
| `show_temperature` | bool | `true` | `false` 时只显示 SOC，不显示 ℃ |

---

## 4. `custom:hoymiles-history-chart`

按**日 / 月 / 年**查看曲线，并可用 `‹` `›` 或日期输入框翻到任意时间段，绘制风格与
厂商 App 的历史页一致。正值向上、负值向下堆叠，因此「充电 / 放电」这类双极性传感器
会自然地分居 0 线两侧。

```yaml
type: custom:hoymiles-history-chart
dev_id: MSA-280520260806
title: 历史数据
language: zh
range: day
height: 330
unit: W
series:
  - entity: sensor.x_pv_power
    name: 发电功率
    color: "#22c55e"
  - entity: sensor.x_system_battery_power
    name: 放电[+]/充电[-]
    color: "#4a90d9"
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `series` | list | — | **必填**，每条曲线一项：`entity` / `name` / `color` |
| `dev_id` | string | — | 可选（所有 series 都给了 `entity` 时可省） |
| `title` | string | — | 卡片标题 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `range` | `day` \| `month` \| `year` | `day` | 初始范围 |
| `height` | number (px) | `330` | SVG 高度 |
| `unit` | string | — | 纵轴单位（超过 1.5 kW 自动换成 kW） |
| `zero_line` | bool | `true` | 是否画 0 线 |
| `symmetric` | bool | `true` | `false` = 从 min 到 max 自底向上（SOC 用） |
| `min` / `max` | number | — | 固定上下限 |
| `span` | number | — | 对称模式下固定半量程 |
| `sync_group` | string | — | 同一组的卡片共享时间窗口（范围 + 日期） |
| `show_toolbar` | bool | `true` | `false` 隐藏本卡的时间控件（给跟随卡用） |

### 行为说明

- 数据来自 `recorder/statistics_during_period`（长期统计），**无需管理员权限**，
  也不接触数据库文件。
- 顶栏与厂商 App 的历史页一致：**左上角是日期胶囊（圆形 `‹` `›` 包着日期），
  右上角是范围下拉（日 / 月 / 年）**；曲线下方的图例也是 App 那种圆角胶囊。
- 纵轴刻度会按实际步长自动决定小数位（例如 1.25 kW 的步长会显示 `1.25` 而不是取整成 `1`）。
- 固定 `span` / `min` / `max` 可让同一组曲线在不同日子保持同一量程，便于横向对比。
- **点击下方图例可以高亮某条曲线**：选中的曲线加粗提亮，其余曲线淡入背景；
  再点同一条、或点图表区域即取消高亮。悬停浮窗里被淡化的曲线会同步降低透明度。
- **鼠标移到图上时，同一 `sync_group` 的其它图表会在同一时间点显示引导线和浮窗**
  （如仪表盘的「历史数据」驱动「电池容量(SOC)」）；移开后一并消失。匹配按
  时间戳进行，所以两张图即使分桶粒度或数据缺口不同也能对上。
- `show_toolbar: false` 配合 `sync_group` 就能做成「上面一张图控制、下面几张图只跟随」
  的仪表盘。
- 卡片被移除时会自动从组里注销，不会残留。

---

## 5. `custom:hoymiles-gauge`

一张**统计卡**：左上标题、右上图标、中间大字数值，下方**一条绿弧**按数值占
`min`~`max` 的百分比填充，弧中央同时显示该百分比。HA 自带 `gauge` 卡片的轻量替代。

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_battery_charge_energy_today
name: 今日充电量
unit: kWh
scale: 0.001
max: 10
min: 0
decimals: 2
icon: ⚡
label: 自发自用率
color: "#22c55e"
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `entity` | entity id | — | **必填**，驱动大字数值 |
| `name` | string | 实体名 | 标题 |
| `unit` | string | 实体单位 | 显示单位 |
| `scale` | number | `1` | 显示前的换算系数（`0.001` 可把 Wh 显示成 kWh） |
| `max` | number | — | **显示单位下的**上限；不填表示弧线随数值增长 |
| `min` | number | `0` | 下限 |
| `decimals` | number | `2` | 数值小数位 |
| `icon` | string | — | 标题右侧的图标 |
| `label` | string | — | 百分比下方的说明文字 |
| `color` | CSS 颜色 | `#22c55e` | 弧线颜色 |
| `show_arc` | bool | `true` | `false` 时去掉弧线与百分比，只剩读数 |

### 比例模式

当真正关心的数字是**两个实体之间的比例**（而不是占某个虚构上限的百分比）时，
可以单独给弧线指定数据源。大字读数仍取 `entity`，只有弧线与百分比来自比例。

| 参数 | 说明 |
|---|---|
| `percent_numerator` | 比例模式必填 |
| `percent_subtract` | 可选，从被减数中扣除 |
| `percent_denominator` | 可选，默认等于被减数 |

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_system_pv_energy_today
name: 今日发电量
unit: kWh
scale: 0.001
icon: ☀️
label: 自发自用率
percent_numerator: sensor.msa_280520260806_system_pv_energy_today
percent_subtract: sensor.msa_280520260806_grid_on_energy_out_total
percent_denominator: sensor.msa_280520260806_system_pv_energy_today
```

即：自发自用率 = （发电量 − 上网电量）÷ 发电量。

### 行为说明

- 百分比 = `(值 − min) / (max − min) × 100`，四舍五入到整数；值超出量程时钳到 0~100%。
- 实体还没上报数据时仍画出空弧，数值与百分比显示 `—`，卡片不会变成一片空白。
- 把 `max` 设为 100 并直接接 SOC 传感器，就是一张电池电量表。

---

## 6. `custom:hoymiles-control`

把《禾迈微储 MQTT 协议开发指南》§10~§20 里**所有可下发的控制**做成按钮 / 输入框。
指令**直接发布到协议 topic**（qos 1、retain false），因此即使某个 discovery 实体缺失
或选项列表比协议窄，卡片也仍可用；当前值则从对应实体回读。

```yaml
type: custom:hoymiles-control
dev_id: MSA-280520260806
language: zh
title: 设备控制
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dev_id` | string | — | **必填** |
| `title` | string | 本地化的「设备控制」 | 卡片标题 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `show_power_ctrl` | bool | `true` | `false` 隐藏「功率控制」行 |
| `show_phase` | bool | `true` | `false` 隐藏「多相输出功率」行 |
| `show_topics` | bool | `false` | 在每行下方显示 MQTT 主题（调试用） |
| `subtitle` | bool | `true` | `false` 隐藏标题右侧的灰色说明 |

### 各行与协议 topic

| 行 | 协议 topic | 说明 |
|---|---|---|
| 设备开关 | `switch/<dev_id>/set` | `ON` / `OFF` |
| EMS 模式 | `select/<dev_id>/ems_mode/command` | `general` / `mqtt_ctrl` / `tou_plan`，不支持的选项自动置灰 |
| 功率控制 | `number/<dev_id>/power_ctrl/set` | 仅 `mqtt_ctrl` 模式有效，需至少每分钟下发一次 |
| 输出功率 | `number/<dev_id>/output_power/set` | 满载输出上限（W） |
| 多相输出功率 | `number/<dev_id>/phase_output_power/set` | 按 `{"phase_a":..,"phase_b":..,"phase_c":..}` 下发 |
| 获取 TOU 计划 | `sensor/<dev_id>/tou_plan/get` | 应答发布在 `tou_plan/status` |
| 重启设备 | `button/<dev_id>/reboot/trigger` | 二次确认后发 `RESTART` |

### 行为说明

- 卡片的范围提示（如 `-1000 ~ 1000 W`）优先读实体的 `min` / `max` 属性，
  读不到时用协议默认值。
- 布局参考 iOS 设置页：小组件包在圆角分组里、组间有灰色小节标题
  （**电源与模式 / 功率设置 / 计划与维护**）、每行是「图标 + 名称 + 右侧控件」，
  分割线**左侧内缩**；开关机与 EMS 模式用**分段控件**，危险操作（重启）用红色。
- **开关机很慢**：固件要把 PCS（及电池包）真正停下来或启动起来。卡片会把请求状态
  显示为「待确认」最多 5 秒，直到设备回读到位，随后短暂显示对勾。
- 每行的 MQTT topic **默认不显示**（它们是调试信息，会挤掉正文）；需要时用
  `show_topics: true` 打开。

---

## 7. `custom:hoymiles-tou-editor`

分时计划可视化编辑器。它通过集成服务（`hoymiles.set_tou_day_plan`、
`set_tou_week_plan`、`get_tou_plan`、`set_ems_mode`）与设备交互；万一集成不在了，
会退化为直接 `mqtt.publish`。

```yaml
type: custom:hoymiles-tou-editor
dev_id: MSA-280520260806
language: zh
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dev_id` | string | — | **必填** |
| `title` | string | 本地化的标题 | 卡片标题 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `require_tou_mode` | bool | `true` | 只有在 EMS 模式为 `tou_plan` 时才渲染编辑界面；`false` 关掉该门控 |
| `ems_entity` | entity id | 自动 | 覆盖用于读取 EMS 模式的实体 |
| `status_entity` | entity id | 自动 | 覆盖用于读取计划状态的实体 |
| `day_ack_entity` | entity id | 自动 | 覆盖日计划应答实体 |
| `week_ack_entity` | entity id | 自动 | 覆盖周计划应答实体 |

### 行为说明

- 一天由若干时间段（segment）组成，字段为 `mode` / `ts` / `te` / `sh` / `sl` /
  `pc` / `pd`；`ts`、`te` 是 15 分钟为单位的槽位（`0`~`96`）。
- 模式：`1` 强制充电、`2` 光伏充电、`4` 放电。
- 卡片会依次下发 `day1`…`day8` 日计划 → 周计划 → 切到 `tou_plan` → 回读当天计划。
- 卡片自带 UI 配置编辑器，也可以在仪表盘里图形化添加与配置。

> **为什么要有 EMS 门控。** 早期固件没有给 `ems_mode` 提供 `state_topic`，集成会给它
> 补一个**自维护的 retained 状态话题** `hoymiles/<dev_id>/ems_mode/state`：
>
> - 任何人向 `…/ems_mode/command` 下发后，集成立即回显到该话题 → 界面 / 卡片即时刷新；
> - 同时跟随 `system/state` 里的 `ems_mode`（设备真实运行模式，5 分钟周期）进行纠正，
>   所以设备侧超时自动回退到 `general` 也能反映出来。
>
> 为什么不直接把 `state_topic` 指向 `system/state`：该话题只有 5 分钟周期，而本卡片
> 是用 select 状态做门控的，那样会让「切到 tou_plan」后最多卡 5 分钟。

---

## 8. `custom:hoymiles-energy-sankey`

基于长期统计绘制的「源 → 汇」能量流桑基图。

```yaml
type: custom:hoymiles-energy-sankey
dev_id: MSA-280520260806
title: 能量流
language: zh
range: today
```

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dev_id` | string | — | **必填** |
| `title` | string | 本地化标题 | 卡片标题 |
| `language` | `zh` \| `en` | *自动* | 钉死卡片语言；不填则跟随当前 Home Assistant 用户的语言。 |
| `range` | `today` \| `7d` \| `30d` \| `month` | `today` | 时间范围 |
| `balancer_label` | string | 本地化 | 「损耗 / 未计量」节点的自定义名称 |
| `show_toolbar` | bool | `true` | `false` 隐藏时间段切换栏 |
| `ribbon_gap` | number (px) | `3` | 带宽之间的白色间隙 |
| `ribbon_opacity` | number | `0.5` | 带宽透明度（0~1） |
| `icons` | map | — | 逐节点 emoji 覆盖，如 `pv: "☀️"` |
| `statistics` | string \| list \| map | — | 覆盖默认 `statistic_id`。值可以是单个 id 或数组，数组会被求和 |

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

### 交互

点击某条带可以把这条流单独高亮；点击某个节点方框可以高亮所有与它相连的带。
其余部分变暗，并在详情面板列出涉及的流。再点同一目标（或点空白处）取消高亮。
这只是视图状态，数值不会改变。

### 关于「损耗 / 未计量」节点

桑基图要求流量守恒，而设备各端口是**独立计量**的（转换损耗、采样相位、
未计量负载都会造成差额）。卡片**不做归一化缩放**，而是把差额显式画成一个
节点（正差额记为「损耗/其他」，负差额记为「未计量」），
保证图面守恒且各条数值真实。

### 渲染精度说明

两侧各是一列节点方框。由于设备每个端口独立计量，带宽背后的**走线并非实测**：
它是在禁止「电池放电 → 电池充电」这类不可能环路的前提下，用迭代比例拟合
把每个源按比例分摊到各个汇上得到的估计值。请把带宽当作尽力而为的归因，
而不是计量事实。

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
> `*_today` 型每天清零，HA 在**长时间停机后**会把「跨天下降」识别为设备重置，
> 中间天数的增量会丢失；累计型没有这个问题。

设备特有的 **EPS / 插座 / 离网** 端口官方模型装不下，那部分用本卡片展示。
