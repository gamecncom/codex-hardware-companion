import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export interface DeviceViewDescriptor {
  viewId: string;
  serverEpoch: string;
  revision: string;
  screen: 'projects' | 'tasks' | 'detail' | 'transcript';
  kind: 'projects' | 'tasks' | 'detail' | 'transcript';
  choice: number;
  catalogVersion: string;
  items: any[];
  target?: { connectorId: string; projectId: string; threadId: string };
  jpegPath: string;
  nextCursor?: string;
  title?: string;
  textLines?: string[];
  page?: number;
  pageCount?: number;
  resultRevision?: string;
  recordingId?: string;
  layout?: 'compact';
  status?: string;
  unreadCount?: number;
}

export function compactStatusLabel(status: unknown): string {
  switch (String(status ?? '').toLowerCase()) {
    case 'completed': return '完成';
    case 'waiting_user': return '等待你处理';
    case 'failed': return '失败';
    default: return '处理中';
  }
}

/** Two larger, readable lines for the 480x320 compact detail card. */
export function compactDetailLines(text: string): string[] {
  const lines: string[] = [];
  const paragraphs = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let truncated = false;
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex];
    let line = '', width = 0;
    for (const char of paragraph) {
      const advance = char.codePointAt(0)! > 255 ? 24 : 14;
      if (line && width + advance > 432) {
        lines.push(line); line = ''; width = 0;
        if (lines.length === 2) { truncated = true; break; }
      }
      line += char; width += advance;
    }
    if (truncated) break;
    lines.push(line);
    if (lines.length >= 2) { truncated = paragraphIndex < paragraphs.length - 1; break; }
  }
  const result = lines.slice(0, 2);
  if (!result.length) result.push('');
  if (truncated) {
    const last = result.length - 1;
    result[last] = `${result[last].slice(0, Math.max(0, result[last].length - 1))}…`;
  }
  return result;
}

export function paginateResult(text: string): string[][] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, '\n').split('\n')) {
    let line = '', width = 0;
    for (const char of paragraph) {
      const advance = char.codePointAt(0)! > 255 ? 16 : 9;
      if (width + advance > 420) { lines.push(line); line = ''; width = 0; }
      line += char; width += advance;
    }
    lines.push(line);
  }
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 8) pages.push(lines.slice(i, i + 8));
  return pages.length ? pages : [['']];
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

async function fontCss() {
  const path = process.env.HC_FONT_FILE;
  if (!path) return '';
  const data = await readFile(path);
  const ext = path.toLowerCase().endsWith('.ttf') ? 'truetype' : 'opentype';
  return `@font-face{font-family:HCFont;src:url(data:font/${ext};base64,${data.toString('base64')}) format('${ext}');}`;
}

export async function renderDeviceJpeg(descriptor: DeviceViewDescriptor): Promise<Buffer> {
  if (descriptor.kind === 'detail' && descriptor.layout === 'compact') {
    const title = Array.from(descriptor.title ?? '任务详情').slice(0, 40).join('');
    const titleLines = [title.slice(0, 20), title.slice(20, 40)].filter(Boolean);
    const titleSvg = titleLines.map((line, index) => `<text x="24" y="${34 + index * 26}" font-size="22" font-weight="700" fill="#ffffff">${esc(line)}</text>`).join('');
    const bodyLines = (descriptor.textLines ?? ['', '']).slice(0, 2);
    const bodySvg = bodyLines.map((line, index) => `<text x="24" y="${145 + index * 36}" font-size="25" fill="#000000">${esc(line)}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><style>${await fontCss()}text{font-family:HCFont,Arial,sans-serif}</style><rect width="480" height="320" fill="#ffffff"/><rect x="0" y="0" width="480" height="78" fill="#000000"/><rect x="24" y="70" width="432" height="2" fill="#ffffff"/>${titleSvg}<text x="24" y="102" font-size="18" font-weight="700" fill="#000000">${esc(descriptor.status ?? '处理中')}</text>${bodySvg}<line x1="24" y1="207" x2="456" y2="207" stroke="#000000" stroke-width="2"/><text x="24" y="244" font-size="18" fill="#000000">待查看任务：${Number(descriptor.unreadCount ?? 0)}</text><text x="24" y="298" font-size="17" fill="#000000">按住语音键说话</text></svg>`;
    return sharp(Buffer.from(svg)).resize(480, 320, { fit: 'fill' }).jpeg({ quality: 82, progressive: false }).toBuffer();
  }
  if (descriptor.kind === 'detail' || descriptor.kind === 'transcript') {
    const title = Array.from(descriptor.title ?? '任务详情').slice(0, 20).join('');
    const lines = (descriptor.textLines ?? []).map((line, index) => `<text x="24" y="${98 + index * 25}" font-size="16" fill="#172033">${esc(line)}</text>`).join('');
    const prompt = descriptor.kind === 'transcript' ? '<text x="24" y="286" font-size="13" fill="#0f766e">确认发送</text><text x="140" y="286" font-size="13" fill="#64748b">取消录音</text>' : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><style>${await fontCss()}text{font-family:HCFont,Arial,sans-serif}</style><rect width="480" height="320" fill="white"/><rect width="480" height="64" fill="#0f172a"/><text x="24" y="39" font-size="20" fill="white">${esc(title)}</text>${lines}${prompt}<text x="24" y="310" font-size="12" fill="#64748b">第 ${(descriptor.page ?? 0) + 1} / ${descriptor.pageCount ?? 1} 页</text></svg>`;
    return sharp(Buffer.from(svg)).jpeg({ quality: 82, progressive: false }).toBuffer();
  }
  const selected = descriptor.items[descriptor.choice];
  const shorten = (value: unknown, max = 24) => { const s = String(value ?? ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
  const title = shorten(selected?.label || (descriptor.kind === 'projects' ? '项目目录' : '任务目录'), 22);
  const subtitle = descriptor.kind === 'projects'
    ? `${descriptor.items.length} 个任务`
    : `${selected?.status ?? ''}  ${selected?.threadId ?? ''}`;
  const rows = descriptor.items.slice(0, 7).map((item, index) => {
    const label = shorten(item.label, 34);
    const active = index === descriptor.choice;
    return `<rect x="24" y="${126 + index * 26}" width="432" height="22" rx="5" fill="${active ? '#dbeafe' : '#f8fafc'}"/><text x="34" y="${142 + index * 26}" font-size="13" fill="#0f172a">${esc(`${index + 1}. ${label}`)}</text>`;
  }).join('');
  const css = await fontCss();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><style>${css}text{font-family:HCFont,Arial,sans-serif}</style><rect width="480" height="320" fill="#ffffff"/><rect x="0" y="0" width="480" height="82" fill="#0f172a"/><text x="24" y="34" font-size="20" font-weight="700" fill="#ffffff">${esc(title || (descriptor.kind === 'projects' ? '项目目录' : '任务目录'))}</text><text x="24" y="61" font-size="13" fill="#cbd5e1">${esc(subtitle)} · choice ${descriptor.choice}</text><text x="24" y="106" font-size="12" fill="#64748b">Hardware Companion · catalog ${esc(descriptor.catalogVersion)}</text>${rows}</svg>`;
  return sharp(Buffer.from(svg)).resize(480, 320, { fit: 'fill' }).jpeg({ quality: 82, progressive: false }).toBuffer();
}
