import type {
  StaffBootstrapView,
  StaffDomainKey,
  StaffOnDemandResource,
} from '../shared/normalized-contracts'

export type WorkspacePhase = 'idle' | 'loading' | 'ready' | 'error' | 'login_required'
export type ResourcePhase = 'idle' | 'loading' | 'ready' | 'error'

export interface ResourceState {
  phase: ResourcePhase
  data: unknown
  message: string | null
  requestId: number
}

export interface NormalizedWorkspaceState {
  phase: WorkspacePhase
  bootstrap: StaffBootstrapView | null
  etag: string | null
  message: string | null
  selectedResource: StaffOnDemandResource | null
  resources: Record<StaffOnDemandResource, ResourceState>
}

export type WorkspaceAction =
  | { type: 'bootstrap-loading' }
  | { type: 'bootstrap-ready'; bootstrap: StaffBootstrapView; etag: string | null }
  | { type: 'bootstrap-not-modified'; etag: string | null }
  | { type: 'bootstrap-error'; message: string; loginRequired: boolean }
  | { type: 'resource-loading'; resource: StaffOnDemandResource; requestId: number }
  | { type: 'resource-ready'; resource: StaffOnDemandResource; requestId: number; data: unknown }
  | { type: 'resource-error'; resource: StaffOnDemandResource; requestId: number; message: string }
  | { type: 'resource-close' }

const emptyResource = (): ResourceState => ({
  phase: 'idle',
  data: null,
  message: null,
  requestId: 0,
})

export function initialWorkspaceState(): NormalizedWorkspaceState {
  return {
    phase: 'idle',
    bootstrap: null,
    etag: null,
    message: null,
    selectedResource: null,
    resources: {
      sessions: emptyResource(),
      operations: emptyResource(),
      fulfillment: emptyResource(),
      'reservation-summary': emptyResource(),
    },
  }
}

export function workspaceReducer(
  state: NormalizedWorkspaceState,
  action: WorkspaceAction,
): NormalizedWorkspaceState {
  switch (action.type) {
    case 'bootstrap-loading':
      return { ...state, phase: 'loading', message: null }
    case 'bootstrap-ready':
      return {
        ...state,
        phase: 'ready',
        bootstrap: action.bootstrap,
        etag: action.etag,
        message: null,
      }
    case 'bootstrap-not-modified':
      return {
        ...state,
        phase: state.bootstrap === null ? 'error' : 'ready',
        etag: action.etag,
        message: state.bootstrap === null ? '本地没有可恢复的工作台数据，请重新加载' : null,
      }
    case 'bootstrap-error':
      return {
        ...state,
        phase: action.loginRequired ? 'login_required' : 'error',
        message: action.message,
      }
    case 'resource-loading':
      return {
        ...state,
        selectedResource: action.resource,
        resources: {
          ...state.resources,
          [action.resource]: {
            ...state.resources[action.resource],
            phase: 'loading',
            message: null,
            requestId: action.requestId,
          },
        },
      }
    case 'resource-ready': {
      const current = state.resources[action.resource]
      if (current.requestId !== action.requestId) return state
      return {
        ...state,
        resources: {
          ...state.resources,
          [action.resource]: { ...current, phase: 'ready', data: action.data, message: null },
        },
      }
    }
    case 'resource-error': {
      const current = state.resources[action.resource]
      if (current.requestId !== action.requestId) return state
      return {
        ...state,
        resources: {
          ...state.resources,
          [action.resource]: { ...current, phase: 'error', message: action.message },
        },
      }
    }
    case 'resource-close':
      return { ...state, selectedResource: null }
  }
}

export interface ResourceDefinition {
  resource: StaffOnDemandResource
  domain: StaffDomainKey
  label: string
  description: string
}

export const RESOURCE_DEFINITIONS: readonly ResourceDefinition[] = [
  { resource: 'sessions', domain: 'live', label: '现场', description: '营业桌台与当前桌次' },
  { resource: 'operations', domain: 'service', label: '任务', description: '需要处理的服务事项' },
  { resource: 'fulfillment', domain: 'fulfillment', label: '出品', description: '当前岗位可处理的制作与配送' },
  { resource: 'reservation-summary', domain: 'reservations', label: '预约', description: '今日预约与到店状态' },
] as const

export function availableResources(bootstrap: StaffBootstrapView): ResourceDefinition[] {
  const visibleDomains = new Set(bootstrap.domainSummaries.map((summary) => summary.key))
  return RESOURCE_DEFINITIONS.filter((definition) => visibleDomains.has(definition.domain))
}

export interface PresentationItem {
  id: string
  title: string
  status: string | null
  detail: string | null
}

export function resourceItems(resource: StaffOnDemandResource, value: unknown): PresentationItem[] {
  const source = resourceSource(resource, value)
  return source.slice(0, 50).map((item, index) => presentationItem(item, index))
}

function resourceSource(resource: StaffOnDemandResource, value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  const key = resource === 'sessions'
    ? 'tables'
    : resource === 'operations'
      ? 'tasks'
      : resource === 'fulfillment'
        ? 'workItems'
        : 'reservations'
  const nested = value[key]
  return Array.isArray(nested) ? nested : []
}

function presentationItem(value: unknown, index: number): PresentationItem {
  if (!isRecord(value)) {
    return { id: `item-${index}`, title: '业务记录', status: null, detail: null }
  }
  const title = firstText(value, ['title', 'tableCode', 'customerName', 'displayName', 'productName', 'publicId'])
    ?? `业务记录 ${index + 1}`
  const status = firstText(value, ['statusLabel', 'normalizedStatus', 'status'])
  const detail = firstText(value, ['detail', 'note', 'requestedAt', 'arrivalAt', 'createdAt'])
  const id = firstText(value, ['id', 'publicId', 'code']) ?? `item-${index}`
  return { id, title, status, detail }
}

function firstText(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
