import { expect, it } from 'bun:test'
import { createCanteensQuery, createFoodQuery } from '../../queries/food'
import { combineFoodWeeks, createFoodService } from '../../utils/food-refresh'

it('coalesces concurrent refresh and preserves last-good data after failure', async () => {
    let requests = 0
    let fail = false
    let disk: unknown = null
    const service = createFoodService({
        fetchSnapshot: async () => {
            requests++
            if (fail) throw Error('offline')
            return {
                foodData: [{ timestamp: '2026-10-19', meals: [] }],
                translationFallback: false,
                errors: []
            }
        },
        read: async () => disk,
        write: async (value) => {
            disk = value
        },
        now: () => new Date('2026-10-19T12:00:00Z')
    })
    await Promise.all([service.refresh(), service.refresh()])
    expect(requests).toBe(1)
    fail = true
    await service.refresh()
    const result = await service.get()
    expect(result.stale).toBe(true)
    expect(result.updatedAt).toBe('2026-10-19T12:00:00.000Z')
    expect(result.foodData).toHaveLength(1)
})
it('restores persisted data after a process restart', async () => {
    const disk = {
        foodData: [{ timestamp: '2026-10-19', meals: [] }],
        translationFallback: false,
        errors: [],
        updatedAt: '2026-10-19T12:00:00Z'
    }
    const service = createFoodService({
        fetchSnapshot: async () => {
            throw Error()
        },
        read: async () => disk,
        write: async () => {},
        now: () => new Date('2026-10-19T13:00:00Z')
    })
    expect((await service.get()).foodData).toHaveLength(1)
})
it('does not publish a candidate when durable storage fails', async () => {
    const service = createFoodService({
        fetchSnapshot: async () => ({
            foodData: [],
            translationFallback: false,
            errors: []
        }),
        read: async () => null,
        write: async () => {
            throw Error('disk full')
        },
        now: () => new Date()
    })
    await service.refresh()
    expect((await service.get()).available).toBe(false)
})

it('merges published weeks in date order and deduplicates overlapping days', () => {
    const day = { timestamp: '2026-10-23', meals: [] }
    const result = combineFoodWeeks(
        { foodData: [day], translationFallback: false, errors: [] },
        {
            foodData: [{ timestamp: '2026-10-26', meals: [] }, day],
            translationFallback: true,
            errors: []
        }
    )
    expect(result.foodData.map((day) => day.timestamp)).toEqual([
        '2026-10-23',
        '2026-10-26'
    ])
    expect(result.translationFallback).toBe(true)
})

it('retains independent English menus when combining current and next weeks', () => {
    const current = {
        foodData: [],
        englishFoodData: [{ timestamp: '2026-10-23', meals: [] }],
        translationFallback: false,
        errors: []
    }
    const next = {
        foodData: [],
        englishFoodData: [{ timestamp: '2026-10-26', meals: [] }],
        translationFallback: false,
        errors: []
    }
    expect(
        combineFoodWeeks(current, next).englishFoodData?.map(
            (day) => day.timestamp
        )
    ).toEqual(['2026-10-23', '2026-10-26'])
})

const canteen = (id: string) => ({
    id,
    sourceId: '1',
    name: id,
    address: ['Street 1'],
    general: [{ days: 'Montag', time: '08:00 - 14:00' }],
    distribution: []
})

it('canteens query returns the cached canteens for the language', async () => {
    const service = createFoodService({
        fetchSnapshot: async () => ({
            foodData: [],
            translationFallback: false,
            errors: [],
            canteens: [canteen('BergedorfMensa')],
            englishCanteens: [canteen('EnglishMensa')]
        }),
        read: async () => null,
        write: async () => {},
        now: () => new Date()
    })
    const query = createCanteensQuery(service)
    expect(await query(null, {})).toEqual([canteen('BergedorfMensa')])
    expect(await query(null, { language: 'en' })).toEqual([
        canteen('EnglishMensa')
    ])
    await expect(query(null, { language: 'fr' })).rejects.toThrow()
})

it('keeps the last good canteens when a refresh fails', async () => {
    let fail = false
    const service = createFoodService({
        fetchSnapshot: async () => {
            if (fail) throw Error('offline')
            return {
                foodData: [],
                translationFallback: false,
                errors: [],
                canteens: [canteen('BergedorfMensa')]
            }
        },
        read: async () => null,
        write: async () => {},
        now: () => new Date()
    })
    await service.refresh()
    fail = true
    await service.refresh()
    expect((await service.get()).canteens).toEqual([canteen('BergedorfMensa')])
})

it('merges canteens across weeks without duplicates', () => {
    const base = { foodData: [], translationFallback: false, errors: [] }
    const result = combineFoodWeeks(
        { ...base, canteens: [canteen('A')] },
        { ...base, canteens: [canteen('A'), canteen('B')] }
    )
    expect(result.canteens?.map((c) => c.id)).toEqual(['A', 'B'])
})

it('legacy meal without icons is served with icons null', async () => {
    const meal = (id: string, icons?: string[]) => ({
        id,
        restaurant: 'BergedorfMensa',
        ...(icons ? { icons } : {})
    })
    const service = createFoodService({
        fetchSnapshot: async () => ({
            foodData: [
                {
                    timestamp: '2026-10-19',
                    meals: [
                        meal('old'),
                        meal('new', ['pork']),
                        meal('none', [])
                    ]
                }
            ],
            translationFallback: false,
            errors: []
        }),
        read: async () => null,
        write: async () => {},
        now: () => new Date()
    })
    const result = await createFoodQuery(service as never)(null, {
        locations: ['BergedorfMensa']
    })
    expect(result.foodData[0].meals.map((m) => m.icons)).toEqual([
        null,
        ['pork'],
        []
    ])
})
