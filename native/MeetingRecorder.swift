// Time Center's call recorder. Started by the app when a call begins, stopped (stdin closed) when it ends.
//
// One ScreenCaptureKit stream carries both sides of the call: `.audio` is everything this Mac plays (the
// other people, "them"), `.microphone` is you ("me"). Each side is resampled to 16 kHz mono and
//   - written whole to `<out-dir>/<side>.m4a`, the recording kept for 30 days, and
//   - cut into WAV chunks at a pause under `<out-dir>/chunks/`, for whisper to transcribe as the call goes.
// Chunks with no speech in them are dropped here: whisper invents "Thank you." out of silence.
// Adapted from QbDCode's common/qbdcode-shell/chat/listen-capture.swift, which records this way on this Mac.
//
// Usage: meeting-recorder <out-dir>
// stdout, one JSON object per line:
//   {"ready":true,"mic":true|false}                       recording (mic false: macOS refused the microphone)
//   {"wav":"<path>","src":"me"|"them","t0":<epoch ms>}    a chunk to transcribe
//   {"error":"<plain words>"}                             fatal; exits non-zero
// Stops when stdin closes (Time Center quit, crashed or the call ended), finishing both files first.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let RATE = 16000.0
/// Shortest chunk worth cutting at a pause.
let MIN_SEC = 4.0
/// Cut here even mid-sentence, or the transcript lags too far behind the talk.
let MAX_SEC = 18.0
/// This much quiet ends a chunk.
let PAUSE_SEC = 0.5
/// RMS of a 30 ms frame below this counts as quiet.
let QUIET = Float(0.006)
/// A chunk with less speech than this is dropped.
let MIN_SPEECH_SEC = 0.6

/// Lines are printed from the capture queue and the main thread; the lock keeps them whole.
let sayLock = NSLock()

/// Prints one JSON line for Time Center.
func say(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else {
        return
    }
    sayLock.lock()
    defer { sayLock.unlock() }
    // The throwing write: once Time Center has quit nobody reads stdout, and the old write() raises on a
    // closed pipe, which would kill the recorder before it finishes its .m4a files.
    try? FileHandle.standardOutput.write(contentsOf: (text + "\n").data(using: .utf8)!)
}

/// Reports a fatal problem and exits.
func fail(_ message: String) -> Never {
    say(["error": message])
    exit(2)
}

/// One side of the call: its resampler, its whole-call file, and the samples waiting to become a chunk.
final class Side {
    let src: String
    let chunkDir: URL
    let file: AVAudioFile?
    var converter: AVAudioConverter?
    var inFormat: AVAudioFormat?
    var samples: [Float] = []
    var t0: Double = 0
    var seq = 0
    let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: RATE, channels: 1, interleaved: false)!

    /// - Parameters:
    ///   - src: "me" or "them".
    ///   - dir: The recording's folder.
    init(_ src: String, _ dir: URL) {
        self.src = src
        chunkDir = dir.appendingPathComponent("chunks", isDirectory: true)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: RATE,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32000,
        ]
        file = try? AVAudioFile(
            forWriting: dir.appendingPathComponent("\(src).m4a"), settings: settings,
            commonFormat: .pcmFormatFloat32, interleaved: false)
        if file == nil {
            say(["warning": "Could not create \(src).m4a; the transcript still works."])
        }
    }

    /// Takes one buffer from the stream: converts it, writes it to the file, and cuts a chunk at a pause.
    func add(_ sampleBuffer: CMSampleBuffer) {
        guard let pcm = Side.pcm(sampleBuffer) else {
            return
        }
        if inFormat == nil || !(inFormat!.isEqual(pcm.format)) {
            inFormat = pcm.format
            converter = AVAudioConverter(from: pcm.format, to: out)
        }
        guard let converter else {
            return
        }
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * RATE / pcm.format.sampleRate) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: capacity) else {
            return
        }
        var given = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return pcm
        }
        if error != nil || converted.frameLength == 0 {
            return
        }
        try? file?.write(from: converted)
        if samples.isEmpty {
            t0 = Date().timeIntervalSince1970 * 1000 - Double(converted.frameLength) / RATE * 1000
        }
        samples.append(contentsOf: UnsafeBufferPointer(start: converted.floatChannelData![0], count: Int(converted.frameLength)))
        let seconds = Double(samples.count) / RATE
        if seconds >= MAX_SEC || (seconds >= MIN_SEC && quietTail()) {
            flush()
        }
    }

    /// Root-mean-square loudness of samples[from..<to].
    func rms(_ from: Int, _ to: Int) -> Float {
        if to <= from {
            return 0
        }
        var sum: Float = 0
        for index in from..<to {
            sum += samples[index] * samples[index]
        }
        return (sum / Float(to - from)).squareRoot()
    }

    /// Whether the last PAUSE_SEC was quiet, i.e. a good place to cut.
    func quietTail() -> Bool {
        let tail = Int(PAUSE_SEC * RATE)
        if samples.count < tail {
            return false
        }
        let frame = Int(0.03 * RATE)
        var index = samples.count - tail
        while index + frame <= samples.count {
            if rms(index, index + frame) >= QUIET {
                return false
            }
            index += frame
        }
        return true
    }

    /// Writes the waiting samples as a chunk, unless there's too little speech in them to be worth it.
    func flush() {
        defer { samples.removeAll(keepingCapacity: true) }
        let frame = Int(0.03 * RATE)
        var speech = 0
        var index = 0
        while index + frame <= samples.count {
            if rms(index, index + frame) >= QUIET * 2 {
                speech += 1
            }
            index += frame
        }
        if Double(speech) * 0.03 < MIN_SPEECH_SEC {
            return
        }
        seq += 1
        let url = chunkDir.appendingPathComponent("\(src)-\(Int(t0))-\(seq).wav")
        if writeWav(url) {
            say(["wav": url.path, "src": src, "t0": Int(t0)])
        }
    }

    /// Writes the waiting samples as 16-bit PCM WAV, via a temporary name so a reader never sees half a file.
    func writeWav(_ url: URL) -> Bool {
        var data = Data()
        func u32(_ value: UInt32) {
            var little = value.littleEndian
            data.append(Data(bytes: &little, count: 4))
        }
        func u16(_ value: UInt16) {
            var little = value.littleEndian
            data.append(Data(bytes: &little, count: 2))
        }
        let bytes = UInt32(samples.count * 2)
        data.append("RIFF".data(using: .ascii)!)
        u32(36 + bytes)
        data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!)
        u32(16)
        u16(1)
        u16(1)
        u32(UInt32(RATE))
        u32(UInt32(RATE) * 2)
        u16(2)
        u16(16)
        data.append("data".data(using: .ascii)!)
        u32(bytes)
        var pcm = [Int16](repeating: 0, count: samples.count)
        for (index, value) in samples.enumerated() {
            pcm[index] = Int16(max(-1, min(1, value)) * 32767)
        }
        pcm.withUnsafeBufferPointer {
            data.append(UnsafeBufferPointer(
                start: UnsafeRawPointer($0.baseAddress!).assumingMemoryBound(to: UInt8.self), count: $0.count * 2))
        }
        let partial = url.appendingPathExtension("part")
        do {
            try data.write(to: partial)
            try FileManager.default.moveItem(at: partial, to: url)
            return true
        } catch {
            return false
        }
    }

    /// Finishes the whole-call file so it plays, then writes the last chunk. The file goes first: it is the
    /// part that can't be recovered later, while a chunk left on disk is picked up on the next start.
    func finish() {
        file?.close()
        flush()
    }

    /// Copies a stream buffer into an AVAudioPCMBuffer in its own format.
    static func pcm(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(description)
        else {
            return nil
        }
        var asbd = asbdPointer.pointee
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            return nil
        }
        let count = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else {
            return nil
        }
        buffer.frameLength = count
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(count), into: buffer.mutableAudioBufferList)
        return status == noErr ? buffer : nil
    }
}

