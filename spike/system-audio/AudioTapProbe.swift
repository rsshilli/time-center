// Spike: capture the Mac's system audio with a Core Audio process tap (macOS 14.2+), the fallback when
// Electron's built-in loopback doesn't work. Taps all system output, measures the level for 1.5 s of
// quiet, plays a quiet 440 Hz tone with afplay, measures again, and prints one `SPIKE_RESULT {json}` line.
//
// Run: swift spike/system-audio/AudioTapProbe.swift <path-to-tone.wav>

import AudioToolbox
import CoreAudio
import Foundation

/// Running peak RMS of the tapped audio, written from the Core Audio IO thread.
final class LevelMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var peak: Float = 0
    private var buffers = 0

    /// Folds one IO cycle's float samples into the running peak.
    func add(_ list: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        var sum: Float = 0
        var count = 0
        for buffer in abl {
            guard let data = buffer.mData else { continue }
            let samples = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            let floats = data.bindMemory(to: Float.self, capacity: samples)
            for i in 0..<samples {
                sum += floats[i] * floats[i]
            }
            count += samples
        }
        let rms = count > 0 ? (sum / Float(count)).squareRoot() : 0
        lock.lock()
        peak = max(peak, rms)
        buffers += 1
        lock.unlock()
    }

    /// Returns the peak and buffer count since the last call, and resets them.
    func takeReading() -> (peak: Float, buffers: Int) {
        lock.lock()
        defer {
            peak = 0
            buffers = 0
            lock.unlock()
        }
        return (peak, buffers)
    }
}

/// Prints the result line and exits.
func finish(_ fields: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    print("SPIKE_RESULT " + String(data: data, encoding: .utf8)!)
    exit(0)
}

/// Reads the UID of the default output device, which the aggregate device is clocked from.
func defaultOutputUID() -> String? {
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr else {
        return nil
    }
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    address.mSelector = kAudioDevicePropertyDeviceUID
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid) == noErr, let uid else {
        return nil
    }
    return uid.takeRetainedValue() as String
}

let tonePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
// Without the tone, the probe would measure silence and wrongly report "not captured".
guard FileManager.default.fileExists(atPath: tonePath) else {
    finish(["method": "coreaudio-tap", "error": "tone file missing: \(tonePath). Run `npm run spike:audio:electron` once to write it."])
}

let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
description.uuid = UUID()
description.isPrivate = true
description.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
if tapStatus != noErr {
    finish(["method": "coreaudio-tap", "error": "AudioHardwareCreateProcessTap failed", "status": tapStatus])
}

guard let outputUID = defaultOutputUID() else {
    finish(["method": "coreaudio-tap", "error": "no default output device"])
}

let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "TimeCenterSpikeTap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
if aggregateStatus != noErr {
    AudioHardwareDestroyProcessTap(tapID)
    finish(["method": "coreaudio-tap", "error": "AudioHardwareCreateAggregateDevice failed", "status": aggregateStatus])
}

let meter = LevelMeter()
var procID: AudioDeviceIOProcID?
let procStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, inputData, _, _, _ in
    meter.add(inputData)
}
let startStatus = procStatus == noErr ? AudioDeviceStart(aggregateID, procID) : procStatus
if startStatus != noErr {
    finish(["method": "coreaudio-tap", "error": "AudioDeviceStart failed", "status": startStatus])
}

Thread.sleep(forTimeInterval: 0.3)
_ = meter.takeReading()
Thread.sleep(forTimeInterval: 1.5)
let quiet = meter.takeReading()

let player = Process()
player.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
player.arguments = ["-v", "0.2", tonePath]
do {
    try player.run()
} catch {
    finish(["method": "coreaudio-tap", "error": "afplay failed to start: \(error)"])
}
Thread.sleep(forTimeInterval: 1.8)
let tone = meter.takeReading()
player.waitUntilExit()

AudioDeviceStop(aggregateID, procID)
if let procID {
    AudioDeviceDestroyIOProcID(aggregateID, procID)
}
AudioHardwareDestroyAggregateDevice(aggregateID)
AudioHardwareDestroyProcessTap(tapID)

finish([
    "method": "coreaudio-tap",
    "outputDevice": outputUID,
    "quietRms": quiet.peak,
    "quietBuffers": quiet.buffers,
    "toneRms": tone.peak,
    "toneBuffers": tone.buffers,
    "toneExit": player.terminationStatus,
    "captured": tone.peak > max(0.005, quiet.peak * 4),
])
