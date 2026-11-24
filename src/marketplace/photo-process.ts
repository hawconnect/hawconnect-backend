import sharp from 'sharp'

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export type ProcessedPhoto = {
    data: Buffer
    contentType: 'image/jpeg' | 'image/webp'
}

function detect(b: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'jpeg'
    if (
        b.length >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
            (v, i) => b[i] === v
        )
    )
        return 'png'
    if (
        b.length >= 12 &&
        Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' &&
        Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP'
    )
        return 'webp'
    return null
}

export async function processPhoto(bytes: Uint8Array): Promise<ProcessedPhoto> {
    if (bytes.length > MAX_PHOTO_BYTES) throw Error('PhotoTooLarge')
    const kind = detect(bytes)
    if (!kind) throw Error('InvalidPhoto')
    try {
        const image = sharp(bytes, { limitInputPixels: 50_000_000 })
            .rotate()
            .resize({
                width: 1600,
                height: 1600,
                fit: 'inside',
                withoutEnlargement: true
            })
        if (kind === 'jpeg')
            return {
                data: await image.jpeg({ quality: 82 }).toBuffer(),
                contentType: 'image/jpeg'
            }
        return {
            data: await image.webp({ quality: 82 }).toBuffer(),
            contentType: 'image/webp'
        }
    } catch {
        throw Error('InvalidPhoto')
    }
}
