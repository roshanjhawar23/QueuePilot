import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerResult } from 'aws-lambda';

/**
 * HTTP API Lambda authorizer (simple response mode).
 *
 * Expects:  Authorization: Bearer <demo token>
 * The expected token comes from the DEMO_TOKEN environment variable, which the SAM template
 * fills from a NoEcho CloudFormation parameter you type at deploy time. It is never in the code
 * or the frontend build. API Gateway caches the result for 5 minutes per token, so this function
 * runs rarely.
 *
 * Both values are hashed first so the comparison is constant-time even when lengths differ.
 */
function digest(v: string): Buffer {
  return createHash('sha256').update(v).digest();
}

export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || expectedToken.length < 12) return false; // fail closed if misconfigured
  if (!authorizationHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!.trim()), digest(expectedToken));
}

export const handler = async (event: APIGatewayRequestAuthorizerEventV2): Promise<APIGatewaySimpleAuthorizerResult> => {
  const header = event.headers?.authorization ?? event.identitySource?.[0];
  const ok = isAuthorized(header, process.env.DEMO_TOKEN);
  if (!ok) console.log(JSON.stringify({ level: 'warn', msg: 'authorization denied', fn: 'authorizer', route: event.routeKey }));
  return { isAuthorized: ok };
};
