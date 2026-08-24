import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { NormalizedApiClient } from '../normalized-api'

interface PublicationEmployee {
  id: string
  employeeCode: string
  displayName: string
}

interface CustomerPublicProfile {
  id: string
  employeeId: string
  employeeDisplayName: string
  publicDisplayName: string
  status: 'draft' | 'published' | 'withdrawn'
  draftedByEmployeeId: string | null
  approvedByEmployeeId: string | null
  approvedAt: string | null
  effectiveAt: string | null
  withdrawnAt: string | null
  withdrawalReason: string | null
  approvalReference: string | null
  createdAt: string
  updatedAt: string
}

interface PrivacyPolicyRelease {
  id: string
  policyVersion: string
  content: string
  contentSha256: string
  operatorName: string
  contact: string
  dataRetentionPolicyVersion: string
  thirdPartyRegisterVersion: string
  status: 'draft' | 'published' | 'withdrawn'
  draftedByEmployeeId: string | null
  approvedBy: string | null
  approvedAt: string | null
  effectiveAt: string | null
  withdrawnAt: string | null
  withdrawalReason: string | null
  approvalReference: string | null
  createdAt: string
  updatedAt: string
}

type Notice = { tone: 'success' | 'error'; text: string }

export function CustomerPublicationPanel({ api, permissions }: {
  api: NormalizedApiClient
  permissions: readonly string[]
}) {
  const canManageProfile = permissions.includes('customer.public-profile.manage')
  const canPublishProfile = permissions.includes('customer.public-profile.publish')
  const canViewPrivacy = permissions.includes('privacy.policy.view')
  const canManagePrivacy = permissions.includes('privacy.policy.manage')
  const canPublishPrivacy = permissions.includes('privacy.policy.publish')
  const canReadProfiles = canManageProfile || canPublishProfile
  const canReadPrivacy = canViewPrivacy || canManagePrivacy || canPublishPrivacy
  const [employees, setEmployees] = useState<PublicationEmployee[]>([])
  const [profiles, setProfiles] = useState<CustomerPublicProfile[]>([])
  const [policies, setPolicies] = useState<PrivacyPolicyRelease[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [publicDisplayName, setPublicDisplayName] = useState('')
  const [profileReason, setProfileReason] = useState('依据员工确认建立顾客公开服务名草稿')
  const [profileApprovalReference, setProfileApprovalReference] = useState('')
  const [policyVersion, setPolicyVersion] = useState('')
  const [policyContent, setPolicyContent] = useState('')
  const [operatorName, setOperatorName] = useState('')
  const [contact, setContact] = useState('')
  const [retentionVersion, setRetentionVersion] = useState('')
  const [thirdPartyVersion, setThirdPartyVersion] = useState('')
  const [policyReason, setPolicyReason] = useState('录入已获批准的正式隐私政策正文')
  const [approvedBy, setApprovedBy] = useState('')
  const [policyApprovalReference, setPolicyApprovalReference] = useState('')

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setPhase('loading')
    try {
      const [nextEmployees, nextProfiles, nextPolicies] = await Promise.all([
        canManageProfile
          ? api.getEndpoint<{ data: PublicationEmployee[] }>('/api/staff/customer-publication/employees').then((response) => response.data)
          : Promise.resolve([]),
        canReadProfiles
          ? api.getEndpoint<{ data: CustomerPublicProfile[] }>('/api/staff/customer-publication/profiles').then((response) => response.data)
          : Promise.resolve([]),
        canReadPrivacy
          ? api.getEndpoint<{ data: PrivacyPolicyRelease[] }>('/api/staff/customer-publication/privacy-policies').then((response) => response.data)
          : Promise.resolve([]),
      ])
      setEmployees(nextEmployees)
      setProfiles(nextProfiles)
      setPolicies(nextPolicies)
      setPhase('ready')
    } catch (error) {
      setPhase('error')
      setNotice({ tone: 'error', text: message(error, '顾客公开内容状态没有读取成功') })
    }
  }, [api, canManageProfile, canReadPrivacy, canReadProfiles])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (employeeId === '' && employees.length > 0) setEmployeeId(employees[0]!.id)
  }, [employeeId, employees])

  const latestProfiles = useMemo(() => profiles.filter((profile) => profile.status !== 'withdrawn'), [profiles])

  async function submitProfileDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManageProfile || busy) return
    if (employeeId === '' || publicDisplayName.trim().length < 1 || profileReason.trim().length < 2) {
      setNotice({ tone: 'error', text: '请选择员工，并填写顾客公开服务名和草拟说明' })
      return
    }
    await mutate(async () => {
      await api.putEndpoint(`/api/staff/customer-publication/profiles/${employeeId}/draft`, {
        publicDisplayName: publicDisplayName.trim(), reason: profileReason.trim(),
      }, { idempotencyKey: operationIdempotency('customer-public-profile-draft') })
      setPublicDisplayName('')
      return '顾客公开服务名草稿已保存；须由独立复核人凭确认编号发布。'
    })
  }

  async function publishProfile(profile: CustomerPublicProfile) {
    if (!canPublishProfile || busy) return
    if (profileApprovalReference.trim().length < 8) {
      setNotice({ tone: 'error', text: '请先填写不少于8位的门店或人事确认编号' })
      return
    }
    if (!window.confirm(`确认发布“${profile.publicDisplayName}”作为顾客可见服务名？发布后内容不可直接改写。`)) return
    await mutate(async () => {
      await api.postEndpoint(`/api/staff/customer-publication/profiles/${profile.id}/publish`, {
        approvalReference: profileApprovalReference.trim(), effectiveAt: new Date().toISOString(), reason: '依据人事或门店确认正式发布',
      }, { idempotencyKey: operationIdempotency('customer-public-profile-publish') })
      setProfileApprovalReference('')
      return '顾客公开服务名已发布。'
    })
  }

  async function withdrawProfile(profile: CustomerPublicProfile) {
    if (!canPublishProfile || busy) return
    const reason = window.prompt('请填写撤下原因（至少2个字）：', '员工服务范围调整')
    if (reason === null) return
    if (reason.trim().length < 2) { setNotice({ tone: 'error', text: '撤下原因至少需要2个字' }); return }
    if (!window.confirm(`确认撤下顾客可见服务名“${profile.publicDisplayName}”？顾客端将不再显示。`)) return
    await mutate(async () => {
      await api.postEndpoint(`/api/staff/customer-publication/profiles/${profile.id}/withdraw`, { reason: reason.trim() }, {
        idempotencyKey: operationIdempotency('customer-public-profile-withdraw'),
      })
      return '顾客公开服务名已撤下。'
    })
  }

  async function submitPolicyDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManagePrivacy || busy) return
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(policyVersion)
      || policyContent.trim().length < 80 || operatorName.trim().length < 2 || contact.trim().length < 2
      || retentionVersion.trim().length < 2 || thirdPartyVersion.trim().length < 2 || policyReason.trim().length < 2) {
      setNotice({ tone: 'error', text: '请完整填写正式版本号、正文、主体、联系方式、规则版本和草拟说明' })
      return
    }
    await mutate(async () => {
      const contentSha256 = await sha256(policyContent)
      await api.postEndpoint('/api/staff/customer-publication/privacy-policies/drafts', {
        policyVersion, content: policyContent, contentSha256,
        operatorName: operatorName.trim(), contact: contact.trim(),
        dataRetentionPolicyVersion: retentionVersion.trim(), thirdPartyRegisterVersion: thirdPartyVersion.trim(),
        reason: policyReason.trim(),
      }, { idempotencyKey: operationIdempotency('privacy-policy-draft') })
      return '隐私政策草稿已保存；顾客端不会显示草稿。'
    })
  }

  async function publishPolicy(policy: PrivacyPolicyRelease) {
    if (!canPublishPrivacy || busy) return
    if (approvedBy.trim().length < 2 || policyApprovalReference.trim().length < 8) {
      setNotice({ tone: 'error', text: '请填写法务或运营批准人，以及不少于8位的批准材料编号' })
      return
    }
    if (!window.confirm(`确认发布隐私政策 ${policy.policyVersion}？当前已发布版本会被保留为撤下记录。`)) return
    await mutate(async () => {
      await api.postEndpoint(`/api/staff/customer-publication/privacy-policies/${encodeURIComponent(policy.policyVersion)}/publish`, {
        approvedBy: approvedBy.trim(), approvalReference: policyApprovalReference.trim(),
        effectiveAt: new Date().toISOString(), reason: '依据法务与运营批准材料正式发布',
      }, { idempotencyKey: operationIdempotency('privacy-policy-publish') })
      setPolicyApprovalReference('')
      return `隐私政策 ${policy.policyVersion} 已发布。`
    })
  }

  async function withdrawPolicy(policy: PrivacyPolicyRelease) {
    if (!canPublishPrivacy || busy) return
    const reason = window.prompt('请填写撤下原因（至少2个字）：', '等待更新后的正式政策版本')
    if (reason === null) return
    if (reason.trim().length < 2) { setNotice({ tone: 'error', text: '撤下原因至少需要2个字' }); return }
    if (!window.confirm(`确认撤下当前隐私政策 ${policy.policyVersion}？撤下后顾客将无法查看政策，发布门禁会阻止上线。`)) return
    await mutate(async () => {
      await api.postEndpoint(`/api/staff/customer-publication/privacy-policies/${encodeURIComponent(policy.policyVersion)}/withdraw`, {
        reason: reason.trim(),
      }, { idempotencyKey: operationIdempotency('privacy-policy-withdraw') })
      return `隐私政策 ${policy.policyVersion} 已撤下；请尽快发布有效替代版本。`
    })
  }

  async function mutate(action: () => Promise<string>) {
    setBusy(true); setNotice(null)
    try {
      setNotice({ tone: 'success', text: await action() })
      await load(true)
    } catch (error) {
      setNotice({ tone: 'error', text: message(error, '操作未完成，原数据保持不变') })
    } finally { setBusy(false) }
  }

  if (phase === 'loading') return <div className="staff-module-state" role="status"><LoaderCircle className="is-spinning" /><strong>正在读取顾客公开内容</strong></div>
  if (phase === 'error') return <div className="staff-module-state is-error" role="alert"><CircleAlert /><strong>{notice?.text ?? '顾客公开内容没有读取成功'}</strong><button type="button" onClick={() => void load()}>重新读取</button></div>

  return <section className="customer-publication-panel" aria-labelledby="customer-publication-title">
    <header><div><small>顾客可见内容必须经独立复核、版本化留痕</small><h3 id="customer-publication-title">顾客公开资料与隐私政策</h3></div><button type="button" disabled={busy} onClick={() => void load(true)}><RefreshCw />刷新</button></header>
    {notice !== null && <p className={`customer-publication-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'success' ? <CheckCircle2 /> : <CircleAlert />}{notice.text}</p>}

    {canManageProfile && <form className="staff-module-form" onSubmit={(event) => void submitProfileDraft(event)}>
      <header><strong>顾客公开服务名草稿</strong><small>员工内部姓名不会自动对顾客展示；请仅录入已获员工确认的服务名。</small></header>
      <label>员工<select required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">请选择</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}（{employee.employeeCode}）</option>)}</select></label>
      <label>顾客公开服务名<input required maxLength={80} value={publicDisplayName} onChange={(event) => setPublicDisplayName(event.target.value)} placeholder="例如：小林" /></label>
      <label className="customer-publication-wide">草拟说明<input required minLength={2} maxLength={500} value={profileReason} onChange={(event) => setProfileReason(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? '正在保存' : '保存草稿'}</button>
    </form>}

    {canPublishProfile && <label className="customer-publication-approval">门店或人事确认编号<input value={profileApprovalReference} maxLength={240} onChange={(event) => setProfileApprovalReference(event.target.value)} placeholder="例如：HR-2026-0824-001" /></label>}
    {canReadProfiles && <section className="customer-publication-list"><header><strong>员工顾客公开服务名</strong><small>发布后的内容只能撤下；如需更正，请新建草稿后重新独立发布。</small></header>{latestProfiles.length === 0 ? <p>暂无顾客公开服务名。</p> : latestProfiles.map((profile) => <article key={profile.id}><div><strong>{profile.publicDisplayName}</strong><small>对应员工：{profile.employeeDisplayName} · {profileStatus(profile.status)}{profile.effectiveAt === null ? '' : ` · 生效 ${formatDateTime(profile.effectiveAt)}`}</small></div><div>{profile.status === 'draft' && canPublishProfile && <button type="button" disabled={busy} onClick={() => void publishProfile(profile)}>独立发布</button>}{profile.status === 'published' && canPublishProfile && <button type="button" className="is-danger" disabled={busy} onClick={() => void withdrawProfile(profile)}>撤下</button>}</div></article>)}</section>}

    {canManagePrivacy && <form className="staff-module-form customer-publication-policy-form" onSubmit={(event) => void submitPolicyDraft(event)}>
      <header><strong>隐私政策草稿</strong><small>只可录入已经完成法务审核的正式内容；系统会自动计算正文摘要，草稿不会向顾客展示。</small></header>
      <label>版本号<input required pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,63}" value={policyVersion} onChange={(event) => setPolicyVersion(event.target.value)} placeholder="例如：PIPL.2026.08" /></label>
      <label>运营主体<input required minLength={2} maxLength={200} value={operatorName} onChange={(event) => setOperatorName(event.target.value)} /></label>
      <label>联系渠道<input required minLength={2} maxLength={500} value={contact} onChange={(event) => setContact(event.target.value)} placeholder="例如：privacy@example.com" /></label>
      <label>数据保留规则版本<input required minLength={2} maxLength={80} value={retentionVersion} onChange={(event) => setRetentionVersion(event.target.value)} placeholder="例如：retention-v1" /></label>
      <label>第三方服务清单版本<input required minLength={2} maxLength={80} value={thirdPartyVersion} onChange={(event) => setThirdPartyVersion(event.target.value)} placeholder="例如：third-party-v1" /></label>
      <label className="customer-publication-wide">隐私政策正文<textarea required minLength={80} maxLength={50000} value={policyContent} onChange={(event) => setPolicyContent(event.target.value)} placeholder="粘贴已获批准的正式隐私政策全文" /></label>
      <label className="customer-publication-wide">草拟说明<input required minLength={2} maxLength={500} value={policyReason} onChange={(event) => setPolicyReason(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? '正在保存' : '保存政策草稿'}</button>
    </form>}

    {canPublishPrivacy && <div className="customer-publication-approval-grid"><label>法务或运营批准人<input value={approvedBy} maxLength={200} onChange={(event) => setApprovedBy(event.target.value)} placeholder="已实际复核的姓名或主体" /></label><label>批准材料编号<input value={policyApprovalReference} maxLength={240} onChange={(event) => setPolicyApprovalReference(event.target.value)} placeholder="例如：LEGAL-2026-0824-001" /></label></div>}
    {canReadPrivacy && <section className="customer-publication-list"><header><strong>隐私政策版本</strong><small>未发布版本不对顾客显示；撤下当前版本会触发生产发布门禁。</small></header>{policies.length === 0 ? <p>暂无隐私政策版本，顾客端会保持不展示。</p> : policies.map((policy) => <article key={policy.id}><div><strong>{policy.policyVersion}</strong><small>{profileStatus(policy.status)} · 摘要 {policy.contentSha256.slice(0, 12)}…{policy.effectiveAt === null ? '' : ` · 生效 ${formatDateTime(policy.effectiveAt)}`}</small></div><div>{policy.status === 'draft' && canPublishPrivacy && <button type="button" disabled={busy} onClick={() => void publishPolicy(policy)}>独立发布</button>}{policy.status === 'published' && canPublishPrivacy && <button type="button" className="is-danger" disabled={busy} onClick={() => void withdrawPolicy(policy)}>撤下</button>}</div></article>)}</section>}
    <p className="staff-module-footnote"><ShieldCheck /> 这里记录的是发布链和材料编号，不替代真实员工确认、法务批准、微信平台审核或现场验收。尚未提交这些材料时，生产发布门禁仍会阻止部署。</p>
  </section>
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('')
}

function operationIdempotency(scope: string): string { return `${scope}-${crypto.randomUUID()}` }
function profileStatus(value: 'draft' | 'published' | 'withdrawn'): string {
  return ({ draft: '草稿', published: '已发布', withdrawn: '已撤下' } as const)[value]
}
function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}
