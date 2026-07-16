import type {
  AcceptSongRequestCommand,
  CancelSongRequestCommand,
  CompleteSongRequestCommand,
  ConfirmSongRequestCommand,
  MarkSongRequestPaidCommand,
  MarkSongRequestRefundedCommand,
  RejectSongRequestCommand,
  SingerAppearance,
  SongActor,
  SongAuditEvent,
  SongRequest,
  SongRequestStatus,
  SongState,
  StartSongPerformanceCommand,
  SubmitSongRequestCommand,
} from '../src/shared/song-contracts.js'

function assertNonEmpty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string, label = '时间') {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}必须是有效的ISO时间`)
}

function assertBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('营业日格式必须为YYYY-MM-DD')
}

function assertMoney(value: number, label: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label}必须是${allowZero ? '非负' : '正'}安全整数`)
  }
}

function assertCurrency(value: string) {
  if (!/^[A-Z]{3}$/.test(value)) throw new Error('币种必须是三位大写代码')
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value)
    case 'object': {
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
    }
    default:
      throw new Error('幂等请求包含不支持的数据类型')
  }
}

function findRequest(state: SongState, requestId: string) {
  const request = state.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('点歌请求不存在')
  return request
}

function executeIdempotent(
  state: SongState,
  key: string,
  operation: string,
  payload: unknown,
  execute: () => SongRequest,
) {
  assertNonEmpty(key, '幂等键')
  const fingerprintPayload = typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload).filter(([field]) => field !== 'occurredAt'))
    : payload
  const fingerprint = canonicalize(fingerprintPayload)
  const existing = state.idempotencyRecords.find((record) => record.key === key)
  if (existing) {
    if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
      throw new Error('幂等键已用于不同请求')
    }
    const result = state.requests.find((request) => request.id === existing.requestId)
    if (!result) throw new Error('幂等记录指向的点歌请求不存在')
    return result
  }

  const result = execute()
  state.idempotencyRecords.push({ key, operation, fingerprint, requestId: result.id })
  return result
}

function assertUniqueConfiguration(state: SongState) {
  const appearanceIds = state.performanceSessions.flatMap((item) => item.appearances.map((appearance) => appearance.id))
  const collections: Array<[string, string[]]> = [
    ['歌手ID', state.singers.map((item) => item.id)],
    ['歌手操作人ID', state.singers.map((item) => item.actorId)],
    ['歌曲ID', state.songs.map((item) => item.id)],
    ['曲库配置ID', state.repertoire.map((item) => item.id)],
    ['演出场次ID', state.performanceSessions.map((item) => item.id)],
    ['歌手排班ID', appearanceIds],
    ['桌台会话ID', state.tableSessions.map((item) => item.id)],
    ['经理操作人ID', state.managerActorIds],
  ]
  for (const [label, ids] of collections) {
    if (new Set(ids).size !== ids.length) throw new Error(`${label}不能重复`)
  }
}

