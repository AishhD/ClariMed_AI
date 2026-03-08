import { GoogleGenAI, Modality, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface DiagnosticFeedback {
  summary: string;
  condition: string;
  symptoms: string[];
  bulletPoints: string[];
  recommendations: string[];
  glossary: { term: string; definition: string }[];
  questionsForDoctor: string[];
}

export async function analyzeDiagnosticDocument(input: { fileBase64?: string, mimeType?: string, text?: string }): Promise<DiagnosticFeedback> {
  const parts: any[] = [];

  if (input.fileBase64 && input.mimeType) {
    parts.push({
      inlineData: {
        data: input.fileBase64,
        mimeType: input.mimeType,
      },
    });
  }

  if (input.text) {
    parts.push({ text: `Context/Symptoms provided by user: ${input.text}` });
  }

  parts.push({
    text: "Analyze this medical diagnostic information. Provide a clear summary, a list of key findings as bullet points, a list of recommendations, a glossary of complex medical terms found in the document with simple definitions, and a list of 3-5 specific questions the user should ask their doctor. Respond in JSON format.",
  });

  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [
      {
        parts: parts,
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          condition: { type: Type.STRING, description: "The primary medical condition or diagnosis identified" },
          symptoms: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of common symptoms associated with this condition" },
          bulletPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
          glossary: { 
            type: Type.ARRAY, 
            items: { 
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING },
                definition: { type: Type.STRING }
              },
              required: ["term", "definition"]
            } 
          },
          questionsForDoctor: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["summary", "condition", "symptoms", "bulletPoints", "recommendations", "glossary", "questionsForDoctor"],
      },
    },
  });

  return JSON.parse(response.text || "{}");
}

export async function generateAudioFeedback(feedback: DiagnosticFeedback): Promise<string | undefined> {
  const glossaryText = feedback.glossary.length > 0 
    ? `Here are some terms explained: ${feedback.glossary.map(g => `${g.term}: ${g.definition}`).join('. ')}` 
    : '';
  
  const questionsText = feedback.questionsForDoctor.length > 0
    ? `You might want to ask your doctor: ${feedback.questionsForDoctor.join('. ')}`
    : '';

  const fullScript = `
    Summary: ${feedback.summary}. 
    Key findings: ${feedback.bulletPoints.join('. ')}.
    ${glossaryText}
    ${questionsText}
    Recommendations: ${feedback.recommendations.join('. ')}.
  `.replace(/[*#_~`]/g, '').replace(/\s+/g, ' ').trim();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: `Read the following medical feedback in a supportive, clear, and conversational tone: ${fullScript}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
}

export async function findSupportOrganizations(condition: string, location?: { lat: number, lng: number }) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Find support organizations, patient groups, associations or specialized clinics for ${condition}, specifically focusing on UK-based groups (like NHS resources, UK charities, or local support networks). Also, list 3-5 highly useful and reputable websites for patient information on this condition. Provide a list of names and their locations or URLs.`,
    config: {
      tools: [{ googleMaps: {} }, { googleSearch: {} }],
      toolConfig: {
        retrievalConfig: {
          latLng: location ? { latitude: location.lat, longitude: location.lng } : undefined
        }
      }
    }
  });

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  const organizations = chunks?.filter(c => c.maps).map(c => ({
    title: c.maps.title,
    uri: c.maps.uri
  })) || [];

  // Also include web search results if available
  const webResults = chunks?.filter(c => c.web).map(c => ({
    title: c.web.title,
    uri: c.web.uri
  })) || [];

  return {
    text: response.text,
    organizations: [...organizations, ...webResults]
  };
}

export async function startChatSession(feedback: DiagnosticFeedback) {
  const context = `
    You are a medical assistant helping a patient understand their diagnostic results.
    Here is the analysis of their document:
    Summary: ${feedback.summary}
    Key Findings: ${feedback.bulletPoints.join(', ')}
    Recommendations: ${feedback.recommendations.join(', ')}
    Glossary: ${feedback.glossary.map(g => `${g.term}: ${g.definition}`).join('; ')}
    
    The user will now ask follow-up questions. Be supportive, clear, and always remind them to consult their doctor for final medical decisions.
  `;

  return ai.chats.create({
    model: "gemini-3.1-pro-preview",
    config: {
      systemInstruction: context,
    },
  });
}
