# 架构说明

`hoymiles` 集成如何与设备通信：话题、固件 discovery 补丁、实体模型与可用性判定。

[English](ARCHITECTURE.md) · **简体中文**

---

## 模块职责

| 文件 | 职责 |
|---|---|
| `__init__.py` | 配置项加载、前端资源注册、服务注册 |
| `manifest.json` | 域、版本、依赖（`mqtt`、`http`、`frontend`） |
| `const.py` | topic 模板、常量、TOU 应答状态码、卡片资源清单 |
| `mqtt_util.py` | MQTT 收发与设备自动发现 |
| `coordinator.py` | MQTT 推送型 `DataUpdateCoordinator` + 可用性判定 |
| `discovery_override.py` | 改写固件 discovery 报文 |
| `sensor.py` | 状态传感器 + TOU 回显 / 应答传感器 |
| `binary_sensor.py` | 加热状态 |
| `number.py` | 三相输出功率（集成本地实体） |
| `config_flow.py` | 设备发现与接入 |
| `options_flow.py` | TOU 配置向导 |
| `services.py` / `services.yaml` | `hoymiles.*` 服务 |
| `strings.json` / `translations/` | 界面文案（`en`、`zh-Hans`） |
| `brand/` | `icon.png`（256×256）与 `logo.png`（657×256） |
| `www/` | 八张 Lovelace 卡片（纯 ES module） |

## 话题模型

`<dev_id>` = `<mqtt_param.client_prefix>-<SN>`，未配置前缀时仅 SN。

设备侧保持**裸 MQTT topic** 约定，没有私有封装，集成也不会另造一套。集成订阅：

| 话题 | 载荷 | 周期 |
|---|---|---|
| `quick/state` | 扁平 JSON，实时值 | 1 秒 |
| `device/state` | 嵌套 JSON，变化较慢的值 | 5 分钟 |
| `system/state` | 系统级值，**仅主机 / 单机发布** | 5 分钟 |
| `hoymiles/<dev_id>/tou_day_plan/ack` | 日计划应答 | 按需 |
| `hoymiles/<dev_id>/tou_week_plan/ack` | 周计划应答 | 按需 |
| `hoymiles/<dev_id>/tou_plan/status` | 当前计划上报 | 按需 |
| `homeassistant/+/<dev_id>/config` | 固件自己的 discovery 报文 | 连接时 |

全部依据《禾迈微储 MQTT 协议开发指南 V0.5.1》。

## 与固件 discovery 的分工

固件通过 MQTT Discovery 已注册以下实体，集成**故意不重复创建**：

| 实体 | discovery 话题 |
|---|---|
| 设备开关 | `homeassistant/switch/<dev_id>/config` |
| EMS 模式 | `homeassistant/select/<dev_id>/ems_mode/config` |
| 功率控制 | `homeassistant/number/<dev_id>/power_ctrl/config` |
| SOC / 电池功率 | `homeassistant/sensor/<dev_id>/soc|bat_p/config` |
| 输出功率 / 多相输出功率 | `homeassistant/number/<dev_id>/output_power|phase_output_power/config` |
| 重启 | `homeassistant/button/<dev_id>/reboot/config` |

因此集成**不创建** `soc` 与 `bat_power` 实体，避免同一数据出现两个实体。

## 集成会「补丁」固件的 discovery 报文

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
> ⚠️ **副作用：** 固件每次重连会重发一次自己的（旧）报文，HA 可能在补丁到达前先对旧
> 报文报一次错；日志里看到 `Invalid config for [switch.mqtt]` 但实体正常，属于正常现象。
> 反之，即使卸载集成，只要固件重连一次就会用自己的报文覆盖回去，**自带自愈**。
>
> `availability_topic` 与 `ems_mode` 状态话题都位于 `hoymiles/<dev_id>/…` 命名
> 空间下，与固件话题不冲突。
>
> ⚠️ HA 不会为**已存在**的实体重建订阅：给实体新增 `state_topic` 这类订阅键需要**完整重启**
> HA 才生效（`mqtt.reload` 也不一定行）。若设备恰好在 HA 启动瞬间重连、HA 先读到未修正的
> 报文，个别实体会到下次重启前不跟随状态话题。

### 开关实体的固件支持情况

补 `command_topic` 只是让 HA **不再拒绝**这条报文，能否真正开关机取决于固件：

| 固件 | `…/switch/…/config` | 订阅 `…/switch/…/set` | 表现 |
|---|---|---|---|
| ≤ 1.3.101 | 缺 `command_topic` | ✗ 未订阅 | 补丁后实体出现，但下发无效（设备不响应） |
| 下一个发版及以后 | 完整 | ✓ 已订阅 | 开关机生效（`ON` 唤醒 / `OFF` 休眠） |

## 实体模型

