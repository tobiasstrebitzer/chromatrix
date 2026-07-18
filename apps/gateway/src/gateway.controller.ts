// Gateway management controller — the provisioning surface (PRD §5: MCP is provisioning-ONLY; agents then
// drive raw CDP over the scoped URL an allocateTab hands back). Each mutating action is a REST route AND an
// @Mcp tool, so the same operation is callable by a human (cli/HTTP) or an agent (MCP). It carries no CDP
// traffic — that goes over the raw-WS mux mounted outside Nest (see cdp-upgrade.ts).

import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common'
import { Mcp } from '@silkweave/nestjs'
import { CdpGatewayService } from './gateway.service.ts'
import { takeoverViewerHtml } from './takeover.ts'
import { AllocateTabDto, IdentityIdDto, IdentityRefDto, ReleaseTabDto, StartIdentityDto } from './dto.ts'

@Controller()
export class GatewayController {
  constructor(private readonly gateway: CdpGatewayService) {}

  @Post('identity')
  @Mcp({ name: 'create-identity' })
  createIdentity(@Body() body: IdentityIdDto) {
    return this.gateway.createIdentity(body.id)
  }

  @Post('identity/start')
  @Mcp({ name: 'start-identity' })
  async startIdentity(@Body() body: StartIdentityDto) {
    return this.gateway.startIdentity(body.id, { headless: body.headless })
  }

  @Post('identity/stop')
  @Mcp({ name: 'stop-identity' })
  async stopIdentity(@Body() body: IdentityIdDto) {
    await this.gateway.stopIdentity(body.id)
    return { id: body.id, stopped: true }
  }

  @Get('sessions')
  @Mcp({ name: 'list-sessions' })
  listSessions() {
    return { sessions: this.gateway.listSessions() }
  }

  @Post('tab/allocate')
  @Mcp({ name: 'allocate-tab' })
  async allocateTab(@Body() body: AllocateTabDto) {
    return this.gateway.allocateTab(body.identity, body.agentId, { url: body.url })
  }

  @Post('tab/release')
  @Mcp({ name: 'release-tab' })
  async releaseTab(@Body() body: ReleaseTabDto) {
    await this.gateway.releaseTab(body.identity, body.targetId)
    return { identity: body.identity, targetId: body.targetId, released: true }
  }

  @Post('health')
  @Mcp({ name: 'health' })
  async health(@Body() body: IdentityRefDto) {
    return this.gateway.health(body.identity)
  }

  @Post('takeover/start')
  @Mcp({ name: 'start-takeover' })
  startTakeover(@Body() body: IdentityRefDto) {
    // Provisioning returns the human-facing viewer URL; the actual screencast rides the raw-WS route.
    if (!this.gateway.isRunning(body.identity)) {
      throw new Error(`identity "${body.identity}" is not running — startIdentity first`)
    }
    return { identity: body.identity, viewerUrl: `${this.gateway.publicHttpOrigin()}/takeover/${body.identity}` }
  }

  /** Human-facing live-view + takeover page (drives the real tab via the /takeover/<id>/ws raw-WS route). */
  @Get('takeover/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  takeoverPage(@Param('id') id: string): string {
    return takeoverViewerHtml(id)
  }
}
