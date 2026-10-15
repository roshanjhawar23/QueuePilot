import type { HttpEvent, HttpResult } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

export interface RouteContext {
  event: HttpEvent;
  requestId: string;
  log: Logger;
}

export type RouteHandler = (ctx: RouteContext) => Promise<HttpResult>;
