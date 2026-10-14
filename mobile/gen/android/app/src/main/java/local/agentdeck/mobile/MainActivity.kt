package local.agentdeck.mobile

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
}
