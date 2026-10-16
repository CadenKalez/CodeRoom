// Draws Code Room's app icon (1024×1024 PNG): glowing code bubbles joined by strands.
//     swiftc make_icon.swift -o make_icon && ./make_icon icon.png

import Cocoa

let size = 1024
guard CommandLine.arguments.count > 1,
      let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else {
    fputs("usage: make_icon out.png\n", stderr)
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
let space = CGColorSpaceCreateDeviceRGB()

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}
func gradient(_ colors: [CGColor], _ stops: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: space, colors: colors as CFArray, locations: stops)!
}

// macOS icon grid: an 824pt rounded square centred on the 1024 canvas
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: rgb(0x000000, 0.45))
ctx.addPath(tilePath); ctx.setFillColor(rgb(0x05030f)); ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tilePath); ctx.clip()
ctx.drawRadialGradient(gradient([rgb(0x1d2066), rgb(0x0c0a2c), rgb(0x04020c)], [0, 0.55, 1]),
                       startCenter: CGPoint(x: 512, y: 560), startRadius: 0,
                       endCenter: CGPoint(x: 512, y: 512), endRadius: 640, options: [])

// confetti of code fragments
srand48(42)
let palette: [UInt32] = [0xff5fd2, 0x4ff3ff, 0xffe14f, 0x7dff6a, 0xb98bff, 0xff9a3d]
ctx.setBlendMode(.plusLighter)
for _ in 0..<170 {
    let x = 110 + drand48() * 804, y = 110 + drand48() * 804
    let w = 4 + drand48() * 22, h = 3 + drand48() * 3
    ctx.setFillColor(rgb(palette[Int(drand48() * Double(palette.count))], 0.25 + drand48() * 0.45))
    ctx.fill(CGRect(x: x, y: y, width: w, height: h))
}

// floor rings
ctx.setLineWidth(3)
for ring in 1...4 {
    ctx.setStrokeColor(rgb(0x4ff3ff, 0.16 - CGFloat(ring) * 0.025))
    ctx.strokeEllipse(in: CGRect(x: 512 - CGFloat(ring) * 120, y: 170 - CGFloat(ring) * 22, width: CGFloat(ring) * 240, height: CGFloat(ring) * 44))
}

struct Bubble { let x: CGFloat, y: CGFloat, r: CGFloat, color: UInt32 }
let bubbles = [
    Bubble(x: 410, y: 560, r: 168, color: 0xff5fd2),
    Bubble(x: 700, y: 650, r: 104, color: 0x4ff3ff),
    Bubble(x: 680, y: 365, r: 118, color: 0xffe14f),
    Bubble(x: 300, y: 300, r: 72, color: 0x7dff6a),
    Bubble(x: 800, y: 470, r: 52, color: 0xb98bff),
    Bubble(x: 520, y: 805, r: 48, color: 0x4ff3ff),
    Bubble(x: 225, y: 720, r: 40, color: 0xff9a3d),
]

// strands: a fan of curved hairs between connected bubbles
let edges = [(0, 1, 9), (0, 2, 11), (0, 3, 6), (1, 2, 5), (2, 4, 4), (0, 5, 4), (0, 6, 3), (1, 4, 3), (3, 2, 4)]
for (a, b, count) in edges {
    let A = bubbles[a], B = bubbles[b]
    let ang = atan2(B.y - A.y, B.x - A.x)
    for k in 0..<count {
        let spread = (CGFloat(k) / CGFloat(max(1, count - 1)) - 0.5) * 0.9
        let p0 = CGPoint(x: A.x + cos(ang + spread) * A.r * 0.95, y: A.y + sin(ang + spread) * A.r * 0.95)
        let p1 = CGPoint(x: B.x + cos(ang + .pi - spread) * B.r * 0.95, y: B.y + sin(ang + .pi - spread) * B.r * 0.95)
        let mid = CGPoint(x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2)
        let bend = spread * 70
        let ctl = CGPoint(x: mid.x - sin(ang) * bend, y: mid.y + cos(ang) * bend)
        let path = CGMutablePath(); path.move(to: p0); path.addQuadCurve(to: p1, control: ctl)
        ctx.addPath(path); ctx.setStrokeColor(rgb(A.color, 0.10)); ctx.setLineWidth(10); ctx.strokePath()
        ctx.addPath(path); ctx.setStrokeColor(rgb(A.color, 0.75)); ctx.setLineWidth(2.6); ctx.strokePath()
    }
}

// bubbles: outer glow, dark core, wrapped "code" lines, glassy rim and highlight
for b in bubbles {
    let c = CGPoint(x: b.x, y: b.y)
    ctx.setBlendMode(.plusLighter)
    ctx.drawRadialGradient(gradient([rgb(b.color, 0.45), rgb(b.color, 0)], [0, 1]),
                           startCenter: c, startRadius: b.r * 0.85, endCenter: c, endRadius: b.r * 1.55, options: [])
    ctx.setBlendMode(.normal)
    ctx.setFillColor(rgb(0x07051a, 0.85)); ctx.fillEllipse(in: CGRect(x: b.x - b.r, y: b.y - b.r, width: b.r * 2, height: b.r * 2))

    ctx.saveGState()
    ctx.addEllipse(in: CGRect(x: b.x - b.r, y: b.y - b.r, width: b.r * 2, height: b.r * 2)); ctx.clip()
    ctx.setBlendMode(.plusLighter)
    let line = max(7, b.r / 9)
    var y = b.y - b.r + line
    var row = 0
    while y < b.y + b.r - line / 2 {
        let lat = (y - b.y) / b.r, w = sqrt(max(0, 1 - lat * lat))
        var x = b.x - b.r * w * 0.92 + CGFloat((row * 37) % 5) * line * 0.6
        while x < b.x + b.r * w * 0.8 {
            let seg = line * CGFloat(1 + (row * 7 + Int(x)) % 5)
            ctx.setFillColor(rgb(b.color, 0.28 + 0.4 * w))
            ctx.fill(CGRect(x: x, y: y - line * 0.22, width: min(seg, b.x + b.r * w - x), height: line * 0.44))
            x += seg + line * 0.7
        }
        y += line * 1.25
        row += 1
    }
    ctx.restoreGState()

    ctx.setBlendMode(.normal)
    ctx.drawRadialGradient(gradient([rgb(b.color, 0.02), rgb(b.color, 0.18), rgb(b.color, 0.95), rgb(b.color, 0.3)], [0, 0.72, 0.95, 1]),
                           startCenter: CGPoint(x: b.x - b.r * 0.2, y: b.y + b.r * 0.25), startRadius: 2,
                           endCenter: c, endRadius: b.r, options: [])
    ctx.setStrokeColor(rgb(0xffffff, 0.45)); ctx.setLineWidth(max(2, b.r / 40))
    ctx.strokeEllipse(in: CGRect(x: b.x - b.r + 1, y: b.y - b.r + 1, width: b.r * 2 - 2, height: b.r * 2 - 2))
    let hl = CGPoint(x: b.x - b.r * 0.36, y: b.y + b.r * 0.42)
    ctx.drawRadialGradient(gradient([rgb(0xffffff, 0.85), rgb(0xffffff, 0)], [0, 1]),
                           startCenter: hl, startRadius: 0, endCenter: hl, endRadius: b.r * 0.42, options: [])
}
ctx.restoreGState()

// subtle edge light on the tile
ctx.addPath(tilePath); ctx.setStrokeColor(rgb(0x8cf0ff, 0.18)); ctx.setLineWidth(3); ctx.strokePath()

NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
