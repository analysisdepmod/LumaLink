import { useMemo, useState, type ReactNode } from 'react'
import { Button, Card, Divider, Drawer, Input, Segmented, Space, Switch, Typography, Upload, message } from 'antd'
import { FileTextOutlined, InboxOutlined, ReloadOutlined, SendOutlined, SettingOutlined, SoundOutlined, SoundFilled } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import VisualMatrix from '../components/VisualMatrix'
import TurboMatrix from '../components/TurboMatrix'
import { type Encoding, type EncodingSpec } from '../services/visualCodec'
import type { OpticalLaneCount } from '../services/metaBarcode'
import { buildTransfer, maxPayload, type BuiltTransfer } from '../services/transferCodec'
import { buildZoneMap, isMultiZone, type ZoneMap } from '../services/adaptiveZones'
import { playChannelTone } from '../services/channelTone'

const { Title, Text } = Typography

const ENCODING_STEPS: { value: Encoding; label: string; detail: string }[] = [
  { value: 'bw', label: 'لونان', detail: 'أعلى تحمّل' },
  { value: 'color8', label: '8 ألوان', detail: 'الخيار العملي' },
  { value: 'color16', label: '16 لون', detail: 'سعة أعلى' },
  { value: 'color32', label: '32 لون', detail: 'كاميرا ممتازة' },
  { value: 'color64', label: '64 لون', detail: 'تجريبي' },
]
const GRID_STEPS = [64, 72, 96, 128, 192, 256]
const SPEED_STEPS = [2, 4, 5, 6.5, 8, 10, 12, 15, 20, 30, 45, 60, 80, 100]
const PROTECTION_STEPS = [0.5, 0.6, 0.625, 0.7]
const LANE_STEPS: OpticalLaneCount[] = [1, 2, 4, 6]
const PROTECTION_LABEL: Record<number, { title: string; detail: string }> = {
  0.5: { title: 'حماية عالية', detail: 'للصورة الأضعف' },
  0.6: { title: 'حماية متوازنة', detail: 'للإرسال اليومي' },
  0.625: { title: 'مضبوط', detail: 'الخيار المقاس' },
  0.7: { title: 'سرعة أعلى', detail: 'للإشارة النظيفة' },
}
type ProfileKey = 'stable' | 'fast' | 'lab'
const PROFILES: Record<ProfileKey, { label: string; caption: string; enc: Encoding; grid: number; fps: number; rate: number; lanes: OpticalLaneCount }> = {
  stable: { label: 'مستقر', caption: 'للروابط اليومية', enc: 'color8', grid: 64, fps: 6.5, rate: 0.625, lanes: 1 },
  fast: { label: 'Fast', caption: 'سعة أعلى للوصلة النظيفة', enc: 'color8', grid: 72, fps: 12, rate: 0.625, lanes: 2 },
  lab: { label: 'دقة عالية', caption: 'شاشة وكاميرا أقوى', enc: 'color16', grid: 128, fps: 5, rate: 0.5, lanes: 1 },
}

function Stepper<T extends string | number>({ label, value, steps, render, onChange }: { label: string; value: T; steps: readonly T[]; render: (value: T) => ReactNode; onChange: (value: T) => void }) {
  const index = Math.max(0, steps.indexOf(value))
  return <div className="opt-stepper"><Text className="opt-stepper-label">{label}</Text><div className="opt-stepper-control"><Button aria-label={`تقليل ${label}`} disabled={index === 0} onClick={() => onChange(steps[index - 1])}>−</Button><div className="opt-stepper-value">{render(value)}</div><Button aria-label={`زيادة ${label}`} disabled={index === steps.length - 1} onClick={() => onChange(steps[index + 1])}>+</Button></div></div>
}

