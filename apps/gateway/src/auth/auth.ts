// The single access token, and the one place every surface consults to check it.
//
// There is exactly ONE credential for the whole gateway (see @chromatrix/shared/token). What varies is only
// how a client can *carry* it, and that is dictated by the transport rather than by preference:
//
//   • Authorization: Bearer …   — programmatic HTTP (CLI over MCP, curl, agents). Preferred.
//   • Cookie                    — the dashboard. `<img src>` and `new WebSocket()` cannot set headers, so a
//                                 cookie is the *only* way the browser can authenticate a screenshot poll or
//                                 the takeover socket. Set once at login.
//   • ?token= query             — raw-WS clients that are neither (a CDP client pointed at /cdp). Accepted on
//                                 the upgrade paths only, never on /api — query strings land in access logs.
//
// All three converge on `verifyAccessToken`, so there is one comparison, done in constant time, one place.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { IncomingMessage } from 'node:http'
import type { Request } from 'express'
import { ensureToken, isConfigFileExposed, tokensMatch } from '@chromatrix/shared'

/** Name of the cookie the dashboard authenticates with. */
export const AUTH_COOKIE = 'chromatrix_token'

/** Marks a route reachable without a token. Only the login/status routes should carry it. */
export const PUBLIC_ROUTE = 'chromatrix:public'
export const Public = () => SetMetadata(PUBLIC_ROUTE, true)

/**
 * The process-wide access token, resolved once at boot.
 *
 * Deliberately module state rather than a Nest provider: the raw-WS upgrade handler runs *outside* Nest's DI
 * container (PRD §6) and needs the same value, and threading a provider out to it would mean either a second
 * source of truth or passing the token through three layers that have no other reason to know it.
 */
let accessToken: string | undefined

export interface TokenInit {
  /** True when this boot minted the token — main.ts prints it once so the operator can copy it. */
  created: boolean
  /** True when the config file is readable beyond its owner; worth warning about since it holds the token. */
  exposed: boolean
}

/** Resolve (and on first run, mint + persist) the access token. Called once, before `listen`. */
export function initAccessToken(): TokenInit {
  const { token, created } = ensureToken()
  accessToken = token
  return { created, exposed: isConfigFileExposed() }
}

/** For tests/e2e that boot a gateway with a known token instead of the user's real config. */
export function setAccessToken(token: string): void {
  accessToken = token
}

export function getAccessToken(): string {
  if (!accessToken) throw new Error('access token not initialised — call initAccessToken() before listen')
  return accessToken
}

/** Constant-time check of a presented token against the gateway's. */
export function verifyAccessToken(presented: string | undefined): boolean {
  return tokensMatch(presented, accessToken)
}

/**
 * Parse a single cookie out of a raw `Cookie` header.
 *
 * Hand-rolled rather than pulling in `cookie-parser`: we need exactly one cookie, on a path that also has to
 * work for raw `IncomingMessage`s outside Express (the WS upgrades), where Nest middleware never runs.
 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/** The token a plain HTTP request carries, by either supported means. Query strings are NOT consulted here. */
export function tokenFromRequest(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return cookieValue(req.headers.cookie, AUTH_COOKIE)
}

/**
 * Present the session cookie as a bearer header, for the silkweave transports.
 *
 * `/trpc` and `/mcp` are gated inside silkweave, whose auth reads `Authorization: Bearer` and nothing else —
 * it has no concept of our cookie. The dashboard drives the gateway over tRPC and *cannot* send that header,
 * because the cookie is HttpOnly by design. Without this bridge the browser signs in successfully and then
 * 401s on its very first query.
 *
 * So this adapts the carrier, not the credential: same token, still verified in exactly one place
 * (silkweave's `verifyToken` → `verifyAccessToken`). It only fills a header that is ABSENT — a request that
 * brought its own Authorization keeps it, so a programmatic client is never silently re-authenticated as
 * whoever happened to have a cookie in the jar.
 */
export function cookieToBearer(req: IncomingMessage, _res: unknown, next: () => void): void {
  if (!req.headers.authorization) {
    const cookie = cookieValue(req.headers.cookie, AUTH_COOKIE)
    if (cookie) req.headers.authorization = `Bearer ${cookie}`
  }
  next()
}

/**
 * Guard for every Nest HTTP route. Registered globally (APP_GUARD) rather than per-controller so that a route
 * added later is protected by default — the failure mode of the opposite arrangement is a new provisioning
 * route silently shipping unauthenticated.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate, OnModuleInit {
  constructor(private readonly reflector: Reflector) {}

  onModuleInit(): void {
    getAccessToken() // fail at boot, not on the first request, if the token was never initialised
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true
    const req = context.switchToHttp().getRequest<Request>()
    if (!verifyAccessToken(tokenFromRequest(req))) {
      throw new UnauthorizedException('missing or invalid access token')
    }
    return true
  }
}
