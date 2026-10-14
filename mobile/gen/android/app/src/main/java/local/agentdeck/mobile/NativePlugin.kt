package local.agentdeck.mobile

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// 手改部分（非 Tauri 生成）：AgentDeck 本地插件 native 的 Kotlin 实现，Rust 侧见 mobile/src/native.rs。
// 提供前台服务启停（保活）、电池优化白名单状态 / 申请、应用系统设置页，以及后台提醒通知（带会话 id 的点击跳转）。
//
// 为什么提醒通知不走 tauri-plugin-notification 的 show：它在 Android 上点击回调的 payload 不含自定义 extra / 通知 id
// （2.6.0 的 sourceJson 从未赋值），无法知道该跳哪个会话；这里自己发通知，PendingIntent 带 agentId，
// 点击经 onNewIntent 以事件 notificationClicked 转给前端，冷启动（进程已被杀）则由 takeLaunchTarget 取走。
// 通知权限的申请仍用 tauri-plugin-notification 的 requestPermission。

@InvokeArg
class KeepAliveArgs {
  var text: String = ""
  var wakeLock: Boolean = false
}

@InvokeArg
class AttentionArgs {
  var id: Int = 0
  var title: String = ""
  var body: String = ""
  /** finished / failed / permission / schedule，决定通知 channel */
  var kind: String = "finished"
  var agentId: String? = null
}

@TauriPlugin
class NativePlugin(private val activity: Activity) : Plugin(activity) {
  /** 冷启动时由点击通知拉起的目标；被前端取走一次后清空 */
  private var launchTarget: JSObject? = null

