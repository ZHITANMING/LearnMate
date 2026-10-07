import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readInput } from '../src/commands/add.js';
import { EXIT, UsageError } from '../src/core/errors.js';
import { ingest } from '../src/core/ingest.js';
import { docxToText, isDocxFile } from '../src/io/readers/docx.js';

/* ------------------------------------------------------------------ *
 * 夹具：手工拼一个最小的 .docx
 *
 * 真正的 .docx 是 Word 生成的，几百个字节的最小包也塞不进测试文件里；
 * 而读取器要认的东西并不多，所以这里按 ZIP 的结构**手工拼**一个出来。
 * 好处是每个用例都能精确控制包里有什么（压缩方式、条目顺序、注释……）。
 * ------------------------------------------------------------------ */

interface Entry {
  name: string;
  data: Buffer;
  /** 用 deflate 压缩（默认不压缩）。 */
  deflate?: boolean;
  /** 压缩方式字段，用来造「不认识的压缩方式」。 */
  method?: number;
  /** 条目上的扩展字段与注释，用来确认读取器会跳过它们。 */
  extra?: Buffer;
  comment?: Buffer;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** 拼一个 ZIP 包。**CRC 一律写 0**——读取器不看它（见 D42 的已知缺口）。 */
function buildZip(entries: readonly Entry[], archiveComment?: Buffer): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const extra = entry.extra ?? Buffer.alloc(0);
    const comment = entry.comment ?? Buffer.alloc(0);
    const method = entry.method ?? (entry.deflate === true ? 8 : 0);
    const body = entry.deflate === true ? deflateRawSync(entry.data) : entry.data;

    const local = Buffer.alloc(30 + name.length + extra.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // 需要的解压版本
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    name.copy(local, 30);
    extra.copy(local, 30 + name.length);
    localParts.push(local, body);

    const central = Buffer.alloc(46 + name.length + extra.length + comment.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // 生成的版本
    central.writeUInt16LE(20, 6); // 需要的解压版本
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);
    comment.copy(central, 46 + name.length + extra.length);
    centralParts.push(central);

    offset += local.length + body.length;
  }

