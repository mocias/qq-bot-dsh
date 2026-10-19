/**
 * Embedded runtime skill definition.
 *
 * The plugin registers the `memory` skill through `ctx.skills.register()`,
 * so the operating protocol (remember / recall / consolidate / forget +
 * bootstrap) ships with the plugin and does not depend on a filesystem
 * skill file. Project-level skills (e.g. `<project>/.dsh/skills/memory`)
 * still outrank this runtime registration, so a user can override the
 * protocol locally.
 *
 * The instruction body lives in `skills/memory.md` next to this package.
 *
 * @module dsh-plugin-memory/skill
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MEMORY_SKILL_NAME = 'memory'

export const MEMORY_SKILL_DESCRIPTION =
  '长期记忆技能：按指引读写记忆库（SOUL.md 人格、MEMORY.md 协议、index.md 目录、log.md 时间线），执行 remember / recall / consolidate / forget，会话收尾做 digest 沉淀；记忆为可迁移的 markdown。'

export const MEMORY_SKILL_WHEN_TO_USE =
  '每次会话开始（boot recall，配合插件自动注入的 boot 块）、用户说"记住/忘掉/你还记得"、学到关于用户或自身的持久事实/偏好/决策、会话收尾 digest 沉淀、用户要求 lint / 导出 / 迁移 / 打包记忆时。'

let cached = undefined

/**
 * Read the instruction body shipped with the package.
 * @returns {string} skill instruction markdown
 */
export function memorySkillContent(options = {}) {
  if (cached === undefined) {
    const url = new URL('../skills/memory.md', import.meta.url)
    try {
      cached = readFileSync(fileURLToPath(url), 'utf8')
    } catch {
      cached = ''
    }
  }
  if (options.digestMode === 'conversation-idle' || options.digestMode === 'compaction-idle') return cached
    .replace('会话中或收尾时，把值得持久化的内容', '收到空闲记忆整理任务或用户明确要求时，把值得持久化的内容')
    .replace(/^- \*\*digest 是强制义务[^\r\n]*/m,
      '- **后台整理时机**：普通聊天过程中和每轮回复后不自行启动整理。只在收到【空闲记忆整理】任务时，整理该任务覆盖的历史资料和近期对话；触发条件、空闲时长和去重由插件负责。先保存页面、index.md、log.md，再追加任务指定的完成标记。用户回来时立即让路，不发整理通知。用户明确要求记住、忘记或修正时可立即执行。')
  return cached
}
