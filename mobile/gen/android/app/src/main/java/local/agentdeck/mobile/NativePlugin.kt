package local.agentdeck.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// 手改部分（非 Tauri 生成）：AgentDeck 本地插件 native 的 Kotlin 实现，Rust 侧见 mobile/src/native.rs。
// 提供前台服务启停（保活）、电池优化白名单状态 / 申请、应用系统设置页。

@InvokeArg
class KeepAliveArgs {
  var text: String = ""
  var wakeLock: Boolean = false
}

@TauriPlugin
class NativePlugin(private val activity: Activity) : Plugin(activity) {
  /** 启动（或更新文案）前台服务；调用时 App 在前台，不会触发 Android 12+ 的后台启动限制 */
  @Command
  fun keepaliveStart(invoke: Invoke) {
    val args = invoke.parseArgs(KeepAliveArgs::class.java)
    val intent = Intent(activity, KeepAliveService::class.java)
      .putExtra(KeepAliveService.EXTRA_TEXT, args.text)
      .putExtra(KeepAliveService.EXTRA_WAKELOCK, args.wakeLock)
    try {
      ContextCompat.startForegroundService(activity, intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("启动前台服务失败：${e.message}")
    }
  }

  @Command
  fun keepaliveStop(invoke: Invoke) {
    activity.stopService(Intent(activity, KeepAliveService::class.java))
    invoke.resolve()
  }

  @Command
  fun batteryOptimizationStatus(invoke: Invoke) {
    val pm = activity.getSystemService(Activity.POWER_SERVICE) as PowerManager
    val result = JSObject()
    result.put("ignoring", pm.isIgnoringBatteryOptimizations(activity.packageName))
    invoke.resolve(result)
  }

  /** 弹出系统「忽略电池优化」确认框（需 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 权限）；结果由前端回前台后重新查询 */
  @Command
  fun requestIgnoreBatteryOptimization(invoke: Invoke) {
    try {
      activity.startActivity(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
      )
      invoke.resolve()
    } catch (e: Exception) {
      // 个别 ROM 不支持该 Intent：退到电池优化总列表
      try {
        activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        invoke.resolve()
      } catch (e2: Exception) {
        invoke.reject("无法打开电池优化设置：${e2.message}")
      }
    }
  }

  /** 本应用的系统设置页（自启动 / 后台活动 / 通知开关都从这里进） */
  @Command
  fun openAppSettings(invoke: Invoke) {
    try {
      activity.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
      )
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("无法打开应用设置：${e.message}")
    }
  }
}
