/**
 * 把一份 NoteDraft 渲染成一条笔记的 Markdown。
 *
 * 这是整个项目里最需要「无聊」的一个模块：它不读时钟、不读文件、不联网、不用随机数，
 * 同样的输入必须永远产出逐字节相同的输出。理由很实际——如果渲染结果会漂移，
 * 那么「改模板」就变成了「重调模型」，而「两次运行结果不同」会让 Git diff 变成噪音。
 *
 * 所有时间戳、id、模型名都由调用方通过 NoteMeta 传进来。
 *
 * 本模块只负责渲染，不负责校验模型的产出。长度、数量、枚举这些约束由 core/analyze.ts
 * 在模型返回后检查（契约第 4.3 节）。这里只拒绝那些「渲染出来必然是坏文件」的输入。
 */

import type {
  Block,
  ConceptBlock,
  Language,
  ListBlock,
  NoteDraft,
  NoteMeta,
  ParamItem,
  ParamsBlock,
  StepsBlock,
  TextBlock,
  UncertainBlock,
  UncertainItem,
} from './contracts.js';

/* ------------------------------------------------------------------ *
 * 默认标题
 * ------------------------------------------------------------------ */

/**
 * 块没有给标题时用的默认标题，按笔记语言分两套。
 *
 * 英文那套不是翻译，是各自语言里本来就该用的说法。契约第 3.3 节第 1 条只列了中文，
 * 英文那套是本次实现补上的——否则一条 `language: en` 的笔记
 * 会顶着 `## 操作步骤` 这种标题。
 */
const DEFAULT_TITLES: Record<Language, Record<'steps' | 'list' | 'params' | 'uncertain', string>> = {
  zh: { steps: '操作步骤', list: '要点', params: '参数', uncertain: '待确认' },
  en: { steps: 'Steps', list: 'Key Points', params: 'Parameters', uncertain: 'Open Questions' },
};

/** `params` 表格的表头，同样分语言。 */
const PARAM_HEADERS: Record<Language, readonly [string, string, string]> = {
  zh: ['参数', '取值', '说明'],
  en: ['Parameter', 'Value', 'Note'],
};

/** `uncertain` 条目下的两个前缀。冒号也跟着语言走——英文里用全角 `：` 很刺眼。 */
const UNCERTAIN_LABELS: Record<Language, { reason: string; resolution: string }> = {
  zh: { reason: '存疑原因：', resolution: '更正为：' },
  en: { reason: 'Uncertain because: ', resolution: 'Corrected to: ' },
};

/* ------------------------------------------------------------------ *
 * 渲染前的守卫
 * ------------------------------------------------------------------ */

/**
 * 拒绝换行符。
 *
 * 契约第 4.4 节规定所有字符串值都是单行纯文本，那一条本该由校验环节保证。
 * 渲染器这里再拦一道，是因为在单行的位置上写进一个换行符，产出的一定是坏文件：
 * frontmatter 会被撑破、标题会被劈成两行。**宁可当场停住，也不要写出一个
 * 看起来正常、其实已经烂了的文件**——这正是阶段 1 认定的头号风险。
 */
function assertSingleLine(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `${field} 里有换行符，渲染不成一行。\n` +
        `  这该由校验环节拦住（契约第 4.4 节）。渲染器拒绝把它写进文件，` +
        `因为写出去的结果一定是坏的。`,
    );
  }
}

/**
 * 拒绝带路径的 source_ref。
 *
 * 契约第 3.1 节规定这个字段**只存文件名**：完整路径会泄露用户名和目录结构，
 * 笔记一旦被分享或同步就跟着出去了。这是隐私承诺，所以在这里也拦一道，
 * 不让它悄悄写进文件。
 */
function assertPlainFileName(value: string): void {
  if (/[\\/]/.test(value)) {
    throw new Error(
      `source_ref 只允许存文件名，但拿到的是带路径的 ${JSON.stringify(value)}。\n` +
        `  完整路径会泄露用户名和目录结构（契约第 3.1 节），请在上游取 basename。`,
    );
  }
}

/** frontmatter 里的字符串字段。 */
function assertMetaRenderable(meta: NoteMeta): void {
  assertSingleLine(meta.id, 'id');
  assertSingleLine(meta.inputId, 'input_id');
  assertSingleLine(meta.created, 'created');
  assertSingleLine(meta.updated, 'updated');
  assertSingleLine(meta.sourceHash, 'source_hash');
  assertSingleLine(meta.model, 'model');
  assertSingleLine(meta.promptVersion, 'prompt_version');
  if (meta.sourceRef !== undefined) {
    assertSingleLine(meta.sourceRef, 'source_ref');
    assertPlainFileName(meta.sourceRef);
  }
}

