import type { IncomingHttpHeaders } from 'node:http'
import {
    type ASTVisitor,
    type FragmentDefinitionNode,
    GraphQLError,
    Kind,
    type SelectionSetNode,
    type ValidationContext
} from 'graphql'

/** The app's deepest query is 5 levels; this leaves room without allowing abuse. */
export const MAX_QUERY_DEPTH = 10

/** Rejects operations nested deeper than `max` fields, fragments included. */
export function depthLimit(max: number) {
    return (context: ValidationContext): ASTVisitor => {
        const fragments = new Map<string, FragmentDefinitionNode>()
        for (const definition of context.getDocument().definitions)
            if (definition.kind === Kind.FRAGMENT_DEFINITION)
                fragments.set(definition.name.value, definition)

        const depth = (
            selectionSet: SelectionSetNode | undefined,
            visiting: Set<string>
        ): number => {
            if (!selectionSet) return 0
            let deepest = 0
            for (const selection of selectionSet.selections) {
                if (selection.kind === Kind.FIELD)
                    deepest = Math.max(
                        deepest,
                        1 + depth(selection.selectionSet, visiting)
                    )
                else if (selection.kind === Kind.INLINE_FRAGMENT)
                    deepest = Math.max(
                        deepest,
                        depth(selection.selectionSet, visiting)
                    )
                else {
                    const name = selection.name.value
                    // Cycles are reported by graphql's own NoFragmentCycles rule.
                    if (visiting.has(name)) continue
                    deepest = Math.max(
                        deepest,
                        depth(
                            fragments.get(name)?.selectionSet,
                            new Set([...visiting, name])
                        )
                    )
                }
            }
            return deepest
        }

        return {
            OperationDefinition(node) {
                if (depth(node.selectionSet, new Set()) > max)
                    context.reportError(
                        new GraphQLError('QueryTooDeep', { nodes: [node] })
                    )
            }
        }
    }
}

/** The app's queries use no aliases; this stops one request asking for a field thousands of times. */
export const MAX_ALIASES = 50

/** Rejects operations with more than `max` aliased fields, counting every fragment spread. */
export function aliasLimit(max: number) {
    return (context: ValidationContext): ASTVisitor => {
        const fragments = new Map<string, FragmentDefinitionNode>()
        for (const definition of context.getDocument().definitions)
            if (definition.kind === Kind.FRAGMENT_DEFINITION)
                fragments.set(definition.name.value, definition)

        const count = (
            selectionSet: SelectionSetNode | undefined,
            visiting: Set<string>
        ): number => {
            if (!selectionSet) return 0
            let total = 0
            for (const selection of selectionSet.selections) {
                if (total > max) break
                if (selection.kind === Kind.FIELD)
                    total +=
                        (selection.alias ? 1 : 0) +
                        count(selection.selectionSet, visiting)
                else if (selection.kind === Kind.INLINE_FRAGMENT)
                    total += count(selection.selectionSet, visiting)
                else {
                    const name = selection.name.value
                    // Cycles are reported by graphql's own NoFragmentCycles rule.
                    if (visiting.has(name)) continue
                    total += count(
                        fragments.get(name)?.selectionSet,
                        new Set([...visiting, name])
                    )
                }
            }
            return total
        }

        return {
            OperationDefinition(node) {
                if (count(node.selectionSet, new Set()) > max)
                    context.reportError(
                        new GraphQLError('TooManyAliases', { nodes: [node] })
                    )
            }
        }
    }
}

/**
 * Body limit for /graphql. Only signed-in requests carry calendar syncs
 * (up to 4.5 MB, see sync-validation); anonymous queries are tiny.
 */
export function jsonLimitFor(
    headers: Pick<IncomingHttpHeaders, 'cookie' | 'authorization'>
): string {
    return headers.cookie || headers.authorization ? '5mb' : '100kb'
}

/** Fixed-window in-memory limiter; returns false once `key` used its budget. */
export function createRateLimiter({
    max,
    windowMs,
    maxKeys = 10_000,
    now = Date.now
}: {
    max: number
    windowMs: number
    maxKeys?: number
    now?: () => number
}) {
    const entries = new Map<string, { count: number; until: number }>()
    let swept = 0
    return (key: string): boolean => {
        const time = now()
        if (time - swept >= 1000 || entries.size >= maxKeys) {
            swept = time
            for (const [k, entry] of entries)
                if (entry.until <= time) entries.delete(k)
        }
        const entry = entries.get(key)
        if (!entry || entry.until <= time) {
            if (!entry && entries.size >= maxKeys) return false
            entries.set(key, { count: 1, until: time + windowMs })
            return true
        }
        if (entry.count >= max) return false
        entry.count++
        return true
    }
}
