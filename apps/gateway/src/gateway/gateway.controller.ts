// Gateway management controller — the provisioning surface (PRD §5: MCP is provisioning-ONLY; agents then
// drive raw CDP over the scoped URL an allocateTab hands back). Each action is a REST route under /api, a
// tRPC procedure (the web dashboard's typed client), and — where it provisions — an @Mcp tool for agents. It
// carries no CDP traffic: that goes over the raw-WS mux mounted outside Nest (see cdp/cdp-upgrade.ts).

import { Body, Controller, Get, Post } from '@nestjs/common'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { CdpGatewayService } from './gateway.service.ts'
import { AllocateTabDto, IdentityIdDto, IdentityRefDto, ReleaseTabDto, StartIdentityDto } from './dto.ts'

@Controller('api')
export class GatewayController {
  constructor(private readonly gateway: CdpGatewayService) {}

  @Post('identity')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'create-identity' })
  createIdentity(@Body() body: IdentityIdDto) {
    return this.gateway.createIdentity(body.id)
  }

  @Post('identity/start')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'start-identity' })
  async startIdentity(@Body() body: StartIdentityDto) {
    return this.gateway.startIdentity(body.id, { headless: body.headless })
  }

  @Post('identity/stop')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'stop-identity' })
  async stopIdentity(@Body() body: IdentityIdDto) {
    await this.gateway.stopIdentity(body.id)
    return { id: body.id, stopped: true }
  }

  @Get('sessions')
  @Trpc()
  @Mcp({ name: 'list-sessions' })
  listSessions() {
    return { sessions: this.gateway.listSessions() }
  }

  @Post('tab/allocate')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'allocate-tab' })
  async allocateTab(@Body() body: AllocateTabDto) {
    return this.gateway.allocateTab(body.identity, body.agentId, { url: body.url })
  }

  @Post('tab/release')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'release-tab' })
  async releaseTab(@Body() body: ReleaseTabDto) {
    await this.gateway.releaseTab(body.identity, body.targetId)
    return { identity: body.identity, targetId: body.targetId, released: true }
  }

  @Post('health')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'health' })
  async health(@Body() body: IdentityRefDto) {
    return this.gateway.health(body.identity)
  }

  @Post('takeover/start')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'start-takeover' })
  startTakeover(@Body() body: IdentityRefDto) {
    // Provisioning returns the human-facing viewer URL (the SPA's takeover route); the screencast itself
    // rides the raw-WS /takeover/<id>/ws route the SPA connects to.
    if (!this.gateway.isRunning(body.identity)) {
      throw new Error(`identity "${body.identity}" is not running — startIdentity first`)
    }
    return { identity: body.identity, viewerUrl: `${this.gateway.publicHttpOrigin()}/#/takeover/${body.identity}` }
  }
}
