package local.agentdeck.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // M0 实验开关：切后台后让 WebView 的 JS 继续运行（adb 以 --ez m0_keepjs true 打开）。
  private var keepJs = false

  override fun onResume() {
    super.onResume()
    if (keepJs) tuneWebView()
  }

  override fun onPause() {
    super.onPause()
    // wry 在 onPause 里调用 WebView.onPause()；这里在其后立刻恢复，并让渲染进程在不可见时也保持高优先级。
    if (keepJs) tuneWebView()
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) findWebView(view.getChildAt(i))?.let { return it }
    }
    return null
  }

  private fun tuneWebView() {
    val webView = findWebView(window.decorView) ?: return
    if (Build.VERSION.SDK_INT >= 26) {
      webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }
    webView.onResume()
    webView.resumeTimers()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // edge-to-edge 下 adjustResize 不再自动缩小内容区（targetSdk 35+ 在 Android 15 上强制 edge-to-edge），
    // 软键盘弹出时把输入法高度作为底部内边距，让 WebView 变矮，输入框保持在键盘上方。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(0, 0, 0, ime.bottom)
      insets
    }

    handleM0Intent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleM0Intent(intent)
  }

  /**
   * M0 调试钩子（adb 触发，M3 起改成随连接状态自动启停）：
   *   adb shell am start -n local.agentdeck.mobile/.MainActivity --ez m0_fgs true [--ez m0_wakelock true]
   *   adb shell am start -n local.agentdeck.mobile/.MainActivity --ez m0_fgs false
   *   adb shell am start -n local.agentdeck.mobile/.MainActivity --ez m0_keepjs true   # 切后台后不暂停 WebView JS
   */
  private fun handleM0Intent(intent: Intent?) {
    if (intent == null) return
    if (intent.hasExtra("m0_keepjs")) {
      keepJs = intent.getBooleanExtra("m0_keepjs", false)
      if (keepJs) tuneWebView()
    }
    if (!intent.hasExtra("m0_fgs")) return
    val service = Intent(this, KeepAliveService::class.java)
    if (intent.getBooleanExtra("m0_fgs", false)) {
      if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
      ) {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
      }
      service.putExtra(KeepAliveService.EXTRA_WAKELOCK, intent.getBooleanExtra("m0_wakelock", false))
      ContextCompat.startForegroundService(this, service)
    } else {
      stopService(service)
    }
  }
}
