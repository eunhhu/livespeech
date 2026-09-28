/**
 * Contract between the Bun server and the client, plus the Gemini Live wire format
 * we rely on. Field placement of the raw `setup` message mirrors what @google/genai
 * (liveConnectConfigToMldev) emits: `translationConfig` and `responseModalities`
 * live under `generationConfig`, transcription configs sit at the top of `setup`.
 */

export const TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";

/** @google/genai only supports ephemeral tokens on v1alpha. */
export const LIVE_API_VERSION = "v1alpha";

export const INPUT_SAMPLE_RATE = 16_000;
export const OUTPUT_SAMPLE_RATE = 24_000;
export const INPUT_MIME = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`;

export interface TokenRequest {
  targetLanguageCode: string;
}

export interface TokenResponse {
  /** Full WebSocket URL including the single-use ephemeral token. */
  wsUrl: string;
  /** Setup message to send first. Must match the constraints locked into the token. */
  setup: LiveSetup;
  expireTime: string;
}

export interface HealthResponse {
  ok: true;
  accessCodeRequired: boolean;
  model: string;
}

export interface LiveSetup {
  model: string;
  generationConfig: {
    responseModalities: ["AUDIO"];
    translationConfig: {
      targetLanguageCode: string;
      echoTargetLanguage: boolean;
    };
  };
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
}

export function buildTranslateSetup(targetLanguageCode: string): LiveSetup {
  return {
    model: `models/${TRANSLATE_MODEL}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      translationConfig: {
        targetLanguageCode,
        // Stay silent when the speaker already uses the target language. This is what
        // lets two parallel sessions act as a bidirectional interpreter.
        echoTargetLanguage: false,
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

export function liveWsUrl(token: string): string {
  return (
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.` +
    `${LIVE_API_VERSION}.GenerativeService.BidiGenerateContentConstrained` +
    `?access_token=${encodeURIComponent(token)}`
  );
}

// ---- Server -> client messages (subset we consume) ----

export interface LiveTranscription {
  text?: string;
  finished?: boolean;
  languageCode?: string;
}

export interface LiveServerMessage {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    inputTranscription?: LiveTranscription;
    outputTranscription?: LiveTranscription;
    interrupted?: boolean;
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
  goAway?: { timeLeft?: string };
  usageMetadata?: object;
}
