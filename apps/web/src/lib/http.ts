import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
export function getCorrelationId(req: NextRequest): string {
  return req.headers.get("X-Correlation-Id") ?? randomUUID();
}
export function errorBody(status: number, code: string, detail: string, correlation_id: string) {
  return { type: "about:blank", title: code, status, code, detail, correlation_id };
}
