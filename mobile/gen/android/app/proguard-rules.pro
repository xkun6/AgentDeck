# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ---- AgentDeck（手改）：release 开启了 R8 压缩 / 混淆 ----
# tauri-android 的 consumer rules 已按注解保留 @TauriPlugin 的 @Command 方法与 @InvokeArg 类，
# 这里再显式保留本包的插件类、Args 类与反射命令入口，避免 R8 改名 / 裁剪后 Rust 侧 plugin:native|xxx 调用失败。
-keep class local.agentdeck.mobile.NativePlugin {
  public <init>(...);
  @app.tauri.annotation.Command public <methods>;
}
-keep class local.agentdeck.mobile.*Args {
  *;
}
# 清单里声明的组件与 Rust 侧 JNI 按名查找的类
-keep class local.agentdeck.mobile.MainActivity { *; }
-keep class local.agentdeck.mobile.KeepAliveService { *; }
# 保留异常堆栈的行号信息，便于排查线上崩溃
-keepattributes SourceFile,LineNumberTable,*Annotation*
