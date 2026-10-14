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
 * M0 验证用最小前台服务：常驻通知「AgentDeck 已连接」，让进程在切后台 / 锁屏后保持较高优先级，
 * 以便验证 WebView 里的 WebSocket 能否继续收事件。
 *
 * - foregroundServiceType 取 specialUse（Android 14+ 必须声明类型；dataSync 在 Android 15 有 6 小时上限，
 *   remoteMessaging 面向消息类 App，都不合适），Manifest 里附带用途说明。
 * - 可选 PARTIAL_WAKE_LOCK（extra `wakelock`）：用于验证锁屏后 CPU 休眠是否是断连原因。
 * 该服务只由 MainActivity 里的 M0 调试 extra 启动，M3 再改成随连接状态自动启停。
 */
class KeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    createChannel()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (intent?.getBooleanExtra(EXTRA_WAKELOCK, false) == true && wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentdeck:keepalive").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "AgentDeck 连接", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }

  private fun buildNotification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setContentTitle("AgentDeck 已连接")
      .setContentText("保持与电脑上的 Agent 服务的连接")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
  }

  companion object {
    const val CHANNEL_ID = "agentdeck_keepalive"
    const val NOTIFICATION_ID = 1001
    const val EXTRA_WAKELOCK = "wakelock"
  }
}
