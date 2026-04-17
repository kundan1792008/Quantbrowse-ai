import { NextRequest, NextResponse } from "next/server";

type ClipPayload = {
  id: string;
  title?: string;
  url?: string;
  type?: string;
  createdAt?: number;
  tags?: Array<{ label: string; score: number }>;
};

type SyncStore = Map<string, ClipPayload>;

function getStore(): SyncStore {
  const globalStore = globalThis as typeof globalThis & {
    __qbaSyncStore?: SyncStore;
  };
  if (!globalStore.__qbaSyncStore) {
    globalStore.__qbaSyncStore = new Map();
  }
  return globalStore.__qbaSyncStore;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { clip?: ClipPayload };
    if (!body.clip?.id) {
      return NextResponse.json(
        { error: "A clip payload with an id is required." },
        { status: 400 }
      );
    }

    const store = getStore();
    store.set(body.clip.id, body.clip);

    return NextResponse.json({
      success: true,
      stored: body.clip.id,
      total: store.size,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Unable to process clip sync request." },
      { status: 500 }
    );
  }
}

export async function GET() {
  const store = getStore();
  return NextResponse.json({
    success: true,
    clips: Array.from(store.values()),
    total: store.size,
  });
}
