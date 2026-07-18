import type { AnyTRPCRootTypes, TRPCBuiltRouter, TRPCMutationProcedure, TRPCQueryProcedure, TRPCSubscriptionProcedure } from '@trpc/server'

type TrpcRootTypes = {
  ctx: object
  meta: object
  errorShape: unknown
  transformer: false
} & AnyTRPCRootTypes

export type AppRouter = TRPCBuiltRouter<TrpcRootTypes, {
  gatewayCreateIdentity: TRPCMutationProcedure<{
    meta: object
    input: {
      id: string
    }
    output: unknown
  }>
  gatewayStartIdentity: TRPCMutationProcedure<{
    meta: object
    input: {
      id: string
      headless?: boolean | undefined
    }
    output: unknown
  }>
  gatewayStopIdentity: TRPCMutationProcedure<{
    meta: object
    input: {
      id: string
    }
    output: unknown
  }>
  gatewayListSessions: TRPCQueryProcedure<{
    meta: object
    input: {}
    output: unknown
  }>
  gatewayAllocateTab: TRPCMutationProcedure<{
    meta: object
    input: {
      identity: string
      agentId: string
      url?: string | undefined
    }
    output: unknown
  }>
  gatewayReleaseTab: TRPCMutationProcedure<{
    meta: object
    input: {
      identity: string
      targetId: string
    }
    output: unknown
  }>
  gatewayHealth: TRPCMutationProcedure<{
    meta: object
    input: {
      identity: string
    }
    output: unknown
  }>
  gatewayStartTakeover: TRPCMutationProcedure<{
    meta: object
    input: {
      identity: string
    }
    output: unknown
  }>
}>
