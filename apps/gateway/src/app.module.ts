// Gateway Nest module. Registers the silkweave MCP adapter (provisioning tools under /mcp) and wires the
// CdpGatewayService as a factory provider — its one ctor arg (the absolute profiles root) isn't a Nest
// provider, so it's supplied via useFactory. The raw-WS CDP mux is NOT a Nest concern; main.ts binds it to
// the underlying http.Server after boot (PRD §6).

import { Module } from '@nestjs/common'
import { SilkweaveModule } from '@silkweave/nestjs'
import { mcp } from '@silkweave/nestjs/mcp'
import { GatewayController } from './gateway.controller.ts'
import { CdpGatewayService } from './gateway.service.ts'
import { profilesRoot } from './paths.ts'

@Module({
  imports: [
    SilkweaveModule.forRoot({
      silkweave: {
        name: 'chromatrix-gateway',
        description: 'chromatrix CDP orchestration gateway — identity/tab provisioning + takeover',
        version: '0.1.0',
      },
      // Provisioning-only MCP surface (PRD §5): create/start identities, allocate/release scoped tabs,
      // health, start-takeover. Agents drive raw CDP over the URL allocate-tab returns, not over /mcp.
      adapters: [mcp({ basePath: '/mcp' })],
    }),
  ],
  controllers: [GatewayController],
  providers: [{ provide: CdpGatewayService, useFactory: () => new CdpGatewayService(profilesRoot()) }],
  exports: [CdpGatewayService],
})
export class AppModule {}
