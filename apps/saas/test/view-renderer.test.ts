import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compactDetailLines, compactStatusLabel, renderDeviceJpeg } from '../src/view-renderer.js';

const descriptor = (kind: 'projects' | 'detail') => ({
  viewId: `view-${kind}`, serverEpoch: 'server', revision: '1', screen: kind, kind,
  choice: 0, catalogVersion: '1', items: [{ label: '演示任务', threadId: 'thread-1', status: 'idle' }],
  jpegPath: `/v1/device/views/view-${kind}.jpg`, title: '演示', textLines: ['内容'],
});

test('device JPEGs are baseline rather than progressive for firmware decoder', async () => {
  for (const kind of ['projects', 'detail'] as const) {
    const jpeg = await renderDeviceJpeg(descriptor(kind));
    assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
    const metadata = await sharp(jpeg).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 480);
    assert.equal(metadata.height, 320);
    assert.equal(metadata.isProgressive, false);
    let sawSof0 = false;
    for (let i = 2; i + 9 < jpeg.length;) {
      if (jpeg[i] !== 0xff) { i++; continue; }
      const marker = jpeg[i + 1];
      if (marker === 0xc0) { sawSof0 = true; break; }
      if (marker === 0xda || marker === 0xd9) break;
      const length = jpeg.readUInt16BE(i + 2);
      i += 2 + length;
    }
    assert.equal(sawSof0, true);
  }
});

test('compact detail card is two-line black and white layout with localized status', async () => {
  assert.equal(compactStatusLabel('completed'), '完成');
  assert.equal(compactStatusLabel('waiting_user'), '等待你处理');
  assert.equal(compactStatusLabel('failed'), '失败');
  assert.equal(compactStatusLabel('running'), '处理中');
  const lines = compactDetailLines('这是一段足够长的任务结果正文，用于验证紧凑卡片只保留两行并在末尾截断。这里还有更多内容，不能分页，也不能挤出卡片边界。');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /…$/);
  const jpeg = await renderDeviceJpeg({ ...descriptor('detail'), layout: 'compact', status: '等待你处理', unreadCount: 3, textLines: lines });
  const metadata = await sharp(jpeg).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 480);
  assert.equal(metadata.height, 320);
  assert.equal(metadata.isProgressive, false);
  assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
});