  override fun load(webView: WebView) {
    super.load(webView)
    launchTarget = targetOf(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    targetOf(intent)?.let { trigger("notificationClicked", it) }
  }

  // App 前后台状态（Activity resume / stop）。MainActivity 在后台保活时会让 WebView 一直保持「可见」，
  // 页面的 document.visibilityState 不再可信，前端改读这里的状态（见 web/src/mobile/native/app-state.ts）。
  override fun onResume(activity: AppCompatActivity) {
    super.onResume(activity)
    trigger("appState", appStatePayload())
  }

  override fun onStop(activity: AppCompatActivity) {
    super.onStop(activity)
    trigger("appState", appStatePayload())
  }

  private fun appStatePayload(): JSObject {
    val payload = JSObject()
    payload.put("foreground", foreground)
    return payload
  }

  @Command
  fun appState(invoke: Invoke) {
    invoke.resolve(appStatePayload())
  }

  private fun targetOf(intent: Intent?): JSObject? {
    if (intent == null || !intent.getBooleanExtra(EXTRA_FROM_ATTENTION, false)) return null
    val target = JSObject()
    target.put("agentId", intent.getStringExtra(EXTRA_AGENT_ID))
    return target
  }

  @Command
  fun takeLaunchTarget(invoke: Invoke) {
    val result = JSObject()
    result.put("target", launchTarget)
    launchTarget = null
    activity.intent?.removeExtra(EXTRA_FROM_ATTENTION)
    invoke.resolve(result)
  }

  @Command
  fun notificationStatus(invoke: Invoke) {
    val result = JSObject()
    result.put("enabled", NotificationManagerCompat.from(activity).areNotificationsEnabled())
    invoke.resolve(result)
  }

  /** 发一条 attention 提醒；同 id 的通知会被覆盖（前端另按 notice.id 去重） */
  @Command
  fun showAttention(invoke: Invoke) {
    val args = invoke.parseArgs(AttentionArgs::class.java)
    ensureChannels()
    val open = PendingIntent.getActivity(
      activity,
      args.id,
      Intent(activity, MainActivity::class.java)
        .setAction(Intent.ACTION_MAIN)
        .addCategory(Intent.CATEGORY_LAUNCHER)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        .putExtra(EXTRA_FROM_ATTENTION, true)
        .putExtra(EXTRA_AGENT_ID, args.agentId),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val channel = channelOf(args.kind)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(activity, channel) else Notification.Builder(activity)
    builder
      .setContentTitle(args.title)
      .setContentText(args.body)
      .setStyle(Notification.BigTextStyle().bigText(args.body))
      .setSmallIcon(R.drawable.ic_stat_agentdeck)
      .setContentIntent(open)
      .setAutoCancel(true)
    if (Build.VERSION.SDK_INT < 26) {
      // 8.0 以前没有 channel：用优先级区分，待审批更高
      @Suppress("DEPRECATION")
      builder.setPriority(if (args.kind == "permission") Notification.PRIORITY_HIGH else Notification.PRIORITY_DEFAULT)
        .setDefaults(Notification.DEFAULT_ALL)
    }
    val manager = activity.getSystemService(Activity.NOTIFICATION_SERVICE) as NotificationManager
    try {
      manager.notify(args.id, builder.build())
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("发送通知失败：${e.message}")
    }
  }

  private fun channelOf(kind: String): String =
    when (kind) {
      "permission" -> CHANNEL_PERMISSION
      "schedule" -> CHANNEL_SCHEDULE
      else -> CHANNEL_RESULT
    }

  /** 与前台服务的常驻通知（agentdeck_keepalive，低优先级静音）分开：待审批高优先级，完成 / 失败与定时任务默认优先级 */
  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = activity.getSystemService(NotificationManager::class.java)
    fun create(id: String, name: String, description: String, importance: Int) {
      if (manager.getNotificationChannel(id) != null) return
      val channel = NotificationChannel(id, name, importance)
      channel.description = description
      channel.enableVibration(true)
      manager.createNotificationChannel(channel)
    }
    create(CHANNEL_PERMISSION, "待审批", "Agent 请求审批工具调用或回答问题时提醒", NotificationManager.IMPORTANCE_HIGH)
    create(CHANNEL_RESULT, "完成与失败", "会话本轮完成或失败时提醒", NotificationManager.IMPORTANCE_DEFAULT)
    create(CHANNEL_SCHEDULE, "定时任务", "定时任务失败或目标循环结束时提醒", NotificationManager.IMPORTANCE_DEFAULT)
  }

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

  /**
   * 本应用的通知设置页。部分厂商（如华为）会把「待审批」channel 的设置页重定向到只有「允许通知 / 静默通知 / 锁屏通知」的分组页，
   * 里面没有「横幅」开关，所以改为打开应用级通知设置（那里才有横幅 / 悬浮通知开关）。
   * 按顺序尝试：应用通知设置 → 「待审批」channel 设置（需要 channel 已存在，所以先 ensureChannels）→ 应用详情页；
   * 前一个 Intent 在该机型上无法启动（抛异常）才退到下一个。
   */
  @Command
  fun openAppNotificationSettings(invoke: Invoke) {
    ensureChannels()
    val pkg = activity.packageName
    val candidates = mutableListOf<Intent>()
    if (Build.VERSION.SDK_INT >= 26) {
      candidates.add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg))
      candidates.add(
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
          .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_PERMISSION)
      )
    } else {
      candidates.add(Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("app_package", pkg))
    }
    candidates.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")))

    var lastError: Exception? = null
    for (intent in candidates) {
      try {
        activity.startActivity(intent)
        invoke.resolve()
        return
      } catch (e: Exception) {
        lastError = e
      }
    }
    invoke.reject("无法打开通知设置：${lastError?.message}")
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

  companion object {
    /** Activity 是否处于前台（onResume 置 true、onStop 置 false），由 MainActivity 维护 */
    @Volatile
    var foreground = false

    const val CHANNEL_PERMISSION = "agentdeck_permission"
    const val CHANNEL_RESULT = "agentdeck_result"
    const val CHANNEL_SCHEDULE = "agentdeck_schedule"
    const val EXTRA_FROM_ATTENTION = "local.agentdeck.mobile.FROM_ATTENTION"
    const val EXTRA_AGENT_ID = "local.agentdeck.mobile.AGENT_ID"
  }
}
