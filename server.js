import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { z } from 'zod';
import { ALFRED_SYSTEM_PROMPT } from './alfredPrompt.js';

const app = express();
const port = Number(process.env.PORT || 8787);

if (!process.env.OPENAI_API_KEY) {
  console.warn('WARNING: OPENAI_API_KEY is missing. Add it to .env before using /api/alfred/chat.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.ALFRED_MODEL || 'gpt-5.5';

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
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { message, context } = parsed.data;

  try {
    const input = JSON.stringify({
      userMessage: message,
      phoneContext: context || { recentNotifications: [] }
    });

    // Uses the OpenAI Responses API. Keep the key on this server only.
    const response = await openai.responses.create({
      model,
      instructions: ALFRED_SYSTEM_PROMPT,
      input,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_object' } }
    });

    const raw = response.output_text;
    const json = JSON.parse(raw);
    const validated = ActionResponse.safeParse(json);

    if (!validated.success) {
      return res.json({
        reply: "I understood you, but my action format failed. Please repeat that command.",
        action: { name: 'no_action', args: {} },
        requiresConfirmation: false,
        debug: { raw }
      });
    }

    return res.json(validated.data);
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