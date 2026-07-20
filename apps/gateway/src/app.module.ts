// Gateway Nest module. Registers the silkweave adapters (tRPC procedures under /trpc, MCP tools under /mcp,
// and the AppRouter typegen the web app consumes) plus ServeStatic for the built SPA in prod. The
// CdpGatewayService is a factory provider — its one ctor arg (the absolute profiles root) isn't a Nest
// provider, so it's supplied via useFactory. The raw-WS CDP mux is NOT a Nest concern; main.ts binds it to
// the underlying http.Server after boot (PRD §6).

import { join } from 'node:path'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ServeStaticModule } from '@nestjs/serve-static'
import { SilkweaveModule } from '@silkweave/nestjs'
import { mcp } from '@silkweave/nestjs/mcp'
import { trpc } from '@silkweave/nestjs/trpc'
import { typegen } from '@silkweave/nestjs/typegen'
import { GatewayController } from './gateway/gateway.controller.ts'
import { CdpGatewayService } from './gateway/gateway.service.ts'
import { AccessTokenGuard, verifyAccessToken } from './auth/auth.ts'
import { AuthController } from './auth/auth.controller.ts'
import { profilesRoot, repoRoot } from './common/paths.ts'

/**
 * Token check for the silkweave transports. Shaped as silkweave's `verifyToken` contract (an `AuthInfo` on
 * success, `undefined` on failure) but backed by the same constant-time comparison the Nest guard uses — one
 * credential, one comparison, three call sites.
 */
const verifyToken = async (token: string) =>
  verifyAccessToken(token) ? { token, clientId: 'chromatrix-operator', scopes: ['operator'] } : undefined

@Module({
  imports: [
    // Prod: serve the built SPA (apps/web/dist) on the same port as the API. In dev the dev-proxy in
    // bootstrap.ts handles non-API routes (proxied to Vite) BEFORE this runs, and a missing dist just
    // serves nothing — so this is safe to always register. The API namespaces are excluded so they 404 as
    // their own handlers, not index.html. (`/cdp` + the takeover WS are raw upgrades — never HTTP GETs — so
    // ServeStatic never sees them.)
    ServeStaticModule.forRoot({
      rootPath: join(repoRoot(), 'apps', 'web', 'dist'),
      exclude: ['/api', '/api/{*path}', '/trpc', '/trpc/{*path}', '/mcp', '/mcp/{*path}'],
    }),
    SilkweaveModule.forRoot({
      silkweave: {
        name: 'chromatrix-gateway',
        description: 'chromatrix CDP orchestration gateway — identity/tab provisioning + takeover',
        version: '0.1.0',
      },
      adapters: [
        // @Trpc()-decorated controller methods → tRPC procedures under /trpc (the web app's typed client).
        trpc({ basePath: '/trpc', auth: { required: true, verifyToken } }),
        // The same methods (where @Mcp'd) → MCP tools under /mcp. Provisioning-only surface (PRD §5): agents
        // then drive raw CDP over the scoped URL AllocateTab returns.
        //
        // Auth goes on the ADAPTER, not on the controller methods: `tools/list` is a transport-level call with
        // no controller method behind it, so a per-method guard would leave the tool catalogue readable to
        // anyone. Gating here closes discovery and invocation together.
        mcp({ basePath: '/mcp', auth: { required: true, verifyToken } }),
        // Emit the AppRouter type into the web app on every boot (committed; regenerated on boot).
        typegen({ path: join(repoRoot(), 'apps', 'web', 'src', 'generated', 'appRouter.d.ts') }),
      ],
    }),
  ],
  controllers: [GatewayController, AuthController],
  providers: [
    { provide: CdpGatewayService, useFactory: () => new CdpGatewayService(profilesRoot()) },
    // Global rather than per-controller so a route added later is protected by DEFAULT. The opposite
    // arrangement fails silently — a new provisioning route ships unauthenticated and nothing complains.
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [CdpGatewayService],
})
export class AppModule {}