| 平台 | 来源 | 示例 |
|---|---|---|
| `sensor` | `quick/state`（1 秒，所有角色） | `PV Power`、`Grid On Power`、`Battery Status`、`System SOC` |
| `sensor` | `device/state`（5 分钟，所有角色） | `Grid On Voltage`、`Inverter Power`、`PV1 Power`、`Pack 1 SOC`、`Battery Temperature` |
| `sensor` | `system/state`（5 分钟，仅主机 / 单机） | `System PV Energy Today`、`Battery Charge Energy Today`、`EMS Mode (Device)` |
| `sensor` | TOU 话题 | `TOU Plan Status`、`TOU Day Plan Ack`、`TOU Week Plan Ack` |
| `binary_sensor` | `quick/state`、`device/state` | `Heating`、`System Heating`、`Pack N Heating` |
| `number` | 集成本地维护 | `Phase A/B/C Output Power` |

> `system/state` 与 `quick/state` 的 `sys_*` 字段仅主机 / 单机发布；从机上这些实体为
> `unknown`。
>
> `pv_num` / `pvs` 字段在 PID=0x2806 的机型上不发布，`PV1..PV4 Power` 为 `unknown`。

## 可用性判定

所有实体都带可用性判定：`quick/state` 超过 **2 分钟**（或 `device/state`、
`system/state` 超过 **11 分钟**）没收到推送，集成就会把
`hoymiles/<dev_id>/availability` 置为 `offline`，**固件 discovery 的实体与集成自己的
实体会一起转为 `unavailable`**，避免继续展示陈旧值。恢复推送后自动变回 `online`。

## EMS 模式状态话题

早期固件未提供 `ems_mode` 的 `state_topic`，集成会给它补一个**自维护的 retained 状态
话题** `hoymiles/<dev_id>/ems_mode/state`：

- 任何人向 `…/ems_mode/command` 下发后，集成立即回显到该话题 → 界面 / 卡片即时刷新；
- 同时跟随 `system/state` 里的 `ems_mode`（设备真实运行模式）进行纠正，所以设备侧
  超时自动回退到 `general` 也能反映出来。

为什么不直接把 `state_topic` 指向 `system/state`：该话题只有 5 分钟周期，而 TOU 编辑器
是用 select 状态做门控的，那样会让「切到 tou_plan」后最多卡 5 分钟。

## 多相输出功率

三相限值设备**不会回读**，因此 `Phase A/B/C Output Power` 展示的是「最后一次下发值」
（跨 HA 重启会通过实体状态恢复）。任一相从未设置过时会回退到协议下限 100 W，
并打一条 warning；想避免这种情况请用 `hoymiles.set_phase_output_power` 一次设齐三相。

固件自带的 `phase_output_power` 实体被补上 `command_template` 后也能用，语义是
**一个值同时应用到三相**（固件只接受完整的三相 JSON）。

## 型号识别（为分型号版式预留）

设备注册表条目带 `model`，固件的 MQTT discovery 报文里则写在 `device.model`。
实测到的取值：

| 设备 | `device.model` |
|---|---|
| `MSA-2805…` | `HiBattery 4020 X` |
| `MSA-2800…` | `MS-A2` |
| （第三种变体） | `HiBattery 1920 AC` |

两个重要前提：

1. **只有固件的 discovery 条目带型号**，集成自己创建的 `DeviceInfo` 里
   `model: null`。电池卡片是从**设备注册表**读型号的，这也是本机标题能默认显示
   `HiBattery 4020 X` 的原因。
2. **`DeviceInfo` 只在实体首次添加时写入设备注册表**
   （`entity_platform._async_add_entity`），之后再修改不会同步过去。若要回填型号，
   需要在 `discovery_override._on_discovery_message` 里从 `payload["device"]["model"]`
   取出，等 discovery 报文到达后用 `device_registry.async_update_device(model=...)` 写入。

不同型号**上报的数据量差异也很大**：`MSA-2800` 系列只发布约 3~7 个对象，而
`MSA-2805` 约 95 个。集成无论如何都会创建固定的实体清单，因此小型号上会有大量
始终收不到数据的实体 —— 卡片必须做优雅降级，而不能假设每个实体都有值
（功率流卡片的「小气泡」与「有无电表」逻辑就是现成的例子）。

## 诊断

用 Mosquitto 客户端直接盯原始报文：

```bash
# 某台设备的全部流量
mosquitto_sub -h <broker> -v -t 'homeassistant/#'
mosquitto_sub -h <broker> -v -t 'device/#' -t 'system/#'

# 只看被补丁改写的 discovery 报文
mosquitto_sub -h <broker> -v -t 'homeassistant/+/<dev_id>/config'
```

常见日志行的含义见 [README](../README.zh-Hans.md#排错) 的排错表。