function assertConfigurationIntegrity(state: SongState) {
  const singerIds = new Set(state.singers.map((item) => item.id))
  const songIds = new Set(state.songs.map((item) => item.id))
  const activeOfferKeys = new Set<string>()

  for (const singer of state.singers) {
    assertNonEmpty(singer.id, '歌手ID')
    assertNonEmpty(singer.displayName, '歌手名称')
    assertNonEmpty(singer.actorId, '歌手操作人ID')
  }
  for (const song of state.songs) {
    assertNonEmpty(song.id, '歌曲ID')
    assertNonEmpty(song.title, '歌曲名称')
    assertNonEmpty(song.artist, '歌曲原唱')
    if (!Number.isSafeInteger(song.durationSeconds) || song.durationSeconds <= 0) throw new Error('歌曲时长必须是正整数')
  }
  for (const offer of state.repertoire) {
    assertNonEmpty(offer.id, '曲库配置ID')
    if (!singerIds.has(offer.singerId) || !songIds.has(offer.songId)) throw new Error('曲库配置引用了不存在的歌手或歌曲')
    assertMoney(offer.priceAmount, '点歌价格')
    assertCurrency(offer.currency)
    if (!Number.isSafeInteger(offer.configVersion) || offer.configVersion <= 0) throw new Error('曲库配置版本不合法')
    if (offer.enabled) {
      const key = `${offer.singerId}\u0000${offer.songId}`
      if (activeOfferKeys.has(key)) throw new Error('同一歌手歌曲只能有一条启用报价')
      activeOfferKeys.add(key)
    }
  }

  for (const performance of state.performanceSessions) {
    assertNonEmpty(performance.id, '演出场次ID')
    assertBusinessDate(performance.businessDate)
    assertTimestamp(performance.startsAt, '演出开始时间')
    assertTimestamp(performance.endsAt, '演出结束时间')
    const starts = Date.parse(performance.startsAt)
    const ends = Date.parse(performance.endsAt)
    if (starts >= ends) throw new Error('演出场次结束时间必须晚于开始时间')
    for (const appearance of performance.appearances) {
      assertNonEmpty(appearance.id, '歌手排班ID')
      if (!singerIds.has(appearance.singerId)) throw new Error('歌手排班引用了不存在的歌手')
      assertAppearanceWindow(appearance, appearance.requestOpensAt)
      if (Date.parse(appearance.startsAt) < starts || Date.parse(appearance.endsAt) > ends) {
        throw new Error('歌手排班必须位于演出场次时段内')
      }
      if (Date.parse(appearance.requestOpensAt) < starts || Date.parse(appearance.requestClosesAt) > ends) {
        throw new Error('点歌窗口必须位于演出场次时段内')
      }
    }
  }

  const openTableIds = new Set<string>()
  for (const table of state.tableSessions) {
    assertNonEmpty(table.id, '桌台会话ID')
    assertNonEmpty(table.tableId, '桌台ID')
    assertNonEmpty(table.tableCode, '桌台编号')
    assertTimestamp(table.openedAt, '开台时间')
    if (table.closedAt) {
      assertTimestamp(table.closedAt, '结台时间')
      if (Date.parse(table.closedAt) < Date.parse(table.openedAt)) throw new Error('结台时间不能早于开台时间')
    }
    if (table.status === 'open') {
      if (table.closedAt) throw new Error('开台中的桌台会话不能设置结台时间')
      if (openTableIds.has(table.tableId)) throw new Error('同一桌台只能有一个开台会话')
      openTableIds.add(table.tableId)
    } else if (!table.closedAt) {
      throw new Error('已结台的桌台会话必须记录结台时间')
    }
  }
  state.managerActorIds.forEach((actorId) => assertNonEmpty(actorId, '经理操作人ID'))
}

function assertAppearanceWindow(appearance: SingerAppearance, occurredAt: string) {
  const occurred = Date.parse(occurredAt)
  const opens = Date.parse(appearance.requestOpensAt)
  const closes = Date.parse(appearance.requestClosesAt)
  const starts = Date.parse(appearance.startsAt)
  const ends = Date.parse(appearance.endsAt)
  if ([opens, closes, starts, ends].some(Number.isNaN)) throw new Error('歌手演出时段配置不合法')
  if (starts >= ends || opens >= closes || opens > ends || closes < starts) {
    throw new Error('歌手演出及点歌时段配置不合法')
  }
  if (occurred < opens || occurred > closes) throw new Error('当前不在该歌手可点歌时段')
}

function assertActorCanOperate(state: SongState, request: SongRequest, actor: SongActor) {
  assertNonEmpty(actor.actorId, '操作人')
  if (actor.role === 'manager') return
  if (actor.role !== 'singer') throw new Error('仅歌手或经理可以处理点歌请求')
  const singer = state.singers.find((item) => item.id === request.priceSnapshot.singerId)
  if (!singer || singer.actorId !== actor.actorId) throw new Error('仅被点歌手本人可以处理该请求')
}

function assertManagerOrSystem(_state: SongState, actor: SongActor, action: string) {
  assertNonEmpty(actor.actorId, '操作人')
  if (actor.role === 'system') return
  if (actor.role === 'manager') return
  throw new Error(`仅经理或系统可以${action}`)
}

function assertChronology(request: SongRequest, occurredAt: string) {
  assertTimestamp(occurredAt, '操作时间')
  if (Date.parse(occurredAt) < Date.parse(request.updatedAt)) throw new Error('操作时间不能早于上一状态时间')
}

function appendEvent(
  state: SongState,
  request: SongRequest,
  event: Omit<SongAuditEvent, 'id' | 'requestId'>,
) {
  state.auditEvents.push({
    ...event,
    id: `song-event:${request.id}:${state.auditEvents.filter((item) => item.requestId === request.id).length + 1}`,
    requestId: request.id,
  })
}

