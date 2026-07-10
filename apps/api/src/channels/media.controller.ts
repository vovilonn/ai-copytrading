import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import { ChannelsService } from './channels.service.js'

// message_media.storage_path хранится относительным ("var/media/<key>/<id>_<i>.jpg", см.
// apps/tg-ingest/src/ingest.service.ts, MEDIA_ROOT_REL) — относительно корня репозитория,
// где запускается воркер. apps/api/src/channels лежит на 4 уровня глубже корня.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

@Controller('media')
export class MediaController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const media = await this.channels.getMedia(id)
    if (!media) throw new NotFoundException()

    const absPath = path.isAbsolute(media.storagePath) ? media.storagePath : path.join(REPO_ROOT, media.storagePath)
    try {
      await access(absPath)
    } catch {
      throw new NotFoundException()
    }

    res.setHeader('Content-Type', media.mediaType)
    createReadStream(absPath).pipe(res)
  }
}