/** 走一遍草稿里所有字符串字段，把「渲染出来必然是坏文件」的输入挡在渲染之前。 */
function assertDraftRenderable(draft: NoteDraft): void {
  assertSingleLine(draft.title, 'title');
  assertSingleLine(draft.summary, 'summary');
  for (const tag of draft.tags) assertSingleLine(tag, 'tags 里的一项');

  draft.blocks.forEach((block, index) => {
    const at = `blocks[${index}]`;
    switch (block.type) {
      case 'text':
        assertSingleLine(block.text, `${at}.text`);
        break;
      case 'steps':
      case 'list':
        if (block.title !== undefined) assertSingleLine(block.title, `${at}.title`);
        block.items.forEach((item, i) => assertSingleLine(item, `${at}.items[${i}]`));
        break;
      case 'params':
        if (block.title !== undefined) assertSingleLine(block.title, `${at}.title`);
        block.items.forEach((item, i) => {
          assertSingleLine(item.name, `${at}.items[${i}].name`);
          if (item.value !== undefined) assertSingleLine(item.value, `${at}.items[${i}].value`);
          if (item.note !== undefined) assertSingleLine(item.note, `${at}.items[${i}].note`);
        });
        break;
      case 'concept':
        assertSingleLine(block.term, `${at}.term`);
        assertSingleLine(block.explanation, `${at}.explanation`);
        break;
      case 'uncertain':
        block.items.forEach((item, i) => {
          assertSingleLine(item.text, `${at}.items[${i}].text`);
          assertSingleLine(item.reason, `${at}.items[${i}].reason`);
          if (item.resolution !== undefined) {
            assertSingleLine(item.resolution, `${at}.items[${i}].resolution`);
          }
        });
        break;
    }
  });
}

/* ------------------------------------------------------------------ *
 * YAML
 * ------------------------------------------------------------------ */

/** 以这些字符开头的标量在 YAML 里是有结构的，必须加引号。 */
const YAML_INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** 会被 YAML 解析成布尔或 null 的裸标量。 */
const YAML_KEYWORD = /^(?:true|false|null|yes|no|on|off|~)$/i;
/** 会被 YAML 解析成数字的裸标量。 */
const YAML_NUMBER = /^[-+]?(?:\d[\d_]*)(?:\.\d*)?(?:[eE][-+]?\d+)?$/;

function needsQuotes(value: string): boolean {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (YAML_INDICATOR_START.test(value)) return true;
  if (YAML_KEYWORD.test(value)) return true;
  if (YAML_NUMBER.test(value)) return true;
  // `key: value` 里的 `: ` 会让整行被当成嵌套映射。结尾的冒号同理。
  if (value.includes(': ') || value.endsWith(':')) return true;
  // ` #` 会被当成注释起点，后面的内容就丢了。
  if (value.includes(' #')) return true;
  return false;
}

/**
 * 把一个字符串写成安全的 YAML 标量。
 *
 * 不这么做的话，一个标题里带 `: `（比如 `新建: 尺寸 1920`）就会把 frontmatter 整段毁掉，
 * 而且毁得非常安静——文件看着还在，Obsidian 只是不再认得这些字段了。
 * 加引号是双引号风格，因为只有它支持反斜杠转义。
 */
