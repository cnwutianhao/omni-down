// 生成 OmniDown 应用图标 1024x1024 master PNG
// 设计：macOS 规范圆角矩形（824/1024，圆角 185）+ 深蓝渐变底 + 下载箭头 + 底部进度条
// 运行: osascript -l JavaScript scripts/gen-icon.js
ObjC.import('Cocoa');

function run() {
  const SIZE = 1024;
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(SIZE, SIZE));
  img.lockFocus;

  // ---- 圆角裁剪路径（Apple 规范：内容 824px，圆角 185）----
  const contentSize = 824;
  const offset = (SIZE - contentSize) / 2; // 100
  const radius = 185;
  const rect = $.NSMakeRect(offset, offset, contentSize, contentSize);
  const clip = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect, radius, radius);
  clip.addClip;

  // ---- 背景：深蓝→紫渐变（对角线）----
  const bgGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.16, 0.42, 0.95, 1), // #296BF2
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.45, 0.25, 0.90, 1) // #7340E6
  );
  bgGrad.drawInRectAngle(rect, -45);

  // ---- 微光效果：顶部高光（全高渐变，避免接缝）----
  const hlGrad = $.NSGradient.alloc.initWithStartingColorEndingColor(
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0.20),
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0)
  );
  hlGrad.drawInRectAngle(rect, 90);

  // ---- 下载箭头（白色，粗圆角线条）----
  $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 1).set;
  const arrow = $.NSBezierPath.bezierPath;
  arrow.lineWidth = 72;
  arrow.lineCapStyle = $.NSRoundLineCapStyle;
  arrow.lineJoinStyle = $.NSRoundLineJoinStyle;

  // 竖线：从 (512, 700) 到 (512, 420)
  arrow.moveToPoint($.NSMakePoint(512, 700));
  arrow.lineToPoint($.NSMakePoint(512, 430));
  // 左斜线
  arrow.moveToPoint($.NSMakePoint(392, 545));
  arrow.lineToPoint($.NSMakePoint(512, 425));
  // 右斜线
  arrow.moveToPoint($.NSMakePoint(632, 545));
  arrow.lineToPoint($.NSMakePoint(512, 425));
  arrow.stroke;

  // ---- 底部托盘（进度条意象）----
  const tray = $.NSBezierPath.bezierPath;
  tray.lineWidth = 64;
  tray.lineCapStyle = $.NSRoundLineCapStyle;
  tray.moveToPoint($.NSMakePoint(330, 300));
  tray.lineToPoint($.NSMakePoint(694, 300));
  $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0.92).set;
  tray.stroke;

  // ---- 托盘上的进度点（青色圆点，双引擎意象）----
  $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.35, 0.95, 0.95, 1).set; // 青色
  const dot = $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(470, 268, 64, 64));
  dot.fill;

  img.unlockFocus;

  // ---- 导出 PNG ----
  const tiff = img.TIFFRepresentation;
  const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  const desktop = $.NSString.stringWithString('/Users/wutianhao/Projects/OmniDown/build/icon.png');
  png.writeToFileAtomically(desktop, true);
  return 'OK: icon.png written';
}