function changeStatus(
  state: SongState,
  request: SongRequest,
  expected: SongRequestStatus[],
  next: SongRequestStatus,
  actor: SongActor,
  occurredAt: string,
  eventType: SongAuditEvent['type'],
  reason: string | null = null,
  details: SongAuditEvent['details'] = {},
) {
  if (!expected.includes(request.status)) {
    throw new Error(`点歌请求状态${request.status}不能变更为${next}`)
  }
  assertChronology(request, occurredAt)
  const previous = request.status
  request.status = next
  request.updatedAt = occurredAt
  request.revision += 1
  appendEvent(state, request, {
    type: eventType,
    actorId: actor.actorId,
    actorRole: actor.role,
    fromStatus: previous,
    toStatus: next,
    occurredAt,
    reason,
    details,
  })
  return request
}

export function createSongState(
  configuration: Omit<SongState, 'requests' | 'auditEvents' | 'idempotencyRecords'>,
): SongState {
  assertBusinessDate(configuration.businessDate)
  const state: SongState = {
    ...configuration,
    singers: configuration.singers.map((item) => ({ ...item })),
    songs: configuration.songs.map((item) => ({ ...item })),
    repertoire: configuration.repertoire.map((item) => ({ ...item })),
    performanceSessions: configuration.performanceSessions.map((item) => ({
      ...item,
      appearances: item.appearances.map((appearance) => ({ ...appearance })),
    })),
    tableSessions: configuration.tableSessions.map((item) => ({ ...item })),
    managerActorIds: [...configuration.managerActorIds],
    requests: [],
    auditEvents: [],
    idempotencyRecords: [],
  }
  assertUniqueConfiguration(state)
  assertConfigurationIntegrity(state)
  return state
}

export function submitSongRequest(state: SongState, command: SubmitSongRequestCommand) {
  assertNonEmpty(command.requestId, '点歌请求ID')
  assertNonEmpty(command.requestedBy, '点歌客人')
  assertNonEmpty(command.performanceSessionId, '演出场次ID')
  assertNonEmpty(command.appearanceId, '歌手排班ID')
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.singerId, '歌手ID')
  assertNonEmpty(command.songId, '歌曲ID')
  assertTimestamp(command.occurredAt, '点歌时间')
  if (command.customerNote.trim().length > 300) throw new Error('点歌备注不能超过300字')

  return executeIdempotent(state, command.idempotencyKey, 'song_request.submit.v1', command, () => {
    if (state.requests.some((request) => request.id === command.requestId)) throw new Error('点歌请求ID已存在')
    const table = state.tableSessions.find((item) => item.id === command.tableSessionId)
    if (!table) throw new Error('桌台会话不存在')
    if (table.status !== 'open') throw new Error('桌台尚未开台或已经结台')
    if (Date.parse(command.occurredAt) < Date.parse(table.openedAt)) throw new Error('点歌时间不能早于开台时间')

    const performance = state.performanceSessions.find((item) => item.id === command.performanceSessionId)
    if (!performance) throw new Error('演出场次不存在')
    if (performance.businessDate !== state.businessDate) throw new Error('只能提交当前营业日的点歌请求')
    if (!['scheduled', 'live'].includes(performance.status)) throw new Error('当前演出场次不接受点歌')
    const sessionStart = Date.parse(performance.startsAt)
    const sessionEnd = Date.parse(performance.endsAt)
    if (Number.isNaN(sessionStart) || Number.isNaN(sessionEnd) || sessionStart >= sessionEnd) {
      throw new Error('演出场次时间配置不合法')
    }
    const occurred = Date.parse(command.occurredAt)
    if (occurred < sessionStart || occurred > sessionEnd) throw new Error('当前不在演出场次时段')

    const appearance = performance.appearances.find((item) => item.id === command.appearanceId)
    if (!appearance || appearance.singerId !== command.singerId) throw new Error('歌手不在所选演出排班')
    if (!appearance.acceptingRequests) throw new Error('该歌手当前暂停接受点歌')
    assertAppearanceWindow(appearance, command.occurredAt)

    const singer = state.singers.find((item) => item.id === command.singerId)
    if (!singer || !singer.active) throw new Error('歌手不存在或已停用')
    const song = state.songs.find((item) => item.id === command.songId)
    if (!song || !song.active) throw new Error('歌曲不存在或已下架')
    const offer = state.repertoire.find(
      (item) => item.singerId === singer.id && item.songId === song.id && item.enabled,
    )
    if (!offer) throw new Error('该歌手不会或暂不接受演唱此歌曲')
    assertMoney(offer.priceAmount, '点歌价格')
    assertCurrency(offer.currency)
    if (!Number.isSafeInteger(offer.configVersion) || offer.configVersion <= 0) throw new Error('曲库配置版本不合法')

    const request: SongRequest = {
      id: command.requestId,
      performanceSessionId: performance.id,
      appearanceId: appearance.id,
      tableSessionId: table.id,
      tableId: table.tableId,
      tableCode: table.tableCode,
      requestedBy: command.requestedBy,
      customerNote: command.customerNote.trim(),
      status: 'pending_confirmation',
      priceSnapshot: {
        repertoireEntryId: offer.id,
        singerId: singer.id,
        songId: song.id,
        songTitle: song.title,
        songArtist: song.artist,
        singerName: singer.displayName,
        priceAmount: offer.priceAmount,
        currency: offer.currency,
        configVersion: offer.configVersion,
      },
      payment: null,
      confirmedBy: null,
      confirmedAt: null,
      acceptedBy: null,
      acceptedAt: null,
      performingAt: null,
      completedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      cancelledBy: null,
      cancelledAt: null,
      refundReason: null,
      refundReference: null,
      refundedAt: null,
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
      revision: 1,
    }
    state.requests.push(request)
    appendEvent(state, request, {
      type: 'song_request.submitted.v1',
      actorId: command.requestedBy,
      actorRole: 'guest',
      fromStatus: null,
      toStatus: 'pending_confirmation',
      occurredAt: command.occurredAt,
      reason: null,
      details: {
        performanceSessionId: performance.id,
        appearanceId: appearance.id,
        tableSessionId: table.id,
        priceAmount: offer.priceAmount,
        currency: offer.currency,
        configVersion: offer.configVersion,
      },
    })
    return request
  })
}

