import { describe, expect, it } from 'vitest';
import {
  decodeDeviceDefaults,
  decodeDevices,
  decodeHiddenOrigins,
  DEVICE_DEFAULTS_URL,
  mergeDeviceDefaults,
  mergeDevices,
  parseDeviceImport,
  renameDevice,
  validateDevice,
} from './deviceRegistry';

describe('parseDeviceImport', () => {
  it('解析「名称|地址」写法并去重', () => {
    const devices = parseDeviceImport('marc-linux-pc|http://100.72.0.111:3001;jx88|http://100.108.86.109:3001');
    expect(devices).toEqual([
      { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
      { name: 'jx88', origin: 'http://100.108.86.109:3001' },
    ]);
  });

  it('支持 JSON 数组写法', () => {
    const raw = encodeURIComponent(JSON.stringify([{ name: 'a', origin: 'http://1.2.3.4:3001' }]));
    expect(parseDeviceImport(decodeURIComponent(raw))).toEqual([{ name: 'a', origin: 'http://1.2.3.4:3001' }]);
  });

  it('丢弃含凭据、路径或坏协议的单项，其余照常导入', () => {
    const raw = [
      'ok|http://1.2.3.4:3001',
      'withCred|http://user:pw@1.2.3.4:3001',
      'withPath|http://1.2.3.4:3001/artifacts.html',
      'badProto|ftp://1.2.3.4',
    ].join(';');
    expect(parseDeviceImport(raw)).toEqual([{ name: 'ok', origin: 'http://1.2.3.4:3001' }]);
  });

  it('空值与损坏 JSON 返回空列表', () => {
    expect(parseDeviceImport(null)).toEqual([]);
    expect(parseDeviceImport('')).toEqual([]);
    expect(parseDeviceImport('[{"name":')).toEqual([]);
  });
});

describe('mergeDevices', () => {
  it('按 origin 去重并保留既有顺序', () => {
    const current = [{ name: '当前设备', origin: 'http://a:1' }];
    const merged = mergeDevices(current, [
      { name: '重复', origin: 'http://a:1' },
      { name: '新设备', origin: 'http://b:2' },
    ]);
    expect(merged).toEqual([
      { name: '当前设备', origin: 'http://a:1' },
      { name: '新设备', origin: 'http://b:2' },
    ]);
  });
});

describe('设备改名', () => {
  const devices = [
    { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
    { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001' },
  ];

  it('只改显示名，地址与顺序不变', () => {
    expect(renameDevice(devices, 'http://100.117.103.34:3001', '  工作室 Mac  ')).toEqual([
      { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
      { name: '工作室 Mac', origin: 'http://100.117.103.34:3001' },
    ]);
  });

  it('名称为空、超长或地址不存在时不产生半成品', () => {
    expect(() => renameDevice(devices, 'http://100.117.103.34:3001', '   ')).toThrow();
    expect(() => renameDevice(devices, 'http://100.117.103.34:3001', 'x'.repeat(81))).toThrow();
    expect(renameDevice(devices, 'http://nope:1', '名字')).toEqual(devices);
  });

  it('预置设备地址用的是站点根路径', () => {
    // 深链（/p/xxx）上也要能取到，否则切换设备列表会空掉。
    expect(DEVICE_DEFAULTS_URL).toBe('/devices.json');
    expect(new URL(DEVICE_DEFAULTS_URL, 'http://host:5186/p/general').pathname).toBe('/devices.json');
  });

  it('本机改名不会被 devices.json 的原始名称覆盖', () => {
    const merged = mergeDeviceDefaults(
      renameDevice(devices, 'http://100.117.103.34:3001', 'leo 的 Mac'),
      [
        { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
        { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001' },
      ],
    );
    expect(merged).toEqual([
      { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
      { name: 'leo 的 Mac', origin: 'http://100.117.103.34:3001' },
    ]);
  });
});

describe('既有校验保持不变', () => {
  it('拒绝非根地址', () => {
    expect(() => validateDevice('x', 'http://1.2.3.4:3001/sub')).toThrow();
  });
  it('decodeDevices 会剔除损坏条目', () => {
    expect(decodeDevices('[{"name":"a","origin":"http://a:1"},{"name":"b"}]')).toEqual([{ name: 'a', origin: 'http://a:1' }]);
  });
});
describe('部署侧预置设备', () => {
  it('接受 {devices:[…]} 与裸数组两种写法', () => {
    const expected = [{ name: 'a', origin: 'http://a:1' }];
    expect(decodeDeviceDefaults({ devices: expected })).toEqual(expected);
    expect(decodeDeviceDefaults(expected)).toEqual(expected);
    expect(decodeDeviceDefaults('nope')).toEqual([]);
    expect(decodeDeviceDefaults({ devices: [{ name: 'x', origin: 'ftp://a' }] })).toEqual([]);
  });

  it('预置在前、本机新增在后，同 origin 只留一个', () => {
    const merged = mergeDeviceDefaults(
      [{ name: '本机设备', origin: 'http://local:1' }],
      [{ name: '预置A', origin: 'http://a:1' }, { name: '预置B', origin: 'http://b:1' }],
    );
    expect(merged.map(d => d.origin)).toEqual(['http://a:1', 'http://b:1', 'http://local:1']);
  });

  it('删除过的预置设备不再出现', () => {
    const merged = mergeDeviceDefaults([], [{ name: 'A', origin: 'http://a:1' }, { name: 'B', origin: 'http://b:1' }], ['http://a:1']);
    expect(merged.map(d => d.origin)).toEqual(['http://b:1']);
  });

  it('已删除记录只接受 http(s) 来源', () => {
    expect(decodeHiddenOrigins('["http://a:1","javascript:alert(1)","file:///etc"]')).toEqual(['http://a:1']);
    expect(decodeHiddenOrigins('{bad')).toEqual([]);
  });
});
