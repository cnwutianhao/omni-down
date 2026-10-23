// 平台标记：macOS 使用隐藏标题栏（hiddenInset），需要为左上角红绿灯留白；
// Windows / Linux 用系统原生标题栏，不需要留白。
// 必须放在独立文件里：index.html 的 CSP 是 default-src 'self'，内联 <script> 会被拦截。
//
// data-platform：二值（mac / other），供 CSS 区分标题栏留白，勿改成三值（styles.css 依赖它）。
// data-os：三值（mac / win / linux），供界面文案按平台显示系统术语。
const ua = navigator.userAgent;
const isMac = ua.includes('Mac');
const isWin = ua.includes('Windows');

document.documentElement.dataset.platform = isMac ? 'mac' : 'other';
document.documentElement.dataset.os = isMac ? 'mac' : isWin ? 'win' : 'linux';