export function confirmSongRequest(state: SongState, command: ConfirmSongRequestCommand) {
  return executeIdempotent(state, command.idempotencyKey, 'song_request.confirm.v1', command, () => {
    const request = findRequest(state, command.requestId)
    if (!['staff', 'manager', 'system'].includes(command.actor.role)) {
      throw new Error('仅服务人员或经理可以确认点歌')
    }
    changeStatus(
      state,
      request,
      ['pending_confirmation'],
      'pending_payment',
      command.actor,
      command.occurredAt,
      'song_request.confirmed.v1',
    )
    request.confirmedBy = command.actor.actorId
    request.confirmedAt = command.occurredAt
    return request
  })
}

export function markSongRequestPaid(state: SongState, command: MarkSongRequestPaidCommand) {
  assertNonEmpty(command.paymentReference, '支付单号')
  assertMoney(command.paidAmount, '实付金额')
  assertCurrency(command.currency)
  if (!['cash', 'physical_pos'].includes(command.collectionChannel)) throw new Error('点歌仅支持现场现金或物理POS收款')
  if (!['staff', 'manager', 'system'].includes(command.actor.role)) throw new Error('仅现场收款人员可以登记点歌收款')
  return executeIdempotent(state, command.idempotencyKey, 'song_request.mark_paid.v1', command, () => {
    const request = findRequest(state, command.requestId)
    if (state.requests.some((item) => item.id !== request.id && item.payment?.paymentReference === command.paymentReference)) {
      throw new Error('支付单号已绑定其他点歌请求')
    }
    if (request.status !== 'pending_payment') throw new Error(`点歌请求状态${request.status}不能确认支付`)
    if (command.paidAmount !== request.priceSnapshot.priceAmount || command.currency !== request.priceSnapshot.currency) {
      throw new Error('支付金额或币种与点歌价格快照不一致')
    }
    assertChronology(request, command.occurredAt)
    request.payment = {
      paymentReference: command.paymentReference,
      paidAmount: command.paidAmount,
      currency: command.currency,
      collectionChannel: command.collectionChannel,
      paidAt: command.occurredAt,
    }
    return changeStatus(
      state,
      request,
      ['pending_payment'],
      'paid',
      command.actor,
      command.occurredAt,
      'song_request.paid.v1',
      null,
      { paymentReference: command.paymentReference, paidAmount: command.paidAmount, currency: command.currency, collectionChannel: command.collectionChannel },
    )
  })
}

