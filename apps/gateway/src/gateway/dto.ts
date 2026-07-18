// Input DTOs for the gateway's management/MCP surface. Per the silkweave MCP-tool constraint (see the gtm
// content controller note), every @Mcp input field is a concrete scalar with an @ApiProperty + class-validator
// rule — the cli/MCP proxy builds one option per field, so no nested objects or nullable unions here.

import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsOptional, IsString } from 'class-validator'

export class IdentityIdDto {
  @ApiProperty({ description: 'Identity id — lowercase slug ≤64 chars; appears in the scoped CDP URL.' })
  @IsString()
  id!: string
}

export class StartIdentityDto {
  @ApiProperty({ description: 'Identity id to launch a real Chrome for.' })
  @IsString()
  id!: string

  @ApiProperty({ required: false, description: 'Run Chrome headless (default: headed — the fidelity default).' })
  @IsOptional()
  @IsBoolean()
  headless?: boolean
}

export class AllocateTabDto {
  @ApiProperty({ description: 'Running identity to lease a tab under.' })
  @IsString()
  identity!: string

  @ApiProperty({ description: 'Opaque agent id the tab is leased exclusively to (scopes the minted CDP token).' })
  @IsString()
  agentId!: string

  @ApiProperty({ required: false, description: 'Initial URL for the new tab (default about:blank).' })
  @IsOptional()
  @IsString()
  url?: string
}

export class ReleaseTabDto {
  @ApiProperty({ description: 'Identity the tab belongs to.' })
  @IsString()
  identity!: string

  @ApiProperty({ description: 'The leased CDP targetId to release + close.' })
  @IsString()
  targetId!: string
}

export class IdentityRefDto {
  @ApiProperty({ description: 'Running identity id.' })
  @IsString()
  identity!: string
}
