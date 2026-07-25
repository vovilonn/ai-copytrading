import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import { resolveMediaRoot } from '../config/config.schema.js'
import { ChannelsService } from './channels.service.js'

// message_media.storage_path хранится относительным ("var/media/<key>/<id>_<i>.jpg", см.
// apps/tg-ingest/src/ingest.service.ts, MEDIA_ROOT_REL), а корень на диске берём из MEDIA_ROOT —
// «N уровней вверх от import.meta.url» в прод-образе указывает мимо /app (pnpm deploy сплющивает
// apps/api/src → src), и картинки в UI переставали отдаваться. См. config.schema.ts.
const MEDIA_ROOT = resolveMediaRoot(process.env.MEDIA_ROOT)

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