/// The stream and both sides.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let them: Side
    let me: Side
    let queue = DispatchQueue(label: "recorder.audio")
    var stream: SCStream?

    /// - Parameter dir: The recording's folder.
    init(_ dir: URL) {
        them = Side("them", dir)
        me = Side("me", dir)
    }

    /// Starts the stream. Screen Recording covers the system audio; the microphone needs its own permission.
    func start() async {
        if !CGPreflightScreenCaptureAccess() {
            fail("macOS hasn't allowed Time Center to record the screen and system audio (Privacy & Security → Screen & System Audio Recording).")
        }
        let micAllowed = await AVCaptureDevice.requestAccess(for: .audio)
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            fail("Couldn't start capturing system audio: \(error.localizedDescription)")
        }
        guard let display = content.displays.first else {
            fail("No display found to capture audio from.")
        }
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(RATE)
        config.channelCount = 1
        config.captureMicrophone = micAllowed
        // Audio only; the API needs a video side, so it is made as small and slow as it allows.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 10, timescale: 1)
        config.queueDepth = 3
        let newStream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
        do {
            try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            if micAllowed {
                try newStream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
            }
            try await newStream.startCapture()
        } catch {
            fail("Couldn't start recording: \(error.localizedDescription)")
        }
        stream = newStream
        say(["ready": true, "mic": micAllowed])
    }

    /// Hands each audio buffer to its side; the tiny video frames are ignored.
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio {
            them.add(sampleBuffer)
        } else if type == .microphone {
            me.add(sampleBuffer)
        }
    }

    /// The stream died (e.g. permission withdrawn): finish the files, then report it.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.sync {
            them.finish()
            me.finish()
        }
        fail("Recording stopped: \(error.localizedDescription)")
    }

    /// Stops the stream, finishes both sides and exits.
    func stop() {
        let done = DispatchSemaphore(value: 0)
        if let stream {
            stream.stopCapture { _ in done.signal() }
            _ = done.wait(timeout: .now() + 2)
        }
        queue.sync {
            them.finish()
            me.finish()
        }
        exit(0)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: meeting-recorder <out-dir>")
}
let outDir = URL(fileURLWithPath: args[1], isDirectory: true)
do {
    try FileManager.default.createDirectory(
        at: outDir.appendingPathComponent("chunks", isDirectory: true), withIntermediateDirectories: true)
} catch {
    fail("Couldn't create \(outDir.path): \(error.localizedDescription)")
}
let capture = Capture(outDir)
// Printing after Time Center has gone must fail quietly, not end the process mid-finish.
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { capture.stop() }
term.resume()
// stdin closing means Time Center is gone or the call ended; never keep recording with nobody reading.
DispatchQueue.global().async {
    while readLine() != nil {}
    DispatchQueue.main.async { capture.stop() }
}
Task { await capture.start() }
dispatchMain()
