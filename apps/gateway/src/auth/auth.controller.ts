// Browser session routes. These exist ONLY for the dashboard: a browser cannot attach an `Authorization`
// header to an `<img src>` (the tab-card screenshot poll) or to `new WebSocket()` (takeover), so it trades the
// token for a cookie once and the browser carries it automatically thereafter.
//
// Programmatic clients - the CLI over MCP, agents, curl - never touch these routes; they send
// `Authorization: Bearer <token>` on every request and hold no session.
//
// Deliberately neither @Trpc nor @Mcp: this is transport-level session management for one specific client,
// not part of the provisioning surface. Exposing "log in" as an MCP tool would be nonsense.

import { Body, Controller, Get, HttpException, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AUTH_COOKIE, Public, tokenFromRequest, verifyAccessToken } from './auth.ts'
import { clearLoginFailures, loginRetryAfter, recordLoginFailure } from './login-throttle.ts'
import { AccessTokenDto } from '../gateway/dto.ts'

/**
 * A year. The token itself never expires (it is rotated by editing config, not by elapsed time), so a short
 * cookie lifetime would only log the operator out of their own dashboard for no security gain - an attacker
 * with the cookie has the token, and the cookie expiring does not un-leak it.
 */
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

@Controller('api/auth')
export class AuthController {
  /**
   * Trade the access token for a session cookie.
   *
   * `httpOnly` so page scripts can't read it back out - this token can drive a fleet of signed-in browsers,
   * so it should never be reachable from JS. `sameSite: 'lax'` blocks cross-site form posts from riding the
   * session while leaving normal navigation to the dashboard working. `secure` is set only when the request
   * actually arrived over TLS: hardcoding it would break `http://127.0.0.1:8830` in dev (the browser silently
   * drops a Secure cookie on plain http), and hardcoding it off would leak the cookie over a plaintext hop in
   * prod. `req.protocol` reflects `X-Forwarded-Proto` when Express is configured to trust the proxy.
   */
  @Post('login')
  @Public()
  login(@Body() body: AccessTokenDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Throttle check first, so a locked-out caller learns nothing about the guess it just made - and a
    // correct token during the cooldown is refused too (the operator still has Bearer auth, which never
    // touches this route). Keyed by socket address; see login-throttle.ts for why not `req.ip`.
    const throttleKey = req.socket.remoteAddress ?? 'unknown'
    const retryAfter = loginRetryAfter(throttleKey)
    if (retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter))
      throw new HttpException('too many failed login attempts - try again shortly', HttpStatus.TOO_MANY_REQUESTS)
    }
    if (!verifyAccessToken(body.token)) {
      recordLoginFailure(throttleKey)
      throw new UnauthorizedException('invalid access token')
    }
    clearLoginFailures(throttleKey)
    res.cookie(AUTH_COOKIE, body.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    })
    return { authenticated: true }
  }

  @Post('logout')
  @Public()
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/' })
    return { authenticated: false }
  }

  /**
   * Whether the caller is already authenticated. Public and 200-on-failure by design: the dashboard calls
   * this on load to decide between the login screen and the app, and a 401 there would be an error to handle
   * rather than an answer to a question.
   */
  @Get('status')
  @Public()
  status(@Req() req: Request) {
    return { authenticated: verifyAccessToken(tokenFromRequest(req)) }
  }
}
