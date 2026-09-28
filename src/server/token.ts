import { GoogleGenAI, Modality } from "@google/genai";
import {
  LIVE_API_VERSION,
  TRANSLATE_MODEL,
  buildTranslateSetup,
  liveWsUrl,
  type TokenResponse,
} from "../shared/protocol";

const apiKey = process.env.GEMINI_API_KEY;

const ai = apiKey
  ? new GoogleGenAI({ apiKey, httpOptions: { apiVersion: LIVE_API_VERSION } })
  : null;

export const hasApiKey = ai !== null;

/**
 * Mints a single-use ephemeral token whose Live config is fully locked
 * (`lockAdditionalFields: []`), so a leaked token can only ever open a
 * translate session into the language it was issued for.
 */
export async function mintTranslateToken(targetLanguageCode: string): Promise<TokenResponse> {
  if (!ai) throw new Error("GEMINI_API_KEY is not set");

  const now = Date.now();
  const expireTime = new Date(now + 30 * 60_000).toISOString();

  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      liveConnectConstraints: {
        model: TRANSLATE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: { targetLanguageCode, echoTargetLanguage: false },
        },
      },
      lockAdditionalFields: [],
    },
  });

  if (!token.name) throw new Error("Token response had no name");

  return {
    wsUrl: liveWsUrl(token.name),
    setup: buildTranslateSetup(targetLanguageCode),
    expireTime,
  };
}
