import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const SYSTEM_PROMPT = `You are Quantbrowse AI, a smart browsing assistant integrated into a Chrome extension. You are given a user command and the extracted text content of the active webpage. Your job is to analyze the page content and provide a concise, accurate, and actionable response based on the user's request.

Guidelines:
- Be direct and concise. Avoid unnecessary filler phrases.
- When summarizing, capture the key points in a few sentences or a short bulleted list.
- When extracting data (prices, links, names, etc.), present it in a clean, structured format.
- If the page content is insufficient to fulfill the request, say so clearly and suggest what the user can do.
- Never fabricate information that is not present in the provided page content.
- Format your response using plain text or simple markdown (bold, bullets) for readability inside the extension popup.`;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  return new OpenAI({ apiKey });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, domContent } = body as {
      prompt?: string;
      domContent?: string;
    };

    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      return NextResponse.json(
        { error: "A non-empty 'prompt' field is required." },
        { status: 400 }
      );
    }

    if (
      !domContent ||
      typeof domContent !== "string" ||
      domContent.trim() === ""
    ) {
      return NextResponse.json(
        { error: "A non-empty 'domContent' field is required." },
        { status: 400 }
      );
    }

    const openai = getOpenAIClient();

    if (!openai) {
      return NextResponse.json(
        {
          error:
            "OPENAI_API_KEY is not configured on the server. Please set it before using the AI endpoint.",
        },
        { status: 500 }
      );
    }

    const truncatedDom = domContent.slice(0, 12000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `User Command: ${prompt.trim()}\n\n--- Page Content ---\n${truncatedDom}`,
        },
      ],
      max_tokens: 1024,
      temperature: 0.3,
    });

    const aiResponse =
      completion.choices[0]?.message?.content?.trim() ??
      "No response generated.";

    return NextResponse.json({ result: aiResponse });
  } catch (error: unknown) {
    console.error("[/api/browse] Error:", error);

    if (error instanceof OpenAI.APIError && error.status === 401) {
      return NextResponse.json(
        { error: "Invalid OpenAI API key. Please check your configuration." },
        { status: 500 }
      );
    }

    if (
      error instanceof OpenAI.APIError &&
      (error.status === 429 || error.code === "insufficient_quota")
    ) {
      return NextResponse.json(
        {
          error:
            "OpenAI rate limit or quota exceeded. Please try again later.",
        },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: "An internal server error occurred. Please try again." },
      { status: 500 }
    );
  }
}
