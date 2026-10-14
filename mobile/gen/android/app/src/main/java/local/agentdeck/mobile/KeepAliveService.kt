package local.agentdeck.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 手改部分（非 Tauri 生成）：后台保持连接用的前台服务，由 NativePlugin.keepaliveStart 启停。
 *
 * 常驻通知用独立的低优先级静音 channel（与 attention 提醒的 channel 分开）；文案由前端传入
 * （「AgentDeck 已连接：<电脑名>」），再次启动即更新文案。
 * - foregroundServiceType 取 specialUse（Android 14+ 必须声明类型；dataSync 在 Android 15 有 6 小时上限，
 *   remoteMessaging 面向消息类 App，都不合适），Manifest 里附带用途说明。
 * - 可选 PARTIAL_WAKE_LOCK（extra `wakelock`，默认关）：锁屏后 CPU 休眠导致断连时的备用手段。
 */
class KeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    active = true
    createChannel()
    val text = intent?.getStringExtra(EXTRA_TEXT)?.takeIf { it.isNotBlank() } ?: DEFAULT_TEXT
    val notification = buildNotification(text)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    val wantWakeLock = intent?.getBooleanExtra(EXTRA_WAKELOCK, false) == true
    if (wantWakeLock && wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentdeck:keepalive").apply {
        setReferenceCounted(false)
        acquire()
      }
    } else if (!wantWakeLock) {
      releaseWakeLock()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    active = false
    releaseWakeLock()
    super.onDestroy()
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      val channel = NotificationChannel(CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_LOW)
      channel.description = "App 在后台时保持与电脑的连接的常驻提示"
      channel.setSound(null, null)
      channel.enableVibration(false)
      manager.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(text: String): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setContentTitle("AgentDeck")
      .setContentText(text)
      .setSmallIcon(R.drawable.ic_stat_agentdeck)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
  }

  companion object {
    /** 服务是否在运行：MainActivity 据此决定切后台时是否让 WebView 继续运行（见 MainActivity 注释） */
    @Volatile
    var active = false

    const val CHANNEL_ID = "agentdeck_keepalive"
    const val NOTIFICATION_ID = 1001
    const val EXTRA_TEXT = "text"
    const val EXTRA_WAKELOCK = "wakelock"
    private const val DEFAULT_TEXT = "AgentDeck 已连接"
  }
}
