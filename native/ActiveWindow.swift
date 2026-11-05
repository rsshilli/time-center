// Time Center's front-window reader. One long-running process, started by the app, that prints one
// JSON line every few seconds: the front app, its focused window's title and, for Chrome only, the
// active tab's address, and whether a call is going (some app other than Krisp is using the microphone).
// Apps on the ignore list (Edge) are reported by name only: their windows are
// never read and they are never sent an Apple event.
//
// An ignore entry is a bundle id, which also covers ids under it ("com.microsoft.edgemac" covers Edge
// Beta, Dev, Canary and Edge web apps), or an app's name as macOS shows it.
//
// Usage: active-window [--interval 3] [--ignore com.microsoft.edgemac,Some App]
// Exits when its stdin closes, i.e. when Time Center quits or crashes.
//
// Usage: active-window --capture --ignore com.microsoft.edgemac
// Takes one screenshot of every display with the ignored apps' windows left out of the picture (what is
// behind them shows instead), prints them as one JSON array, then exits. Needs Screen Recording.

import AppKit
import ApplicationServices
import CoreAudio
import Foundation
import ScriptingBridge
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// One report: what is in front right now.
struct Sample: Encodable {
    let app: String?
    let bundleId: String?
    let title: String?
    let url: String?
    let ignored: Bool
    let onCall: Bool
}

/// Chrome's bundle ids (stable, beta, dev, canary) all start with this.
let chromePrefix = "com.google.Chrome"

/// Installed Chrome web apps (Google Chat, …) are `com.google.Chrome.app.<id>`; they can't answer
/// "URL of active tab", so asking only costs an Apple event per tick.
func isChromeBrowser(_ bundleId: String) -> Bool {
    return bundleId.hasPrefix(chromePrefix) && !bundleId.hasPrefix(chromePrefix + ".app.")
}

/// Reads the front window on a timer and prints a Sample per tick.
final class Reporter {
    private let ignored: Set<String>
    private let encoder = JSONEncoder()
    private let calls = CallDetector()
    /// The Chrome tab address is reused while the window title stays the same, since a tab switch or
    /// navigation usually changes the title. Saves an Apple event most ticks while Chrome is in front.
    private var lastUrlKey: String?
    private var lastUrl: String?
    private var lastUrlAt = Date.distantPast
    /// Re-ask Chrome at least this often, for pages that change address but keep their title.
    private let urlMaxAge: TimeInterval = 15

    /// - Parameter ignored: Bundle ids whose windows must never be read.
    init(ignored: Set<String>) {
        self.ignored = ignored
    }

    /// Prints one sample of the front window.
    func tick() {
        let sample = read()
        guard let data = try? encoder.encode(sample), let line = String(data: data, encoding: .utf8) else {
            return
        }
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }

