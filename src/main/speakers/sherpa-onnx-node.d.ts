/** The slice of sherpa-onnx-node used for voiceprints (the package ships no types). */
declare module "sherpa-onnx-node" {
  /** A stream of speech fed to the extractor. */
  export interface OnlineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }

  /** Turns speech into a speaker embedding (voiceprint). */
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number; debug?: boolean });
    createStream(): OnlineStream;
    /** With enableExternalBuffer true the result is a view of native memory; pass false for a JavaScript copy. */
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }
}