  const comment = archiveComment ?? Buffer.alloc(0);
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/** 一个段落。 */
function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function document(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`
  );
}

/** 一份能读的 .docx：`[Content_Types].xml` 在前（真实的包就是这样），正文在后。 */
function docx(entries: readonly Entry[]): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<Relationships/>', 'utf8') },
    ...entries,
  ]);
}

function docxWith(body: string): Buffer {
  return docx([{ name: 'word/document.xml', data: Buffer.from(document(body), 'utf8') }]);
}

/** 跑一段必然失败的抽取，把抛出来的错误交回来。 */
function failureOf(bytes: Uint8Array): UsageError {
  try {
    docxToText(bytes);
  } catch (error) {
    assert.ok(error instanceof UsageError, `期望 UsageError，实际是 ${String(error)}`);
    assert.equal(error.exitCode, EXIT.USAGE, '读不了的文件必须是用法错误，退出码 2（此时 raw/ 还没写）');
    return error;
  }
  throw new assert.AssertionError({ message: '期望它抛错，但它没有' });
}

const TEMP_DIRS: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'learnmate-docx-'));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('isDocxFile —— 只看扩展名', () => {
  it('认 .docx，大小写都认', () => {
    assert.equal(isDocxFile('示例输入.docx'), true);
    assert.equal(isDocxFile('示例输入.DOCX'), true);
  });

  it('别的都不认', () => {
    assert.equal(isDocxFile('示例输入.doc'), false, '老的 .doc 不是压缩包，读不了');
    assert.equal(isDocxFile('示例输入.txt'), false);
    assert.equal(isDocxFile('docx'), false);
    assert.equal(isDocxFile('示例输入.docx.txt'), false);
  });
});

describe('docxToText —— 段落与文字', () => {
  it('抽出一个段落里的文字', () => {
    assert.equal(docxToText(docxWith(para('你好'))), '你好\n');
  });

  it('多个段落按原顺序、一段一行', () => {
    assert.equal(docxToText(docxWith(para('第一段') + para('第二段'))), '第一段\n第二段\n');
  });

  it('同一个段落里的多个 run 拼成一行', () => {
    const body = '<w:p><w:r><w:t>甲</w:t></w:r><w:r><w:t>乙</w:t></w:r></w:p>';
    assert.equal(docxToText(docxWith(body)), '甲乙\n');
  });

  it('空段落留下一个空行', () => {
    assert.equal(docxToText(docxWith(para('上') + '<w:p/>' + para('下'))), '上\n\n下\n');
  });

  it('段首段尾的空格保留（排版信息，不该被吃掉）', () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">  缩进的内容  </w:t></w:r></w:p>';
    assert.equal(docxToText(docxWith(body)), '  缩进的内容  \n');
  });
});

describe('docxToText —— 结构翻译成空白', () => {
  it('表格：一行的单元格用 Tab 隔开，换行结束', () => {
    const cell = (text: string) => `<w:tc>${para(text)}</w:tc>`;
    const row = (left: string, right: string) => `<w:tr>${cell(left)}${cell(right)}</w:tr>`;
    assert.equal(docxToText(docxWith(row('甲', '乙') + row('丙', '丁'))), '甲\t乙\n丙\t丁\n');
  });

  it('w:tab 变成制表符，w:br 变成换行', () => {
    const body = '<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r></w:p>';
    assert.equal(docxToText(docxWith(body)), '甲\t乙\n丙\n');
  });

  it('超链接里的文字保留（它是正文的一部分）', () => {
    const body =
      '<w:p><w:r><w:t>见</w:t></w:r>' +
      '<w:hyperlink r:id="rId1"><w:r><w:t>这份资料</w:t></w:r></w:hyperlink></w:p>';
    assert.equal(docxToText(docxWith(body)), '见这份资料\n');
  });

  it('域代码是给 Word 看的指令，不进正文', () => {
    const body =
      '<w:p><w:r><w:instrText>HYPERLINK "http://example.invalid"</w:instrText></w:r>' +
      '<w:r><w:t>显示的链接文字</w:t></w:r></w:p>';
    assert.equal(docxToText(docxWith(body)), '显示的链接文字\n');
  });

  it('XML 注释被丢掉', () => {
    assert.equal(docxToText(docxWith(`<!-- 这是注释 -->${para('正文')}`)), '正文\n');
  });

  it('段落属性（w:pPr / w:pStyle）不产生多余的空行', () => {
    const body = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>';
    assert.equal(docxToText(docxWith(body)), '标题\n');
  });

  it('修订删掉的文字（w:delText）不进正文', () => {
    const body = '<w:p><w:r><w:t>保留的</w:t></w:r><w:del><w:r><w:delText>删掉的</w:delText></w:r></w:del></w:p>';
    assert.equal(docxToText(docxWith(body)), '保留的\n');
  });

  it('XML 自己的排版（声明后面的换行、元素之间的缩进）不进正文', () => {
    // 真实的 .docx 就是长这样的：`<?xml …?>` 后面一个换行，元素之间还有缩进。
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
      `  <w:body>\n    ${para('正文')}\n  </w:body>\n` +
      '</w:document>';
    const zip = docx([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf8') }]);
    assert.equal(docxToText(zip), '正文\n');
  });
});

describe('docxToText —— 实体', () => {
  it('五个预定义实体都还原成字符', () => {
    const body = para('&amp;&lt;&gt;&quot;&apos;');
    assert.equal(docxToText(docxWith(body)), '&<>"\'\n');
  });

  it('十进制与十六进制实体都还原成字符', () => {
    assert.equal(docxToText(docxWith(para('&#20013;&#x6587;'))), '中文\n');
  });

  it('XML 里本就不合法的命名实体原样留着，不猜', () => {
    assert.equal(docxToText(docxWith(para('甲&nbsp;乙'))), '甲&nbsp;乙\n');
  });
});

describe('docxToText —— 压缩包怎么读', () => {
  it('deflate 压过的正文条目能读', () => {
    const entries: Entry[] = [
      { name: 'word/document.xml', data: Buffer.from(document(para('压过的正文')), 'utf8'), deflate: true },
    ];
    assert.equal(docxToText(docx(entries)), '压过的正文\n');
  });

  it('正文条目排在别的条目后面也能找到（靠中央目录，不靠顺序）', () => {
    const entries: Entry[] = [
      { name: 'word/styles.xml', data: Buffer.from('<styles/>', 'utf8'), deflate: true },
      { name: 'docProps/app.xml', data: Buffer.from('<app/>', 'utf8') },
      { name: 'word/document.xml', data: Buffer.from(document(para('最后才轮到正文')), 'utf8') },
    ];
    assert.equal(docxToText(docx(entries)), '最后才轮到正文\n');
  });

  it('条目的扩展字段和注释、以及包尾的注释都不影响解析', () => {
    const entries: Entry[] = [
      {
        name: 'word/document.xml',
        data: Buffer.from(document(para('带着附件字段')), 'utf8'),
        deflate: true,
        extra: Buffer.from('UT\u0005\u0000\u0001\u0000\u0000\u0000', 'latin1'),
        comment: Buffer.from('条目注释', 'utf8'),
      },
    ];
    assert.equal(docxToText(docx(entries)), '带着附件字段\n');
  });

  it('传进来的是一段视图（byteOffset 不为 0）也读得对', () => {
    const zip = docxWith(para('包在一个更大的缓冲区里'));
    const padded = Buffer.concat([Buffer.from('前面垫一段'), zip, Buffer.from('后面垫一段')]);
    const view = padded.subarray(Buffer.from('前面垫一段').length);
    assert.equal(docxToText(view.subarray(0, zip.length)), '包在一个更大的缓冲区里\n');
  });
});

describe('docxToText —— 读不了的文件，一律退出码 2', () => {
  it('根本不是压缩包（比如 .doc 改了个名）', () => {
    const error = failureOf(Buffer.from('这不是压缩包，只是一段普通文字', 'utf8'));
    assert.match(error.message, /不是一个压缩包/);
    assert.match(error.message, /另存为 \.docx/, '要告诉用户怎么自救');
  });

  it('空文件', () => {
    assert.match(failureOf(Buffer.alloc(0)).message, /不是一个压缩包/);
  });

  it('被截断的包', () => {
    const zip = docxWith(para('正文'));
    assert.match(failureOf(zip.subarray(0, zip.length - 40)).message, /不是一个压缩包|损坏/);
  });

  it('是压缩包，但里面没有 word/document.xml（不是 Word 文档）', () => {
    const zip = buildZip([{ name: 'word/styles.xml', data: Buffer.from('<styles/>', 'utf8') }]);
    assert.match(failureOf(zip).message, /找不到 word\/document\.xml/);
  });

  it('压缩方式不认识', () => {
    const zip = docx([{ name: 'word/document.xml', data: Buffer.alloc(8), method: 99 }]);
    assert.match(failureOf(zip).message, /不认识的压缩方式/);
  });

  it('正文里一个字都没有（通篇图片、图表、公式）', () => {
    const zip = docxWith('<w:p><w:r><w:drawing/></w:r></w:p>');
    const error = failureOf(zip);
    assert.match(error.message, /一个字都没抽出来/);
    assert.match(error.message, /OCR/, '要告诉用户这条路还没通');
  });

  it('deflate 数据本身坏了', () => {
    // 头部声明「这段是 deflate 压的」，实际塞进去的却不是压缩数据。
    const zip = docx([{ name: 'word/document.xml', data: Buffer.from('乱码不是压缩数据'), method: 8 }]);
    assert.match(failureOf(zip).message, /读不出来/);
  });
});

describe('readInput —— .docx 走抽取这条路（契约 5.6）', () => {
  it('给一个 .docx 文件，拿到的是抽出来的文字，source_ref 仍是文件名', () => {
    const dir = tempDir();
    const file = join(dir, '示例输入.docx');
    writeFileSync(file, docxWith(para('甲脚本') + para('做一件事')));

    assert.deepEqual(readInput(file), { text: '甲脚本\n做一件事\n', sourceRef: '示例输入.docx' });
  });

  it('source_ref 只留文件名，完整路径不进知识库', () => {
    const dir = tempDir();
    const file = join(dir, '示例输入.docx');
    writeFileSync(file, docxWith(para('正文')));
    assert.equal(readInput(file).sourceRef, '示例输入.docx');
  });

  it('纯文本文件的行为一点没变', () => {
    const dir = tempDir();
    const file = join(dir, '示例输入.txt');
    writeFileSync(file, '第一行\r\n第二行', 'utf8');
    assert.deepEqual(readInput(file), { text: '第一行\r\n第二行', sourceRef: '示例输入.txt' });
  });

  it('文件不存在还是那条「读不到这个文件」', () => {
    const dir = tempDir();
    assert.throws(() => readInput(join(dir, '不存在.docx')), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /读不到这个文件/);
      return true;
    });
  });

  it('抽出来的文字能直接过 ingest，后面那条链路只看见文本', () => {
    const text = docxToText(docxWith(para('要点一') + para('要点二')));
    const result = ingest(text, { maxInputChars: 20_000, sourceLabel: '示例输入.docx' });
    assert.equal(result.normalized, '要点一\n要点二\n');
    assert.equal(result.charCount, [...'要点一\n要点二'].length, '末尾那个换行是规范化补的，不算用户写的字');
    assert.match(result.hash, /^sha256:[0-9a-f]{64}$/);
  });
});