    /// Works out the current sample.
    private func read() -> Sample {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return Sample(app: nil, bundleId: nil, title: nil, url: nil, ignored: false, onCall: calls.isOnCall())
        }
        let bundleId = app.bundleIdentifier
        if isIgnored(app, ignored) {
            return Sample(app: app.localizedName, bundleId: bundleId, title: nil, url: nil, ignored: true, onCall: calls.isOnCall())
        }
        let title = focusedWindowTitle(pid: app.processIdentifier) ?? frontWindowName(pid: app.processIdentifier)
        var url: String? = nil
        if let bundleId, isChromeBrowser(bundleId) {
            url = chromeUrl(pid: app.processIdentifier, title: title)
        } else {
            // Coming back to Chrome later must ask again, even if the title happens to match.
            lastUrlKey = nil
        }
        return Sample(app: app.localizedName, bundleId: bundleId, title: title, url: url, ignored: false, onCall: calls.isOnCall())
    }

    /// The focused window's title via Accessibility. Nil without the Accessibility permission.
    private func focusedWindowTitle(pid: pid_t) -> String? {
        let appElement = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window
        else {
            return nil
        }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success
        else {
            return nil
        }
        let text = title as? String
        return text?.isEmpty == false ? text : nil
    }

    /// The app's frontmost normal window name from the window server. Needs Screen Recording.
    private func frontWindowName(pid: pid_t) -> String? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for window in windows {
            let owner = window[kCGWindowOwnerPID as String] as? pid_t
            let layer = window[kCGWindowLayer as String] as? Int
            if owner == pid, layer == 0, let name = window[kCGWindowName as String] as? String, !name.isEmpty {
                return name
            }
        }
        return nil
    }

    /// The active Chrome tab's address. Needs the Automation permission for Chrome; nil without it.
    /// Without a title (no Accessibility or Screen Recording) nothing tells tabs apart, so it asks every tick.
    /// Asks the Chrome in front by process id: asking by bundle id reaches whichever copy macOS picks, and
    /// with a second copy running (a Playwright test browser) that was the wrong one. Seen 2026-11-05: real
    /// tabs recorded as `localhost:5290` and `127.0.0.1:50558` for 1h 18m; the probe by pid read them right.
    private func chromeUrl(pid: pid_t, title: String?) -> String? {
        let key = title.map { "\(pid)\u{1}" + $0 }
        if let key, key == lastUrlKey, Date().timeIntervalSince(lastUrlAt) < urlMaxAge {
            return lastUrl
        }
        let chrome = SBApplication(processIdentifier: pid)
        let windows = (chrome?.value(forKey: "windows") as? SBElementArray)?.compactMap { $0 as? SBObject } ?? []
        let tab = frontTab(windows, title: title)
        let url = tab?.value(forKey: "URL") as? String
        // On failure (no Automation permission yet, or no window), don't cache, so a permission granted
        // later is picked up on the next tick. lastError is a method: `lastError == nil` without the call
        // compares the method itself, which is never nil, and dropped every address (2026-11-05).
        guard chrome?.lastError() == nil, let url else {
            lastUrlKey = nil
            return nil
        }
        lastUrlKey = key
        lastUrlAt = Date()
        lastUrl = url
        return url
    }

    /// The active tab of the window you're looking at: the first window whose active tab's title starts the
    /// focused window's title (Chrome adds " - Google Chrome - <profile>" and the like), else the first window.
    /// Chrome's first window isn't always the one in front: the pinned Calendar tab was recorded as
    /// `about:blank` three times during a Meet (2026-11-05, rows 980/1011/1013) — suspected, not verified, to
    /// be Meet's floating picture-in-picture window being listed first.
    private func frontTab(_ windows: [SBObject], title: String?) -> SBObject? {
        let tabs = windows.compactMap { $0.value(forKey: "activeTab") as? SBObject }
        guard let title else {
            return tabs.first
        }
        let match = tabs.first { tab in
            guard let tabTitle = tab.value(forKey: "title") as? String, !tabTitle.isEmpty else {
                return false
            }
            return title.hasPrefix(tabTitle)
        }
        return match ?? tabs.first
    }
}

/// Apps that hold the microphone open without a call: Krisp's noise filter runs all the time (seen
/// 2026-11-05: `ai.krisp.krispMac` capturing input with no call going), and Time Center itself records.
let notACall = ["ai.krisp", "org.shillington.timecenter"]

/// Works out whether a call is going: some app other than those above is capturing microphone input
/// (Core Audio's per-process input state, macOS 14+, needs no permission). Browser calls count too:
/// Chrome's audio helper has no bundle id of its own, and was seen capturing during a real Meet call.
final class CallDetector {
    /// Says whether a call is going right now.
    func isOnCall() -> Bool {
        return capturingProcesses().contains { pid in
            let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
            return pid != getpid() && !notACall.contains { bundleId == $0 || bundleId.hasPrefix($0 + ".") }
        }
    }
}

/// Lists the processes capturing microphone input, by pid.
func capturingProcesses() -> [pid_t] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else {
        return []
    }
    var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &processes) == noErr else {
        return []
    }
    return processes
        .filter { audioProperty($0, kAudioProcessPropertyIsRunningInput, UInt32(0)) != 0 }
        .map { audioProperty($0, kAudioProcessPropertyPID, pid_t(0)) }
}

