import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(_req: Request) {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
