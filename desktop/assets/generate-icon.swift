import AppKit
import Foundation

// Reuses the library's deep green and "文" mark; all sizes are drawn from this source.
let outputDirectory = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: outputDirectory, withIntermediateDirectories: true)
let variants: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (filename, size) in variants {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB,
                                  bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = NSAffineTransform()
    scale.scale(by: CGFloat(size) / 1024)
    scale.concat()
    let shape = NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 196, yRadius: 196)
    NSColor(srgbRed: 21 / 255, green: 63 / 255, blue: 59 / 255, alpha: 1).setFill()
    shape.fill()
    NSColor(srgbRed: 55 / 255, green: 105 / 255, blue: 93 / 255, alpha: 1).setStroke()
    shape.lineWidth = 3
    shape.stroke()
    let font = NSFont(name: "PingFangSC-Medium", size: 586) ?? NSFont.systemFont(ofSize: 586, weight: .medium)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
    let mark = "文" as NSString
    let markSize = mark.size(withAttributes: attributes)
    mark.draw(at: NSPoint(x: (1024 - markSize.width) / 2, y: (1024 - markSize.height) / 2 + 15), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent(filename))
}