export function acceptSongRequest(state: SongState, command: AcceptSongRequestCommand) {
  return executeIdempotent(state, command.idempotencyKey, 'song_request.accept.v1', command, () => {
    const request = findRequest(state, command.requestId)
    assertActorCanOperate(state, request, command.actor)
    changeStatus(state, request, ['paid'], 'accepted', command.actor, command.occurredAt, 'song_request.accepted.v1')
    request.acceptedBy = command.actor.actorId
    request.acceptedAt = command.occurredAt
    return request
  })
}

export function startSongPerformance(state: SongState, command: StartSongPerformanceCommand) {
  return executeIdempotent(state, command.idempotencyKey, 'song_request.start_performance.v1', command, () => {
    const request = findRequest(state, command.requestId)
    assertActorCanOperate(state, request, command.actor)
    changeStatus(
      state,
      request,
      ['accepted'],
      'performing',
      command.actor,
      command.occurredAt,
      'song_request.performing.v1',
    )
    request.performingAt = command.occurredAt
    return request
  })
}

export function completeSongRequest(state: SongState, command: CompleteSongRequestCommand) {
  return executeIdempotent(state, command.idempotencyKey, 'song_request.complete.v1', command, () => {
    const request = findRequest(state, command.requestId)
    assertActorCanOperate(state, request, command.actor)
    changeStatus(
      state,
      request,
      ['performing'],
      'completed',
      command.actor,
      command.occurredAt,
      'song_request.completed.v1',
    )
    request.completedAt = command.occurredAt
    return request
  })
}

export function rejectSongRequest(state: SongState, command: RejectSongRequestCommand) {
  assertNonEmpty(command.reason, '拒绝原因')
  return executeIdempotent(state, command.idempotencyKey, 'song_request.reject.v1', command, () => {
    const request = findRequest(state, command.requestId)
    if (request.status === 'pending_confirmation') {
      if (!['staff', 'manager', 'system'].includes(command.actor.role)) throw new Error('仅服务人员或经理可以确认无法演唱')
    } else {
      assertActorCanOperate(state, request, command.actor)
    }
    const paid = ['paid', 'accepted'].includes(request.status)
    const next = paid ? 'refund_required' : 'rejected'
    changeStatus(
      state,
      request,
      paid ? ['paid', 'accepted'] : ['pending_confirmation', 'pending_payment'],
      next,
      command.actor,
      command.occurredAt,
      paid ? 'song_request.refund_required.v1' : 'song_request.rejected.v1',
      command.reason.trim(),
      { paymentReference: request.payment?.paymentReference ?? null },
    )
    request.rejectedBy = command.actor.actorId
    request.rejectedAt = command.occurredAt
    request.rejectionReason = command.reason.trim()
    if (paid) request.refundReason = command.reason.trim()
    return request
  })
}

export function cancelSongRequest(state: SongState, command: CancelSongRequestCommand) {
  assertNonEmpty(command.reason, '取消原因')
  return executeIdempotent(state, command.idempotencyKey, 'song_request.cancel.v1', command, () => {
    const request = findRequest(state, command.requestId)
    if (command.actor.role !== 'guest' && command.actor.role !== 'manager') {
      throw new Error('仅客人或经理可以取消未支付点歌')
    }
    if (command.actor.role === 'guest' && command.actor.actorId !== request.requestedBy) {
      throw new Error('仅点歌客人本人可以取消请求')
    }
    changeStatus(
      state,
      request,
      ['pending_confirmation', 'pending_payment'],
      'cancelled',
      command.actor,
      command.occurredAt,
      'song_request.cancelled.v1',
      command.reason.trim(),
    )
    request.cancelledBy = command.actor.actorId
    request.cancelledAt = command.occurredAt
    return request
  })
}

export function markSongRequestRefunded(state: SongState, command: MarkSongRequestRefundedCommand) {
  assertNonEmpty(command.refundReference, '退款单号')
  assertManagerOrSystem(state, command.actor, '确认点歌退款')
  return executeIdempotent(state, command.idempotencyKey, 'song_request.mark_refunded.v1', command, () => {
    const request = findRequest(state, command.requestId)
    if (state.requests.some((item) => item.id !== request.id && item.refundReference === command.refundReference)) {
      throw new Error('退款单号已绑定其他点歌请求')
    }
    changeStatus(
      state,
      request,
      ['refund_required'],
      'refunded',
      command.actor,
      command.occurredAt,
      'song_request.refunded.v1',
      request.refundReason,
      { refundReference: command.refundReference, paymentReference: request.payment?.paymentReference ?? null },
    )
    request.refundReference = command.refundReference
    request.refundedAt = command.occurredAt
    return request
  })
}
