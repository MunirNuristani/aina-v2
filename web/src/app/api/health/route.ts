import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health: is the app up, and can it reach the database? Also a handy way to time Neon's cold start.
export async function GET() {
  const t0 = Date.now();
  try {
    await getPool().query("select 1");
    return NextResponse.json({ ok: true, db_ms: Date.now() - t0 });
  } catch (err) {
    console.error("health: database check failed", err);
    return NextResponse.json({ ok: false, error: "database_unavailable" }, { status: 503 });
  }
}
