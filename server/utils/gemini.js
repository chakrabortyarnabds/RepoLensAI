import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

export async function callGemini(prompt, { maxTokens = 8192, temperature = 0.3, maxRetries = 3 } = {}) {
  for (const modelName of MODELS) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature,
          },
        });
        const response = result.response;
        const text = response.text();
        if (text) return text;
      } catch (error) {
        const is429 = error.message?.includes('429') || error.message?.includes('quota');
        const isRetryable = is429 || error.message?.includes('500') || error.message?.includes('503');
        
        if (isRetryable && attempt < maxRetries - 1) {
          const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
          console.warn(`[Gemini] ${modelName} attempt ${attempt + 1} failed (${is429 ? '429 quota' : 'server error'}), retrying in ${waitMs}ms...`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        
        // If last attempt for this model, try next model
        if (attempt === maxRetries - 1) {
          console.warn(`[Gemini] ${modelName} exhausted ${maxRetries} retries, trying next model...`);
          break;
        }
      }
    }
  }

  console.error('[Gemini] All models and retries exhausted');
  return null;
}

export function extractJSON(text) {
  if (!text) return null;
  try {
    // Try direct parse
    return JSON.parse(text);
  } catch {
    // Try extracting from markdown code block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}