/// Reads one fixed-size Core Audio property of an audio object, or the fallback when it can't.
func audioProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ fallback: T) -> T {
    var address = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = fallback
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : fallback
}

/// Says whether an app is on the ignore list.
func isIgnored(_ app: NSRunningApplication, _ ignored: Set<String>) -> Bool {
    return isIgnored(bundleId: app.bundleIdentifier, name: app.localizedName, ignored)
}

/// Says whether an app is on the ignore list, by bundle id (or an id under it) or by name.
func isIgnored(bundleId: String?, name: String?, _ ignored: Set<String>) -> Bool {
    if let name, ignored.contains(name) {
        return true
    }
    guard let bundleId else {
        return false
    }
    return ignored.contains { bundleId == $0 || bundleId.hasPrefix($0 + ".") }
}

/// One display's picture, as printed by `--capture`.
struct DisplayShot: Encodable {
    let displayId: String
    /// JPEG at the display's size in points, base64.
    let full: String
    /// JPEG 320 points wide, base64.
    let thumb: String
}

/// JPEG quality for the full picture: readable text at roughly 150–300 KB.
let fullQuality = 0.6

/// Width of the thumbnail shown on the dashboard.
let thumbWidth = 320

/// Captures every display with the ignored apps' windows left out.
func captureDisplays(_ ignored: Set<String>) async throws -> [DisplayShot] {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let hidden = content.applications.filter { isIgnored(bundleId: $0.bundleIdentifier, name: $0.applicationName, ignored) }
    var shots: [DisplayShot] = []
    for display in content.displays {
        let filter = SCContentFilter(display: display, excludingApplications: hidden, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let full = jpeg(image, quality: fullQuality), let thumb = jpeg(scaled(image, width: thumbWidth), quality: 0.7)
        else {
            continue
        }
        shots.append(DisplayShot(displayId: String(display.displayID), full: full.base64EncodedString(), thumb: thumb.base64EncodedString()))
    }
    return shots
}

/// Encodes a picture as JPEG.
func jpeg(_ image: CGImage?, quality: Double) -> Data? {
    guard let image else {
        return nil
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
        return nil
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
}

/// Shrinks a picture to a width, keeping its shape.
func scaled(_ image: CGImage, width: Int) -> CGImage? {
    let height = max(1, image.height * width / max(1, image.width))
    guard let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else {
        return nil
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

/// Reads `--interval`, `--ignore` and `--capture` from the command line.
func parseArguments() -> (interval: TimeInterval, ignored: Set<String>, captureOnly: Bool) {
    var interval: TimeInterval = 3
    var ignored = Set<String>()
    var captureOnly = false
    let args = CommandLine.arguments
    var index = 1
    while index < args.count {
        let value = index + 1 < args.count ? args[index + 1] : ""
        if args[index] == "--interval", let seconds = TimeInterval(value), seconds > 0 {
            interval = seconds
            index += 1
        } else if args[index] == "--ignore" {
            ignored = Set(value.split(separator: ",").map { String($0) }.filter { !$0.isEmpty })
            index += 1
        } else if args[index] == "--capture" {
            captureOnly = true
        }
        index += 1
    }
    return (interval, ignored, captureOnly)
}

let (interval, ignored, captureOnly) = parseArguments()

if captureOnly {
    Task {
        do {
            let data = try JSONEncoder().encode(try await captureDisplays(ignored))
            FileHandle.standardOutput.write(data + "\n".data(using: .utf8)!)
            exit(0)
        } catch {
            FileHandle.standardError.write("Screenshot failed: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(1)
        }
    }
    dispatchMain()
}

let reporter = Reporter(ignored: ignored)

// Quit when the parent closes our stdin, so the helper never outlives Time Center.
Thread.detachNewThread {
    while FileHandle.standardInput.availableData.count > 0 {}
    exit(0)
}

reporter.tick()
Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in reporter.tick() }
RunLoop.main.run()
