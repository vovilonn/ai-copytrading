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
const MEDIA_ROOT = path.join(REPO_ROOT, 'var', 'media')

@Controller('media')
export class MediaController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const media = await this.channels.getMedia(id)
    if (!media) throw new NotFoundException()

    // storage_path пишет только воркер, но отдавать файл наружу по значению из БД без проверки
    // контейнмента нельзя: одна кривая миграция или ручной UPDATE — и /api/media/:id читает /etc/passwd.
    // Абсолютные пути и "выход" через ".." отклоняются одинаково — единственный путь наружу закрыт.
    const relative = media.storagePath.replace(/^var[/\\]media[/\\]/, '')
    const absPath = path.resolve(MEDIA_ROOT, relative)
    if (absPath !== MEDIA_ROOT && !absPath.startsWith(MEDIA_ROOT + path.sep)) throw new NotFoundException()

    try {
      await access(absPath)
    } catch {
      throw new NotFoundException()
    }

    res.setHeader('Content-Type', media.mediaType)
    createReadStream(absPath).pipe(res)
  }
}
