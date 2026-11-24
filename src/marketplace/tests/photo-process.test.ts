import { expect, test } from 'bun:test'
import sharp from 'sharp'
import { processPhoto } from '../photo-process'

const jpegWithExif = () =>
    sharp({
        create: {
            width: 64,
            height: 48,
            channels: 3,
            background: { r: 200, g: 10, b: 10 }
        }
    })
        .withExif({ IFD0: { Copyright: 'secret-owner' } })
        .jpeg()
        .toBuffer()

test('strips EXIF from JPEG and keeps the type', async () => {
    const input = await jpegWithExif()
    expect((await sharp(input).metadata()).exif).toBeDefined()
    const out = await processPhoto(input)
    expect(out.contentType).toBe('image/jpeg')
    expect((await sharp(out.data).metadata()).exif).toBeUndefined()
    expect(out.data.includes(Buffer.from('secret-owner'))).toBe(false)
})

test('resizes a large PNG to at most 1600px and emits WebP', async () => {
    const input = await sharp({
        create: {
            width: 4000,
            height: 1000,
            channels: 3,
            background: { r: 0, g: 0, b: 255 }
        }
    })
        .png()
        .toBuffer()
    const out = await processPhoto(input)
    expect(out.contentType).toBe('image/webp')
    const meta = await sharp(out.data).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(1600)
    expect(meta.height).toBe(400)
})

test('rejects text disguised as an image', async () => {
    await expect(
        processPhoto(Buffer.from('hello, not an image'))
    ).rejects.toThrow('InvalidPhoto')
})

test('rejects GIF', async () => {
    const gif = await sharp({
        create: {
            width: 4,
            height: 4,
            channels: 3,
            background: { r: 1, g: 1, b: 1 }
        }
    })
        .gif()
        .toBuffer()
    await expect(processPhoto(gif)).rejects.toThrow('InvalidPhoto')
})

test('rejects oversize input', async () => {
    await expect(
        processPhoto(new Uint8Array(5 * 1024 * 1024 + 1))
    ).rejects.toThrow('PhotoTooLarge')
})
