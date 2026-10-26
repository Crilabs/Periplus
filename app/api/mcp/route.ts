import { connection } from "next/server";
import { handleMcpRequest, methodNotAllowed } from "@/lib/mcp/handler";

// The Periplus MCP server (plan 2026-10-26-periplus-mcp): authenticated per request by a personal token, never prerendered.
export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleMcpRequest(request);
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
