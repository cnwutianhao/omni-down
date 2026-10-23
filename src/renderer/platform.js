// 平台标记：macOS 使用隐藏标题栏（hiddenInset），需要为左上角红绿灯留白；
// Windows / Linux 用系统原生标题栏，不需要留白。
// 必须放在独立文件里：index.html 的 CSP 是 default-src 'self'，内联 <script> 会被拦截。
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac')
  ? 'mac'
  : 'other';