function yamlScalar(value: string): string {
  if (!needsQuotes(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** frontmatter 的字段顺序是固定的，这样同一份草稿的 diff 才稳定。 */
function renderFrontmatter(draft: NoteDraft, meta: NoteMeta): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${yamlScalar(meta.id)}`);
  lines.push(`input_id: ${yamlScalar(meta.inputId)}`);
  lines.push(`title: ${yamlScalar(draft.title)}`);
  lines.push(`created: ${yamlScalar(meta.created)}`);
  lines.push(`updated: ${yamlScalar(meta.updated)}`);
  lines.push(`summary: ${yamlScalar(draft.summary)}`);
  lines.push('tags:');
  for (const tag of draft.tags) lines.push(`  - ${yamlScalar(tag)}`);
  lines.push(`status: ${meta.status}`);
  lines.push(`source_hash: ${yamlScalar(meta.sourceHash)}`);
  if (meta.sourceRef !== undefined) lines.push(`source_ref: ${yamlScalar(meta.sourceRef)}`);
  lines.push(`schema_version: ${meta.schemaVersion}`);
  lines.push(`language: ${draft.language}`);
  lines.push(`model: ${yamlScalar(meta.model)}`);
  lines.push(`prompt_version: ${yamlScalar(meta.promptVersion)}`);
  lines.push('---');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 正文
 * ------------------------------------------------------------------ */

/** 空标题用默认标题顶上——这是「空字段不产生空标题」的那一半。 */
function blockTitle(title: string | undefined, fallback: string): string {
  const trimmed = title?.trim() ?? '';
  return trimmed === '' ? fallback : trimmed;
}

/** 表格单元格里出现的 `|` 会把这一行劈成多列，必须转义。 */
function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function renderSteps(block: StepsBlock, language: Language): string | null {
  if (block.items.length === 0) return null;
  const heading = `## ${blockTitle(block.title, DEFAULT_TITLES[language].steps)}`;
  const items = block.items.map((item, index) => `${index + 1}. ${item}`);
  // 列表项之间只能是单个换行。用空行隔开会被 Markdown 当成「松散列表」，
  // 每项都裹上段落间距，读起来就散了。
  return [heading, items.join('\n')].join('\n\n');
}

function renderList(block: ListBlock, language: Language): string | null {
  if (block.items.length === 0) return null;
  const heading = `## ${blockTitle(block.title, DEFAULT_TITLES[language].list)}`;
  const items = block.items.map((item) => `- ${item}`);
  return [heading, items.join('\n')].join('\n\n');
}

function renderParams(block: ParamsBlock, language: Language): string | null {
  if (block.items.length === 0) return null;
  const heading = `## ${blockTitle(block.title, DEFAULT_TITLES[language].params)}`;
  const [nameHeader, valueHeader, noteHeader] = PARAM_HEADERS[language];
  const rows = block.items.map((item: ParamItem) => {
    const value = item.value === undefined ? '' : tableCell(item.value);
    const note = item.note === undefined ? '' : tableCell(item.note);
    return `| ${tableCell(item.name)} | ${value} | ${note} |`;
  });
  // 标题与表格之间必须空一行：表头紧跟在上一行文字后面，多数 Markdown 解析器
  // （包括 Obsidian 用的那套）根本不会把它认成表格。
  const table = [`| ${nameHeader} | ${valueHeader} | ${noteHeader} |`, '|---|---|---|', ...rows];
  return [heading, table.join('\n')].join('\n\n');
}

function renderText(block: TextBlock): string | null {
  const text = block.text.trim();
  return text === '' ? null : text;
}

/** 概念是笔记里的旁注，所以只有 `###`，没有 `##`（契约第 3.3 节第 2 条）。 */
function renderConcept(block: ConceptBlock): string | null {
  const term = block.term.trim();
  if (term === '') return null;
  return [`### ${term}`, block.explanation.trim()].join('\n\n');
}

function renderBlock(block: Block, language: Language): string | null {
  switch (block.type) {
    case 'text':
      return renderText(block);
    case 'steps':
      return renderSteps(block, language);
    case 'list':
      return renderList(block, language);
    case 'params':
      return renderParams(block, language);
    case 'concept':
      return renderConcept(block);
    case 'uncertain':
      // 存疑项一律留到文末统一渲染，见 renderUncertain。
      return null;
  }
}

/**
 * 把所有 `uncertain` 块里的条目收拢成文末的一个 `## 待确认`。
 *
 * 契约规定整篇至多 1 个 `uncertain` 块，这里仍然按「全部收拢」处理：
 * 万一模型给了两个，合并进去总比丢掉一个强。丢内容是这个项目最不能接受的失败。
 */
function renderUncertain(blocks: Block[], language: Language): string | null {
  const items: UncertainItem[] = [];
  for (const block of blocks) {
    if (block.type !== 'uncertain') continue;
    for (const item of block.items) {
      if (item.text.trim() !== '') items.push(item);
    }
  }
  if (items.length === 0) return null;

  const labels = UNCERTAIN_LABELS[language];
  const lines: string[] = [`## ${DEFAULT_TITLES[language].uncertain}`];
  for (const item of items) {
    lines.push('');
    lines.push(`- ${item.text.trim()}`);
    if (item.reason.trim() !== '') lines.push(`  - ${labels.reason}${item.reason.trim()}`);
    if (item.resolution !== undefined && item.resolution.trim() !== '') {
      lines.push(`  - ${labels.resolution}${item.resolution.trim()}`);
    }
  }
  return lines.join('\n');
}

/**
 * 只渲染正文（不含 frontmatter），末尾恰好一个换行符。
 *
 * 单独导出是因为将来会有「同一份草稿换个模板重渲染」的需求，那时只关心正文。
 */
export function renderBody(draft: NoteDraft): string {
  assertDraftRenderable(draft);
  return buildBody(draft);
}

function buildBody(draft: NoteDraft): string {
  const parts: string[] = [`# ${draft.title}`];
  if (draft.summary.trim() !== '') parts.push(`> ${draft.summary.trim()}`);

  for (const block of draft.blocks) {
    const rendered = renderBlock(block, draft.language);
    if (rendered !== null) parts.push(rendered);
  }

  const uncertain = renderUncertain(draft.blocks, draft.language);
  if (uncertain !== null) parts.push(uncertain);

  return `${parts.join('\n\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 渲染一条完整的笔记文件：frontmatter + 空行 + 正文，末尾恰好一个换行符。
 *
 * `created` / `updated` 必须由调用方传入——这个函数不读时钟。
 */
export function renderNote(draft: NoteDraft, meta: NoteMeta): string {
  assertDraftRenderable(draft);
  assertMetaRenderable(meta);
  return `${renderFrontmatter(draft, meta)}\n\n${buildBody(draft)}`;
}
