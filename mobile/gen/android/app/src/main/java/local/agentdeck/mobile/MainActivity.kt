package local.agentdeck.mobile

import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// 手改部分（非 Tauri 生成）。generated/ 下的 WryActivity 每次构建都会被 wry 重新生成，不能改，所以保活逻辑写在这里。
//
// 背景（真机结论）：放行华为后台设置后进程不再被 freezer 冻结，但切后台约 5 分钟后 WebView 里的页面 JS 整体停止，
// 超过 5 分钟的 client.attention 不再触发通知。原因在 WebView 一侧：
// 1. WryActivity.onPause 会调用 webView.onPause()，Chromium 据此把页面置为不可见；
// 2. Activity stop 后窗口可见性变为 INVISIBLE（View.dispatchWindowVisibilityChanged），页面同样被视为不可见。
// 不可见页面会被 Blink 限流（后台定时器 1 次/秒 → 5 分钟后 1 次/分钟）乃至冻结。
// 所以「后台保持连接」开启并已连接（KeepAliveService.active）时：
// - onPause 后立刻 webView.onResume() + resumeTimers()；
// - onStop 后把窗口可见性重新派发为 VISIBLE（系统的 INVISIBLE 在 stop 之后的下一次 traversal 才派发，故延迟重发几次）；
// - 渲染进程优先级不随 WebView 不可见而降级（waivedWhenNotVisible=false）。
// 代价：页面的 document.visibilityState 在后台也是 visible，所以前端的「前台 / 后台」改由 NativePlugin 的 appState 提供。
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private val handler = Handler(Looper.getMainLooper())
  private val keepRunning = Runnable { keepWebViewRunning() }

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
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    // 默认 waivedWhenNotVisible=true：WebView 不可见时渲染进程优先级降到最低，更容易被系统回收 / 限流
    if (Build.VERSION.SDK_INT >= 26) {
      webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }
  }

  override fun onResume() {
    // 先于 super 更新：PluginManager.onResume 会触发 NativePlugin 发 appState 事件，需要读到最新值
    NativePlugin.foreground = true
    super.onResume()
    handler.removeCallbacks(keepRunning)
  }

  override fun onPause() {
    super.onPause()
    if (KeepAliveService.active) {
      // WryActivity.onPause 刚调用过 webView.onPause()，立即恢复
      webView?.let {
        it.onResume()
        it.resumeTimers()
      }
    }
  }

  override fun onStop() {
    NativePlugin.foreground = false
    super.onStop()
    if (KeepAliveService.active) {
      keepWebViewRunning()
      // 系统在 stop 之后的下一次 traversal 才把窗口可见性派发为 INVISIBLE，所以延迟重发几次
      for (delay in longArrayOf(300, 1_500, 5_000)) handler.postDelayed(keepRunning, delay)
    }
  }

  override fun onDestroy() {
    handler.removeCallbacks(keepRunning)
    super.onDestroy()
  }

  private fun keepWebViewRunning() {
    val view = webView ?: return
    if (NativePlugin.foreground || !KeepAliveService.active) return
    view.onResume()
    view.resumeTimers()
    view.dispatchWindowVisibilityChanged(View.VISIBLE)
  }
}
