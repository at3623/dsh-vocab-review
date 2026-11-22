/**
 * QQ ↔ DSH-session bridge for dsh-vocab-review.
 *
 * The QQ client receives one message; this bridge decides whether the plugin can
 * answer it directly (commands: start/stop/stats) or whether the model must be
 * involved (grading an answer, reading an image). Model turns are submitted with
 * `sessionController.prompt` on the selected DSH session, the committed
 * assistant text is relayed back to the same QQ chat, and the plugin's own loop
 * continues pushing the next question.
 *
 * One QQ prompt at a time: messages are queued so a fast typist cannot interleave
 * two turns on the same session.
 */
import { randomUUID } from 'node:crypto'

export const QQ_PREFIX = '[QQ]'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The model must not add a Q line while the plugin pushes questions itself. */
function stripQuestionLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*Q\s*[:：]/iu.test(line))
    .join('\n')
    .trim()
}

function mediaTypeOf(attachment) {
  const declared = String(attachment.contentType || '').toLowerCase()
  if (IMAGE_TYPES.has(declared)) return declared
  const name = String(attachment.filename || '').toLowerCase()
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

export function createQqBridge(options) {
  const ctx = options.ctx
  const logger = options.logger || null
  const client = options.client
  const resolveSession = options.resolveSession
  const onCommand = options.onCommand
  const send = options.send
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000
  const seen = new Set()
  const seenOrder = []
  let queue = Promise.resolve()

  function remember(messageId) {
    seen.add(messageId)
    seenOrder.push(messageId)
    while (seenOrder.length > 500) {
      const oldest = seenOrder.shift()
      seen.delete(oldest)
    }
  }

  function accept(message) {
    if (!message || !message.messageId || !message.targetId) return false
    if (seen.has(message.messageId)) return false
    remember(message.messageId)
    queue = queue
      .then(() => dispatch(message))
      .catch((error) => logger?.warn?.(`dsh-vocab-review: [qq] message failed: ${String(error && error.message ? error.message : error)}`))
    return true
  }

  async function dispatch(message) {
    const text = String(message.content || '').trim()
    const image = (message.attachments || []).find((item) => /^image\//iu.test(item.contentType || '') || /\.(?:png|jpe?g|webp|gif)$/iu.test(item.filename || ''))
    if (!text && !image) {
      await send(message, '目前只支持文字和图片消息。')
      return
    }
    if (text && typeof onCommand === 'function') {
      const handled = await onCommand(text, message)
      if (handled) return
    }
    const sessionId = typeof resolveSession === 'function' ? resolveSession() : ''
    if (!sessionId) {
      await send(message, '插件还没有可用的对话：请先在 DSH 里打开或新建一个会话，然后回到 QQ 重试。')
      return
    }
    let content
    if (image) {
      const parts = await imageParts(image)
      if (!parts) {
        await send(message, '这张图片的格式不支持（只支持 png / jpg / webp / gif），或者太大了。')
        return
      }
      content = parts
      // Tell the plugin that this turn came from a QQ image, so an import tool
      // call stores words without starting the review loop.
      try {
        options.onImage?.()
      } catch {
        /* the plugin flag is advisory */
      }
    } else {
      content = [{ type: 'text', text: `${QQ_PREFIX} ${text}` }]
    }
    const answer = await promptAndWait(sessionId, content)
    if (answer) await send(message, answer)
  }

  async function imageParts(attachment) {
    let media = null
    try {
      media = await client.downloadImage(attachment.url)
    } catch (error) {
      logger?.warn?.(`dsh-vocab-review: [qq] image download failed: ${String(error && error.message ? error.message : error)}`)
      return null
    }
    const declared = mediaTypeOf(attachment)
    const mediaType = IMAGE_TYPES.has(media.mediaType) ? media.mediaType : declared
    if (!IMAGE_TYPES.has(mediaType)) return null
    return [
      {
        type: 'text',
        text: `${QQ_PREFIX} 用户通过 QQ 发来一张图片。如果它是有划线的单词表，请调用 vocab_import 导入划线词（原形、逗号分隔）；如果它是没有划线的文章/阅读材料，请调用 vocab_import_article 按考试高频词挑词，不要整篇导入。图片只用于识别，不会被保存。导入后用一两句话告诉用户结果。复习不要自动开始，也不要输出任何 Q: 行——用户在 QQ 里发「开始背单词」时才重新开始复习。`,
      },
      { type: 'image', mediaType, data: media.data, name: attachment.filename || 'qq-image' },
    ]
  }

  function promptAndWait(sessionId, content) {
    return new Promise((resolve) => {
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.prompt !== 'function') {
        resolve('')
        return
      }
      const requestId = `vocab-review-qq-${randomUUID()}`
      let armed = false
      let answer = ''
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          off()
        } catch {
          /* already disposed */
        }
        resolve(value)
      }
      const timer = setTimeout(() => finish(''), timeoutMs)
      timer.unref?.()
      const off = ctx.on('session/event', (session, event) => {
        if (!session || session.id !== sessionId || !event) return
        if (event.type === 'user/message') {
          const text = messageText(event.data)
          if (text.trim().startsWith(QQ_PREFIX)) {
            armed = true
            answer = ''
          }
          return
        }
        if (!armed) return
        if (event.type === 'assistant/message') {
          const text = messageText(event.data && event.data.message)
          if (text.trim()) answer = text
          return
        }
        if (event.type === 'turn/end') {
          finish(stripQuestionLines(answer))
        }
      })
      Promise.resolve()
        .then(() =>
          controller.prompt(
            {
              requestId,
              sessionId,
              mode: 'queue',
              content,
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            new AbortController().signal,
          ),
        )
        .catch((error) => {
          logger?.warn?.(
            `dsh-vocab-review: [qq] prompt failed: ${String(error && error.message ? error.message : error)}`,
          )
          finish('')
        })
    })
  }

  return { accept, pending: () => seenOrder.length }
}
