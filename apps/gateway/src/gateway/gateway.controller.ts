// Gateway management controller — the provisioning surface (PRD §5: MCP is provisioning-ONLY; agents then
// drive raw CDP over the scoped URL an allocateTab hands back). Each action is a REST route under /api, a
// tRPC procedure (the web dashboard's typed client), and — where it provisions — an @Mcp tool for agents. It
// carries no CDP traffic: that goes over the raw-WS mux mounted outside Nest (see cdp/cdp-upgrade.ts).

import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { CdpGatewayService } from './gateway.service.ts'
import {
  AllocateTabDto,
  DefaultViewportDto,
  IdentityIdDto,
  IdentityRefDto,
  NavigateTabDto,
  ReleaseTabDto,
  SetViewportDto,
  StartIdentityDto,
  TabRefDto,
} from './dto.ts'

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

  /**
   * Destroy an identity: stop its Chrome, then delete its profile dir. This is the only route that discards
   * durable state — the profile dir holds the signed-in session, so there is nothing to restore afterwards.
   */
  @Post('identity/delete')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'delete-identity' })
  async deleteIdentity(@Body() body: IdentityIdDto) {
    await this.gateway.deleteIdentity(body.id)
    return { id: body.id, deleted: true }
  }

  @Get('sessions')
  @Trpc()
  @Mcp({ name: 'list-sessions' })
  async listSessions() {
    return { sessions: await this.gateway.listSessions() }
  }

  @Post('tab/allocate')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'allocate-tab' })
  async allocateTab(@Body() body: AllocateTabDto) {
    return this.gateway.allocateTab(body.identity, body.agentId, {
      url: body.url,
      width: body.width,
      height: body.height,
    })
  }

  @Post('tab/viewport')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'set-tab-viewport' })
  async setTabViewport(@Body() body: SetViewportDto) {
    // Answers with the size actually achieved, not the size requested: Chrome enforces a minimum window and
    // silently clamps, so echoing the request back would make the UI lie about the tab's real viewport.
    return this.gateway.setTabViewport(body.identity, body.targetId, body.width, body.height)
  }

  @Post('tab/navigate')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'navigate-tab' })
  async navigateTab(@Body() body: NavigateTabDto) {
    return this.gateway.navigateTab(body.identity, body.targetId, body.url)
  }

  @Post('tab/viewport/get')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'get-tab-viewport' })
  async getTabViewport(@Body() body: TabRefDto) {
    return this.gateway.getTabViewport(body.identity, body.targetId)
  }

  @Get('settings')
  @Trpc()
  @Mcp({ name: 'get-settings' })
  getSettings() {
    return this.gateway.settings()
  }

  @Post('settings/default-viewport')
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'set-default-viewport' })
  setDefaultViewport(@Body() body: DefaultViewportDto) {
    // 0×0 clears the default — the MCP tool contract forbids nullable fields, so a sentinel is how a caller
    // says "unset" without a second tool.
    const defaultViewport =
      body.width > 0 && body.height > 0 ? { width: body.width, height: body.height } : undefined
    return this.gateway.saveSettings({ ...this.gateway.settings(), defaultViewport })
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

  /**
   * Live JPEG of one tab — the dashboard's tab cards poll this so the Sessions view doubles as a monitor.
   *
   * The only route here that is neither tRPC nor MCP, on purpose: it answers with image bytes, so an `<img
   * src>` is both the simplest client and the most efficient wire format (no base64 inflation, browser-managed
   * decode). Agents have no use for it — they drive their own tabs over the scoped CDP URL.
   */
  @Get('tab/screenshot')
  @Header('Cache-Control', 'no-store')
  async screenshot(@Query('identity') identity: string, @Query('targetId') targetId: string) {
    if (!identity || !targetId) throw new NotFoundException('identity and targetId are required')
    try {
      // StreamableFile, not the raw Buffer: Nest hands a bare Buffer to res.json(), which serializes it as
      // {"type":"Buffer","data":[…]} — a valid 200 that no <img> can decode.
      return new StreamableFile(await this.gateway.captureTab(identity, targetId), { type: 'image/jpeg' })
    } catch (err) {
      // A closed tab / stopped identity is the common case under polling, not an incident: 404 lets the card
      // fall back to its placeholder without painting the error strip red on every tick.
      throw new NotFoundException(err instanceof Error ? err.message : String(err))
    }
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
