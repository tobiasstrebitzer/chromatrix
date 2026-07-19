// Input DTOs for the gateway's management/MCP surface. Per the silkweave MCP-tool constraint (see the gtm
// content controller note), every @Mcp input field is a concrete scalar with an @ApiProperty + class-validator
// rule — the cli/MCP proxy builds one option per field, so no nested objects or nullable unions here.

import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator'

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

  @ApiProperty({
    required: false,
    description: 'Content width in CSS px (min 500). Omit to use the gateway default viewport, if set.',
  })
  @IsOptional()
  @IsInt()
  width?: number

  @ApiProperty({
    required: false,
    description: 'Content height in CSS px (min 288). Omit to use the gateway default viewport, if set.',
  })
  @IsOptional()
  @IsInt()
  height?: number
}

export class SetViewportDto {
  @ApiProperty({ description: 'Identity the tab belongs to.' })
  @IsString()
  identity!: string

  @ApiProperty({ description: 'The leased CDP targetId to resize.' })
  @IsString()
  targetId!: string

  @ApiProperty({ description: 'Content width in CSS px. Clamped to a 500 px minimum by Chrome.' })
  @IsInt()
  width!: number

  @ApiProperty({ description: 'Content height in CSS px. Clamped to a 288 px minimum by Chrome.' })
  @IsInt()
  height!: number
}

export class NavigateTabDto {
  @ApiProperty({ description: 'Identity the tab belongs to.' })
  @IsString()
  identity!: string

  @ApiProperty({ description: 'The leased CDP targetId to navigate.' })
  @IsString()
  targetId!: string

  @ApiProperty({ description: 'Absolute URL to load in the tab.' })
  @IsString()
  url!: string
}

export class TabRefDto {
  @ApiProperty({ description: 'Identity the tab belongs to.' })
  @IsString()
  identity!: string

  @ApiProperty({ description: 'The leased CDP targetId.' })
  @IsString()
  targetId!: string
}

export class DefaultViewportDto {
  @ApiProperty({ description: 'Default content width in CSS px for new tabs. 0 clears the default.' })
  @IsInt()
  width!: number

  @ApiProperty({ description: 'Default content height in CSS px for new tabs. 0 clears the default.' })
  @IsInt()
  height!: number
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
