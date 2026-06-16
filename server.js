import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ALFRED_SYSTEM_PROMPT } from './alfredPrompt.js';

const app = express();
const port = Number(process.env.PORT || 8787);

if (!process.env.GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is missing. Add it to Vercel Environment Variables.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.ALFRED_MODEL || 'gemini-2.5-flash-lite';

app.use(cors({ origin: process.env.ALFRED_ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

const ChatRequest = z.object({
  message: z.string().min(1).max(4000),
  context: z.object({
    recentNotifications: z.array(z.object({
      app: z.string().optional(),
      title: z.string().optional(),
      text: z.string().optional(),
      time: z.string().optional()
    })).optional()
  }).optional()
});

const ActionResponse = z.object({
  reply: z.string(),
  action: z.object({
    name: z.enum([
      'open_app',
      'go_home',
      'go_back',
      'scroll_down',
      'scroll_up',
      'summarize_notifications',
      'no_action'
    ]),
    args: z.record(z.any()).default({})
  }),
  requiresConfirmation: z.boolean().default(false)
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'alfred-backend' });
});

app.post('/api/alfred/chat', async (req, res) => {
  const parsed = ChatRequest.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.flatten()
    });
  }

  const { message, context } = parsed.data;

  try {
    const input = JSON.stringify({
      userMessage: message,
      phoneContext: context || { recentNotifications: [] }
    });

    const prompt = `${ALFRED_SYSTEM_PROMPT}

You are Alfred, a mobile phone assistant.

Return valid JSON only.
Return exactly one JSON object with this shape:
{
  "reply": "string",
  "action": {
    "name": "open_app",
    "args": {
      "appName": "youtube"
    }
  },
  "requiresConfirmation": false
}

Allowed action names:
open_app, go_home, go_back, scroll_down, scroll_up, summarize_notifications, no_action.

For open_app, use args like:
{
  "appName": "youtube"
}

Common appName values:
youtube
whatsapp
chrome
instagram
gmail
maps
camera
settings

Do not use packageName.
Do not include markdown.
Do not include code fences.
Do not include explanations outside JSON.

User request object:
${input}`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    });

    const raw = response.text;
    const json = JSON.parse(raw);
    const validated = ActionResponse.safeParse(json);

    if (!validated.success) {
      return res.json({
        reply: 'I understood you, but my action format failed. Please repeat that command.',
        action: { name: 'no_action', args: {} },
        requiresConfirmation: false,
        debug: { raw }
      });
    }

    const finalData = validated.data;

    if (finalData.action.name === 'open_app') {
      const lowerMessage = message.toLowerCase();

      const appMap = [
        { keywords: ['youtube', 'yt'], appName: 'youtube' },
        { keywords: ['whatsapp', 'whatapp', 'wa'], appName: 'whatsapp' },
        { keywords: ['chrome', 'google chrome'], appName: 'chrome' },
        { keywords: ['instagram', 'insta', 'ig'], appName: 'instagram' },
        { keywords: ['gmail', 'email'], appName: 'gmail' },
        { keywords: ['maps', 'google maps'], appName: 'maps' },
        { keywords: ['camera'], appName: 'camera' },
        { keywords: ['settings'], appName: 'settings' }
      ];

      const match = appMap.find(app =>
        app.keywords.some(keyword => lowerMessage.includes(keyword))
      );

      if (match && !finalData.action.args.appName) {
        finalData.action.args.appName = match.appName;
      }

      if (finalData.action.args.packageName && !finalData.action.args.appName) {
        const packageToApp = {
          'com.google.android.youtube': 'youtube',
          'com.whatsapp': 'whatsapp',
          'com.android.chrome': 'chrome',
          'com.instagram.android': 'instagram',
          'com.google.android.gm': 'gmail'
        };

        finalData.action.args.appName = packageToApp[finalData.action.args.packageName] || '';
        delete finalData.action.args.packageName;
      }
    }

    return res.json(finalData);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Alfred backend failed',
      message: error?.message || 'Unknown error'
    });
  }
});

export default app;

if (process.env.VERCEL !== '1') {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Alfred backend running at http://0.0.0.0:${port}`);
  });
}