export default function SendPage() {
  const [source, setSource] = useState<'file' | 'text'>('file')
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [profile, setProfile] = useState<ProfileKey>('fast')
  // Keep the initial console state tied to the Fast profile.  This avoids the
  // misleading case where the UI says Fast while a stale literal still sends
  // the old 6.5fps configuration.
  const [enc, setEnc] = useState<Encoding>(PROFILES.fast.enc)
  const [grid, setGrid] = useState(PROFILES.fast.grid)
  const [fps, setFps] = useState(PROFILES.fast.fps)
  const [rate, setRate] = useState(PROFILES.fast.rate)
  const [turboLanes, setTurboLanes] = useState<OpticalLaneCount>(PROFILES.fast.lanes)
  const [useZones, setUseZones] = useState(false)
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [built, setBuilt] = useState<BuiltTransfer | null>(null)
  const [busy, setBusy] = useState(false)
  const spec: EncodingSpec = useMemo(() => ({ enc, gridW: grid, gridH: grid, rate }), [enc, grid, rate])
  const zoneMap: ZoneMap | undefined = useMemo(() => { const map = buildZoneMap(grid, grid, enc); return useZones && isMultiZone(map) ? map : undefined }, [enc, grid, useZones])
  const effectiveChunk = useMemo(() => maxPayload(spec, zoneMap), [spec, zoneMap])
  // A camera does not see every screen flip.  On the measured Turbo link, a
  // 24+1 run left ~80 systematic chunks missing before there were enough repair
  // equations to solve them.  Eight direct symbols followed by one repair keeps
  // the same fast start but continuously funds recovery while the sources pass.
  // v7: four systematic chunks followed by one repair. Repairs retain the
  // paired-loss-safe w2 mapping selected in transferCodec; the shorter direct
  // run spreads recovery equations earlier without the failed all-wide tail.
  // Retained for legacy/zoned manifests. Normal v10 transfers use the balanced
  // 1:1 full-carousel schedule in transferCodec so direct chunks never disappear
  // into a repair-only tail.
  const systematicRun = 8
  const hasSource = source === 'file' ? !!file : text.trim().length > 0
  const resetBuilt = () => setBuilt(null)
  const chooseProfile = (key: ProfileKey) => { const next = PROFILES[key]; setProfile(key); setEnc(next.enc); setGrid(next.grid); setFps(next.fps); setRate(next.rate); setTurboLanes(next.lanes); setUseZones(false); resetBuilt() }
  const chooseEncoding = (next: Encoding) => { setEnc(next); setProfile('lab'); resetBuilt() }
  const chooseGrid = (next: number) => { setGrid(next); setProfile('lab'); resetBuilt() }

  async function generate() {
    let raw: Uint8Array; let name: string; let mime: string; let kind: 'file' | 'text'
    if (source === 'text') { raw = new TextEncoder().encode(text); if (!raw.length) { message.warning('اكتب النص أولاً'); return }; name = 'message.txt'; mime = 'text/plain'; kind = 'text' }
    else { if (!file) { message.warning('اختر ملفاً أولاً'); return }; raw = new Uint8Array(await file.arrayBuffer()); name = file.name; mime = file.type || 'application/octet-stream'; kind = 'file' }
    playChannelTone('launch', soundEnabled)
    setBusy(true)
    try { setBuilt(await buildTransfer(raw, { kind, name, mime }, { spec, chunkSize: effectiveChunk, frameCount: 1, fps, lanes: turboLanes, systematicRun, zoneMap, zoneRingWidth: zoneMap ? Math.max(4, Math.round(grid * .15)) : undefined })); setAdvancedOpen(false) }
    catch (error) { message.error(`تعذر تجهيز النقل: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setBusy(false) }
  }

  const advanced = <div className="opt-advanced">
    <div className="opt-drawer-intro"><span className="opt-eyebrow">CHANNEL CONTROL</span><Text>هذه الخيارات تغيّر أداء الإشارة. ابدأ بـ Fast، ثم غيّر خياراً واحداً فقط عند الاختبار.</Text></div>
    <Stepper label="عدد المصفوفات" value={turboLanes} steps={LANE_STEPS} onChange={value => { setTurboLanes(value); setProfile('lab'); resetBuilt() }} render={value => <><strong>{value === 1 ? 'مصفوفة واحدة' : `${value} مصفوفات`}</strong><small>{value <= 2 ? 'صف واحد' : `${value / 2} صفوف · مصفوفتان بكل صف`}</small></>} />
    <Divider /><Stepper label="سرعة تبديل الإشارة" value={fps} steps={SPEED_STEPS} onChange={value => { setFps(value); setProfile('lab'); resetBuilt() }} render={value => <><strong>{value} fps</strong><small>{value === 100 ? 'الحد الأعلى' : 'إطار في الثانية'}</small></>} />
    <Divider /><Stepper label="مستوى الحماية من أخطاء القراءة" value={rate} steps={PROTECTION_STEPS} onChange={value => { setRate(value); setProfile('lab'); resetBuilt() }} render={value => <><strong>{PROTECTION_LABEL[value].title}</strong><small>{PROTECTION_LABEL[value].detail}</small></>} />
    <Divider /><div className="opt-setting-row"><div><Text strong>استغلال مناطق الشاشة</Text><Text type="secondary">تجربة للشاشات والكاميرات ذات الدقة العالية.</Text></div><Switch checked={useZones} onChange={checked => { setUseZones(checked); setProfile('lab'); resetBuilt() }} /></div>
    <Divider /><div className="opt-setting-row"><div><Text strong>الصوت التشغيلي</Text><Text type="secondary">نبضات قصيرة عند إطلاق القناة وقفل الاستقبال.</Text></div><Switch checked={soundEnabled} onChange={setSoundEnabled} /></div>
  </div>

  if (built) {
    const turbo = turboLanes > 1
    const barcode = { version: built.manifest.v >= 11 ? 3 as const : 2 as const, enc: built.manifest.enc, rate: built.bootstrapRate, zones: !!built.manifest.zones, ringWidth: built.manifest.zones?.[0] ?? 0, gridW: built.manifest.gridW, gridH: built.manifest.gridH }
    const control = built.manifest.v >= 11 ? { id: built.manifest.id, k: built.manifest.k, chunk: built.manifest.chunk, comp: built.manifest.comp } : undefined
    const matrixProps = { frameAt: built.frameAt, frameCount: built.frameCount, spec: { enc: built.manifest.enc, gridW: built.manifest.gridW, gridH: built.manifest.gridH }, fps, zoneMap, barcode, control, segmented: built.segmented }
    return <div className="opt-transfer-view"><div className="opt-transfer-bar"><div><Text className="opt-eyebrow">LUMALINK / LIVE CHANNEL</Text><Title level={4}>قناة الإرسال تعمل</Title><div className="opt-channel-status transmitting"><i />بث ضوئي مستمر</div></div><Space wrap><span className="opt-live-spec">{enc === 'bw' ? 'لونان' : `${enc.replace('color', '')} ألوان`} · {grid}×{grid}{turbo ? ` · Turbo ×${turboLanes}` : ''}</span><Button type="text" icon={soundEnabled ? <SoundFilled /> : <SoundOutlined />} onClick={() => setSoundEnabled(value => !value)} /><Button icon={<SettingOutlined />} onClick={() => setAdvancedOpen(true)}>ضبط</Button><Button icon={<ReloadOutlined />} onClick={() => setBuilt(null)}>نقل جديد</Button></Space></div>{turbo ? <TurboMatrix {...matrixProps} lanes={turboLanes as Exclude<OpticalLaneCount, 1>} /> : <VisualMatrix {...matrixProps} holdTicks={1} />}<Drawer title="ضبط القناة المتقدم" open={advancedOpen} onClose={() => setAdvancedOpen(false)} width={390} placement="left" footer={<Button type="primary" block icon={<SendOutlined />} loading={busy} onClick={generate}>تطبيق وإعادة التوليد</Button>}>{advanced}</Drawer></div>
  }

  return <div className="opt-page">
    <section className="opt-hero"><div className="opt-constellation" aria-hidden="true"><i /><i /><i /><i /><i /></div><div className="opt-orbit" aria-hidden="true"><i /><i /><b>◈</b></div><span className="opt-eyebrow">LUMALINK / OPTICAL TRANSFER CHANNEL</span><Title>أرسل عبر الضوء</Title><Text>قناة بصرية مباشرة بين الشاشة والكاميرا، بلا إنترنت وبلا اقتران.</Text><div className={`opt-channel-status ${busy ? 'arming' : hasSource ? 'ready' : 'idle'}`}><i />{busy ? 'تجهيز الإشارة' : hasSource ? 'القناة جاهزة للإطلاق' : 'بانتظار حمولة القناة'}</div></section>
    <Card className="opt-card opt-panel opt-profile-card" bordered={false}><div className="opt-panel-cap"><Text className="opt-section-label">اختيار مسار الإرسال</Text><span>01</span></div><div className="opt-profiles">{(Object.keys(PROFILES) as ProfileKey[]).map(key => <button key={key} className={`opt-profile ${profile === key ? 'active' : ''}`} onClick={() => chooseProfile(key)}><strong>{PROFILES[key].label}</strong><span>{PROFILES[key].caption}</span></button>)}</div></Card>
    <Card className="opt-card opt-panel opt-source-panel" bordered={false}><div className="opt-panel-cap"><Text className="opt-section-label">حمولة القناة</Text><span>02</span></div><Segmented block value={source} onChange={value => { setSource(value as 'file' | 'text'); resetBuilt() }} options={[{ label: 'ملف', value: 'file', icon: <InboxOutlined /> }, { label: 'نص', value: 'text', icon: <FileTextOutlined /> }]} /><div className="opt-source">{source === 'file' ? <Upload.Dragger multiple={false} maxCount={1} beforeUpload={next => { setFile(next); resetBuilt(); return false }} onRemove={() => { setFile(null); resetBuilt() }} fileList={file ? [{ uid: '1', name: file.name, size: file.size } as UploadFile] : []}><p className="ant-upload-drag-icon"><InboxOutlined /></p><p className="ant-upload-text">ضع ملفك ضمن مجال الإرسال</p></Upload.Dragger> : <Input.TextArea rows={5} value={text} onChange={event => { setText(event.target.value); resetBuilt() }} placeholder="اكتب رسالتك هنا…" />}</div></Card>
    <Card className="opt-card opt-panel opt-signal-panel" bordered={false}><div className="opt-config-heading"><div className="opt-panel-cap"><Text className="opt-section-label">بناء الإشارة</Text><span>03</span></div><Button type="text" icon={<SettingOutlined />} onClick={() => setAdvancedOpen(true)}>مختبر الإشارة</Button></div><div className="opt-steppers"><Stepper label="الترميز اللوني" value={enc} steps={ENCODING_STEPS.map(item => item.value)} onChange={chooseEncoding} render={value => { const item = ENCODING_STEPS.find(entry => entry.value === value)!; return <><strong>{item.label}</strong><small>{item.detail}</small></> }} /><Stepper label="حجم الشبكة" value={grid} steps={GRID_STEPS} onChange={chooseGrid} render={value => <><strong>{value} × {value}</strong><small>خلايا المصفوفة</small></>} /></div><div className="opt-config-summary"><span>{turboLanes > 1 ? `Turbo ×${turboLanes}` : 'مسار واحد'}</span><span>{fps} fps</span><span>LDPC {rate}</span></div><Button type="primary" size="large" block className="opt-send-button" icon={<SendOutlined />} loading={busy} disabled={!hasSource} onClick={generate}>إطلاق القناة</Button></Card>
    <Drawer title="ضبط القناة المتقدم" open={advancedOpen} onClose={() => setAdvancedOpen(false)} width={390} placement="left">{advanced}</Drawer>
  </div>
}
